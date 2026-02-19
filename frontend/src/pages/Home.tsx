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
  incidentsAvoidedPer10k: number;
  successGainPer10k: number;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
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

function formatIncidentDelta(value: number): string {
  const absolute = formatInteger(Math.round(Math.abs(value)));
  return value >= 0 ? `-${absolute}` : `+${absolute}`;
}

function formatIncidentNarrative(value: number): string {
  const absolute = formatInteger(Math.round(Math.abs(value)));
  return value >= 0 ? `${absolute} fewer incidents` : `${absolute} more incidents`;
}

function cleanSegment(segment: string): string {
  return segment.replace("Domain=", "").replace(/_/g, " ");
}

function policyLevelName(level: number): string {
  if (level === 0) {
    return "Conservative";
  }
  if (level === 1) {
    return "Balanced";
  }
  if (level === 2) {
    return "Growth";
  }
  return `Level ${level}`;
}

function policyLevelAxis(level: number): string {
  if (level === 0) {
    return "Low";
  }
  if (level === 1) {
    return "Mid";
  }
  if (level === 2) {
    return "High";
  }
  return `${level}`;
}

function objectiveValue(point: DoseResponsePoint): number {
  return point.successes_per_10k;
}

function utility(point: DoseResponsePoint): number {
  return objectiveValue(point) - INCIDENT_PENALTY * point.incidents_per_10k;
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
    const observedNaiveUtility = naivePickIndex >= 0 ? naiveUtilities[naivePickIndex] : naiveUtilities[0];
    const correctedNaiveUtility = naivePickIndex >= 0 ? drUtilities[naivePickIndex] : drUtilities[0];

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
      incidentsAvoidedPer10k: drNaivePoint.incidents_per_10k - drAiPoint.incidents_per_10k,
      successGainPer10k: drAiPoint.successes_per_10k - drNaivePoint.successes_per_10k
    });
  }

  return rows.sort((a, b) => a.segment.localeCompare(b.segment));
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
  const revealStage = Math.min(2, Math.floor(activeProgress * 3));

  const storyLine = useMemo(() => {
    if (!score) {
      return "Biased logs hide the best policy.";
    }
    return "Problem -> AI correction -> business value.";
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

  const maxBiasMagnitude = Math.max(...(score?.decisionRows.map((row) => Math.abs(row.biasAtNaive)) ?? [1]), 1e-9);
  const activeBiasMagnitude = Math.abs(activeDecision?.biasAtNaive ?? 0);
  const activeBiasPct = (activeBiasMagnitude / maxBiasMagnitude) * 100;

  const incidentScale = Math.max(score?.naiveIncidentPer10k ?? 0, score?.aiIncidentPer10k ?? 0, 1);
  const successScale = Math.max(score?.naiveSuccessPer10k ?? 0, score?.aiSuccessPer10k ?? 0, 1);
  const currentIncidentBar = ((score?.naiveIncidentPer10k ?? 0) / incidentScale) * 100;
  const aiIncidentBar = (animatedAiIncidents / incidentScale) * 100;
  const currentSuccessBar = ((score?.naiveSuccessPer10k ?? 0) / successScale) * 100;
  const aiSuccessBar = (animatedAiSuccess / successScale) * 100;

  const naiveIndex = activeDecision ? activeDecision.levels.indexOf(activeDecision.naivePick) : 0;
  const aiIndex = activeDecision ? activeDecision.levels.indexOf(activeDecision.aiPick) : 0;
  const levelCount = activeDecision?.levels.length ?? 3;
  const fromPct = levelCount > 1 ? (naiveIndex / (levelCount - 1)) * 100 : 50;
  const toPct = levelCount > 1 ? (aiIndex / (levelCount - 1)) * 100 : 50;
  const connectorLeft = fromPct + (toPct - fromPct) * activeProgress;

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
          <section className="mission-rail" data-testid="mission-rail">
            <article className={`mission-card problem ${revealStage === 0 ? "active" : ""}`} data-testid="mission-problem">
              <p>Problem</p>
              <strong>{`${Math.round(animatedChangedSegments)} biased picks`}</strong>
              <div className="mission-meter">
                <i style={{ width: `${Math.max(10, activeBiasPct)}%` }} />
              </div>
            </article>

            <article className={`mission-card action ${revealStage === 1 ? "active" : ""}`} data-testid="mission-action">
              <p>AI action</p>
              <strong>{activeDecision.naivePick === activeDecision.aiPick ? "Validate" : "Switch"}</strong>
              <div className="mission-swap">
                <span>{policyLevelAxis(activeDecision.naivePick)}</span>
                <span>→</span>
                <span>{policyLevelAxis(activeDecision.aiPick)}</span>
                <i className="mission-swap-token" style={{ left: `${20 + activeProgress * 60}%` }} />
              </div>
            </article>

            <article className={`mission-card value ${revealStage === 2 ? "active" : ""}`} data-testid="mission-value">
              <p>Usefulness</p>
              <strong>{formatIncidentNarrative(animatedActiveIncidentGain)}</strong>
              <div className="mission-delta">
                <span className={animatedActiveSuccessGain >= 0 ? "good" : "bad"}>{`Success ${formatSignedNumber(animatedActiveSuccessGain)}`}</span>
                <span className={animatedActiveIncidentGain >= 0 ? "good" : "bad"}>{`Incidents ${formatIncidentDelta(animatedActiveIncidentGain)}`}</span>
              </div>
            </article>
          </section>

          <section className="duel" data-testid="spotlight">
            <div className="duel-head">
              <span className="duel-segment" data-testid="spotlight-step">
                {`Segment ${activeIndex + 1} of ${score.totalSegments} • ${cleanSegment(activeDecision.segment)}`}
              </span>
            </div>

            <div className="duel-grid">
              <article className={`lane-card ${revealStage === 0 ? "focus-problem" : ""}`} data-testid="lane-observed">
                <p>Observed</p>
                <div className="lane-bars naive">
                  {activeDecision.levels.map((level, index) => (
                    <span
                      key={`naive-${level}`}
                      className={`bar-cell ${activeDecision.naivePick === level ? "selected-current" : ""}`}
                    >
                      <span
                        className="bar-fill naive"
                        style={{ height: `${24 + activeDecision.naiveNorm[index] * 66}%` }}
                      />
                      {activeDecision.naivePick === level ? <span className="bar-glow current" style={{ opacity: 0.3 + activeProgress * 0.7 }} /> : null}
                      {activeDecision.naivePick === level ? <span className="bar-label current">Current</span> : null}
                    </span>
                  ))}
                </div>
              </article>

              <article className="delta-card" data-testid="delta-card">
                <div className="decision-swap" data-testid="decision-swap">
                  <i className={`swap-beam stage-${revealStage}`} style={{ transform: `scaleX(${0.2 + activeProgress * 0.8})` }} />
                  <span className="policy-chip current">{policyLevelName(activeDecision.naivePick)}</span>
                  <span className="swap-arrow">→</span>
                  <span className="policy-chip ai">{policyLevelName(activeDecision.aiPick)}</span>
                </div>
                <div className="connector-track" data-testid="connector">
                  <i className="connector-token" style={{ left: `${connectorLeft}%` }} />
                </div>
                <div className="delta-chips">
                  <span className={`delta-chip ${animatedActiveSuccessGain >= 0 ? "good" : "bad"}`}>
                    {`Success ${formatSignedNumber(animatedActiveSuccessGain)}`}
                  </span>
                  <span className={`delta-chip ${animatedActiveIncidentGain >= 0 ? "good" : "bad"}`}>
                    {`Incidents ${formatIncidentDelta(animatedActiveIncidentGain)}`}
                  </span>
                </div>
              </article>

              <article className={`lane-card ${revealStage > 0 ? "focus-ai" : ""}`} data-testid="lane-corrected">
                <p>AI</p>
                <div className="lane-bars ai" style={{ opacity: 0.62 + activeProgress * 0.38 }}>
                  {activeDecision.levels.map((level, index) => (
                    <span
                      key={`ai-${level}`}
                      className={`bar-cell ${activeDecision.aiPick === level ? "selected-ai" : ""}`}
                    >
                      <span
                        className="bar-fill ai"
                        style={{ height: `${24 + activeDecision.drNorm[index] * 66}%` }}
                      />
                      {activeDecision.aiPick === level ? <span className="bar-glow ai" style={{ opacity: 0.45 + activeProgress * 0.55 }} /> : null}
                      {activeDecision.aiPick === level ? <span className="bar-label ai">AI</span> : null}
                    </span>
                  ))}
                </div>
              </article>
            </div>

            <div className="level-scale" data-testid="level-scale">
              {activeDecision.levels.map((level) => (
                <span key={`scale-${level}`}>{policyLevelAxis(level)}</span>
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
                Auto
              </button>
            </div>
          </section>

          <section className={`impact-board ${revealStage === 2 ? "active" : ""}`} data-testid="impact-board">
            <article className="impact-card current" data-testid="kpi-incidents">
              <p>Current</p>
              <div className="impact-row">
                <span>Incidents / 10k</span>
                <strong>{formatInteger(score.naiveIncidentPer10k)}</strong>
              </div>
              <div className="impact-track"><i className="current" style={{ width: `${currentIncidentBar}%` }} /></div>
              <div className="impact-row">
                <span>Success / 10k</span>
                <strong>{formatInteger(score.naiveSuccessPer10k)}</strong>
              </div>
              <div className="impact-track"><i className="current" style={{ width: `${currentSuccessBar}%` }} /></div>
            </article>

            <article className="impact-card ai" data-testid="kpi-success">
              <p>AI</p>
              <div className="impact-row">
                <span>Incidents / 10k</span>
                <strong>{formatInteger(animatedAiIncidents)}</strong>
              </div>
              <div className="impact-track"><i className="ai" style={{ width: `${aiIncidentBar}%` }} /></div>
              <div className="impact-row">
                <span>Success / 10k</span>
                <strong>{formatInteger(animatedAiSuccess)}</strong>
              </div>
              <div className="impact-track"><i className="ai" style={{ width: `${aiSuccessBar}%` }} /></div>
            </article>

            <article className="impact-card delta" data-testid="kpi-changes">
              <p>Delta</p>
              <strong className={animatedIncidentsAvoided >= 0 ? "good" : "bad"}>{formatIncidentNarrative(animatedIncidentsAvoided)}</strong>
              <strong className={animatedSuccessGain >= 0 ? "good" : "bad"}>{`${formatSignedNumber(animatedSuccessGain)} success / 10k`}</strong>
              <div className="kpi-progress">
                <i style={{ width: `${Math.round(animatedChangeSharePct)}%` }} />
              </div>
            </article>
          </section>

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
