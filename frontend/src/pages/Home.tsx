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
}

interface PathGeometry {
  linePath: string;
  areaPath: string;
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
        aiQueue: naiveQueue
      });
      continue;
    }

    if (minute === APPLY_MINUTE) {
      points.push({
        minute,
        naiveQueue,
        aiQueue: naiveBase * 0.82 + aiTarget * 0.18
      });
      continue;
    }

    if (minute === TIMELINE_MINUTES - 1) {
      points.push({
        minute,
        naiveQueue,
        aiQueue: aiTarget
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
      aiQueue
    });
  }

  return points;
}

function buildPathGeometry(params: {
  values: number[];
  width: number;
  height: number;
  padX: number;
  padY: number;
  minValue: number;
  maxValue: number;
}): PathGeometry {
  const { values, width, height, padX, padY, minValue, maxValue } = params;
  if (values.length === 0) {
    return { linePath: "", areaPath: "" };
  }

  const innerWidth = width - padX * 2;
  const innerHeight = height - padY * 2;
  const denominator = Math.max(values.length - 1, 1);
  const valueRange = Math.max(maxValue - minValue, 1e-9);

  const points = values.map((value, index) => {
    const x = padX + (index / denominator) * innerWidth;
    const normalized = (value - minValue) / valueRange;
    const y = height - padY - normalized * innerHeight;
    return { x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  const areaFloorY = (height - padY).toFixed(2);
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${areaFloorY} L ${points[0].x.toFixed(2)} ${areaFloorY} Z`;

  return { linePath, areaPath };
}

function interpolateSeries(values: number[], t: number): number {
  if (values.length === 0) {
    return 0;
  }

  const bounded = clamp(t, 0, values.length - 1);
  const left = Math.floor(bounded);
  const right = Math.min(values.length - 1, left + 1);
  const fraction = bounded - left;

  return values[left] * (1 - fraction) + values[right] * fraction;
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
  const minuteFloat = activeMinute + minuteProgress;

  const levelCount = focusDecision?.levels.length ?? 3;
  const naiveIndex = focusDecision ? focusDecision.levels.indexOf(focusDecision.naivePick) : 0;
  const aiIndex = focusDecision ? focusDecision.levels.indexOf(focusDecision.aiPick) : 0;
  const fromPct = levelCount > 1 ? (naiveIndex / (levelCount - 1)) * 100 : 50;
  const toPct = levelCount > 1 ? (aiIndex / (levelCount - 1)) * 100 : 50;

  const activationProgress = clamp(
    (minuteFloat - APPLY_MINUTE) / Math.max(TIMELINE_MINUTES - APPLY_MINUTE - 1, 1),
    0,
    1
  );
  const tokenPct = fromPct + (toPct - fromPct) * activationProgress;

  const timelineGeometry = useMemo(() => {
    if (timelinePoints.length === 0) {
      return null;
    }

    const width = 920;
    const height = 212;
    const padX = 28;
    const padY = 18;

    const naiveValues = timelinePoints.map((point) => point.naiveQueue);
    const aiVisibleValues = timelinePoints.map((point, index) => (index <= activeMinute ? point.aiQueue : point.naiveQueue));
    const aiFinalValues = timelinePoints.map((point) => point.aiQueue);

    const allValues = [...naiveValues, ...aiFinalValues];
    const maxValue = Math.max(...allValues) * 1.06;
    const minValue = Math.min(...allValues) * 0.9;

    const naive = buildPathGeometry({
      values: naiveValues,
      width,
      height,
      padX,
      padY,
      minValue,
      maxValue
    });

    const aiVisible = buildPathGeometry({
      values: aiVisibleValues,
      width,
      height,
      padX,
      padY,
      minValue,
      maxValue
    });

    const aiFinal = buildPathGeometry({
      values: aiFinalValues,
      width,
      height,
      padX,
      padY,
      minValue,
      maxValue
    });

    const innerWidth = width - padX * 2;
    const innerHeight = height - padY * 2;
    const playheadX = padX + (minuteFloat / Math.max(timelinePoints.length - 1, 1)) * innerWidth;
    const toY = (value: number): number => {
      const normalized = (value - minValue) / Math.max(maxValue - minValue, 1e-9);
      return height - padY - normalized * innerHeight;
    };

    const naivePointY = toY(interpolateSeries(naiveValues, minuteFloat));
    const aiPointY = toY(interpolateSeries(aiVisibleValues, minuteFloat));

    return {
      width,
      height,
      padX,
      padY,
      naive,
      aiVisible,
      aiFinal,
      playheadX,
      naivePointY,
      aiPointY,
      xTicks: timelinePoints.map((point, index) => ({
        minute: point.minute,
        x: padX + (index / Math.max(timelinePoints.length - 1, 1)) * innerWidth
      }))
    };
  }, [activeMinute, minuteFloat, timelinePoints]);

  const beforeBars = useMemo(() => {
    if (timelinePoints.length === 0) {
      return [];
    }
    const bars = timelinePoints.slice(0, APPLY_MINUTE + 1).map((point) => point.naiveQueue);
    const scale = Math.max(...bars, 1);
    return bars.map((value) => (value / scale) * 100);
  }, [timelinePoints]);

  const afterBars = useMemo(() => {
    if (timelinePoints.length === 0) {
      return [];
    }
    const bars = timelinePoints.slice(APPLY_MINUTE).map((point) => point.aiQueue);
    const scale = Math.max(...bars, 1);
    return bars.map((value) => (value / scale) * 100);
  }, [timelinePoints]);

  const phaseLabel = activeMinute < APPLY_MINUTE
    ? "Bias builds in the queue"
    : activeMinute === APPLY_MINUTE
      ? "AI correction applied"
      : activeMinute >= TIMELINE_MINUTES - 1
        ? "Queue stabilized"
        : "Queue stabilizing";

  const storyLine = "AI detects bias in observed policy logs and automatically corrects the action that stabilizes incident load minute by minute.";

  const metricAnimationKey = `${results.dr?.artifact_version ?? "none"}|${replayTick}`;
  const animatedChangedSegments = useAnimatedNumber(score?.changedSegments ?? 0, `changes|${metricAnimationKey}`);
  const animatedIncidentsAvoided = useAnimatedNumber(score?.incidentsAvoidedPer10k ?? 0, `incidents-avoided|${metricAnimationKey}`);
  const animatedSuccessGain = useAnimatedNumber(score?.successGainPer10k ?? 0, `success-gain|${metricAnimationKey}`);

  const recommendationLine = focusDecision
    ? focusDecision.naivePick === focusDecision.aiPick
      ? "AI recommendation: keep the current policy; no corrective switch is needed."
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

      {score && results.dr && focusDecision && timelineGeometry ? (
        <section className="result-panel" data-testid="results-block">
          <section className="narrative-canvas" data-testid="narrative-canvas">
            <div className="story-strip" data-testid="story-strip">
              <article className="story-node problem" data-testid="scene-problem">
                <p>Observed drift</p>
                <div className="micro-bars">
                  {beforeBars.map((bar, index) => (
                    <i key={`before-${index}`} style={{ height: `${20 + bar * 0.78}%` }} />
                  ))}
                </div>
              </article>

              <article className="story-node ai" data-testid="scene-ai">
                <p>AI correction</p>
                <div className="policy-orbit" data-testid="policy-orbit">
                  <div className="orbit-slots">
                    {focusDecision.levels.map((level) => (
                      <span key={`slot-${level}`}>{policyLevelName(level)}</span>
                    ))}
                  </div>
                  <i
                    className="orbit-link"
                    style={{
                      left: `${Math.min(fromPct, toPct)}%`,
                      width: `${Math.max(5, Math.abs(toPct - fromPct))}%`,
                      transform: `scaleX(${0.2 + activationProgress * 0.8})`,
                      transformOrigin: fromPct <= toPct ? "left center" : "right center"
                    }}
                  />
                  <i className="orbit-node naive" style={{ left: `${fromPct}%` }} />
                  <i className="orbit-node ai" style={{ left: `${tokenPct}%` }} />
                </div>
              </article>

              <article className="story-node value" data-testid="scene-value">
                <p>Stabilized queue</p>
                <div className="micro-bars calm">
                  {afterBars.map((bar, index) => (
                    <i key={`after-${index}`} style={{ height: `${20 + bar * 0.78}%` }} />
                  ))}
                </div>
              </article>
            </div>

            <div className="timeline-canvas" data-testid="timeline-canvas">
              <div className="timeline-phase" data-testid="timeline-phase">{`${phaseLabel} • minute ${String(activeMinute).padStart(2, "0")}`}</div>
              <svg
                className="timeline-svg"
                viewBox={`0 0 ${timelineGeometry.width} ${timelineGeometry.height}`}
                role="img"
                aria-label="Minute-by-minute queue stabilization"
              >
                <defs>
                  <linearGradient id="aiArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(5,150,105,0.30)" />
                    <stop offset="100%" stopColor="rgba(5,150,105,0.03)" />
                  </linearGradient>
                </defs>

                {timelineGeometry.xTicks.map((tick) => (
                  <line
                    key={`tick-${tick.minute}`}
                    x1={tick.x}
                    y1={timelineGeometry.padY}
                    x2={tick.x}
                    y2={timelineGeometry.height - timelineGeometry.padY}
                    className={`tick ${tick.minute === APPLY_MINUTE ? "apply" : ""}`}
                  />
                ))}

                <path d={timelineGeometry.aiFinal.areaPath} className="area-ai" />
                <path d={timelineGeometry.naive.linePath} className="line-naive" data-testid="line-naive" />
                <path d={timelineGeometry.aiVisible.linePath} className="line-ai" data-testid="line-ai" />

                <line
                  x1={timelineGeometry.playheadX}
                  y1={timelineGeometry.padY}
                  x2={timelineGeometry.playheadX}
                  y2={timelineGeometry.height - timelineGeometry.padY}
                  className="playhead"
                  data-testid="timeline-playhead"
                />

                <circle cx={timelineGeometry.playheadX} cy={timelineGeometry.naivePointY} r="5" className="dot-naive" />
                <circle cx={timelineGeometry.playheadX} cy={timelineGeometry.aiPointY} r="5" className="dot-ai" />
              </svg>

              <div className="line-legend" data-testid="line-legend">
                <span><i className="legend-dot naive" />Observed queue</span>
                <span><i className="legend-dot ai" />Queue after AI correction</span>
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
