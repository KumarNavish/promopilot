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

interface QueueTimeline {
  minutes: number[];
  naiveQueue: number[];
  aiQueue: number[];
  sloThreshold: number;
  naiveBreachMinute: number | null;
  aiBreachMinute: number | null;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
  recommendationLine: string;
  successLift: number;
  incidentsAvoided: number;
  riskCostImpactUsd: number;
  changedSegments: number;
  candidatesEvaluated: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
  aiProjection: PolicyProjection;
  naiveProjection: PolicyProjection;
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const OBJECTIVE = "task_success" as const;
const MAX_POLICY_LEVEL = 2;
const INCIDENT_PENALTY = 4;
const WEEKLY_REQUESTS = 5_000_000;
const INCIDENT_COST_USD = 2500;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const TIMELINE_TOTAL_MINUTES = 12;
const TIMELINE_TICK_MS = 420;
const SURGE_MULTIPLIER = 40;
const AI_STEPS = ["Reweight logs", "Estimate outcomes", "Search actions", "Ship policy"] as const;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedInteger(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatInteger(Math.abs(value))}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
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

function optimizePolicy(response: RecommendResponse): PolicyMap {
  const policy: PolicyMap = {};

  for (const segment of response.dose_response) {
    const candidates = segment.points.filter((point) => point.policy_level <= MAX_POLICY_LEVEL);
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

function buildActionSummary(naivePolicy: PolicyMap, aiPolicy: PolicyMap): { text: string; changedCount: number } {
  const changes = Object.keys(aiPolicy)
    .sort((a, b) => a.localeCompare(b))
    .filter((segment) => naivePolicy[segment] !== aiPolicy[segment]);

  if (changes.length === 0) {
    return { text: "No policy level changes", changedCount: 0 };
  }

  const preview = changes
    .slice(0, 2)
    .map((segment) => `${cleanSegment(segment)} L${naivePolicy[segment]} -> L${aiPolicy[segment]}`)
    .join(" | ");
  const suffix = changes.length > 2 ? ` (+${changes.length - 2} more)` : "";
  return { text: `${preview}${suffix}`, changedCount: changes.length };
}

function buildQueueTimeline(params: { naiveWeeklyIncidents: number; aiWeeklyIncidents: number }): QueueTimeline {
  const { naiveWeeklyIncidents, aiWeeklyIncidents } = params;
  const minutes = Array.from({ length: TIMELINE_TOTAL_MINUTES + 1 }, (_, minute) => minute);

  const naiveArrivalPerMin = Math.max(0.2, (naiveWeeklyIncidents / MINUTES_PER_WEEK) * SURGE_MULTIPLIER);
  const aiArrivalPerMin = Math.max(0.1, (aiWeeklyIncidents / MINUTES_PER_WEEK) * SURGE_MULTIPLIER);
  const capacityPerMin = aiArrivalPerMin + (naiveArrivalPerMin - aiArrivalPerMin) * 0.45;
  const initialBacklog = Math.max(8, Math.round(naiveArrivalPerMin * 1.8));
  const sloThreshold = Math.max(initialBacklog + 12, Math.round(initialBacklog + naiveArrivalPerMin * 5));

  let naiveQueue = initialBacklog;
  let aiQueue = initialBacklog;

  const naiveQueueSeries: number[] = [];
  const aiQueueSeries: number[] = [];

  for (let minute = 0; minute <= TIMELINE_TOTAL_MINUTES; minute += 1) {
    naiveQueueSeries.push(naiveQueue);
    aiQueueSeries.push(aiQueue);
    naiveQueue = Math.max(0, naiveQueue + naiveArrivalPerMin - capacityPerMin);
    aiQueue = Math.max(0, aiQueue + aiArrivalPerMin - capacityPerMin);
  }

  const naiveBreachIndex = naiveQueueSeries.findIndex((value) => value >= sloThreshold);
  const aiBreachIndex = aiQueueSeries.findIndex((value) => value >= sloThreshold);

  return {
    minutes,
    naiveQueue: naiveQueueSeries,
    aiQueue: aiQueueSeries,
    sloThreshold,
    naiveBreachMinute: naiveBreachIndex >= 0 ? naiveBreachIndex : null,
    aiBreachMinute: aiBreachIndex >= 0 ? aiBreachIndex : null
  };
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
      incident_cost_usd: INCIDENT_COST_USD
    },
    recommendation: score.recommendationLine,
    impact_vs_naive: {
      successful_outcomes: Math.round(score.successLift),
      incidents_avoided: Math.round(score.incidentsAvoided),
      risk_cost_impact_usd: Math.round(score.riskCostImpactUsd)
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
  const [timelineMinute, setTimelineMinute] = useState(0);

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

    const successLift = aiProjection.successes - naiveProjection.successes;
    const incidentsAvoided = naiveProjection.incidents - aiProjection.incidents;
    const riskCostImpactUsd = naiveProjection.riskCostUsd - aiProjection.riskCostUsd;
    const actionSummary = buildActionSummary(naivePolicy, aiPolicy);
    const candidatesEvaluated = results.dr.dose_response.reduce(
      (count, segment) => count + segment.points.filter((point) => point.policy_level <= MAX_POLICY_LEVEL).length,
      0
    );

    return {
      recommendationLine: `Apply now: ${actionSummary.text}.`,
      successLift,
      incidentsAvoided,
      riskCostImpactUsd,
      changedSegments: actionSummary.changedCount,
      candidatesEvaluated,
      aiPolicy,
      naivePolicy,
      aiProjection,
      naiveProjection
    };
  }, [results.dr, results.naive]);

  const queueTimeline = useMemo<QueueTimeline | null>(() => {
    if (!score) {
      return null;
    }

    return buildQueueTimeline({
      naiveWeeklyIncidents: score.naiveProjection.incidents,
      aiWeeklyIncidents: score.aiProjection.incidents
    });
  }, [score]);

  const storyLine = useMemo(() => {
    if (!queueTimeline || !score) {
      return "Auto-running policy search...";
    }

    if (queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute === null) {
      return `AI reweighted biased logs and tested ${score.candidatesEvaluated} actions: naive breaches SLO at m${queueTimeline.naiveBreachMinute}, AI stays stable.`;
    }

    if (queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute !== null) {
      return `AI reweighted biased logs and tested ${score.candidatesEvaluated} actions: SLO breach shifts from m${queueTimeline.naiveBreachMinute} to m${queueTimeline.aiBreachMinute}.`;
    }

    return `AI reweighted biased logs and tested ${score.candidatesEvaluated} actions: queue stays lower than naive under the same capacity.`;
  }, [queueTimeline, score]);

  const outcomeLine = useMemo(() => {
    if (!queueTimeline) {
      return "Computing timeline...";
    }
    if (queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute === null) {
      return `Outcome: Naive breaches at m${queueTimeline.naiveBreachMinute}. AI stays below SLO ${queueTimeline.sloThreshold}.`;
    }
    if (queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute !== null) {
      return `Outcome: Breach delayed from m${queueTimeline.naiveBreachMinute} to m${queueTimeline.aiBreachMinute}.`;
    }
    return `Outcome: Both stay below SLO ${queueTimeline.sloThreshold}; AI queue remains lower.`;
  }, [queueTimeline]);

  useEffect(() => {
    if (!queueTimeline) {
      setTimelineMinute(0);
      return;
    }
  }, [queueTimeline, replayTick]);

  useEffect(() => {
    if (!queueTimeline) {
      return;
    }

    setTimelineMinute(0);
    const intervalId = window.setInterval(() => {
      setTimelineMinute((current) => {
        if (current >= TIMELINE_TOTAL_MINUTES) {
          window.clearInterval(intervalId);
          return current;
        }
        return current + 1;
      });
    }, TIMELINE_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [queueTimeline, replayTick]);

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}`;
  const queueAnimationKey = `${metricAnimationKey}|${timelineMinute}`;
  const animatedSuccessLift = useAnimatedNumber(score?.successLift ?? 0, `kpi-success|${metricAnimationKey}`);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoided ?? 0, `kpi-incidents|${metricAnimationKey}`);
  const animatedRiskCost = useAnimatedNumber(score?.riskCostImpactUsd ?? 0, `kpi-risk|${metricAnimationKey}`);
  const currentNaiveQueue = queueTimeline ? queueTimeline.naiveQueue[timelineMinute] : 0;
  const currentAiQueue = queueTimeline ? queueTimeline.aiQueue[timelineMinute] : 0;
  const animatedNaiveQueue = useAnimatedNumber(currentNaiveQueue, `queue-naive|${queueAnimationKey}`, 220);
  const animatedAiQueue = useAnimatedNumber(currentAiQueue, `queue-ai|${queueAnimationKey}`, 220);
  const timelineMaxQueue = Math.max(...(queueTimeline?.naiveQueue ?? [1]), ...(queueTimeline?.aiQueue ?? [1]), 1);
  const activeStep = Math.min(
    AI_STEPS.length - 1,
    Math.floor((timelineMinute / TIMELINE_TOTAL_MINUTES) * AI_STEPS.length)
  );

  return (
    <main className="page-shell" data-testid="home-shell">
      <header className="hero">
        <h1>AI incident policy optimizer</h1>
        <p className="single-story" data-testid="single-story">
          {storyLine}
        </p>
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
          <p className="recommendation-line" data-testid="recommendation-line">
            {score.recommendationLine}
          </p>

          <section className="impact-strip" data-testid="impact-strip">
            <div className="impact-strip-header">
              <p className="timeline-headline">AI run (auto)</p>
              <div className="timeline-actions">
                <p className="timeline-minute" data-testid="timeline-minute">{`m${timelineMinute}`}</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setReplayTick((prev) => prev + 1)}
                  data-testid="replay-simulation"
                >
                  Replay
                </button>
              </div>
            </div>

            <div className="step-strip" data-testid="ai-steps">
              {AI_STEPS.map((step, index) => (
                <span
                  key={step}
                  className={`step-pill ${index <= activeStep ? "active" : ""}`}
                  data-testid={`ai-step-${index}`}
                >
                  {step}
                </span>
              ))}
            </div>

            <div className="timeline-rows" data-testid="timeline-chart">
              <article className="timeline-row naive" data-testid="naive-card">
                <p className="timeline-label">Naive</p>
                <div className="timeline-track" aria-hidden="true">
                  {queueTimeline?.minutes.map((minute, index) => {
                    const queue = queueTimeline.naiveQueue[index];
                    const height = (queue / timelineMaxQueue) * 100;
                    const revealed = minute <= timelineMinute;
                    return (
                      <span
                        key={`naive-${minute}`}
                        className={`timeline-bar ${revealed ? "revealed" : ""} ${minute === timelineMinute ? "active" : ""}`}
                        style={{ height: `${Math.max(10, height)}%` }}
                      />
                    );
                  })}
                </div>
                <p className="timeline-value">{formatInteger(animatedNaiveQueue)}</p>
              </article>

              <article className="timeline-row ai" data-testid="ai-card">
                <p className="timeline-label">Bias-adjusted</p>
                <div className="timeline-track" aria-hidden="true">
                  {queueTimeline?.minutes.map((minute, index) => {
                    const queue = queueTimeline.aiQueue[index];
                    const height = (queue / timelineMaxQueue) * 100;
                    const revealed = minute <= timelineMinute;
                    return (
                      <span
                        key={`ai-${minute}`}
                        className={`timeline-bar ${revealed ? "revealed" : ""} ${minute === timelineMinute ? "active" : ""}`}
                        style={{ height: `${Math.max(10, height)}%` }}
                      />
                    );
                  })}
                </div>
                <p className="timeline-value">{formatInteger(animatedAiQueue)}</p>
              </article>
            </div>

            <p className="slo-line" data-testid="timeline-slo">
              {outcomeLine}
            </p>
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-success">
              <p>Extra successful responses</p>
              <strong>{formatSignedInteger(animatedSuccessLift)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Incidents avoided</p>
              <strong>{formatSignedInteger(animatedIncidentsAvoided)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-risk-cost">
              <p>Risk cost saved</p>
              <strong>{formatSignedCurrency(animatedRiskCost)}</strong>
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
