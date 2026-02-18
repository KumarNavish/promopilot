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
const MONTHLY_TRAFFIC_BASE = 1_000_000;

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
  bookingsDelta: number;
  netValueDelta: number;
}

interface DecisionSummary {
  verdict: string;
  supportingLine: string;
  objectiveLabel: string;
  objectiveDelta: number;
  objectiveDigits: number;
  discountDelta: number;
  annualNetValueDelta: number;
  changedSegments: number;
  totalSegments: number;
  topMoves: SegmentMove[];
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
        bookingsDelta: segment.expected_bookings_per_10k - before.expected_bookings_per_10k,
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
  const [activeMethod, setActiveMethod] = useState<Method>("dr");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Partial<Record<Method, RecommendResponse>>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [hasAutoRun, setHasAutoRun] = useState(false);

  const hasResults = Boolean(results.naive || results.dr);
  const activeResponse = results[activeMethod] ?? results.dr ?? results.naive ?? null;

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

  const moves = useMemo(() => {
    if (!results.naive || !results.dr) {
      return [];
    }
    return computeSegmentMoves(results.naive, results.dr);
  }, [results.dr, results.naive]);

  const decision = useMemo((): DecisionSummary | null => {
    if (!scorecard) {
      return null;
    }

    const objectiveDelta = objective === "bookings" ? scorecard.bookingsDelta : scorecard.netValueDelta;
    const objectiveLabel = objective === "bookings" ? "bookings" : "net value";
    const objectiveDigits = objective === "bookings" ? 1 : 0;

    const annualNetValueDelta = (scorecard.netValueDelta * MONTHLY_TRAFFIC_BASE * 12) / 10_000;
    const changedSegments = moves.filter((move) => move.discountDelta !== 0).length;
    const discountReduced = scorecard.discountDelta <= 0;
    const objectiveImproved = objectiveDelta >= 0;

    let verdict = "Run guarded rollout.";
    let supportingLine =
      "Bias-adjusted policy improves spend efficiency but objective gains are mixed. Use traffic guardrails.";

    if (objectiveImproved && discountReduced) {
      verdict = "Ship bias-adjusted policy now.";
      supportingLine = `${signed(objectiveDelta, objectiveDigits)} ${objectiveLabel} per 10k while lowering average discount by ${Math.abs(
        scorecard.discountDelta
      ).toFixed(1)} pp.`;
    } else if (objectiveImproved && !discountReduced) {
      verdict = "Ship bias-adjusted policy with discount cap monitoring.";
      supportingLine = `${signed(objectiveDelta, objectiveDigits)} ${objectiveLabel} per 10k, but average discount rises ${signed(
        scorecard.discountDelta
      )} pp.`;
    } else if (!objectiveImproved && discountReduced && scorecard.netValueDelta > 0) {
      verdict = "Run profitability-first rollout.";
      supportingLine = `Objective dips ${signed(objectiveDelta, objectiveDigits)}, but net value improves with lower discount pressure.`;
    }

    return {
      verdict,
      supportingLine,
      objectiveLabel,
      objectiveDelta,
      objectiveDigits,
      discountDelta: scorecard.discountDelta,
      annualNetValueDelta,
      changedSegments,
      totalSegments: Math.max(moves.length, 1),
      topMoves: moves.slice(0, 3)
    };
  }, [moves, objective, scorecard]);

  const comparisonText = useMemo(() => {
    if (results.naive && results.dr) {
      return summarizeComparison(results.naive, results.dr, objective);
    }
    return "";
  }, [objective, results.dr, results.naive]);

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
      <header className="hero panel minimal-hero">
        <p className="eyebrow">PromoPilot</p>
        <h1>Promotion Policy Decision Simulator</h1>
        <p className="hero-copy">
          Pick objective and constraints. Get one recommendation: what policy to launch and expected business impact.
        </p>
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

      {hasResults && decision ? (
        <section className="results-stack" data-testid="results-block">
          <section className="panel recommendation-panel launch-panel" data-testid="recommendation-panel">
            <p className="eyebrow">Launch Recommendation</p>
            <h2>{decision.verdict}</h2>
            <p className="recommendation-copy">{decision.supportingLine}</p>
            <p className="recommendation-copy">
              Scope: <strong>{segmentBy === "none" ? "all users" : segmentBy}</strong>, max discount <strong>{maxDiscountPct}%</strong>.
            </p>

            <div className="recommendation-metrics">
              <article>
                <p>Objective shift per 10k</p>
                <strong>{signed(decision.objectiveDelta, decision.objectiveDigits)}</strong>
              </article>
              <article>
                <p>Average discount shift (DR - Naive)</p>
                <strong>{signed(decision.discountDelta)} pp</strong>
              </article>
              <article>
                <p>Annual net value impact (1M users/month)</p>
                <strong>{formatCurrency(decision.annualNetValueDelta)}</strong>
              </article>
              <article>
                <p>Segments changed</p>
                <strong>
                  {decision.changedSegments}/{decision.totalSegments}
                </strong>
              </article>
            </div>
          </section>

          {decision.topMoves.length > 0 ? (
            <section className="panel shift-panel" data-testid="shift-panel">
              <div className="shift-head">
                <h3>Top policy moves</h3>
                <p>Largest segment-level discount reallocations.</p>
              </div>
              <div className="moves-grid">
                {decision.topMoves.map((move) => (
                  <article key={`move-${move.segment}`} className="move-card">
                    <p className="move-segment">{move.segment}</p>
                    <p className="move-main">
                      {move.naiveDiscount}% to {move.drDiscount}% ({signed(move.discountDelta)} pp)
                    </p>
                    <p className="move-meta">
                      Bookings {signed(move.bookingsDelta)} | Net value {signed(move.netValueDelta, 0)}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <div className="row-actions">
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

          <details className="panel details-panel" data-testid="details-panel">
            <summary>Technical details (optional)</summary>
            <div className="details-content">
              {comparisonText ? <p className="comparison-banner">{comparisonText}</p> : null}

              <TogglePill value={activeMethod} onChange={setActiveMethod} />

              {scorecard ? <BeforeAfterStrip objective={objective} naive={scorecard.naive} dr={scorecard.dr} /> : null}

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

              {activeResponse ? (
                <DoseResponseChart objective={objective} doseResponse={activeResponse.dose_response} />
              ) : null}
            </div>
          </details>
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">No policy generated yet</p>
          <p>Generate policy to get a launch recommendation.</p>
        </section>
      )}

      <footer className="footer-note">Methodology: propensity + outcome modeling with doubly robust estimation.</footer>
    </main>
  );
}
