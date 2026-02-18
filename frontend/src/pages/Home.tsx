import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, Objective, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";
import { Controls } from "../components/Controls";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
  latency: number;
}

type DecisionTone = "ship" | "pilot" | "hold";

interface ImpactScore {
  decisionTone: DecisionTone;
  recommendationLine: string;
  successLiftWeekly: number;
  incidentsAvoidedWeekly: number;
  riskCostImpactUsdWeekly: number;
  naiveRiskCostUsdWeekly: number;
  drRiskCostUsdWeekly: number;
  latencyDeltaMs: number;
}

const DEMO_OBJECTIVE: Objective = "task_success";
const DEMO_SEGMENT_BY: SegmentBy = "prompt_risk";
const DEMO_MAX_POLICY_LEVEL = 4;

const DEFAULT_WEEKLY_REQUESTS = 5_000_000;
const DEFAULT_INCIDENT_COST_USD = 2500;
const UI_VERSION = "value-v4";

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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
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
    return `L${low} for low-risk, L${medium} for medium-risk, L${high} for high-risk prompts`;
  }

  const fallback = response.segments
    .slice(0, 3)
    .map((segment) => `${segment.segment} -> L${segment.recommended_policy_level}`)
    .join(" | ");

  return fallback || "no policy available";
}

function buildRecommendationLine(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  successLiftWeekly: number;
  incidentsAvoidedWeekly: number;
  latencyDeltaMs: number;
  riskCostImpactUsdWeekly: number;
}): { tone: DecisionTone; text: string } {
  const { naive, dr, successLiftWeekly, incidentsAvoidedWeekly, latencyDeltaMs, riskCostImpactUsdWeekly } = params;
  const naivePolicy = buildPolicyPhrase(naive);
  const drPolicy = buildPolicyPhrase(dr);

  const successMagnitude = formatInteger(Math.abs(successLiftWeekly));
  const successWord = successLiftWeekly >= 0 ? "more" : "fewer";
  const incidentMagnitude = formatInteger(Math.abs(incidentsAvoidedWeekly));
  const incidentWord = incidentsAvoidedWeekly >= 0 ? "fewer" : "more";

  let tone: DecisionTone = "hold";
  let prefix = "Hold";

  if (incidentsAvoidedWeekly > 0 && successLiftWeekly >= 0) {
    tone = "ship";
    prefix = "Ship now";
  } else if (incidentsAvoidedWeekly > -100 && successLiftWeekly > -1000) {
    tone = "pilot";
    prefix = "Pilot first";
  }

  const latencyPhrase = latencyDeltaMs <= 0 ? `${Math.abs(latencyDeltaMs).toFixed(1)}ms faster` : `${latencyDeltaMs.toFixed(1)}ms slower`;
  const policyTransition =
    naivePolicy === drPolicy
      ? `keep ${drPolicy} (but replace naive estimation with bias-adjusted estimation)`
      : `switch from ${naivePolicy} to ${drPolicy}`;

  return {
    tone,
    text:
      `${prefix}: ${policyTransition}; expected ${successMagnitude} ${successWord} successful responses/week, ` +
      `${incidentMagnitude} ${incidentWord} incidents/week, ${formatSignedCurrency(riskCostImpactUsdWeekly)} weekly risk-cost delta, and ${latencyPhrase}.`
  };
}

