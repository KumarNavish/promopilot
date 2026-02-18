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

interface LaunchBrief {
  decisionTone: "ship" | "pilot";
  decisionLine: string;
  supportLine: string;
  objectiveLift: number;
  objectiveDigits: number;
  discountDelta: number;
  annualNetValueDelta: number;
  rolloutSteps: string[];
  guardrails: string[];
}

const DEFAULT_MAX_DISCOUNT = 15;
const MONTHLY_USERS = 1_000_000;
const USERS_BUCKET = 10_000;

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

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const bookings = response.segments.reduce((acc, segment) => acc + segment.expected_bookings_per_10k, 0) / count;
  const netValue = response.segments.reduce((acc, segment) => acc + segment.expected_net_value_per_10k, 0) / count;
  const avgDiscount = response.segments.reduce((acc, segment) => acc + segment.recommended_discount_pct, 0) / count;
  return { bookings, netValue, avgDiscount };
}

function computeTopMove(naive: RecommendResponse, dr: RecommendResponse): SegmentMove | null {
  const naiveMap = new Map(naive.segments.map((segment) => [segment.segment, segment]));

  const moves = dr.segments
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

  return moves[0] ?? null;
}

function buildBrief(
  objective: Objective,
  segmentBy: SegmentBy,
  maxDiscountPct: number,
  objectiveLift: number,
  objectiveDigits: number,
  discountDelta: number,
  annualNetValueDelta: number
): LaunchBrief {
  const scopeLabel = segmentBy === "none" ? "all users" : segmentBy.replace("_", " ");
  const objectiveLabel = objective === "bookings" ? "bookings" : "net value";

  if (objectiveLift >= 0 && discountDelta <= 0) {
    return {
      decisionTone: "ship",
      decisionLine: `Ship optimized discount policy for ${scopeLabel}.`,
      supportLine: `Expected lift: ${signed(objectiveLift, objectiveDigits)} ${objectiveLabel} per 10k while reducing average discount by ${Math.abs(
        discountDelta
      ).toFixed(1)} pp. Annual net value impact: ${formatCurrency(annualNetValueDelta)}.`,
      objectiveLift,
      objectiveDigits,
      discountDelta,
      annualNetValueDelta,
      rolloutSteps: [
        "Week 1: 10% traffic exposure with daily monitoring.",
        "Week 2: 50% exposure if guardrails hold.",
        "Week 3: 100% rollout and lock policy."
      ],
      guardrails: [
        "Pause if net value drops below -$500 per 10k for 2 consecutive days.",
        "Pause if booking lift turns negative for 2 consecutive days.",
        "Rollback if average discount exceeds planned cap by more than 1 pp."
      ]
    };
  }

  return {
    decisionTone: "pilot",
    decisionLine: `Run controlled pilot for ${scopeLabel}.`,
    supportLine: `Expected impact: ${signed(objectiveLift, objectiveDigits)} ${objectiveLabel} per 10k and annual net value impact ${formatCurrency(
      annualNetValueDelta
    )}. Validate with guardrails before full rollout.`,
    objectiveLift,
    objectiveDigits,
    discountDelta,
    annualNetValueDelta,
    rolloutSteps: [
      "Week 1-2: 10% traffic pilot.",
      "Week 3: expand to 30% only if metrics stay non-negative.",
      "Week 4: decide full rollout or rollback."
    ],
    guardrails: [
      "Stop pilot if objective KPI drops for 3 days in a row.",
      "Stop pilot if net value delta becomes negative beyond tolerance.",
      `Never exceed max discount cap of ${maxDiscountPct}%.`
    ]
  };
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("bookings");
  const [maxDiscountPct, setMaxDiscountPct] = useState<number>(DEFAULT_MAX_DISCOUNT);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("none");
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
    const objectiveLift = objective === "bookings" ? dr.bookings - naive.bookings : dr.netValue - naive.netValue;
    const objectiveDigits = objective === "bookings" ? 1 : 0;
    const discountDelta = dr.avgDiscount - naive.avgDiscount;
    const annualNetValueDelta = ((dr.netValue - naive.netValue) * MONTHLY_USERS * 12) / USERS_BUCKET;

    return {
      objectiveLift,
      objectiveDigits,
      discountDelta,
      annualNetValueDelta,
      currentAvgDiscount: naive.avgDiscount,
      optimizedAvgDiscount: dr.avgDiscount
    };
  }, [objective, results.dr, results.naive]);

  const topMove = useMemo(() => {
    if (!results.naive || !results.dr) {
      return null;
    }
    return computeTopMove(results.naive, results.dr);
  }, [results.dr, results.naive]);

  const brief = useMemo(() => {
    if (!score) {
      return null;
    }

    return buildBrief(
      objective,
      segmentBy,
      maxDiscountPct,
      score.objectiveLift,
      score.objectiveDigits,
      score.discountDelta,
      score.annualNetValueDelta
    );
  }, [maxDiscountPct, objective, score, segmentBy]);

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
          message: "Could not compute recommendation. Try again.",
          requestId: err.requestId
        });
      } else {
        setError({ message: "Could not compute recommendation. Try again." });
      }
    } finally {
      setLoading(false);
    }
  }, [maxDiscountPct, objective, segmentBy]);

  return (
    <main className="page-shell">
      <header className="hero panel minimal-hero">
        <p className="eyebrow">PromoPilot</p>
        <h1>Discount Strategy Launch Brief</h1>
        <p className="hero-copy">Set assumptions, run analysis, then apply the recommended policy.</p>
      </header>

      <section className="panel assumptions-panel" data-testid="assumptions-panel">
        <p className="assumptions-title">Step 1: set assumptions</p>
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
      </section>

      {loading ? (
        <p className="loading-line" data-testid="loading-line">
          Step 2: comparing current policy vs optimized policy...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && score && brief ? (
        <section className="results-stack" data-testid="results-block">
          <section className="panel compact-result" data-testid="recommendation-panel">
            <p className={`decision-pill ${brief.decisionTone}`} data-testid="decision-pill">
              {brief.decisionTone === "ship" ? "Decision: Ship" : "Decision: Pilot"}
            </p>
            <p className="recommendation-line" data-testid="recommendation-line">
              {brief.decisionLine}
            </p>
            <p className="recommendation-context" data-testid="recommendation-context">
              {brief.supportLine}
            </p>
            <p className="recommendation-context" data-testid="baseline-context">
              Compared against current observed policy (avg discount {score.currentAvgDiscount.toFixed(1)}%) vs optimized
              policy (avg {score.optimizedAvgDiscount.toFixed(1)}%).
            </p>

            <div className="compact-kpis">
              <article>
                <p>Primary KPI lift (per 10k)</p>
                <strong data-testid="kpi-objective">{signed(score.objectiveLift, score.objectiveDigits)}</strong>
              </article>
              <article>
                <p>Average discount change</p>
                <strong data-testid="kpi-discount">{signed(score.discountDelta)} pp</strong>
              </article>
              <article>
                <p>Annual net value impact</p>
                <strong data-testid="kpi-net-value">{formatCurrency(score.annualNetValueDelta)}</strong>
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
            <h3>Most important policy move</h3>
            <ul className="simple-list">
              {topMove ? (
                <li>
                  {topMove.segment}: discount changes from {topMove.naiveDiscount}% to {topMove.drDiscount}% ({signed(
                    topMove.discountDelta
                  )} pp), expected net value shift {signed(topMove.netValueDelta, 0)} per 10k.
                </li>
              ) : (
                <li>No segment-level change under these assumptions.</li>
              )}
            </ul>
          </section>

          <section className="panel move-panel" data-testid="rollout-plan">
            <h3>Step 3: rollout plan</h3>
            <ul className="simple-list">
              {brief.rolloutSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </section>

          <section className="panel move-panel" data-testid="guardrails">
            <h3>Guardrails</h3>
            <ul className="simple-list">
              {brief.guardrails.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </section>
        </section>
      ) : (
        <section className="panel empty-state">
          <p className="narrative-title">Ready to evaluate</p>
          <p>Run the analysis to generate a launch brief.</p>
        </section>
      )}
    </main>
  );
}
