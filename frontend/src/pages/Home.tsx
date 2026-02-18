import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, DoseResponsePoint, Objective, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
  safeValue: number;
}

type PolicyMap = Record<string, number>;

type OperatingMode = "reliability" | "throughput";

interface ModeConfig {
  label: string;
  objective: Objective;
  maxPolicyLevel: number;
  incidentPenalty: number;
}

interface ImpactScore {
  recommendationLine: string;
  successLiftWeekly: number;
  incidentsAvoidedWeekly: number;
  riskCostImpactUsdWeekly: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
}

const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const DEFAULT_WEEKLY_REQUESTS = 5_000_000;
const DEFAULT_INCIDENT_COST_USD = 2500;

const MODE_CONFIGS: Record<OperatingMode, ModeConfig> = {
  reliability: {
    label: "Reliability first",
    objective: "task_success",
    maxPolicyLevel: 2,
    incidentPenalty: 4
  },
  throughput: {
    label: "Throughput first",
    objective: "task_success",
    maxPolicyLevel: 3,
    incidentPenalty: 1
  }
};

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

function cleanSegment(segment: string): string {
  return segment.replace("Domain=", "").replace(/_/g, " ");
}

function objectiveValue(point: DoseResponsePoint, objective: Objective): number {
  return objective === "safe_value" ? point.safe_value_per_10k : point.successes_per_10k;
}

function utility(point: DoseResponsePoint, objective: Objective, incidentPenalty: number): number {
  return objectiveValue(point, objective) - incidentPenalty * point.incidents_per_10k;
}

function optimizePolicy(response: RecommendResponse, objective: Objective, maxPolicyLevel: number, incidentPenalty: number): PolicyMap {
  const policy: PolicyMap = {};

  for (const segment of response.dose_response) {
    const candidates = segment.points.filter((point) => point.policy_level <= maxPolicyLevel);
    if (candidates.length === 0) {
      continue;
    }

    let best = candidates[0];
    for (const point of candidates.slice(1)) {
      if (utility(point, objective, incidentPenalty) > utility(best, objective, incidentPenalty)) {
        best = point;
      }
    }

    policy[segment.segment] = best.policy_level;
  }

  return policy;
}

function evaluatePolicy(response: RecommendResponse, policy: PolicyMap): MethodRollup {
  let successes = 0;
  let incidents = 0;
  let safeValue = 0;
  let count = 0;

  for (const segment of response.dose_response) {
    const selectedLevel = policy[segment.segment];
    const selected = segment.points.find((point) => point.policy_level === selectedLevel) ?? segment.points[0];
    if (!selected) {
      continue;
    }

    successes += selected.successes_per_10k;
    incidents += selected.incidents_per_10k;
    safeValue += selected.safe_value_per_10k;
    count += 1;
  }

  const safeCount = Math.max(count, 1);
  return {
    successes: successes / safeCount,
    incidents: incidents / safeCount,
    safeValue: safeValue / safeCount
  };
}

function buildPolicyPhrase(policy: PolicyMap): string {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => `${cleanSegment(segment)}: L${level}`)
    .join(", ");
}

function policyToRules(policy: PolicyMap): Array<{ segment: string; policy_level: number }> {
  return Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => ({
      segment,
      policy_level: level
    }));
}

