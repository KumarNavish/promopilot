import { useMemo, useState } from "react";
import {
  ApiError,
  Method,
  Objective,
  RecommendResponse,
  SegmentBy,
  recommendPolicy
} from "../api/client";
import { Controls } from "../components/Controls";
import { DoseResponseChart } from "../components/DoseResponseChart";
import { PolicyCard } from "../components/PolicyCard";
import { TogglePill } from "../components/TogglePill";

interface UiError {
  message: string;
  requestId?: string;
}

const DEFAULT_MAX_DISCOUNT = 15;

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

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("bookings");
  const [maxDiscountPct, setMaxDiscountPct] = useState<number>(DEFAULT_MAX_DISCOUNT);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("none");
  const [activeMethod, setActiveMethod] = useState<Method>("dr");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Partial<Record<Method, RecommendResponse>>>({});
  const [error, setError] = useState<UiError | null>(null);

  const hasResults = Boolean(results.naive || results.dr);
  const activeResponse = results[activeMethod] ?? results.dr ?? results.naive ?? null;

  const comparisonText = useMemo(() => {
    if (results.naive && results.dr) {
      return summarizeComparison(results.naive, results.dr, objective);
    }
    return "";
  }, [objective, results.dr, results.naive]);

  async function handleGenerate(): Promise<void> {
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
  }

  return (
    <main className="page-shell">
      <header className="hero panel">
        <div className="hero-copy-block">
          <p className="eyebrow">PromoPilot</p>
          <h1>Counterfactual Discount Optimizer</h1>
          <p className="hero-copy">
            Choose discounts by segment while avoiding targeting bias from historical promotions.
          </p>
        </div>
        <div className="hero-context">
          <p>
            <strong>Problem</strong> Historical discounts were targeted, so raw conversion can make larger discounts look
            better than they are.
          </p>
          <p>
            <strong>Approach</strong> Compare naive observed outcomes against a bias-adjusted counterfactual policy under
            the same discount cap.
          </p>
          <p>
            <strong>Outcome</strong> Get a policy that protects margin while preserving or improving bookings.
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
      />

      <section className="panel narrative-panel">
        <h2>How to read this demo</h2>
        <div className="narrative-grid">
          <article>
            <p className="narrative-title">1. Set your business target</p>
            <p>Pick bookings or net value, set a max discount cap, and optionally segment your users.</p>
          </article>
          <article>
            <p className="narrative-title">2. Compare two policy choices</p>
            <p>Naive uses raw historical outcomes. Bias-adjusted estimates what each discount would do if assigned fairly.</p>
          </article>
          <article>
            <p className="narrative-title">3. Use the delta as your decision signal</p>
            <p>The hero banner quantifies incremental outcome and discount pressure per 10k users.</p>
          </article>
        </div>
      </section>

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults ? (
        <section className="results-stack" data-testid="results-block">
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

          {activeResponse ? (
            <DoseResponseChart objective={objective} doseResponse={activeResponse.dose_response} />
          ) : null}
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">No policy generated yet</p>
          <p>Select controls above and click Generate policy to compare naive and bias-adjusted recommendations.</p>
        </section>
      )}

      <footer className="footer-note">
        Methodology available in API docs: propensity + outcome modeling with doubly robust estimation.
      </footer>
    </main>
  );
}
