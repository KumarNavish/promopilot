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
  const total = (response: RecommendResponse): number =>
    response.segments.reduce((acc, segment) => {
      return acc + (objective === "bookings" ? segment.expected_bookings_per_10k : segment.expected_net_value_per_10k);
    }, 0);

  const avgDiscount = (response: RecommendResponse): number =>
    response.segments.reduce((acc, segment) => acc + segment.recommended_discount_pct, 0) /
    Math.max(response.segments.length, 1);

  const drTotal = total(dr);
  const naiveTotal = total(naive);
  const delta = drTotal - naiveTotal;
  const discountDelta = avgDiscount(dr) - avgDiscount(naive);

  return `Counterfactual vs Naive: ${delta.toFixed(1)} ${objective === "bookings" ? "bookings" : "value"} and ${discountDelta.toFixed(
    1
  )}% avg discount.`;
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
      <header className="hero">
        <div>
          <p className="eyebrow">PromoPilot</p>
          <h1>Counterfactual Discount Optimizer</h1>
          <p className="hero-copy">Policy recommendations per 10k users from logged promotion data.</p>
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
      ) : null}

      <footer className="footer-note">
        Methodology available in API docs: propensity + outcome modeling with doubly robust estimation.
      </footer>
    </main>
  );
}
