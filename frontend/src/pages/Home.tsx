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
  levels: number[];
  naiveNorm: number[];
  drNorm: number[];
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
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const OBJECTIVE = "task_success" as const;
const MAX_POLICY_LEVEL = 2;
const INCIDENT_PENALTY = 4;
const FRAMES_PER_SEGMENT = 28;
const FRAME_TICK_MS = 120;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedNumber(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatInteger(Math.round(Math.abs(value)))}`;
}

function formatIncidentNarrative(value: number): string {
  const absolute = formatInteger(Math.round(Math.abs(value)));
  return value >= 0 ? `${absolute} fewer incidents` : `${absolute} more incidents`;
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

function normalize(values: number[]): number[] {
  if (values.length === 0) {
    return values;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (Math.abs(max - min) < 1e-9) {
    return values.map(() => 0.5);
  }

  return values.map((value) => (value - min) / (max - min));
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

    const levels = drPoints.map((point) => point.policy_level);
    const drByLevel = new Map(drPoints.map((point) => [point.policy_level, point]));
    const naiveByLevel = naiveLookup.get(segment.segment);

    const naiveUtilities = levels.map((level, index) => {
      const fallback = drPoints[index];
      const observed = naiveByLevel?.get(level) ?? fallback;
      return utility(observed);
    });
    const drUtilities = levels.map((level, index) => {
      const fallback = drPoints[index];
      return utility(drByLevel.get(level) ?? fallback);
    });

    const naivePick = naivePolicy[segment.segment] ?? levels[0];
    const aiPick = aiPolicy[segment.segment] ?? levels[0];

    const naivePickIndex = levels.indexOf(naivePick);
    const aiPickIndex = levels.indexOf(aiPick);

    const observedNaiveUtility = naivePickIndex >= 0 ? naiveUtilities[naivePickIndex] : naiveUtilities[0];
    const correctedNaiveUtility = naivePickIndex >= 0 ? drUtilities[naivePickIndex] : drUtilities[0];
    const correctedAiUtility = aiPickIndex >= 0 ? drUtilities[aiPickIndex] : drUtilities[0];

    const drNaivePoint = drByLevel.get(naivePick) ?? drPoints[0];
    const drAiPoint = drByLevel.get(aiPick) ?? drPoints[0];

    rows.push({
      segment: segment.segment,
      levels,
      naiveNorm: normalize(naiveUtilities),
      drNorm: normalize(drUtilities),
      naivePick,
      aiPick,
      biasAtNaive: observedNaiveUtility - correctedNaiveUtility,
      utilityGain: correctedAiUtility - correctedNaiveUtility,
      incidentsAvoidedPer10k: drNaivePoint.incidents_per_10k - drAiPoint.incidents_per_10k,
      successGainPer10k: drAiPoint.successes_per_10k - drNaivePoint.successes_per_10k
    });
  }

  return rows.sort((a, b) => a.segment.localeCompare(b.segment));
}

function buildPolicyLine(policy: PolicyMap): string {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => `${cleanSegment(segment)}: level ${level}`)
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

function useAnimatedNumber(target: number, animationKey: string, durationMs = 700): number {
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
  const [manualIndex, setManualIndex] = useState<number | null>(null);

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
      decisionRows
    };
  }, [results.dr, results.naive]);

  useEffect(() => {
    if (!score || score.decisionRows.length === 0) {
      setFrame(0);
      return;
    }

    setFrame(0);
    setManualIndex(null);

    const totalFrames = Math.max(score.decisionRows.length * FRAMES_PER_SEGMENT, FRAMES_PER_SEGMENT);
    const intervalId = window.setInterval(() => {
      setFrame((current) => (current + 1) % totalFrames);
    }, FRAME_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [score, replayTick]);

  const autoIndex = score && score.decisionRows.length > 0
    ? Math.floor(frame / FRAMES_PER_SEGMENT) % score.decisionRows.length
    : 0;
  const activeIndex = manualIndex ?? autoIndex;
  const activeDecision = score?.decisionRows[activeIndex];
  const activeProgress = (frame % FRAMES_PER_SEGMENT) / Math.max(FRAMES_PER_SEGMENT - 1, 1);

  const storyLine = useMemo(() => {
    if (!score) {
      return "AI is replaying logged decisions and searching for the highest-utility policy.";
    }

    return `AI corrected ${score.changedSegments} of ${score.totalSegments} policy decisions, with ${formatInteger(Math.round(Math.abs(score.incidentsAvoidedPer10k)))} fewer incidents and ${formatInteger(Math.round(Math.abs(score.successGainPer10k)))} more successful outcomes per 10k requests.`;
  }, [score]);

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}|${activeIndex}`;
  const animatedChangedSegments = useAnimatedNumber(score?.changedSegments ?? 0, `changes|${metricAnimationKey}`);
  const animatedChangeSharePct = useAnimatedNumber(score?.changeSharePct ?? 0, `change-share|${metricAnimationKey}`);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoidedPer10k ?? 0, `incidents-avoided|${metricAnimationKey}`);
  const animatedSuccessGain = useAnimatedNumber(score?.successGainPer10k ?? 0, `success-gain|${metricAnimationKey}`);
  const animatedAiIncidents = useAnimatedNumber(score?.aiIncidentPer10k ?? 0, `ai-incidents|${metricAnimationKey}`);
  const animatedAiSuccess = useAnimatedNumber(score?.aiSuccessPer10k ?? 0, `ai-success|${metricAnimationKey}`);
  const animatedActiveSuccessGain = useAnimatedNumber(activeDecision?.successGainPer10k ?? 0, `row-success|${metricAnimationKey}`);
  const animatedActiveIncidentGain = useAnimatedNumber(activeDecision?.incidentsAvoidedPer10k ?? 0, `row-incidents|${metricAnimationKey}`);

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

      {score && results.dr && activeDecision ? (
        <section className="result-panel" data-testid="results-block">
          <p className="policy-line" data-testid="policy-line">
            <span>Ship now:</span> {score.policyLine}
          </p>

          <section className="spotlight" data-testid="spotlight">
            <div className="spotlight-head">
              <span className="spotlight-domain">{cleanSegment(activeDecision.segment)}</span>
              <span className="spotlight-step" data-testid="spotlight-step">{`Segment ${activeIndex + 1} of ${score.totalSegments}`}</span>
            </div>
            <p className="spotlight-guide" data-testid="spotlight-guide">
              Each column is a policy level. Taller bars mean better expected outcome for this segment.
            </p>

            <div className="spotlight-grid">
              <article className="lane-card" data-testid="lane-observed">
                <p>Historical observed outcomes</p>
                <div className="lane-bars naive">
                  {activeDecision.levels.map((level, index) => (
                    <span key={`naive-${level}`} className="bar-cell">
                      <span
                        className="bar-fill naive"
                        style={{ height: `${24 + activeDecision.naiveNorm[index] * 66}%` }}
                      />
                      {activeDecision.naivePick === level ? <span className="bar-label current">Current</span> : null}
                    </span>
                  ))}
                </div>
              </article>

              <article className="delta-card" data-testid="delta-card">
                <p className="delta-title">AI decision update</p>
                <strong>
                  {activeDecision.naivePick === activeDecision.aiPick
                    ? `Keep policy level ${activeDecision.aiPick}`
                    : `Change policy level ${activeDecision.naivePick} to level ${activeDecision.aiPick}`}
                </strong>
                <small className={animatedActiveIncidentGain >= 0 ? "good" : "bad"}>
                  {`${formatSignedNumber(animatedActiveSuccessGain)} successful outcomes and ${formatIncidentNarrative(animatedActiveIncidentGain)} per 10k requests`}
                </small>
                {activeDecision.naivePick !== activeDecision.aiPick ? (
                  <em title={`Historical logs overestimated policy level ${activeDecision.naivePick} for this segment`}>
                    historical bias corrected
                  </em>
                ) : null}
              </article>

              <article className="lane-card" data-testid="lane-corrected">
                <p>AI bias-adjusted outcomes</p>
                <div className="lane-bars ai" style={{ opacity: 0.62 + activeProgress * 0.38 }}>
                  {activeDecision.levels.map((level, index) => (
                    <span key={`ai-${level}`} className="bar-cell">
                      <span
                        className="bar-fill ai"
                        style={{ height: `${24 + activeDecision.drNorm[index] * 66}%` }}
                      />
                      {activeDecision.aiPick === level ? <span className="bar-label ai">AI choice</span> : null}
                    </span>
                  ))}
                </div>
              </article>
            </div>

            <div className="level-scale" data-testid="level-scale">
              {activeDecision.levels.map((level) => (
                <span key={`scale-${level}`}>{`Policy level ${level}`}</span>
              ))}
            </div>

            <div className="segment-tabs" data-testid="segment-tabs">
              {score.decisionRows.map((row, index) => (
                <button
                  key={`tab-${row.segment}`}
                  type="button"
                  className={`segment-tab ${index === activeIndex ? "active" : ""}`}
                  onClick={() => setManualIndex(index)}
                  data-testid={`segment-tab-${index}`}
                >
                  {cleanSegment(row.segment)}
                </button>
              ))}
              <button
                type="button"
                className={`segment-tab auto ${manualIndex === null ? "active" : ""}`}
                onClick={() => setManualIndex(null)}
                data-testid="auto-tour"
              >
                auto
              </button>
            </div>
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-changes">
              <p>Policies corrected</p>
              <strong>{`${Math.round(animatedChangedSegments)} of ${score.totalSegments} decisions`}</strong>
              <small className={score.changedSegments > 0 ? "good" : "bad"}>{`${Math.round(animatedChangeSharePct)}% of segments changed`}</small>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Incidents per 10k requests</p>
              <strong>{`${formatInteger(score.naiveIncidentPer10k)} -> ${formatInteger(animatedAiIncidents)}`}</strong>
              <small className={animatedIncidentsAvoided >= 0 ? "good" : "bad"}>
                {formatIncidentNarrative(animatedIncidentsAvoided)}
              </small>
            </article>

            <article className="kpi-card" data-testid="kpi-success">
              <p>Successful outcomes per 10k requests</p>
              <strong>{`${formatInteger(score.naiveSuccessPer10k)} -> ${formatInteger(animatedAiSuccess)}`}</strong>
              <small className={animatedSuccessGain >= 0 ? "good" : "bad"}>
                {`${formatSignedNumber(animatedSuccessGain)} vs current policy`}
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
