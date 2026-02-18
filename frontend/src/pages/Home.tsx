import { useCallback, useMemo, useState } from "react";
import {
  ApiError,
  Objective,
  RecommendResponse,
  SegmentBy,
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

interface SegmentMove {
  segment: string;
  naiveLevel: number;
  drLevel: number;
  delta: number;
}

const DEFAULT_MAX_POLICY_LEVEL = 3;

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

function computeMoves(naive: RecommendResponse, dr: RecommendResponse): SegmentMove[] {
  const naiveMap = new Map(naive.segments.map((segment) => [segment.segment, segment]));

  return dr.segments
    .map((segment): SegmentMove | null => {
      const before = naiveMap.get(segment.segment);
      if (!before) {
        return null;
      }
      return {
        segment: segment.segment,
        naiveLevel: before.recommended_policy_level,
        drLevel: segment.recommended_policy_level,
        delta: segment.recommended_policy_level - before.recommended_policy_level
      };
    })
    .filter((move): move is SegmentMove => move !== null && move.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function buildRecommendationLine(segmentBy: SegmentBy, naive: RecommendResponse, dr: RecommendResponse): string {
  const moves = computeMoves(naive, dr);
  if (moves.length === 0) {
    const global = dr.segments[0];
    if (!global) {
      return "No policy change detected.";
    }
    return `Keep guardrail level ${global.recommended_policy_level}; bias adjustment confirms the current policy.`;
  }

  const down = moves.filter((move) => move.delta < 0).length;
  const up = moves.filter((move) => move.delta > 0).length;
  const top = moves
    .slice(0, 2)
    .map((move) => `${move.segment}: L${move.naiveLevel} -> L${move.drLevel}`)
    .join(" | ");

  if (segmentBy === "none") {
    const naiveGlobal = naive.segments[0]?.recommended_policy_level;
    const drGlobal = dr.segments[0]?.recommended_policy_level;
    return `Switch global guardrail from L${naiveGlobal} to L${drGlobal} after bias adjustment.`;
  }

  return `Bias-adjusted policy rebalances guardrails (${down} segment${down === 1 ? "" : "s"} down, ${up} up). ${top}`;
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("task_success");
  const [maxPolicyLevel, setMaxPolicyLevel] = useState<number>(DEFAULT_MAX_POLICY_LEVEL);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("prompt_risk");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const hasResults = Boolean(results.naive && results.dr);
  const appliedPolicy = results.dr ?? null;

  const score = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naive = rollupMethod(results.naive);
    const dr = rollupMethod(results.dr);

    const objectiveLift = objective === "task_success" ? dr.successes - naive.successes : dr.safeValue - naive.safeValue;
    const objectiveLabel = objective === "task_success" ? "Task success lift" : "Safe-value lift";

    return {
      objectiveLift,
      objectiveLabel,
      incidentsAvoided: naive.incidents - dr.incidents,
      latencyDelta: dr.latency - naive.latency,
      avgPolicyDelta: dr.avgPolicyLevel - naive.avgPolicyLevel
    };
  }, [objective, results.dr, results.naive]);

  const recommendationLine = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }
    return buildRecommendationLine(segmentBy, results.naive, results.dr);
  }, [segmentBy, results.dr, results.naive]);

  const handleGenerate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

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
      setLoading(false);
    }
  }, [maxPolicyLevel, objective, segmentBy]);

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">EdgeAlign-DR</p>
        <h1>On-device guardrail policy optimizer</h1>
        <p className="hero-copy">
          Problem: historical logs assign stricter guardrails to risky prompts. The bias-adjusted policy learns what should
          actually run in production.
        </p>
      </header>

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
        <p className="loading-line" data-testid="loading-line">
          Computing naive vs bias-adjusted policy...
        </p>
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
              <p>{score.objectiveLabel} (per 10k)</p>
              <strong>{signed(score.objectiveLift, 1)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incident">
              <p>Incidents avoided (per 10k)</p>
              <strong>{signed(score.incidentsAvoided, 1)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-latency">
              <p>Latency change (ms)</p>
              <strong>{signed(score.latencyDelta, 1)}</strong>
            </article>
          </div>

          <p className="result-footnote" data-testid="result-footnote">
            Average policy level shift vs naive: {signed(score.avgPolicyDelta, 2)}.
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
          <p>Run once to generate the production policy recommendation.</p>
        </section>
      )}
    </main>
  );
}
