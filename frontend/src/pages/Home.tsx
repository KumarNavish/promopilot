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
  bookings: number;
  netValue: number;
  avgDiscount: number;
}

interface SegmentMove {
  segment: string;
  naiveDiscount: number;
  drDiscount: number;
  discountDelta: number;
  netValueDelta: number;
}

interface DecisionSummary {
  headline: string;
  support: string;
  scopeLabel: string;
}

const DEFAULT_MAX_DISCOUNT = 15;
const MONTHLY_TRAFFIC_BASE = 1_000_000;

function exportPolicy(response: RecommendResponse | null): void {
  if (!response) {
    return;
  }

  const blob = new Blob([JSON.stringify(response, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "promopilot-applied-policy.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const bookings = response.segments.reduce((acc, segment) => acc + segment.expected_bookings_per_10k, 0) / count;
  const netValue = response.segments.reduce((acc, segment) => acc + segment.expected_net_value_per_10k, 0) / count;
  const avgDiscount = response.segments.reduce((acc, segment) => acc + segment.recommended_discount_pct, 0) / count;

  return { bookings, netValue, avgDiscount };
}

function computeSegmentMoves(naive: RecommendResponse, dr: RecommendResponse): SegmentMove[] {
  const naiveMap = new Map(naive.segments.map((segment) => [segment.segment, segment]));

  return dr.segments
    .map((segment): SegmentMove | null => {
      const before = naiveMap.get(segment.segment);
      if (!before) {
        return null;
      }

      return {
        segment: segment.segment,
        naiveDiscount: before.recommended_discount_pct,
        drDiscount: segment.recommended_discount_pct,
        discountDelta: segment.recommended_discount_pct - before.recommended_discount_pct,
        netValueDelta: segment.expected_net_value_per_10k - before.expected_net_value_per_10k
      };
    })
    .filter((move): move is SegmentMove => Boolean(move))
    .sort((a, b) => Math.abs(b.discountDelta) - Math.abs(a.discountDelta));
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("bookings");
  const [maxDiscountPct, setMaxDiscountPct] = useState<number>(DEFAULT_MAX_DISCOUNT);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("none");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const hasResults = Boolean(results.naive && results.dr);
  const appliedPolicy = results.dr ?? results.naive ?? null;

  const scorecard = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naive = rollupMethod(results.naive);
    const dr = rollupMethod(results.dr);
    const objectiveDelta = objective === "bookings" ? dr.bookings - naive.bookings : dr.netValue - naive.netValue;
    const annualNetValueDelta = ((dr.netValue - naive.netValue) * MONTHLY_TRAFFIC_BASE * 12) / 10_000;

    return {
      objectiveDelta,
      objectiveDigits: objective === "bookings" ? 1 : 0,
      objectiveLabel: objective === "bookings" ? "bookings" : "net value",
      discountDelta: dr.avgDiscount - naive.avgDiscount,
      annualNetValueDelta,
      currentAvgDiscount: naive.avgDiscount,
      optimizedAvgDiscount: dr.avgDiscount
    };
  }, [objective, results.dr, results.naive]);

  const moves = useMemo(() => {
    if (!results.naive || !results.dr) {
      return [];
    }
    return computeSegmentMoves(results.naive, results.dr).slice(0, 3);
  }, [results.dr, results.naive]);

  const decision = useMemo((): DecisionSummary | null => {
    if (!scorecard) {
      return null;
    }

    const scopeLabel = segmentBy === "none" ? "all users" : segmentBy.replace("_", " ");
    const objectiveMagnitude = Math.abs(scorecard.objectiveDelta).toFixed(scorecard.objectiveDigits);

    if (scorecard.objectiveDelta >= 0 && scorecard.discountDelta <= 0) {
      return {
        headline: "Recommendation: switch to optimized discount strategy.",
        support: `For ${scopeLabel}, expected lift is ${objectiveMagnitude} ${scorecard.objectiveLabel} per 10k while average discount drops ${Math.abs(
          scorecard.discountDelta
        ).toFixed(1)} pp. Annual net value impact: ${formatCurrency(scorecard.annualNetValueDelta)}.`,
        scopeLabel
      };
    }

    return {
      headline: "Recommendation: run a controlled rollout of optimized strategy.",
      support: `For ${scopeLabel}, expected impact is ${signed(scorecard.objectiveDelta, scorecard.objectiveDigits)} ${
        scorecard.objectiveLabel
      } per 10k with annual net value impact ${formatCurrency(scorecard.annualNetValueDelta)}.`,
      scopeLabel
    };
  }, [scorecard, segmentBy]);

  const handleGenerate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective,
          max_discount_pct: maxDiscountPct,
          segment_by: segmentBy,
          method: "naive"
        }),
        recommendPolicy({
          objective,
          max_discount_pct: maxDiscountPct,
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
  }, [maxDiscountPct, objective, segmentBy]);

  return (
    <main className="page-shell">
      <header className="hero panel minimal-hero">
        <p className="eyebrow">PromoPilot</p>
        <h1>Should we change our discount strategy?</h1>
        <p className="hero-copy">Pick assumptions, run analysis, then apply the recommended policy.</p>
      </header>

      <details className="panel assumptions-panel" open={!hasResults}>
        <summary data-testid="assumptions-summary">Step 1: set assumptions</summary>
        <div className="assumptions-body">
          <Controls
            objective={objective}
            maxDiscountPct={maxDiscountPct}
            segmentBy={segmentBy}
            onObjectiveChange={setObjective}
            onMaxDiscountChange={setMaxDiscountPct}
            onSegmentByChange={setSegmentBy}
            onGenerate={handleGenerate}
            loading={loading}
            hasResults={hasResults}
          />
        </div>
      </details>

      {loading ? (
        <p className="loading-line" data-testid="loading-line">
          Step 2: comparing current policy versus optimized policy...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && scorecard && decision ? (
        <section className="results-stack" data-testid="results-block">
          <section className="panel compact-result" data-testid="recommendation-panel">
            <p className="recommendation-line" data-testid="recommendation-line">
              {decision.headline}
            </p>
            <p className="recommendation-context" data-testid="recommendation-context">
              {decision.support}
            </p>

            <div className="compact-kpis">
              <article>
                <p>Primary KPI lift (per 10k)</p>
                <strong data-testid="kpi-objective">{signed(scorecard.objectiveDelta, scorecard.objectiveDigits)}</strong>
              </article>
              <article>
                <p>Average discount change</p>
                <strong data-testid="kpi-discount">{signed(scorecard.discountDelta)} pp</strong>
              </article>
              <article>
                <p>Annual net value impact</p>
                <strong data-testid="kpi-net-value">{formatCurrency(scorecard.annualNetValueDelta)}</strong>
              </article>
            </div>

            <button
              type="button"
              className="button-primary"
              onClick={() => exportPolicy(appliedPolicy)}
              data-testid="apply-policy"
              disabled={!appliedPolicy}
            >
              Apply policy
            </button>
          </section>

          <section className="panel move-panel" data-testid="moves-panel">
            <h3>What will change</h3>
            <ul className="simple-list">
              {moves.length > 0 ? (
                moves.map((move) => (
                  <li key={`move-${move.segment}`}>
                    {move.segment}: {move.naiveDiscount}% to {move.drDiscount}% ({signed(move.discountDelta)} pp), net value {signed(
                      move.netValueDelta,
                      0
                    )} per 10k.
                  </li>
                ))
              ) : (
                <li>No segment-level discount changes for these assumptions.</li>
              )}
            </ul>
          </section>
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">Ready to evaluate</p>
          <p>Run the analysis to get a recommendation.</p>
        </section>
      )}
    </main>
  );
}
