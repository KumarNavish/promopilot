import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  Method,
  Objective,
  RecommendResponse,
  SegmentBy,
  recommendPolicy
} from "../api/client";
import { BeforeAfterStrip } from "../components/BeforeAfterStrip";
import { Controls } from "../components/Controls";
import { DoseResponseChart } from "../components/DoseResponseChart";
import { PolicyCard } from "../components/PolicyCard";
import { TogglePill } from "../components/TogglePill";

interface UiError {
  message: string;
  requestId?: string;
}

const DEFAULT_MAX_DISCOUNT = 15;

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
  link.download = `promopilot-policy-${response.method_used}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function summarizeComparison(naive: RecommendResponse, dr: RecommendResponse, objective: Objective): string {
  const totalBookings = (response: RecommendResponse): number =>
    response.segments.reduce((acc, segment) => acc + segment.expected_bookings_per_10k, 0);
  const totalNetValue = (response: RecommendResponse): number =>
    response.segments.reduce((acc, segment) => acc + segment.expected_net_value_per_10k, 0);

  const avgDiscount = (response: RecommendResponse): number =>
    response.segments.reduce((acc, segment) => acc + segment.recommended_discount_pct, 0) /
    Math.max(response.segments.length, 1);

  const primaryDelta =
    objective === "bookings"
      ? totalBookings(dr) - totalBookings(naive)
      : totalNetValue(dr) - totalNetValue(naive);
  const bookingsDelta = totalBookings(dr) - totalBookings(naive);
  const netValueDelta = totalNetValue(dr) - totalNetValue(naive);
  const discountDelta = avgDiscount(dr) - avgDiscount(naive);
  const primaryLabel = objective === "bookings" ? "bookings" : "net value";

  return [
    `Bias-adjusted policy vs naive: ${primaryDelta >= 0 ? "+" : ""}${primaryDelta.toFixed(1)} ${primaryLabel}.`,
    `Bookings ${bookingsDelta >= 0 ? "+" : ""}${bookingsDelta.toFixed(1)} per 10k.`,
    `Net value ${netValueDelta >= 0 ? "+" : ""}${netValueDelta.toFixed(0)} per 10k.`,
    `Avg discount ${discountDelta >= 0 ? "+" : ""}${discountDelta.toFixed(1)} pp.`
  ].join(" ");
}

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const sumBookings = response.segments.reduce((acc, segment) => acc + segment.expected_bookings_per_10k, 0);
  const sumNetValue = response.segments.reduce((acc, segment) => acc + segment.expected_net_value_per_10k, 0);
  const sumDiscount = response.segments.reduce((acc, segment) => acc + segment.recommended_discount_pct, 0);

  return {
    bookings: sumBookings / count,
    netValue: sumNetValue / count,
    avgDiscount: sumDiscount / count
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("bookings");
  const [maxDiscountPct, setMaxDiscountPct] = useState<number>(DEFAULT_MAX_DISCOUNT);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("none");
  const [activeMethod, setActiveMethod] = useState<Method>("dr");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Partial<Record<Method, RecommendResponse>>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [hasAutoRun, setHasAutoRun] = useState(false);

  const hasResults = Boolean(results.naive || results.dr);
  const activeResponse = results[activeMethod] ?? results.dr ?? results.naive ?? null;

  const comparisonText = useMemo(() => {
    if (results.naive && results.dr) {
      return summarizeComparison(results.naive, results.dr, objective);
    }
    return "";
  }, [objective, results.dr, results.naive]);

  const scorecard = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naive = rollupMethod(results.naive);
    const dr = rollupMethod(results.dr);
    return {
      naive,
      dr,
      bookingsDelta: dr.bookings - naive.bookings,
      netValueDelta: dr.netValue - naive.netValue,
      discountDelta: dr.avgDiscount - naive.avgDiscount
    };
  }, [results.dr, results.naive]);

  const wowHeadline = useMemo(() => {
    if (!scorecard) {
      return "";
    }

    const objectiveDelta = objective === "bookings" ? scorecard.bookingsDelta : scorecard.netValueDelta;
    const objectiveLabel = objective === "bookings" ? "bookings" : "net value";
    const naiveOverDiscount = scorecard.naive.avgDiscount - scorecard.dr.avgDiscount;

    if (naiveOverDiscount > 0 && objectiveDelta >= 0) {
      return `Bias-adjusted wins: ${signed(objectiveDelta, objective === "bookings" ? 1 : 0)} ${objectiveLabel} while cutting avg discount by ${naiveOverDiscount.toFixed(
        1
      )} pp.`;
    }

    return `Bias-adjusted shifts outcome by ${signed(objectiveDelta, objective === "bookings" ? 1 : 0)} ${objectiveLabel} vs naive.`;
  }, [objective, scorecard]);

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
      setActiveMethod("dr");
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

  useEffect(() => {
    if (hasAutoRun) {
      return;
    }

    setHasAutoRun(true);
    void handleGenerate();
  }, [handleGenerate, hasAutoRun]);

  return (
    <main className="page-shell">
      <header className="hero panel">
        <div className="hero-copy-block">
          <p className="eyebrow">PromoPilot</p>
          <h1>Counterfactual Discount Optimizer</h1>
          <p className="hero-copy">One click shows how naive discounting burns margin and how bias-adjusted policy fixes it.</p>
        </div>
        <div className="hero-context">
          <p>
            <strong>Problem</strong> Discounts were historically targeted to higher-intent users, so observed conversion
            overstates the value of bigger discounts.
          </p>
          <p>
            <strong>Method</strong> Run naive observed policy and counterfactual bias-adjusted policy side by side on the
            same objective and constraint.
          </p>
          <p>
            <strong>Why better</strong> Use the decision signal below to see incremental value and discount efficiency in
            seconds.
          </p>
        </div>
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

      {loading && !hasResults ? <p className="loading-line">Running first simulation for you...</p> : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults ? (
        <section className="results-stack" data-testid="results-block">
          {scorecard ? (
            <section className="panel wow-panel" data-testid="wow-panel">
              <p className="eyebrow">Decision Signal</p>
              <h2>{wowHeadline}</h2>
              <p className="wow-subtitle">
                Compare methods on the same segment setup and max discount. Metrics shown are mean expected impact per
                segment cohort of 10k users.
              </p>
              <div className="wow-metrics">
                <article>
                  <p className="metric-label">Bookings delta (DR - Naive)</p>
                  <p className="metric-value">{signed(scorecard.bookingsDelta)}</p>
                </article>
                <article>
                  <p className="metric-label">Net value delta (DR - Naive)</p>
                  <p className="metric-value">{signed(scorecard.netValueDelta, 0)}</p>
                </article>
                <article>
                  <p className="metric-label">Avg discount delta (DR - Naive)</p>
                  <p className="metric-value">{signed(scorecard.discountDelta)}</p>
                </article>
              </div>
              <div className="method-summary-grid">
                <article>
                  <p className="narrative-title">Naive observed</p>
                  <p>
                    Bookings {formatInteger(scorecard.naive.bookings)} | Net value {formatInteger(scorecard.naive.netValue)} |
                    Avg discount {scorecard.naive.avgDiscount.toFixed(1)}%
                  </p>
                </article>
                <article>
                  <p className="narrative-title">Bias-adjusted</p>
                  <p>
                    Bookings {formatInteger(scorecard.dr.bookings)} | Net value {formatInteger(scorecard.dr.netValue)} | Avg
                    discount {scorecard.dr.avgDiscount.toFixed(1)}%
                  </p>
                </article>
              </div>
            </section>
          ) : null}

          {comparisonText ? <p className="comparison-banner">{comparisonText}</p> : null}

          <div className="cards-grid">
            {results.naive ? (
              <PolicyCard
                method="naive"
                response={results.naive}
                objective={objective}
                highlighted={activeMethod === "naive"}
              />
            ) : null}
            {results.dr ? (
              <PolicyCard
                method="dr"
                response={results.dr}
                objective={objective}
                highlighted={activeMethod === "dr"}
              />
            ) : null}
          </div>

          <div className="row-actions">
            <TogglePill value={activeMethod} onChange={setActiveMethod} />
            <button
              type="button"
              className="button-secondary"
              onClick={() => exportPolicy(activeResponse)}
              data-testid="export-json"
              disabled={!activeResponse}
            >
              Export policy JSON
            </button>
          </div>

          {scorecard ? <BeforeAfterStrip objective={objective} naive={scorecard.naive} dr={scorecard.dr} /> : null}

          {activeResponse ? (
            <DoseResponseChart objective={objective} doseResponse={activeResponse.dose_response} />
          ) : null}
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">No policy generated yet</p>
          <p>Generate policy to compare naive and bias-adjusted recommendations.</p>
        </section>
      )}

      <footer className="footer-note">
        Methodology available in API docs: propensity + outcome modeling with doubly robust estimation.
      </footer>
    </main>
  );
}
