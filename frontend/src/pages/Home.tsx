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
  naivePick: number;
  aiPick: number;
  incidentsAvoidedPer10k: number;
  successGainPer10k: number;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
  changedSegments: number;
  totalSegments: number;
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

interface TimelinePoint {
  minute: number;
  naiveQueue: number;
  aiQueue: number;
  phase: "before" | "apply" | "settle" | "stable";
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const OBJECTIVE = "task_success" as const;
const MAX_POLICY_LEVEL = 2;
const INCIDENT_PENALTY = 4;

const TIMELINE_MINUTES = 12;
const APPLY_MINUTE = 3;
const FRAMES_PER_MINUTE = 10;
const FRAME_TICK_MS = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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
  return segment.replace(/^[A-Za-z]+=/, "").replace(/_/g, " ");
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

function objectiveValue(point: DoseResponsePoint): number {
  return point.successes_per_10k;
}

function utility(point: DoseResponsePoint): number {
  return objectiveValue(point) - INCIDENT_PENALTY * point.incidents_per_10k;
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
  const { dr, naivePolicy, aiPolicy } = params;
  const rows: SegmentDecision[] = [];

  for (const segment of dr.dose_response) {
    const points = segment.points
      .filter((point) => point.policy_level <= MAX_POLICY_LEVEL)
      .sort((a, b) => a.policy_level - b.policy_level);

    if (points.length === 0) {
      continue;
    }

    const levels = points.map((point) => point.policy_level);
    const byLevel = new Map(points.map((point) => [point.policy_level, point]));

    const naivePick = naivePolicy[segment.segment] ?? levels[0];
    const aiPick = aiPolicy[segment.segment] ?? levels[0];

    const naivePoint = byLevel.get(naivePick) ?? points[0];
    const aiPoint = byLevel.get(aiPick) ?? points[0];

    rows.push({
      segment: segment.segment,
      levels,
      naivePick,
      aiPick,
      incidentsAvoidedPer10k: naivePoint.incidents_per_10k - aiPoint.incidents_per_10k,
      successGainPer10k: aiPoint.successes_per_10k - naivePoint.successes_per_10k
    });
  }

  return rows.sort((a, b) => b.incidentsAvoidedPer10k - a.incidentsAvoidedPer10k);
}

function policyToRules(policy: PolicyMap): Array<{ segment: string; policy_level: number }> {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => ({
      segment,
      policy_level: level
    }));
}

