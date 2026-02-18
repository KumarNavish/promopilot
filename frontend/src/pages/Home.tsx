import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, DoseResponsePoint, Objective, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
  safeValue: number;
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
  naiveArrivalPerMin: number;
  aiArrivalPerMin: number;
  capacityPerMin: number;
  initialBacklog: number;
}

type PolicyMap = Record<string, number>;

type OperatingMode = "reliability" | "throughput";
type Horizon = "week" | "quarter" | "year";

interface ModeConfig {
  label: string;
  objective: Objective;
  maxPolicyLevel: number;
  incidentPenalty: number;
}

interface HorizonConfig {
  label: string;
  kpiPrefix: string;
  weeks: number;
}

interface ImpactScore {
  recommendationLine: string;
  usefulnessLine: string;
  operationsLine: string;
  policyDiffLine: string;
  successLift: number;
  incidentsAvoided: number;
  riskCostImpactUsd: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
  aiProjection: PolicyProjection;
  naiveProjection: PolicyProjection;
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const DEFAULT_WEEKLY_REQUESTS = 5_000_000;
const DEFAULT_INCIDENT_COST_USD = 2500;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const TIMELINE_TOTAL_MINUTES = 12;
const TIMELINE_TICK_MS = 420;

const MODE_CONFIGS: Record<OperatingMode, ModeConfig> = {
  reliability: {
    label: "Reliability first",
    objective: "task_success",
    maxPolicyLevel: 2,
    incidentPenalty: 4
  },
  throughput: {
    label: "Throughput first",
    objective: "task_success",
    maxPolicyLevel: 3,
    incidentPenalty: 1
  }
};

const HORIZON_CONFIGS: Record<Horizon, HorizonConfig> = {
  week: {
    label: "1 week",
    kpiPrefix: "Weekly",
    weeks: 1
  },
  quarter: {
    label: "1 quarter",
    kpiPrefix: "Quarterly",
    weeks: 13
  },
  year: {
    label: "1 year",
    kpiPrefix: "Annual",
    weeks: 52
  }
};

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

function objectiveValue(point: DoseResponsePoint, objective: Objective): number {
  return objective === "safe_value" ? point.safe_value_per_10k : point.successes_per_10k;
}

function utility(point: DoseResponsePoint, objective: Objective, incidentPenalty: number): number {
  return objectiveValue(point, objective) - incidentPenalty * point.incidents_per_10k;
}

function optimizePolicy(response: RecommendResponse, objective: Objective, maxPolicyLevel: number, incidentPenalty: number): PolicyMap {
  const policy: PolicyMap = {};

  for (const segment of response.dose_response) {
    const candidates = segment.points.filter((point) => point.policy_level <= maxPolicyLevel);
    if (candidates.length === 0) {
      continue;
    }

    let best = candidates[0];
    for (const point of candidates.slice(1)) {
      if (utility(point, objective, incidentPenalty) > utility(best, objective, incidentPenalty)) {
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
  let safeValue = 0;
  let count = 0;

  for (const segment of response.dose_response) {
    const selectedLevel = policy[segment.segment];
    const selected = segment.points.find((point) => point.policy_level === selectedLevel) ?? segment.points[0];
    if (!selected) {
      continue;
    }

    successes += selected.successes_per_10k;
    incidents += selected.incidents_per_10k;
    safeValue += selected.safe_value_per_10k;
    count += 1;
  }

  const safeCount = Math.max(count, 1);
  return {
    successes: successes / safeCount,
    incidents: incidents / safeCount,
    safeValue: safeValue / safeCount
  };
}

function buildPolicyPhrase(policy: PolicyMap): string {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => `${cleanSegment(segment)}: L${level}`)
    .join(", ");
}

function buildPolicyDiffLine(naivePolicy: PolicyMap, aiPolicy: PolicyMap): string {
  const changed = Object.keys(aiPolicy)
    .sort()
    .filter((segment) => aiPolicy[segment] !== naivePolicy[segment])
    .map((segment) => `${cleanSegment(segment)} L${naivePolicy[segment]} -> L${aiPolicy[segment]}`);

  if (changed.length === 0) {
    return "Policy changes vs naive: none; gains come from better counterfactual ranking.";
  }

  return `Policy changes vs naive: ${changed.join(" | ")}.`;
}

function buildQueueTimeline(params: {
  naiveWeeklyIncidents: number;
  aiWeeklyIncidents: number;
  capacityMultiplier: number;
}): QueueTimeline {
  const { naiveWeeklyIncidents, aiWeeklyIncidents, capacityMultiplier } = params;
  const minutes = Array.from({ length: TIMELINE_TOTAL_MINUTES + 1 }, (_, minute) => minute);
  const naiveArrivalPerMin = naiveWeeklyIncidents / MINUTES_PER_WEEK;
  const aiArrivalPerMin = aiWeeklyIncidents / MINUTES_PER_WEEK;
  const capacityPerMin = Math.max(0.0001, naiveArrivalPerMin * capacityMultiplier);
  const initialBacklog = Math.max(1, Math.round(Math.max(naiveArrivalPerMin, aiArrivalPerMin) * 3));
  const sloThreshold = Math.max(5, Math.round(initialBacklog + Math.max(naiveArrivalPerMin, aiArrivalPerMin) * 10));

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
    aiBreachMinute: aiBreachIndex >= 0 ? aiBreachIndex : null,
    naiveArrivalPerMin,
    aiArrivalPerMin,
    capacityPerMin,
    initialBacklog
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

function exportPolicyBundle(params: {
  dr: RecommendResponse;
  score: ImpactScore;
  mode: OperatingMode;
  horizon: Horizon;
  weeklyRequests: number;
  incidentCostUsd: number;
}): void {
  const { dr, score, mode, horizon, weeklyRequests, incidentCostUsd } = params;
  const modeConfig = MODE_CONFIGS[mode];
  const horizonConfig = HORIZON_CONFIGS[horizon];

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    scenario: {
      mode,
      mode_label: modeConfig.label,
      horizon,
      horizon_label: horizonConfig.label,
      objective: modeConfig.objective,
      segment_by: DEMO_SEGMENT_BY,
      max_policy_level: modeConfig.maxPolicyLevel,
      incident_penalty: modeConfig.incidentPenalty,
      weekly_requests: weeklyRequests,
      incident_cost_usd: incidentCostUsd
    },
    recommendation: score.recommendationLine,
    operational_usefulness: score.usefulnessLine,
    operational_oncall: score.operationsLine,
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
  const [mode, setMode] = useState<OperatingMode>("reliability");
  const [horizon, setHorizon] = useState<Horizon>("week");
  const [weeklyRequests, setWeeklyRequests] = useState<number>(DEFAULT_WEEKLY_REQUESTS);
  const [incidentCostUsd, setIncidentCostUsd] = useState<number>(DEFAULT_INCIDENT_COST_USD);
  const [capacityMultiplier, setCapacityMultiplier] = useState<number>(1.0);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);
  const [replayTick, setReplayTick] = useState(0);
  const [timelineMinute, setTimelineMinute] = useState(0);
  const [timelinePlaying, setTimelinePlaying] = useState(true);

  const modeConfig = MODE_CONFIGS[mode];
  const horizonConfig = HORIZON_CONFIGS[horizon];

  const runAnalysis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective: modeConfig.objective,
          max_policy_level: modeConfig.maxPolicyLevel,
          segment_by: DEMO_SEGMENT_BY,
          method: "naive"
        }),
        recommendPolicy({
          objective: modeConfig.objective,
          max_policy_level: modeConfig.maxPolicyLevel,
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
  }, [modeConfig.maxPolicyLevel, modeConfig.objective]);

  const autoRunRef = useRef(false);
  useEffect(() => {
    if (!autoRunRef.current) {
      autoRunRef.current = true;
      void runAnalysis();
      return;
    }

    void runAnalysis();
  }, [runAnalysis]);

  const score = useMemo<ImpactScore | null>(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naivePolicy = optimizePolicy(results.naive, modeConfig.objective, modeConfig.maxPolicyLevel, modeConfig.incidentPenalty);
    const aiPolicy = optimizePolicy(results.dr, modeConfig.objective, modeConfig.maxPolicyLevel, modeConfig.incidentPenalty);

    const naiveEvalByDr = evaluatePolicy(results.dr, naivePolicy);
    const aiEvalByDr = evaluatePolicy(results.dr, aiPolicy);

    const trafficFactor = (weeklyRequests / 10_000) * horizonConfig.weeks;

    const naiveProjection: PolicyProjection = {
      successes: naiveEvalByDr.successes * trafficFactor,
      incidents: naiveEvalByDr.incidents * trafficFactor,
      riskCostUsd: naiveEvalByDr.incidents * trafficFactor * incidentCostUsd
    };

    const aiProjection: PolicyProjection = {
      successes: aiEvalByDr.successes * trafficFactor,
      incidents: aiEvalByDr.incidents * trafficFactor,
      riskCostUsd: aiEvalByDr.incidents * trafficFactor * incidentCostUsd
    };

    const successLift = aiProjection.successes - naiveProjection.successes;
    const incidentsAvoided = naiveProjection.incidents - aiProjection.incidents;
    const riskCostImpactUsd = naiveProjection.riskCostUsd - aiProjection.riskCostUsd;

    const policyPhrase = buildPolicyPhrase(aiPolicy);
    const incidentPhrase =
      incidentsAvoided >= 0
        ? `${formatInteger(incidentsAvoided)} fewer incidents`
        : `${formatInteger(Math.abs(incidentsAvoided))} additional incidents`;
    const traceableMathLine = "Traceable math: incidents = incidents_per_10k x traffic/10k x horizon; risk cost = incidents x incident cost.";

    return {
      recommendationLine: `Ship now: ${policyPhrase}. In ${horizonConfig.label}, this bias-adjusted policy projects ${formatSignedInteger(
        successLift
      )} successful outcomes with ${incidentPhrase} vs naive targeting.`,
      usefulnessLine: `Practical impact: ${formatSignedInteger(incidentsAvoided)} incidents and ${formatSignedCurrency(
        riskCostImpactUsd
      )} risk-cost impact vs naive.`,
      operationsLine: traceableMathLine,
      policyDiffLine: buildPolicyDiffLine(naivePolicy, aiPolicy),
      successLift,
      incidentsAvoided,
      riskCostImpactUsd,
      aiPolicy,
      naivePolicy,
      aiProjection,
      naiveProjection
    };
  }, [horizonConfig.label, horizonConfig.weeks, incidentCostUsd, modeConfig.incidentPenalty, modeConfig.maxPolicyLevel, modeConfig.objective, results.dr, results.naive, weeklyRequests]);

