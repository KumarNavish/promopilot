import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  Objective,
  RecommendResponse,
  SegmentBy,
  SegmentRecommendation,
  recommendPolicy
} from "../api/client";
import { Controls } from "../components/Controls";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  safeValue: number;
  incidents: number;
  latency: number;
  avgPolicyLevel: number;
}

const DEFAULT_MAX_POLICY_LEVEL = 3;
const RUN_STAGES = [
  "Reading historical on-device traffic",
  "Removing targeting bias in logged policies",
  "Selecting best policy level for each segment"
] as const;

function exportPolicy(response: RecommendResponse | null): void {
  if (!response) {
    return;
  }

  const blob = new Blob([JSON.stringify(response, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "edgealign-policy.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const successes = response.segments.reduce((acc, segment) => acc + segment.expected_successes_per_10k, 0) / count;
  const safeValue = response.segments.reduce((acc, segment) => acc + segment.expected_safe_value_per_10k, 0) / count;
  const incidents = response.segments.reduce((acc, segment) => acc + segment.expected_incidents_per_10k, 0) / count;
  const latency = response.segments.reduce((acc, segment) => acc + segment.expected_latency_ms, 0) / count;
  const avgPolicyLevel = response.segments.reduce((acc, segment) => acc + segment.recommended_policy_level, 0) / count;

  return {
    successes,
    safeValue,
    incidents,
    latency,
    avgPolicyLevel
  };
}

function findRiskLevel(segments: SegmentRecommendation[], risk: "low" | "medium" | "high"): number | null {
  const target = segments.find((segment) => segment.segment.toLowerCase() === `risk=${risk}`);
  return target ? target.recommended_policy_level : null;
}

function buildPolicyLine(segmentBy: SegmentBy, dr: RecommendResponse): string {
  if (dr.segments.length === 0) {
    return "No policy recommendation could be generated.";
  }

  if (segmentBy === "none") {
    return `Recommendation: run guardrail level L${dr.segments[0].recommended_policy_level} for all traffic.`;
  }

  if (segmentBy === "prompt_risk") {
    const low = findRiskLevel(dr.segments, "low");
    const medium = findRiskLevel(dr.segments, "medium");
    const high = findRiskLevel(dr.segments, "high");
    if (low !== null && medium !== null && high !== null) {
      return `Recommendation: Low-risk L${low}, Medium-risk L${medium}, High-risk L${high}.`;
    }
  }

  const top = dr.segments
    .slice(0, 3)
    .map((segment) => `${segment.segment}: L${segment.recommended_policy_level}`)
    .join(" | ");
  return `Recommendation: ${top}.`;
}

function buildWhyLine(
  objective: Objective,
  naive: MethodRollup,
  dr: MethodRollup,
  objectiveLift: number,
  incidentsAvoided: number,
  latencyDelta: number
): string {
  const objectiveName = objective === "task_success" ? "successful responses" : "safety-adjusted value";
  return `Why this is better: naive would run average level ${naive.avgPolicyLevel.toFixed(2)}, while bias-adjusted runs ${dr.avgPolicyLevel.toFixed(2)} and improves ${objectiveName} by ${signed(objectiveLift, 1)} per 10k, with incidents ${signed(incidentsAvoided, 1)} lower and latency ${signed(latencyDelta, 1)} ms.`;
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("task_success");
  const [maxPolicyLevel, setMaxPolicyLevel] = useState<number>(DEFAULT_MAX_POLICY_LEVEL);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("prompt_risk");
  const [loading, setLoading] = useState(false);
  const [runStage, setRunStage] = useState(0);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const stageTimerRef = useRef<number | null>(null);

  const hasResults = Boolean(results.naive && results.dr);
  const appliedPolicy = results.dr ?? null;

  useEffect(() => {
    return () => {
      if (stageTimerRef.current !== null) {
        window.clearInterval(stageTimerRef.current);
      }
    };
  }, []);

  const score = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naive = rollupMethod(results.naive);
    const dr = rollupMethod(results.dr);

    const objectiveLift = objective === "task_success" ? dr.successes - naive.successes : dr.safeValue - naive.safeValue;
    const objectiveLabel = objective === "task_success" ? "Successful responses" : "Safety-adjusted value";
    const incidentsAvoided = naive.incidents - dr.incidents;
    const latencyDelta = dr.latency - naive.latency;

    return {
      objectiveLift,
      objectiveLabel,
      incidentsAvoided,
      latencyDelta,
      whyLine: buildWhyLine(objective, naive, dr, objectiveLift, incidentsAvoided, latencyDelta)
    };
  }, [objective, results.dr, results.naive]);

  const recommendationLine = useMemo(() => {
    if (!results.dr) {
      return null;
    }
    return buildPolicyLine(segmentBy, results.dr);
  }, [segmentBy, results.dr]);

  const handleGenerate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setRunStage(0);

    if (stageTimerRef.current !== null) {
      window.clearInterval(stageTimerRef.current);
    }

    stageTimerRef.current = window.setInterval(() => {
      setRunStage((prev) => (prev < RUN_STAGES.length - 1 ? prev + 1 : prev));
    }, 850);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective,
          max_policy_level: maxPolicyLevel,
          segment_by: segmentBy,
          method: "naive"
        }),
        recommendPolicy({
          objective,
          max_policy_level: maxPolicyLevel,
          segment_by: segmentBy,
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
      if (stageTimerRef.current !== null) {
        window.clearInterval(stageTimerRef.current);
        stageTimerRef.current = null;
      }
      setRunStage(RUN_STAGES.length - 1);
      setLoading(false);
    }
  }, [maxPolicyLevel, objective, segmentBy]);

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">EdgeAlign-DR</p>
        <h1>Which guardrail policy should we ship?</h1>
        <p className="hero-copy">
          This tool turns biased historical logs into a production recommendation. It automatically decides where to run
          stricter vs lighter guardrails so you improve outcomes without guessing.
        </p>
      </header>

      <section className="panel story-panel" data-testid="story-panel">
        <p className="story-title">What happens when you click "Generate policy"</p>
        <div className="story-steps" role="list" aria-label="Process overview">
          <p role="listitem">1. Read real logged traffic and outcomes.</p>
          <p role="listitem">2. Correct the bias from targeted policy assignment.</p>
          <p role="listitem">3. Return the policy you can directly ship.</p>
        </div>
      </section>

      <section className="panel controls-wrap" data-testid="assumptions-panel">
        <Controls
          objective={objective}
          maxPolicyLevel={maxPolicyLevel}
          segmentBy={segmentBy}
          onObjectiveChange={setObjective}
          onMaxPolicyLevelChange={setMaxPolicyLevel}
          onSegmentByChange={setSegmentBy}
          onGenerate={handleGenerate}
          loading={loading}
          hasResults={hasResults}
        />
      </section>

      {loading ? (
        <section className="panel run-panel" data-testid="run-panel">
          <p className="run-title">Running automatic analysis</p>
          <ul className="run-steps">
            {RUN_STAGES.map((stage, index) => {
              const status = index < runStage ? "done" : index === runStage ? "active" : "pending";
              return (
                <li key={stage} className={`run-step ${status}`}>
                  {stage}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && score && recommendationLine ? (
        <section className="panel result-panel" data-testid="results-block">
          <p className="recommendation-line" data-testid="recommendation-line">
            {recommendationLine}
          </p>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-objective">
              <p>{score.objectiveLabel} gain (per 10k)</p>
              <strong>{signed(score.objectiveLift, 1)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incident">
              <p>Safety incidents avoided (per 10k)</p>
              <strong>{signed(score.incidentsAvoided, 1)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-latency">
              <p>Latency change (ms)</p>
              <strong>{signed(score.latencyDelta, 1)}</strong>
            </article>
          </div>

          <p className="result-footnote" data-testid="result-footnote">
            {score.whyLine}
          </p>

          <button
            type="button"
            className="button-primary"
            onClick={() => exportPolicy(appliedPolicy)}
            data-testid="apply-policy"
            disabled={!appliedPolicy}
          >
            Apply policy (export JSON)
          </button>
        </section>
      ) : (
        <section className="panel empty-state">
          <p>Ready. Run once to get a ship-ready policy and KPI impact.</p>
        </section>
      )}
    </main>
  );
}