function buildQueueTimeline(score: ImpactScore): TimelinePoint[] {
  const points: TimelinePoint[] = [];
  const naiveBase = score.naiveIncidentPer10k;
  const aiTarget = score.aiIncidentPer10k;

  for (let minute = 0; minute < TIMELINE_MINUTES; minute += 1) {
    const cycle = Math.sin((minute + 1) * 0.85) * 0.045 + Math.cos((minute + 1) * 1.3) * 0.03;
    const naiveQueue = Math.max(0, naiveBase * (1 + cycle));

    if (minute < APPLY_MINUTE) {
      points.push({
        minute,
        naiveQueue,
        aiQueue: naiveQueue,
        phase: "before"
      });
      continue;
    }

    if (minute === APPLY_MINUTE) {
      points.push({
        minute,
        naiveQueue,
        aiQueue: naiveBase * 0.82 + aiTarget * 0.18,
        phase: "apply"
      });
      continue;
    }

    if (minute === TIMELINE_MINUTES - 1) {
      points.push({
        minute,
        naiveQueue,
        aiQueue: aiTarget,
        phase: "stable"
      });
      continue;
    }

    const t = (minute - APPLY_MINUTE) / Math.max(TIMELINE_MINUTES - 1 - APPLY_MINUTE, 1);
    const eased = 1 - (1 - t) ** 2;
    const baselineBlend = naiveBase * (1 - eased) + aiTarget * eased;
    const aiQueue = baselineBlend + (naiveQueue - naiveBase) * (1 - eased);

    points.push({
      minute,
      naiveQueue,
      aiQueue,
      phase: "settle"
    });
  }

  return points;
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

    return {
      changedSegments,
      totalSegments,
      incidentsAvoidedPer10k: naiveEvalByDr.incidents - aiEvalByDr.incidents,
      successGainPer10k: aiEvalByDr.successes - naiveEvalByDr.successes,
      aiPolicy,
      naivePolicy,
      naiveIncidentPer10k: naiveEvalByDr.incidents,
      aiIncidentPer10k: aiEvalByDr.incidents,
      naiveSuccessPer10k: naiveEvalByDr.successes,
      aiSuccessPer10k: aiEvalByDr.successes,
      decisionRows
    };
  }, [results.dr, results.naive]);

  const focusDecision = useMemo<SegmentDecision | null>(() => {
    if (!score || score.decisionRows.length === 0) {
      return null;
    }

    const corrected = score.decisionRows.filter((row) => row.naivePick !== row.aiPick);
    const source = corrected.length > 0 ? corrected : score.decisionRows;
    return source[0] ?? null;
  }, [score]);

  const timelinePoints = useMemo<TimelinePoint[]>(() => {
    if (!score) {
      return [];
    }

    return buildQueueTimeline(score);
  }, [score]);

  useEffect(() => {
    if (timelinePoints.length === 0) {
      setFrame(0);
      return;
    }

    setFrame(0);

    const totalFrames = timelinePoints.length * FRAMES_PER_MINUTE;
    const intervalId = window.setInterval(() => {
      setFrame((current) => (current + 1) % totalFrames);
    }, FRAME_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [timelinePoints, replayTick]);

  const activeMinute = timelinePoints.length > 0
    ? Math.floor(frame / FRAMES_PER_MINUTE) % timelinePoints.length
    : 0;
  const minuteProgress = (frame % FRAMES_PER_MINUTE) / Math.max(FRAMES_PER_MINUTE - 1, 1);

  const naiveIndex = focusDecision ? focusDecision.levels.indexOf(focusDecision.naivePick) : 0;
  const aiIndex = focusDecision ? focusDecision.levels.indexOf(focusDecision.aiPick) : 0;
  const levelCount = focusDecision?.levels.length ?? 3;
  const fromPct = levelCount > 1 ? (naiveIndex / (levelCount - 1)) * 100 : 50;
  const toPct = levelCount > 1 ? (aiIndex / (levelCount - 1)) * 100 : 50;

  const activationProgress = clamp(
    (activeMinute - APPLY_MINUTE + minuteProgress) / Math.max(TIMELINE_MINUTES - APPLY_MINUTE - 1, 1),
    0,
    1
  );
  const tokenPct = fromPct + (toPct - fromPct) * activationProgress;

  const storyLine = "AI spots bias in observed logs, corrects one policy action, and stabilizes the incident queue minute by minute.";

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}`;
  const animatedChangedSegments = useAnimatedNumber(score?.changedSegments ?? 0, `changes|${metricAnimationKey}`);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoidedPer10k ?? 0, `incidents-avoided|${metricAnimationKey}`);
  const animatedSuccessGain = useAnimatedNumber(score?.successGainPer10k ?? 0, `success-gain|${metricAnimationKey}`);

  const queueScale = Math.max(...timelinePoints.map((point) => Math.max(point.naiveQueue, point.aiQueue)), 1);

  const recommendationLine = focusDecision
    ? focusDecision.naivePick === focusDecision.aiPick
      ? "AI recommendation: keep the current policy; no corrective action is needed."
      : `AI recommendation: switch ${cleanSegment(focusDecision.segment)} from ${policyLevelName(focusDecision.naivePick)} to ${policyLevelName(focusDecision.aiPick)}.`
    : "AI recommendation: evaluating policy changes.";

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

      {score && results.dr && focusDecision && timelinePoints.length > 0 ? (
        <section className="result-panel" data-testid="results-block">
          <section className="visual-stage" data-testid="visual-first">
            <div className="policy-lane" data-testid="policy-lane">
              <p>AI correction</p>
              <strong>{cleanSegment(focusDecision.segment)}</strong>
              <div className="policy-track" data-testid="policy-track">
                <div className="policy-slots">
                  {focusDecision.levels.map((level) => (
                    <span key={`slot-${level}`}>{policyLevelName(level)}</span>
                  ))}
                </div>
                <i
                  className="policy-link"
                  style={{
                    left: `${Math.min(fromPct, toPct)}%`,
                    width: `${Math.max(4, Math.abs(toPct - fromPct))}%`,
                    transform: `scaleX(${0.2 + activationProgress * 0.8})`,
                    transformOrigin: fromPct <= toPct ? "left center" : "right center"
                  }}
                />
                <i className="policy-token naive" style={{ left: `${fromPct}%` }} />
                <i className="policy-token ai" style={{ left: `${tokenPct}%` }} />
              </div>
            </div>

            <div className="queue-stage" data-testid="queue-stage">
              <div className="queue-legend">
                <span><i className="legend-dot naive" />Observed queue</span>
                <span><i className="legend-dot ai" />Queue after AI correction</span>
              </div>
              <div className="timeline-shell" data-testid="queue-timeline">
                <i
                  className="timeline-scan"
                  style={{ left: `${((activeMinute + minuteProgress) / Math.max(timelinePoints.length - 1, 1)) * 100}%` }}
                />
                <div className="timeline-grid">
                  {timelinePoints.map((point, index) => {
                    const naiveHeight = (point.naiveQueue / queueScale) * 100;
                    const aiVisibleQueue = index <= activeMinute ? point.aiQueue : point.naiveQueue;
                    const aiHeight = (aiVisibleQueue / queueScale) * 100;
                    const className = [
                      "queue-cell",
                      index === activeMinute ? "active" : "",
                      index === APPLY_MINUTE ? "apply" : "",
                      index > activeMinute ? "future" : "",
                      point.phase === "stable" ? "stable" : ""
                    ].filter(Boolean).join(" ");

                    return (
                      <div className={className} key={`minute-${point.minute}`} data-testid={`timeline-minute-${point.minute}`}>
                        <span className="queue-bar naive" style={{ height: `${18 + naiveHeight * 0.76}%` }} />
                        <span className="queue-bar ai" style={{ height: `${18 + aiHeight * 0.76}%` }} />
                        <span className="minute-label">{`M${String(point.minute).padStart(2, "0")}`}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <p className="recommendation-line" data-testid="recommendation-line">{recommendationLine}</p>

          <section className="kpi-row" data-testid="kpi-row">
            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Incidents</p>
              <strong>{formatIncidentNarrative(animatedIncidentsAvoided)}</strong>
            </article>
            <article className="kpi-card" data-testid="kpi-success">
              <p>Successful responses</p>
              <strong>{`${formatSignedNumber(animatedSuccessGain)} / 10k`}</strong>
            </article>
            <article className="kpi-card" data-testid="kpi-changes">
              <p>Segments corrected</p>
              <strong>{`${Math.round(animatedChangedSegments)}/${score.totalSegments}`}</strong>
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