  const animationKey = `${mode}|${horizon}|${weeklyRequests}|${incidentCostUsd}|${replayTick}`;
  const queueTimeline = useMemo<QueueTimeline | null>(() => {
    if (!score) {
      return null;
    }

    const naiveWeeklyIncidents = score.naiveProjection.incidents / horizonConfig.weeks;
    const aiWeeklyIncidents = score.aiProjection.incidents / horizonConfig.weeks;

    return buildQueueTimeline({
      naiveWeeklyIncidents,
      aiWeeklyIncidents,
      capacityMultiplier
    });
  }, [capacityMultiplier, horizonConfig.weeks, score]);

  useEffect(() => {
    if (!queueTimeline) {
      setTimelineMinute(0);
      setTimelinePlaying(false);
      return;
    }

    setTimelineMinute(0);
    setTimelinePlaying(true);
  }, [animationKey, queueTimeline]);

  useEffect(() => {
    if (!queueTimeline || !timelinePlaying) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setTimelineMinute((current) => {
        if (current >= TIMELINE_TOTAL_MINUTES) {
          window.clearInterval(intervalId);
          setTimelinePlaying(false);
          return current;
        }
        return current + 1;
      });
    }, TIMELINE_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [queueTimeline, timelinePlaying]);

  const animatedSuccessLift = useAnimatedNumber(score?.successLift ?? 0, animationKey);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoided ?? 0, animationKey);
  const animatedRiskCost = useAnimatedNumber(score?.riskCostImpactUsd ?? 0, animationKey);
  const currentNaiveQueue = queueTimeline ? queueTimeline.naiveQueue[timelineMinute] : 0;
  const currentAiQueue = queueTimeline ? queueTimeline.aiQueue[timelineMinute] : 0;
  const animatedNaiveQueue = useAnimatedNumber(currentNaiveQueue ?? 0, `${animationKey}|minute-${timelineMinute}|naive`, 230);
  const animatedAiQueue = useAnimatedNumber(currentAiQueue ?? 0, `${animationKey}|minute-${timelineMinute}|ai`, 230);
  const timelineMaxQueue = Math.max(...(queueTimeline?.naiveQueue ?? [1]), ...(queueTimeline?.aiQueue ?? [1]), 1);
  const timelineSummary =
    currentNaiveQueue >= currentAiQueue
      ? `Minute ${timelineMinute}: bias-adjusted queue is ${formatInteger(currentNaiveQueue - currentAiQueue)} incidents lower.`
      : `Minute ${timelineMinute}: queue pressure is ${formatInteger(currentAiQueue - currentNaiveQueue)} incidents higher; investigate operating mode.`;
  const timelineVerdict = queueTimeline
    ? queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute === null
      ? `Incident-room verdict: naive breaches SLO at minute ${queueTimeline.naiveBreachMinute}; bias-adjusted stays below threshold ${queueTimeline.sloThreshold}.`
      : queueTimeline.naiveBreachMinute !== null && queueTimeline.aiBreachMinute !== null
        ? (() => {
            const breachDelta = queueTimeline.aiBreachMinute - queueTimeline.naiveBreachMinute;
            if (breachDelta > 0) {
              return `Incident-room verdict: both breach, but bias-adjusted delays breach by ${formatInteger(breachDelta)} minutes.`;
            }
            if (breachDelta < 0) {
              return `Incident-room verdict: both breach, and bias-adjusted breaches ${formatInteger(Math.abs(breachDelta))} minutes earlier; choose reliability mode.`;
            }
            return "Incident-room verdict: both breach at the same minute; gains come from lower sustained queue afterward.";
          })()
        : `Incident-room verdict: both stay under SLO threshold ${queueTimeline.sloThreshold}, with lower queue pressure on bias-adjusted policy.`
    : "";

  const weeklyRequestsMillions = weeklyRequests / 1_000_000;

  return (
    <main className="page-shell" data-testid="home-shell">
      <header className="hero">
        <p className="eyebrow">Counterfactual policy runner</p>
        <h1>One-click AI policy optimizer</h1>
        <p className="hero-copy" data-testid="single-story">
          This demo auto-runs on load, corrects biased logs, and shows the exact policy that moves both reliability and business value.
        </p>
      </header>

      <section className="controls" data-testid="controls">
        <div className="field">
          <p className="field-label">Operating mode</p>
          <div className="mode-toggle" role="tablist" aria-label="Operating mode">
            {(["reliability", "throughput"] as OperatingMode[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`mode-pill ${mode === option ? "active" : ""}`}
                onClick={() => setMode(option)}
                data-testid={`mode-${option}`}
              >
                {MODE_CONFIGS[option].label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <p className="field-label">Time horizon</p>
          <div className="mode-toggle" role="tablist" aria-label="Time horizon">
            {(["week", "quarter", "year"] as Horizon[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`mode-pill ${horizon === option ? "active" : ""}`}
                onClick={() => setHorizon(option)}
                data-testid={`horizon-${option}`}
              >
                {HORIZON_CONFIGS[option].label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="weekly-requests">
            Weekly traffic: {weeklyRequestsMillions.toFixed(1)}M requests
          </label>
          <input
            id="weekly-requests"
            type="range"
            min={1}
            max={15}
            step={0.5}
            value={weeklyRequestsMillions}
            onChange={(event) => setWeeklyRequests(Math.round(Number(event.target.value) * 1_000_000))}
            data-testid="weekly-slider"
          />
        </div>

        <div className="field span-two">
          <label className="field-label" htmlFor="incident-cost">
            Incident cost: ${formatInteger(incidentCostUsd)} each
          </label>
          <input
            id="incident-cost"
            type="range"
            min={500}
            max={6000}
            step={250}
            value={incidentCostUsd}
            onChange={(event) => setIncidentCostUsd(Number(event.target.value))}
            data-testid="incident-cost-slider"
          />
        </div>
      </section>

      {loading ? (
        <p className="status-line" data-testid="status-line">
          AI is recomputing policy with counterfactual correction...
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
          <p className="usefulness-line" data-testid="usefulness-line">
            {score.usefulnessLine}
          </p>
          <p className="operations-line" data-testid="operations-line">
            {score.operationsLine}
          </p>
          <p className="policy-diff-line" data-testid="policy-diff-line">
            {score.policyDiffLine}
          </p>

          <section className="impact-strip" data-testid="impact-strip">
            <div className="impact-strip-header">
              <div className="timeline-title">
                <p>Minute-by-minute queue stabilization</p>
                <p className="timeline-summary" data-testid="timeline-minute">
                  {timelineSummary}
                </p>
              </div>
              <div className="timeline-actions">
                <button
                  type="button"
                  className="replay-button"
                  onClick={() => {
                    if (!timelinePlaying && timelineMinute >= TIMELINE_TOTAL_MINUTES) {
                      setTimelineMinute(0);
                    }
                    setTimelinePlaying((prev) => !prev);
                  }}
                  data-testid="timeline-play-toggle"
                >
                  {timelinePlaying ? "Pause timeline" : "Play timeline"}
                </button>
                <button
                  type="button"
                  className="replay-button"
                  onClick={() => setReplayTick((prev) => prev + 1)}
                  data-testid="replay-simulation"
                >
                  Replay simulation
                </button>
              </div>
            </div>
            <div className="timeline-controls">
              <label className="field-label" htmlFor="timeline-capacity">
                Incident desk capacity: x{capacityMultiplier.toFixed(2)} of current load
              </label>
              <input
                id="timeline-capacity"
                type="range"
                min={0.8}
                max={1.2}
                step={0.01}
                value={capacityMultiplier}
                onChange={(event) => setCapacityMultiplier(Number(event.target.value))}
                data-testid="timeline-capacity-slider"
              />
            </div>

            <div className="timeline-rows" data-testid="timeline-chart">
              <article className="timeline-row naive" data-testid="naive-card">
                <p className="timeline-label">Naive queue</p>
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
                <p className="timeline-label">Bias-adjusted queue</p>
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

            <p className="timeline-footnote">Bars are unresolved incidents waiting in queue each minute.</p>
            <p className="timeline-math" data-testid="timeline-math">
              queue[t+1] = max(0, queue[t] + arrivals - capacity) where arrivals/min are {queueTimeline?.naiveArrivalPerMin.toFixed(2)} (naive)
              and {queueTimeline?.aiArrivalPerMin.toFixed(2)} (bias-adjusted), capacity/min is {queueTimeline?.capacityPerMin.toFixed(2)}, and
              initial backlog is {formatInteger(queueTimeline?.initialBacklog ?? 0)}.
            </p>
            <input
              type="range"
              min={0}
              max={TIMELINE_TOTAL_MINUTES}
              step={1}
              value={timelineMinute}
              onChange={(event) => {
                setTimelineMinute(Number(event.target.value));
                setTimelinePlaying(false);
              }}
              data-testid="timeline-scrubber"
            />
            <p className="timeline-verdict" data-testid="timeline-verdict">
              {timelineVerdict}
            </p>
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-success">
              <p>{horizonConfig.kpiPrefix} successful outcomes vs naive</p>
              <strong>{formatSignedInteger(animatedSuccessLift)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>{horizonConfig.kpiPrefix} incidents avoided vs naive</p>
              <strong>{formatSignedInteger(animatedIncidentsAvoided)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-risk-cost">
              <p>{horizonConfig.kpiPrefix} risk cost impact</p>
              <strong>{formatSignedCurrency(animatedRiskCost)}</strong>
            </article>
          </div>

          <button
            type="button"
            className="button-primary"
            onClick={() =>
              exportPolicyBundle({
                dr: results.dr!,
                score,
                mode,
                horizon,
                weeklyRequests,
                incidentCostUsd
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