function exportPolicyBundle(params: {
  dr: RecommendResponse;
  score: ImpactScore;
  mode: OperatingMode;
  weeklyRequests: number;
  incidentCostUsd: number;
}): void {
  const { dr, score, mode, weeklyRequests, incidentCostUsd } = params;
  const config = MODE_CONFIGS[mode];

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    scenario: {
      mode,
      mode_label: config.label,
      objective: config.objective,
      segment_by: DEMO_SEGMENT_BY,
      max_policy_level: config.maxPolicyLevel,
      incident_penalty: config.incidentPenalty,
      weekly_requests: weeklyRequests,
      incident_cost_usd: incidentCostUsd
    },
    recommendation: score.recommendationLine,
    impact_vs_naive_weekly: {
      successful_responses: Math.round(score.successLiftWeekly),
      incidents_avoided: Math.round(score.incidentsAvoidedWeekly),
      risk_cost_impact_usd: Math.round(score.riskCostImpactUsdWeekly)
    },
    recommended_rules: policyToRules(score.aiPolicy),
    naive_reference_rules: policyToRules(score.naivePolicy)
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "policy-apply-bundle.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export function Home(): JSX.Element {
  const [mode, setMode] = useState<OperatingMode>("reliability");
  const [weeklyRequests, setWeeklyRequests] = useState<number>(DEFAULT_WEEKLY_REQUESTS);
  const [incidentCostUsd, setIncidentCostUsd] = useState<number>(DEFAULT_INCIDENT_COST_USD);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ naive?: RecommendResponse; dr?: RecommendResponse }>({});
  const [error, setError] = useState<UiError | null>(null);

  const config = MODE_CONFIGS[mode];

  const runAnalysis = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const [naive, dr] = await Promise.all([
        recommendPolicy({
          objective: config.objective,
          max_policy_level: config.maxPolicyLevel,
          segment_by: DEMO_SEGMENT_BY,
          method: "naive"
        }),
        recommendPolicy({
          objective: config.objective,
          max_policy_level: config.maxPolicyLevel,
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
  }, [config.maxPolicyLevel, config.objective]);

  const autoRunRef = useRef(false);
  useEffect(() => {
    if (!autoRunRef.current) {
      autoRunRef.current = true;
      void runAnalysis();
      return;
    }

    void runAnalysis();
  }, [runAnalysis]);

  const score = useMemo<ImpactScore | null>(() => {
    if (!results.naive || !results.dr) {
      return null;
    }

    const naivePolicy = optimizePolicy(results.naive, config.objective, config.maxPolicyLevel, config.incidentPenalty);
    const aiPolicy = optimizePolicy(results.dr, config.objective, config.maxPolicyLevel, config.incidentPenalty);

    const naiveEvalByDr = evaluatePolicy(results.dr, naivePolicy);
    const aiEvalByDr = evaluatePolicy(results.dr, aiPolicy);

    const weeklyFactor = weeklyRequests / 10_000;
    const successLiftWeekly = (aiEvalByDr.successes - naiveEvalByDr.successes) * weeklyFactor;
    const incidentsAvoidedWeekly = (naiveEvalByDr.incidents - aiEvalByDr.incidents) * weeklyFactor;
    const riskCostImpactUsdWeekly = incidentsAvoidedWeekly * incidentCostUsd;

    const policyPhrase = buildPolicyPhrase(aiPolicy);
    const incidentPhrase =
      incidentsAvoidedWeekly >= 0
        ? `${formatInteger(incidentsAvoidedWeekly)} fewer incidents`
        : `${formatInteger(Math.abs(incidentsAvoidedWeekly))} additional incidents`;

    return {
      recommendationLine: `Ship now: ${policyPhrase}. This bias-adjusted policy is projected to deliver ${formatSignedInteger(
        successLiftWeekly
      )} successful outcomes/week with ${incidentPhrase} vs naive targeting.`,
      successLiftWeekly,
      incidentsAvoidedWeekly,
      riskCostImpactUsdWeekly,
      aiPolicy,
      naivePolicy
    };
  }, [config.incidentPenalty, config.maxPolicyLevel, config.objective, incidentCostUsd, results.dr, results.naive, weeklyRequests]);

  const weeklyRequestsMillions = weeklyRequests / 1_000_000;

  return (
    <main className="page-shell" data-testid="home-shell">
      <header className="hero">
        <p className="eyebrow">Counterfactual policy runner</p>
        <h1>One-click AI policy optimizer</h1>
        <p className="hero-copy" data-testid="single-story">
          This demo auto-runs on load, corrects biased logs, and outputs the highest-value policy to ship this week.
        </p>
      </header>

      <section className="controls" data-testid="controls">
        <div className="field">
          <p className="field-label">Operating mode</p>
          <div className="mode-toggle" role="tablist" aria-label="Operating mode">
            {(["reliability", "throughput"] as OperatingMode[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`mode-pill ${mode === option ? "active" : ""}`}
                onClick={() => setMode(option)}
                data-testid={`mode-${option}`}
              >
                {MODE_CONFIGS[option].label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="weekly-requests">
            Weekly traffic: {weeklyRequestsMillions.toFixed(1)}M requests
          </label>
          <input
            id="weekly-requests"
            type="range"
            min={1}
            max={15}
            step={0.5}
            value={weeklyRequestsMillions}
            onChange={(event) => setWeeklyRequests(Math.round(Number(event.target.value) * 1_000_000))}
            data-testid="weekly-slider"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="incident-cost">
            Incident cost: ${formatInteger(incidentCostUsd)} each
          </label>
          <input
            id="incident-cost"
            type="range"
            min={500}
            max={6000}
            step={250}
            value={incidentCostUsd}
            onChange={(event) => setIncidentCostUsd(Number(event.target.value))}
            data-testid="incident-cost-slider"
          />
        </div>
      </section>

      {loading ? (
        <p className="status-line" data-testid="status-line">
          AI is recomputing policy with counterfactual correction...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {score && results.dr ? (
        <section className="result-panel" data-testid="results-block">
          <p className="recommendation-line" data-testid="recommendation-line">
            {score.recommendationLine}
          </p>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-success">
              <p>Weekly successful outcomes vs naive</p>
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
                dr: results.dr!,
                score,
                mode,
                weeklyRequests,
                incidentCostUsd
              })
            }
            data-testid="apply-policy"
          >
            Apply policy (export JSON)
          </button>
        </section>
      ) : null}
    </main>
  );
}
