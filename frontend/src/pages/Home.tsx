import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, Objective, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
  latency: number;
}

interface ImpactScore {
  recommendationLine: string;
  evidenceLine: string;
  successLiftWeekly: number;
  incidentsAvoidedWeekly: number;
  riskCostImpactUsdWeekly: number;
  latencyDeltaMs: number;
}

const DEMO_OBJECTIVE: Objective = "task_success";
const DEMO_SEGMENT_BY: SegmentBy = "prompt_risk";
const DEMO_MAX_POLICY_LEVEL = 4;
const WEEKLY_REQUESTS = 5_000_000;
const INCIDENT_COST_USD = 2500;
const UI_VERSION = "value-v6";

const RUN_STAGES = [
  "Reweight biased logs with propensity model",
  "Estimate outcomes for every policy level",
  "Compute doubly-robust counterfactual value",
  "Select highest-value policy under constraints"
] as const;

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function formatSignedInteger(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatInteger(Math.abs(value))}`;
}

function formatSignedCurrency(value: number): string {
  const abs = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${abs}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const successes = response.segments.reduce((acc, segment) => acc + segment.expected_successes_per_10k, 0) / count;
  const incidents = response.segments.reduce((acc, segment) => acc + segment.expected_incidents_per_10k, 0) / count;
  const latency = response.segments.reduce((acc, segment) => acc + segment.expected_latency_ms, 0) / count;

  return {
    successes,
    incidents,
    latency
  };
}

function readRiskPolicy(response: RecommendResponse, risk: "low" | "medium" | "high"): number | null {
  const match = response.segments.find((segment) => segment.segment.toLowerCase() === `risk=${risk}`);
  return match ? match.recommended_policy_level : null;
}

function buildPolicyPhrase(response: RecommendResponse): string {
  const low = readRiskPolicy(response, "low");
  const medium = readRiskPolicy(response, "medium");
  const high = readRiskPolicy(response, "high");

  if (low !== null && medium !== null && high !== null) {
    return `L${low} for low-risk prompts, L${medium} for medium-risk prompts, L${high} for high-risk prompts`;
  }

  const fallback = response.segments
    .slice(0, 3)
    .map((segment) => `${segment.segment} -> L${segment.recommended_policy_level}`)
    .join(" | ");

  return fallback || "no policy available";
}

function exportPolicyBundle(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  score: ImpactScore;
}): void {
  const { naive, dr, score } = params;

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    ui_version: UI_VERSION,
    scenario: {
      objective: DEMO_OBJECTIVE,
      segment_by: DEMO_SEGMENT_BY,
      max_policy_level: DEMO_MAX_POLICY_LEVEL
    },
    assumptions: {
      weekly_requests: WEEKLY_REQUESTS,
      incident_cost_usd: INCIDENT_COST_USD
    },
    recommendation: score.recommendationLine,
    evidence: score.evidenceLine,
    impact_vs_naive_weekly: {
      successful_responses: Math.round(score.successLiftWeekly),
      incidents_avoided: Math.round(score.incidentsAvoidedWeekly),
      risk_cost_impact_usd: Math.round(score.riskCostImpactUsdWeekly),
      latency_delta_ms: Number(score.latencyDeltaMs.toFixed(2))
    },
    recommended_rules: dr.segments.map((segment) => ({
      segment: segment.segment,
      policy_level: segment.recommended_policy_level
    })),
    naive_reference_rules: naive.segments.map((segment) => ({
      segment: segment.segment,
      policy_level: segment.recommended_policy_level
    }))
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "edge-policy-bundle.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export function Home(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [activeStage, setActiveStage] = useState<number>(-1);
  const [completedStage, setCompletedStage] = useState<number>(-1);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const hasResults = Boolean(results.naive && results.dr);
  const naiveResult = results.naive;
  const drResult = results.dr;

  const runAnalysis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setActiveStage(0);
    setCompletedStage(-1);

    try {
      await delay(140);
      setCompletedStage(0);
      setActiveStage(1);

      const naivePromise = recommendPolicy({
        objective: DEMO_OBJECTIVE,
        max_policy_level: DEMO_MAX_POLICY_LEVEL,
        segment_by: DEMO_SEGMENT_BY,
        method: "naive"
      });

      const drPromise = recommendPolicy({
        objective: DEMO_OBJECTIVE,
        max_policy_level: DEMO_MAX_POLICY_LEVEL,
        segment_by: DEMO_SEGMENT_BY,
        method: "dr"
      });

      await delay(140);
      setCompletedStage(1);
      setActiveStage(2);

      const [naive, dr] = await Promise.all([naivePromise, drPromise]);

      await delay(140);
      setCompletedStage(2);
      setActiveStage(3);

      await delay(120);
      setResults({ naive, dr });
      setCompletedStage(3);
      setActiveStage(-1);
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

  const autoRunRef = useRef(false);
  useEffect(() => {
    if (autoRunRef.current) {
      return;
    }
    autoRunRef.current = true;
    void runAnalysis();
  }, [runAnalysis]);

  const score = useMemo<ImpactScore | null>(() => {
    if (!naiveResult || !drResult) {
      return null;
    }

    const naive = rollupMethod(naiveResult);
    const dr = rollupMethod(drResult);

    const weeklyFactor = WEEKLY_REQUESTS / 10_000;
    const successLiftWeekly = (dr.successes - naive.successes) * weeklyFactor;
    const incidentsAvoidedWeekly = (naive.incidents - dr.incidents) * weeklyFactor;
    const latencyDeltaMs = dr.latency - naive.latency;
    const riskCostImpactUsdWeekly = incidentsAvoidedWeekly * INCIDENT_COST_USD;

    const scenariosEvaluated = drResult.dose_response.reduce((acc, segment) => acc + segment.points.length, 0);

    return {
      recommendationLine: `AI recommendation: ${buildPolicyPhrase(drResult)}.`,
      evidenceLine: `Counterfactual engine evaluated ${formatInteger(scenariosEvaluated)} segment-policy outcomes and selected the highest-value policy under L${DEMO_MAX_POLICY_LEVEL}.`,
      successLiftWeekly,
      incidentsAvoidedWeekly,
      riskCostImpactUsdWeekly,
      latencyDeltaMs
    };
  }, [naiveResult, drResult]);

  const showDone = hasResults && !loading;

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">Counterfactual AI Runner</p>
        <h1>Bias-adjusted policy run (live)</h1>
        <p className="hero-copy" data-testid="single-story">
          On load, this demo runs a doubly-robust counterfactual simulation on biased logs and returns the one policy to ship.
        </p>
        <p className="build-proof" data-testid="build-proof">
          Live build marker: value-v6
        </p>
        <p className="version-chip" data-testid="version-chip">
          UI version: {UI_VERSION}
        </p>
      </header>

      <section className="panel run-panel" data-testid="run-panel">
        <p className="run-title">AI run status</p>
        <ol className="run-steps" data-testid="run-steps">
          {RUN_STAGES.map((stage, index) => {
            let state = "pending";
            if (showDone || index <= completedStage) {
              state = "done";
            } else if (index === activeStage) {
              state = "active";
            }

            return (
              <li key={stage} className={`run-step ${state}`} data-testid={`run-step-${index}`}>
                <span className="run-step-dot" aria-hidden="true" />
                <span>{stage}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && score && naiveResult && drResult ? (
        <section className="panel result-panel" data-testid="results-block">
          <p className="recommendation-line" data-testid="recommendation-line">
            {score.recommendationLine}
          </p>
          <p className="evidence-line" data-testid="evidence-line">
            {score.evidenceLine}
          </p>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-success">
              <p>Weekly successful responses vs naive</p>
              <strong>{formatSignedInteger(score.successLiftWeekly)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Weekly incidents avoided vs naive</p>
              <strong>{formatSignedInteger(score.incidentsAvoidedWeekly)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-risk-cost">
              <p>Weekly risk cost impact</p>
              <strong>{formatSignedCurrency(score.riskCostImpactUsdWeekly)}</strong>
            </article>
          </div>

          <button
            type="button"
            className="button-primary"
            onClick={() =>
              exportPolicyBundle({
                naive: naiveResult,
                dr: drResult,
                score
              })
            }
            data-testid="apply-policy"
            disabled={!naiveResult || !drResult}
          >
            Apply policy (export JSON)
          </button>
        </section>
      ) : null}
    </main>
  );
}
