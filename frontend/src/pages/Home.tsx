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

interface PolicyProjection {
  successes: number;
  incidents: number;
  riskCostUsd: number;
}

interface SegmentVisual {
  segment: string;
  levels: number[];
  naiveUtilities: number[];
  drUtilities: number[];
  biasGap: number[];
  biasNorm: number[];
  naiveNorm: number[];
  drNorm: number[];
  naivePick: number;
  aiPick: number;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
  policyLine: string;
  successLift: number;
  incidentsAvoided: number;
  candidatesEvaluated: number;
  changedSegments: number;
  incidentDeltaPct: number;
  onCallDeltaPct: number;
  riskDeltaPct: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
  aiProjection: PolicyProjection;
  naiveProjection: PolicyProjection;
  naiveIncidents: number;
  aiIncidents: number;
  naiveOnCallHours: number;
  aiOnCallHours: number;
  naiveRiskCost: number;
  aiRiskCost: number;
  segmentVisuals: SegmentVisual[];
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const OBJECTIVE = "task_success" as const;
const MAX_POLICY_LEVEL = 2;
const INCIDENT_PENALTY = 4;
const WEEKLY_REQUESTS = 5_000_000;
const INCIDENT_COST_USD = 2500;
const TRIAGE_MINUTES_PER_INCIDENT = 8;
const PHASES = ["Logs", "Debias", "Search", "Ship"] as const;
const FRAMES_PER_PHASE = 18;
const TOTAL_FRAMES = PHASES.length * FRAMES_PER_PHASE - 1;
const FRAME_TICK_MS = 180;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}%`;
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

function ratioPercent(after: number, before: number): number {
  if (before <= 0) {
    return 100;
  }
  return (after / before) * 100;
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

function buildSegmentVisuals(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  naivePolicy: PolicyMap;
  aiPolicy: PolicyMap;
}): SegmentVisual[] {
  const { naive, dr, naivePolicy, aiPolicy } = params;

  const naiveLookup = new Map<string, Map<number, DoseResponsePoint>>();
  for (const segment of naive.dose_response) {
    naiveLookup.set(
      segment.segment,
      new Map(segment.points.map((point) => [point.policy_level, point]))
    );
  }

  const visuals: SegmentVisual[] = [];
  for (const segment of dr.dose_response) {
    const drPoints = segment.points
      .filter((point) => point.policy_level <= MAX_POLICY_LEVEL)
      .sort((a, b) => a.policy_level - b.policy_level);

    if (drPoints.length === 0) {
      continue;
    }

    const levels = drPoints.map((point) => point.policy_level);
    const naiveByLevel = naiveLookup.get(segment.segment);

    const naiveUtilities = levels.map((level, index) => {
      const fallbackPoint = drPoints[index];
      const point = naiveByLevel?.get(level) ?? fallbackPoint;
      return utility(point);
    });

    const drUtilities = drPoints.map((point) => utility(point));
    const biasGap = levels.map((_, index) => naiveUtilities[index] - drUtilities[index]);
    const biasAbsMax = Math.max(...biasGap.map((value) => Math.abs(value)), 1e-9);
    const biasNorm = biasGap.map((value) => Math.abs(value) / biasAbsMax);

    visuals.push({
      segment: segment.segment,
      levels,
      naiveUtilities,
      drUtilities,
      biasGap,
      biasNorm,
      naiveNorm: normalize(naiveUtilities),
      drNorm: normalize(drUtilities),
      naivePick: naivePolicy[segment.segment] ?? levels[0],
      aiPick: aiPolicy[segment.segment] ?? levels[0]
    });
  }

  return visuals.sort((a, b) => a.segment.localeCompare(b.segment));
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
      incident_penalty: INCIDENT_PENALTY,
      weekly_requests: WEEKLY_REQUESTS,
      incident_cost_usd: INCIDENT_COST_USD,
      triage_minutes_per_incident: TRIAGE_MINUTES_PER_INCIDENT
    },
    policy_line: score.policyLine,
    metrics_weekly: {
      incidents_before: Math.round(score.naiveIncidents),
      incidents_after: Math.round(score.aiIncidents),
      on_call_hours_before: Math.round(score.naiveOnCallHours * 10) / 10,
      on_call_hours_after: Math.round(score.aiOnCallHours * 10) / 10,
      risk_cost_before_usd: Math.round(score.naiveRiskCost),
      risk_cost_after_usd: Math.round(score.aiRiskCost)
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

    const trafficFactor = WEEKLY_REQUESTS / 10_000;

    const naiveProjection: PolicyProjection = {
      successes: naiveEvalByDr.successes * trafficFactor,
      incidents: naiveEvalByDr.incidents * trafficFactor,
      riskCostUsd: naiveEvalByDr.incidents * trafficFactor * INCIDENT_COST_USD
    };

    const aiProjection: PolicyProjection = {
      successes: aiEvalByDr.successes * trafficFactor,
      incidents: aiEvalByDr.incidents * trafficFactor,
      riskCostUsd: aiEvalByDr.incidents * trafficFactor * INCIDENT_COST_USD
    };

    const segmentVisuals = buildSegmentVisuals({
      naive: results.naive,
      dr: results.dr,
      naivePolicy,
      aiPolicy
    });

    const candidatesEvaluated = segmentVisuals.reduce((count, row) => count + row.levels.length, 0);
    const changedSegments = segmentVisuals.filter((row) => row.naivePick !== row.aiPick).length;
    const naiveIncidents = naiveProjection.incidents;
    const aiIncidents = aiProjection.incidents;
    const naiveOnCallHours = (naiveIncidents * TRIAGE_MINUTES_PER_INCIDENT) / 60;
    const aiOnCallHours = (aiIncidents * TRIAGE_MINUTES_PER_INCIDENT) / 60;
    const naiveRiskCost = naiveProjection.riskCostUsd;
    const aiRiskCost = aiProjection.riskCostUsd;
    const incidentDeltaPct = naiveIncidents > 0 ? ((aiIncidents - naiveIncidents) / naiveIncidents) * 100 : 0;
    const onCallDeltaPct = naiveOnCallHours > 0 ? ((aiOnCallHours - naiveOnCallHours) / naiveOnCallHours) * 100 : 0;
    const riskDeltaPct = naiveRiskCost > 0 ? ((aiRiskCost - naiveRiskCost) / naiveRiskCost) * 100 : 0;

    return {
      policyLine: buildPolicyLine(aiPolicy),
      successLift: aiProjection.successes - naiveProjection.successes,
      incidentsAvoided: naiveIncidents - aiIncidents,
      candidatesEvaluated,
      changedSegments,
      incidentDeltaPct,
      onCallDeltaPct,
      riskDeltaPct,
      aiPolicy,
      naivePolicy,
      aiProjection,
      naiveProjection,
      naiveIncidents,
      aiIncidents,
      naiveOnCallHours,
      aiOnCallHours,
      naiveRiskCost,
      aiRiskCost,
      segmentVisuals
    };
  }, [results.dr, results.naive]);

  useEffect(() => {
    if (!score) {
      setFrame(0);
      return;
    }

    setFrame(0);
    const intervalId = window.setInterval(() => {
      setFrame((current) => {
        if (current >= TOTAL_FRAMES) {
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

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}`;
  const animatedAiIncidents = useAnimatedNumber(score?.aiIncidents ?? 0, `incidents|${metricAnimationKey}`);
  const animatedAiOnCallHours = useAnimatedNumber(score?.aiOnCallHours ?? 0, `oncall|${metricAnimationKey}`);
  const animatedAiRiskCost = useAnimatedNumber(score?.aiRiskCost ?? 0, `risk|${metricAnimationKey}`);
  const animatedIncidentDeltaPct = useAnimatedNumber(score?.incidentDeltaPct ?? 0, `incident-delta|${metricAnimationKey}`);
  const animatedOnCallDeltaPct = useAnimatedNumber(score?.onCallDeltaPct ?? 0, `oncall-delta|${metricAnimationKey}`);
  const animatedRiskDeltaPct = useAnimatedNumber(score?.riskDeltaPct ?? 0, `risk-delta|${metricAnimationKey}`);
  const animatedIncidentRatio = useAnimatedNumber(
    ratioPercent(score?.aiIncidents ?? 0, score?.naiveIncidents ?? 1),
    `incident-ratio|${metricAnimationKey}`
  );
  const animatedOnCallRatio = useAnimatedNumber(
    ratioPercent(score?.aiOnCallHours ?? 0, score?.naiveOnCallHours ?? 1),
    `oncall-ratio|${metricAnimationKey}`
  );
  const animatedRiskRatio = useAnimatedNumber(
    ratioPercent(score?.aiRiskCost ?? 0, score?.naiveRiskCost ?? 1),
    `risk-ratio|${metricAnimationKey}`
  );

  const activePhase = Math.min(PHASES.length - 1, Math.floor(frame / FRAMES_PER_PHASE));
  const phaseProgress = (frame % FRAMES_PER_PHASE) / Math.max(FRAMES_PER_PHASE - 1, 1);
  const displayLevels = score?.segmentVisuals[0]?.levels ?? [0, 1, 2];
  const naiveLaneOpacity = activePhase < 2 ? 1 : 0.52;
  const aiLaneOpacity = activePhase === 0 ? 0.26 : activePhase === 1 ? 0.26 + phaseProgress * 0.34 : 1;
  const aiPickOpacity = activePhase < 2 ? 0 : activePhase === 2 ? phaseProgress : 1;
  const shiftOpacity = activePhase < 2 ? 0 : activePhase === 2 ? phaseProgress : 1;

  return (
    <main className="page-shell" data-testid="home-shell">
      <header className="hero">
        <h1>Counterfactual Policy AI</h1>
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
          <div className="phase-strip" data-testid="phase-strip">
            {PHASES.map((phase, index) => (
              <span
                key={phase}
                className={`phase-pill ${index <= activePhase ? "active" : ""} ${index === activePhase ? "current" : ""}`}
                data-testid={`phase-${index}`}
              >
                {phase}
              </span>
            ))}
          </div>

          <div className="visual-key" data-testid="visual-key">
            <span><i className="key-token bias" />bias</span>
            <span><i className="key-token bar-naive" />observed</span>
            <span><i className="key-token bar-ai" />corrected</span>
            <span><i className="key-token dot-naive" />naive pick</span>
            <span><i className="key-token dot-ai" />ai pick</span>
          </div>

          <section className="decision-film" data-testid="decision-film">
            <div className="film-head">
              <span />
              <span className="film-col">Biased</span>
              <span className="film-col" />
              <span className="film-col">Corrected</span>
            </div>

            {score.segmentVisuals.map((row) => {
              const naivePickIndex = row.levels.indexOf(row.naivePick);
              const aiPickIndex = row.levels.indexOf(row.aiPick);
              const biasAtNaive = naivePickIndex >= 0 ? row.biasNorm[naivePickIndex] : 0;
              const drift = aiPickIndex - naivePickIndex;
              const driftArrow = drift === 0 ? "→" : drift > 0 ? "↗" : "↘";

              return (
                <div key={`film-${row.segment}`} className="film-row">
                  <span className="film-label">{cleanSegment(row.segment)}</span>

                  <div className="film-lane naive" style={{ opacity: naiveLaneOpacity }}>
                    {row.levels.map((level, index) => (
                      <span key={`${row.segment}-naive-${level}`} className="lane-cell">
                        <span
                          className="lane-fill naive"
                          style={{ height: `${22 + row.naiveNorm[index] * 70}%` }}
                        />
                        <span
                          className="lane-bias"
                          style={{ opacity: row.biasNorm[index] * (activePhase < 1 ? 0 : 0.85) }}
                        />
                        {row.naivePick === level ? (
                          <span
                            className="lane-dot naive"
                            style={{
                              boxShadow: `0 0 0 ${2 + biasAtNaive * 6}px rgba(225, 29, 72, ${0.16 + biasAtNaive * 0.42})`
                            }}
                          />
                        ) : null}
                        {row.naivePick === level && row.naivePick !== row.aiPick ? (
                          <span className="lane-status wrong" />
                        ) : null}
                      </span>
                    ))}
                  </div>

                  <span className={`film-shift ${drift === 0 ? "same" : "changed"}`} style={{ opacity: shiftOpacity }}>
                    {driftArrow}
                  </span>

                  <div className="film-lane ai" style={{ opacity: aiLaneOpacity }}>
                    {row.levels.map((level, index) => (
                      <span key={`${row.segment}-ai-${level}`} className="lane-cell">
                        <span
                          className="lane-fill ai"
                          style={{ height: `${22 + row.drNorm[index] * 70}%` }}
                        />
                        {row.aiPick === level ? <span className="lane-dot ai" style={{ opacity: aiPickOpacity }} /> : null}
                        {row.aiPick === level ? <span className="lane-status right" style={{ opacity: aiPickOpacity }} /> : null}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="film-levels">
              <span />
              <div className="film-level-values">
                {displayLevels.map((level) => (
                  <span key={`lvl-left-${level}`}>{`L${level}`}</span>
                ))}
              </div>
              <span />
              <div className="film-level-values">
                {displayLevels.map((level) => (
                  <span key={`lvl-right-${level}`}>{`L${level}`}</span>
                ))}
              </div>
            </div>
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Incidents</p>
              <strong>{formatSignedPercent(animatedIncidentDeltaPct)}</strong>
              <div className="kpi-meter">
                <span className="kpi-baseline" />
                <span className="kpi-current" style={{ width: `${Math.min(130, Math.max(0, animatedIncidentRatio))}%` }} />
              </div>
              <small className={animatedAiIncidents <= score.naiveIncidents ? "good" : "bad"}>
                {`${formatInteger(score.naiveIncidents)} -> ${formatInteger(animatedAiIncidents)}`}
              </small>
            </article>

            <article className="kpi-card" data-testid="kpi-oncall">
              <p>On-call load</p>
              <strong>{formatSignedPercent(animatedOnCallDeltaPct)}</strong>
              <div className="kpi-meter">
                <span className="kpi-baseline" />
                <span className="kpi-current" style={{ width: `${Math.min(130, Math.max(0, animatedOnCallRatio))}%` }} />
              </div>
              <small className={animatedAiOnCallHours <= score.naiveOnCallHours ? "good" : "bad"}>
                {`${Math.round(score.naiveOnCallHours)}h -> ${Math.round(animatedAiOnCallHours)}h`}
              </small>
            </article>

            <article className="kpi-card" data-testid="kpi-risk-cost">
              <p>Risk cost</p>
              <strong>{formatSignedPercent(animatedRiskDeltaPct)}</strong>
              <div className="kpi-meter">
                <span className="kpi-baseline" />
                <span className="kpi-current" style={{ width: `${Math.min(130, Math.max(0, animatedRiskRatio))}%` }} />
              </div>
              <small className={animatedAiRiskCost <= score.naiveRiskCost ? "good" : "bad"}>
                {`${formatCurrency(score.naiveRiskCost)} -> ${formatCurrency(animatedAiRiskCost)}`}
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
