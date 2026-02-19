import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, DoseResponsePoint, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
}

interface SegmentDecision {
  segment: string;
  naivePick: number;
  aiPick: number;
  biasAtNaive: number;
  utilityGain: number;
  incidentsAvoidedPer10k: number;
  successGainPer10k: number;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
  policyLine: string;
  changedSegments: number;
  totalSegments: number;
  changeSharePct: number;
  incidentsAvoidedPer10k: number;
  successGainPer10k: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
  naiveIncidentPer10k: number;
  aiIncidentPer10k: number;
  naiveSuccessPer10k: number;
  aiSuccessPer10k: number;
  decisionRows: SegmentDecision[];
  maxAbsUtilityGain: number;
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const OBJECTIVE = "task_success" as const;
const MAX_POLICY_LEVEL = 2;
const INCIDENT_PENALTY = 4;
const FRAMES_PER_ROW = 20;
const FRAME_TICK_MS = 120;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedNumber(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatInteger(Math.round(Math.abs(value)))}`;
}

function cleanSegment(segment: string): string {
  return segment.replace("Domain=", "").replace(/_/g, " ");
}

function objectiveValue(point: DoseResponsePoint): number {
  return point.successes_per_10k;
}

function utility(point: DoseResponsePoint): number {
  return objectiveValue(point) - INCIDENT_PENALTY * point.incidents_per_10k;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function optimizePolicy(response: RecommendResponse): PolicyMap {
  const policy: PolicyMap = {};

  for (const segment of response.dose_response) {
    const candidates = segment.points
      .filter((point) => point.policy_level <= MAX_POLICY_LEVEL)
      .sort((a, b) => a.policy_level - b.policy_level);

    if (candidates.length === 0) {
      continue;
    }

    let best = candidates[0];
    for (const point of candidates.slice(1)) {
      if (utility(point) > utility(best)) {
        best = point;
      }
    }

    policy[segment.segment] = best.policy_level;
  }

  return policy;
}

function evaluatePolicy(response: RecommendResponse, policy: PolicyMap): MethodRollup {
  let successes = 0;
  let incidents = 0;
  let count = 0;

  for (const segment of response.dose_response) {
    const selectedLevel = policy[segment.segment];
    const selected = segment.points.find((point) => point.policy_level === selectedLevel) ?? segment.points[0];
    if (!selected) {
      continue;
    }

    successes += selected.successes_per_10k;
    incidents += selected.incidents_per_10k;
    count += 1;
  }

  const safeCount = Math.max(count, 1);
  return {
    successes: successes / safeCount,
    incidents: incidents / safeCount
  };
}

function buildSegmentDecisions(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  naivePolicy: PolicyMap;
  aiPolicy: PolicyMap;
}): SegmentDecision[] {
  const { naive, dr, naivePolicy, aiPolicy } = params;

  const naiveLookup = new Map<string, Map<number, DoseResponsePoint>>();
  for (const segment of naive.dose_response) {
    naiveLookup.set(
      segment.segment,
      new Map(segment.points.map((point) => [point.policy_level, point]))
    );
  }

  const rows: SegmentDecision[] = [];

  for (const segment of dr.dose_response) {
    const drPoints = segment.points
      .filter((point) => point.policy_level <= MAX_POLICY_LEVEL)
      .sort((a, b) => a.policy_level - b.policy_level);

    if (drPoints.length === 0) {
      continue;
    }

    const drByLevel = new Map(drPoints.map((point) => [point.policy_level, point]));
    const naiveByLevel = naiveLookup.get(segment.segment);

    const naivePick = naivePolicy[segment.segment] ?? drPoints[0].policy_level;
    const aiPick = aiPolicy[segment.segment] ?? drPoints[0].policy_level;

    const drNaivePoint = drByLevel.get(naivePick) ?? drPoints[0];
    const drAiPoint = drByLevel.get(aiPick) ?? drPoints[0];
    const naiveObservedPoint = naiveByLevel?.get(naivePick) ?? drNaivePoint;

    const naiveObservedUtility = utility(naiveObservedPoint);
    const naiveCorrectedUtility = utility(drNaivePoint);
    const aiCorrectedUtility = utility(drAiPoint);

    rows.push({
      segment: segment.segment,
      naivePick,
      aiPick,
      biasAtNaive: naiveObservedUtility - naiveCorrectedUtility,
      utilityGain: aiCorrectedUtility - naiveCorrectedUtility,
      incidentsAvoidedPer10k: drNaivePoint.incidents_per_10k - drAiPoint.incidents_per_10k,
      successGainPer10k: drAiPoint.successes_per_10k - drNaivePoint.successes_per_10k
    });
  }

  return rows.sort((a, b) => a.segment.localeCompare(b.segment));
}

function buildPolicyLine(policy: PolicyMap): string {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => `${cleanSegment(segment)} L${level}`)
    .join(" | ");
}

function policyToRules(policy: PolicyMap): Array<{ segment: string; policy_level: number }> {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => ({
      segment,
      policy_level: level
    }));
}

function useAnimatedNumber(target: number, animationKey: string, durationMs = 650): number {
  const [value, setValue] = useState(target);
  const previousTargetRef = useRef(target);

  useEffect(() => {
    const startValue = previousTargetRef.current;
    const start = performance.now();
    const delta = target - startValue;
    let frameId = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      const eased = 1 - (1 - progress) ** 3;
      setValue(startValue + delta * eased);

      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      } else {
        previousTargetRef.current = target;
      }
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [animationKey, durationMs, target]);

  return value;
}

function exportPolicyBundle(params: { dr: RecommendResponse; score: ImpactScore }): void {
  const { dr, score } = params;

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    scenario: {
      objective: OBJECTIVE,
      segment_by: DEMO_SEGMENT_BY,
      max_policy_level: MAX_POLICY_LEVEL,
      incident_penalty: INCIDENT_PENALTY
    },
    policy_line: score.policyLine,
    metrics_per_10k: {
      incidents_before: Math.round(score.naiveIncidentPer10k),
      incidents_after: Math.round(score.aiIncidentPer10k),
      successes_before: Math.round(score.naiveSuccessPer10k),
      successes_after: Math.round(score.aiSuccessPer10k)
    },
    policy_changes: {
      changed_segments: score.changedSegments,
      total_segments: score.totalSegments
    },
    recommended_rules: policyToRules(score.aiPolicy),
    naive_reference_rules: policyToRules(score.naivePolicy)
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "policy-apply-bundle.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export function Home(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);
  const [replayTick, setReplayTick] = useState(0);
  const [frame, setFrame] = useState(0);

  const runAnalysis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective: OBJECTIVE,
          max_policy_level: MAX_POLICY_LEVEL,
          segment_by: DEMO_SEGMENT_BY,
          method: "naive"
        }),
        recommendPolicy({
          objective: OBJECTIVE,
          max_policy_level: MAX_POLICY_LEVEL,
          segment_by: DEMO_SEGMENT_BY,
          method: "dr"
        })
      ]);

      setResults({ naive, dr });
    } catch (err) {
      if (err instanceof ApiError) {
        setError({
          message: "Could not compute policy. Try again.",
          requestId: err.requestId
        });
      } else {
        setError({ message: "Could not compute policy. Try again." });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runAnalysis();
  }, [runAnalysis]);

  const score = useMemo<ImpactScore | null>(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naivePolicy = optimizePolicy(results.naive);
    const aiPolicy = optimizePolicy(results.dr);

    const naiveEvalByDr = evaluatePolicy(results.dr, naivePolicy);
    const aiEvalByDr = evaluatePolicy(results.dr, aiPolicy);

    const decisionRows = buildSegmentDecisions({
      naive: results.naive,
      dr: results.dr,
      naivePolicy,
      aiPolicy
    });

    const totalSegments = decisionRows.length;
    const changedSegments = decisionRows.filter((row) => row.naivePick !== row.aiPick).length;
    const changeSharePct = totalSegments > 0 ? (changedSegments / totalSegments) * 100 : 0;

    const naiveIncidentPer10k = naiveEvalByDr.incidents;
    const aiIncidentPer10k = aiEvalByDr.incidents;
    const naiveSuccessPer10k = naiveEvalByDr.successes;
    const aiSuccessPer10k = aiEvalByDr.successes;

    const incidentsAvoidedPer10k = naiveIncidentPer10k - aiIncidentPer10k;
    const successGainPer10k = aiSuccessPer10k - naiveSuccessPer10k;

    const maxAbsUtilityGain = Math.max(
      ...decisionRows.map((row) => Math.abs(row.utilityGain)),
      1e-9
    );

    return {
      policyLine: buildPolicyLine(aiPolicy),
      changedSegments,
      totalSegments,
      changeSharePct,
      incidentsAvoidedPer10k,
      successGainPer10k,
      aiPolicy,
      naivePolicy,
      naiveIncidentPer10k,
      aiIncidentPer10k,
      naiveSuccessPer10k,
      aiSuccessPer10k,
      decisionRows,
      maxAbsUtilityGain
    };
  }, [results.dr, results.naive]);

  useEffect(() => {
    if (!score) {
      setFrame(0);
      return;
    }

    setFrame(0);
    const totalFrames = score.decisionRows.length * FRAMES_PER_ROW + FRAMES_PER_ROW;

    const intervalId = window.setInterval(() => {
      setFrame((current) => {
        if (current >= totalFrames) {
          window.clearInterval(intervalId);
          return current;
        }
        return current + 1;
      });
    }, FRAME_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [score, replayTick]);

  const storyLine = useMemo(() => {
    if (!score) {
      return "AI is replaying logged decisions and searching for the highest-utility policy.";
    }

    const successCount = formatInteger(Math.round(Math.abs(score.successGainPer10k)));
    const incidentCount = formatInteger(Math.round(Math.abs(score.incidentsAvoidedPer10k)));
    const successDirection = score.successGainPer10k >= 0 ? "more successful outcomes" : "fewer successful outcomes";
    const incidentDirection = score.incidentsAvoidedPer10k >= 0 ? "fewer incidents" : "more incidents";

    if (score.changedSegments > 0) {
      return `AI corrected ${score.changedSegments} biased decision and delivered ${successCount} ${successDirection} with ${incidentCount} ${incidentDirection} per 10k requests.`;
    }

    return `AI validated the current policy and estimates ${successCount} ${successDirection} with ${incidentCount} ${incidentDirection} per 10k requests.`;
  }, [score]);

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}`;
  const animatedChangedSegments = useAnimatedNumber(score?.changedSegments ?? 0, `changes|${metricAnimationKey}`);
  const animatedChangeSharePct = useAnimatedNumber(score?.changeSharePct ?? 0, `change-share|${metricAnimationKey}`);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoidedPer10k ?? 0, `incidents-avoided|${metricAnimationKey}`);
  const animatedSuccessGain = useAnimatedNumber(score?.successGainPer10k ?? 0, `success-gain|${metricAnimationKey}`);
  const animatedAiIncidents = useAnimatedNumber(score?.aiIncidentPer10k ?? 0, `ai-incidents|${metricAnimationKey}`);
  const animatedAiSuccess = useAnimatedNumber(score?.aiSuccessPer10k ?? 0, `ai-success|${metricAnimationKey}`);

  return (
    <main className="page-shell" data-testid="home-shell">
      <header className="hero">
        <div className="hero-copy">
          <h1>Counterfactual Policy AI</h1>
          <p className="hero-story" data-testid="hero-story">{storyLine}</p>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => setReplayTick((prev) => prev + 1)}
          data-testid="replay-simulation"
        >
          Replay
        </button>
      </header>

      {loading ? (
        <p className="status-line" data-testid="status-line">
          Running AI policy search...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {score && results.dr ? (
        <section className="result-panel" data-testid="results-block">
          <p className="policy-line" data-testid="policy-line">
            <span>Ship now:</span> {score.policyLine}
          </p>

          <section className="decision-strip" data-testid="decision-strip">
            <div className="strip-head">
              <span>Segment</span>
              <span>Observed</span>
              <span />
              <span>AI</span>
              <span>Measured delta / 10k</span>
            </div>

            {score.decisionRows.map((row, index) => {
              const rowProgress = clamp((frame - index * FRAMES_PER_ROW) / FRAMES_PER_ROW, 0, 1);
              const changed = row.naivePick !== row.aiPick;
              const utilityWidth = clamp((Math.abs(row.utilityGain) / score.maxAbsUtilityGain) * 100, 8, 100) * rowProgress;
              const incidentAbs = formatInteger(Math.round(Math.abs(row.incidentsAvoidedPer10k)));
              const incidentToken = `${row.incidentsAvoidedPer10k >= 0 ? "-" : "+"}${incidentAbs} incidents`;

              return (
                <article
                  key={`decision-${row.segment}`}
                  className={`decision-row ${changed ? "changed" : "same"}`}
                  style={{
                    opacity: 0.34 + rowProgress * 0.66,
                    transform: `translateY(${(1 - rowProgress) * 8}px)`
                  }}
                  data-testid={`decision-row-${index}`}
                >
                  <span className="segment-name">{cleanSegment(row.segment)}</span>
                  <span className={`pick-pill naive ${changed ? "flagged" : "stable"}`}>{`L${row.naivePick}`}</span>
                  <span className={`decision-arrow ${changed ? "changed" : "same"}`}>{changed ? "→" : "="}</span>
                  <span className={`pick-pill ai ${changed ? "lifted" : "stable"}`}>{`L${row.aiPick}`}</span>
                  <span className="impact-cell">
                    <span className={`impact-text ${row.utilityGain >= 0 ? "good" : "bad"}`}>
                      {`${formatSignedNumber(row.successGainPer10k)} success | ${incidentToken}`}
                    </span>
                    <span className="impact-meter">
                      <i className={row.utilityGain >= 0 ? "good" : "bad"} style={{ width: `${utilityWidth}%` }} />
                    </span>
                  </span>
                  {changed ? (
                    <span className="bias-flag" title={`Observed logs overstated this pick by ${formatSignedNumber(row.biasAtNaive)} utility`}>
                      bias corrected
                    </span>
                  ) : null}
                </article>
              );
            })}
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-changes">
              <p>Policies corrected</p>
              <strong>{`${Math.round(animatedChangedSegments)} / ${score.totalSegments}`}</strong>
              <small className={score.changedSegments > 0 ? "good" : "bad"}>{`${Math.round(animatedChangeSharePct)}% switched`}</small>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Incidents avoided / 10k</p>
              <strong>{`${formatInteger(Math.round(Math.abs(animatedIncidentsAvoided)))} ${animatedIncidentsAvoided >= 0 ? "fewer" : "more"}`}</strong>
              <small className={animatedIncidentsAvoided >= 0 ? "good" : "bad"}>
                {`${formatInteger(score.naiveIncidentPer10k)} -> ${formatInteger(animatedAiIncidents)}`}
              </small>
            </article>

            <article className="kpi-card" data-testid="kpi-success">
              <p>Success gain / 10k</p>
              <strong>{formatSignedNumber(animatedSuccessGain)}</strong>
              <small className={animatedSuccessGain >= 0 ? "good" : "bad"}>
                {`${formatInteger(score.naiveSuccessPer10k)} -> ${formatInteger(animatedAiSuccess)}`}
              </small>
            </article>
          </div>

          <button
            type="button"
            className="button-primary"
            onClick={() =>
              exportPolicyBundle({
                dr: results.dr!,
                score
              })
            }
            data-testid="apply-policy"
          >
            Apply policy (export JSON)
          </button>
        </section>
      ) : null}
    </main>
  );
}
