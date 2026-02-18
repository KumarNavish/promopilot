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

const DEFAULT_MAX_DISCOUNT = 15;
const MONTHLY_TRAFFIC_BASE = 1_000_000;

interface MethodRollup {
  bookings: number;
  netValue: number;
  avgDiscount: number;
}

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
  const baselineDiscount = appliedPolicy?.baseline.discount_pct ?? 10;

  const scorecard = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naive = rollupMethod(results.naive);
    const dr = rollupMethod(results.dr);
    const relativeDiscountReduction =
      naive.avgDiscount > 0 ? ((naive.avgDiscount - dr.avgDiscount) / naive.avgDiscount) * 100 : 0;
    const monthlyNetValueDelta = ((dr.netValue - naive.netValue) * MONTHLY_TRAFFIC_BASE) / 10_000;

    return {
      objectiveDelta: objective === "bookings" ? dr.bookings - naive.bookings : dr.netValue - naive.netValue,
      objectiveDigits: objective === "bookings" ? 1 : 0,
      objectiveLabel: objective === "bookings" ? "bookings" : "net value",
      discountDelta: dr.avgDiscount - naive.avgDiscount,
      optimizedAvgDiscount: dr.avgDiscount,
      currentAvgDiscount: naive.avgDiscount,
      monthlyNetValueDelta,
      annualNetValueDelta: monthlyNetValueDelta * 12,
      relativeDiscountReduction
    };
  }, [objective, results.dr, results.naive]);

  const recommendationLine = useMemo(() => {
    if (!scorecard) {
      return "";
    }

    const strategy =
      segmentBy === "none"
        ? "Use one optimized discount policy for all users"
        : `Use optimized discounts by ${segmentBy.replace("_", " ")}`;

    const objectiveDirection = scorecard.objectiveDelta >= 0 ? "increase" : "decrease";
    const objectiveMagnitude = Math.abs(scorecard.objectiveDelta);

    if (scorecard.objectiveDelta >= 0 && scorecard.discountDelta <= 0) {
      return `${strategy}. Expected to ${objectiveDirection} ${scorecard.objectiveLabel} by ${objectiveMagnitude.toFixed(
        scorecard.objectiveDigits
      )} per 10k while reducing discount intensity by ${Math.max(scorecard.relativeDiscountReduction, 0).toFixed(
        0
      )}% (annual net value impact: ${formatCurrency(scorecard.annualNetValueDelta)}).`;
    }

    return `${strategy} with guardrails. Expected ${objectiveDirection} in ${scorecard.objectiveLabel} of ${objectiveMagnitude.toFixed(
      scorecard.objectiveDigits
    )} per 10k and annual net value impact of ${formatCurrency(scorecard.annualNetValueDelta)}.`;
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
        <h1>Promotion Policy Decision</h1>
        <p className="hero-copy">Step 2: click Get recommendation. We compare your current policy against an optimized one.</p>
      </header>

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

      {loading ? (
        <p className="loading-line" data-testid="loading-line">
          Running simulation: current policy vs optimized policy...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && scorecard ? (
        <section className="results-stack" data-testid="results-block">
          <section className="panel compact-result" data-testid="recommendation-panel">
            <p className="recommendation-line" data-testid="recommendation-line">
              {recommendationLine}
            </p>
            <p className="recommendation-context" data-testid="recommendation-context">
              Comparison baseline: current policy at {baselineDiscount}% default discount (observed avg {scorecard.currentAvgDiscount.toFixed(
                1
              )}%) versus optimized avg {scorecard.optimizedAvgDiscount.toFixed(1)}%.
            </p>

            <div className="compact-kpis">
              <article>
                <p>Primary objective lift</p>
                <strong data-testid="kpi-objective">{signed(scorecard.objectiveDelta, scorecard.objectiveDigits)}</strong>
              </article>
              <article>
                <p>Discount intensity reduction</p>
                <strong data-testid="kpi-discount">{Math.max(scorecard.relativeDiscountReduction, 0).toFixed(0)}%</strong>
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
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">Ready when you are</p>
          <p>Set your preferences above and click Get recommendation.</p>
        </section>
      )}
    </main>
  );
}