function exportPolicyBundle(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  score: ImpactScore;
  weeklyRequests: number;
  incidentCostUsd: number;
}): void {
  const { naive, dr, score, weeklyRequests, incidentCostUsd } = params;

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
      weekly_requests: weeklyRequests,
      incident_cost_usd: incidentCostUsd
    },
    recommendation: score.recommendationLine,
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
  const [weeklyRequests, setWeeklyRequests] = useState<number>(DEFAULT_WEEKLY_REQUESTS);
  const [incidentCostUsd, setIncidentCostUsd] = useState<number>(DEFAULT_INCIDENT_COST_USD);

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const hasResults = Boolean(results.naive && results.dr);
  const naiveResult = results.naive;
  const drResult = results.dr;

  const runAnalysis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective: DEMO_OBJECTIVE,
          max_policy_level: DEMO_MAX_POLICY_LEVEL,
          segment_by: DEMO_SEGMENT_BY,
          method: "naive"
        }),
        recommendPolicy({
          objective: DEMO_OBJECTIVE,
          max_policy_level: DEMO_MAX_POLICY_LEVEL,
          segment_by: DEMO_SEGMENT_BY,
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

    const weeklyFactor = weeklyRequests / 10_000;
    const successLiftWeekly = (dr.successes - naive.successes) * weeklyFactor;
    const incidentsAvoidedWeekly = (naive.incidents - dr.incidents) * weeklyFactor;
    const latencyDeltaMs = dr.latency - naive.latency;
    const riskCostImpactUsdWeekly = incidentsAvoidedWeekly * incidentCostUsd;
    const naiveRiskCostUsdWeekly = naive.incidents * weeklyFactor * incidentCostUsd;
    const drRiskCostUsdWeekly = dr.incidents * weeklyFactor * incidentCostUsd;

    const recommendation = buildRecommendationLine({
      naive: naiveResult,
      dr: drResult,
      successLiftWeekly,
      incidentsAvoidedWeekly,
      latencyDeltaMs,
      riskCostImpactUsdWeekly
    });

    return {
      decisionTone: recommendation.tone,
      recommendationLine: recommendation.text,
      successLiftWeekly,
      incidentsAvoidedWeekly,
      riskCostImpactUsdWeekly,
      naiveRiskCostUsdWeekly,
      drRiskCostUsdWeekly,
      latencyDeltaMs
    };
  }, [naiveResult, drResult, weeklyRequests, incidentCostUsd]);

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">Edge Policy Optimizer</p>
        <h1>Bias-adjusted policy recommendation</h1>
        <p className="hero-copy" data-testid="single-story">
          This demo automatically corrects bias in historical logs and outputs a deployable guardrail policy that reduces costly incidents while protecting response success.
        </p>
        <p className="version-chip" data-testid="version-chip">
          UI version: {UI_VERSION}
        </p>
      </header>

      <section className="panel controls-wrap" data-testid="assumptions-panel">
        <Controls
          weeklyRequests={weeklyRequests}
          incidentCostUsd={incidentCostUsd}
          onWeeklyRequestsChange={setWeeklyRequests}
          onIncidentCostChange={setIncidentCostUsd}
          onGenerate={runAnalysis}
          loading={loading}
        />
      </section>

      {loading ? (
        <p className="loading-line" data-testid="loading-line">
          Running auto-demo...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && score && naiveResult && drResult ? (
        <section className="panel result-panel" data-testid="results-block">
          <section className="before-after-strip" data-testid="before-after-strip">
            <article className="strip-col naive" data-testid="naive-card">
              <p className="strip-label">Before: naive from biased logs</p>
              <strong className="strip-policy" data-testid="naive-policy">
                {buildPolicyPhrase(naiveResult)}
              </strong>
              <p className="strip-metric" data-testid="naive-risk-cost">
                Incident cost/week: {formatCurrency(score.naiveRiskCostUsdWeekly)}
              </p>
            </article>

            <article className="strip-col dr" data-testid="dr-card">
              <p className="strip-label">After: bias-adjusted counterfactual</p>
              <strong className="strip-policy" data-testid="dr-policy">
                {buildPolicyPhrase(drResult)}
              </strong>
              <p className="strip-metric" data-testid="dr-risk-cost">
                Incident cost/week: {formatCurrency(score.drRiskCostUsdWeekly)}
              </p>
            </article>

            <div className="strip-delta" data-testid="strip-delta">
              <span>Weekly risk-cost delta</span>
              <strong>{formatSignedCurrency(score.riskCostImpactUsdWeekly)}</strong>
            </div>
          </section>

          <p className={`recommendation-line ${score.decisionTone}`} data-testid="recommendation-line">
            {score.recommendationLine}
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
                score,
                weeklyRequests,
                incidentCostUsd
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
