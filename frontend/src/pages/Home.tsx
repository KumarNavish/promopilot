import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, DoseResponsePoint, Objective, RecommendResponse, SegmentBy, recommendPolicy } from "../api/client";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  incidents: number;
  latency: number;
}

type PolicyMap = Record<string, number>;

interface ImpactScore {
  recommendationLine: string;
  evidenceLine: string;
  policyDiffLine: string;
  successLiftWeekly: number;
  incidentsAvoidedWeekly: number;
  riskCostImpactUsdWeekly: number;
  latencyDeltaMs: number;
  aiPolicy: PolicyMap;
  naivePolicy: PolicyMap;
}

const DEMO_OBJECTIVE: Objective = "task_success";
const DEMO_SEGMENT_BY: SegmentBy = "task_domain";
const DEMO_MAX_POLICY_LEVEL = 2;
const WEEKLY_REQUESTS = 5_000_000;
const INCIDENT_COST_USD = 2500;
const INCIDENT_UTILITY_PENALTY = 4;
const LATENCY_UTILITY_PENALTY = 0;
const UI_VERSION = "value-v7";

const RUN_STAGES = [
  "Reweight biased logs with propensity model",
  "Estimate outcomes for every policy level",
  "Search policy actions with DR utility",
  "Select highest-value constrained policy"
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

function cleanSegment(segment: string): string {
  return segment.replace("=", " ").replace(/_/g, " ");
}

function utility(point: DoseResponsePoint): number {
  return point.successes_per_10k - INCIDENT_UTILITY_PENALTY * point.incidents_per_10k - LATENCY_UTILITY_PENALTY * point.latency_ms;
}

function optimizePolicy(response: RecommendResponse): PolicyMap {
  const policy: PolicyMap = {};

  for (const segment of response.dose_response) {
    const candidates = segment.points.filter((point) => point.policy_level <= DEMO_MAX_POLICY_LEVEL);
    if (candidates.length === 0) {
      continue;
    }

    let best = candidates[0];
    for (const point of candidates.slice(1)) {
      if (utility(point) > utility(best)) {
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
  let latency = 0;
  let count = 0;

  for (const segment of response.dose_response) {
    const selectedLevel = policy[segment.segment];
    const selected = segment.points.find((point) => point.policy_level === selectedLevel) ?? segment.points[0];
    if (!selected) {
      continue;
    }

    successes += selected.successes_per_10k;
    incidents += selected.incidents_per_10k;
    latency += selected.latency_ms;
    count += 1;
  }

  const safeCount = Math.max(count, 1);
  return {
    successes: successes / safeCount,
    incidents: incidents / safeCount,
    latency: latency / safeCount
  };
}

function buildPolicyPhrase(policy: PolicyMap): string {
  const parts = Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, level]) => `${cleanSegment(segment)} -> L${level}`);

  return parts.join(" | ");
}

function buildPolicyDiffLine(naivePolicy: PolicyMap, aiPolicy: PolicyMap): string {
  const segments = Object.keys(aiPolicy).sort();
  const changed = segments
    .filter((segment) => naivePolicy[segment] !== aiPolicy[segment])
    .map((segment) => `${cleanSegment(segment)} L${naivePolicy[segment]} -> L${aiPolicy[segment]}`);

  if (changed.length === 0) {
    return "Policy updates vs naive: none (gains come from better counterfactual ranking).";
  }

  return `Policy updates vs naive: ${changed.join(" | ")}.`;
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
}): void {
  const { dr, score } = params;

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    ui_version: UI_VERSION,
    scenario: {
      objective: DEMO_OBJECTIVE,
      segment_by: DEMO_SEGMENT_BY,
      max_policy_level: DEMO_MAX_POLICY_LEVEL
    },
    optimizer: {
      incident_utility_penalty: INCIDENT_UTILITY_PENALTY,
      latency_utility_penalty: LATENCY_UTILITY_PENALTY
    },
    assumptions: {
      weekly_requests: WEEKLY_REQUESTS,
      incident_cost_usd: INCIDENT_COST_USD
    },
    recommendation: score.recommendationLine,
    evidence: score.evidenceLine,
    policy_updates: score.policyDiffLine,
    impact_vs_naive_weekly: {
      successful_responses: Math.round(score.successLiftWeekly),
      incidents_avoided: Math.round(score.incidentsAvoidedWeekly),
      risk_cost_impact_usd: Math.round(score.riskCostImpactUsdWeekly),
      latency_delta_ms: Number(score.latencyDeltaMs.toFixed(2))
    },
    recommended_rules: policyToRules(score.aiPolicy),
    naive_reference_rules: policyToRules(score.naivePolicy)
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
      await delay(120);
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

      await delay(120);
      setCompletedStage(1);
      setActiveStage(2);

      const [naive, dr] = await Promise.all([naivePromise, drPromise]);

      await delay(120);
      setCompletedStage(2);
      setActiveStage(3);

      await delay(100);
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

    const naivePolicy = optimizePolicy(naiveResult);
    const aiPolicy = optimizePolicy(drResult);

    const naiveEvalByDr = evaluatePolicy(drResult, naivePolicy);
    const aiEvalByDr = evaluatePolicy(drResult, aiPolicy);

    const weeklyFactor = WEEKLY_REQUESTS / 10_000;
    const successLiftWeekly = (aiEvalByDr.successes - naiveEvalByDr.successes) * weeklyFactor;
    const incidentsAvoidedWeekly = (naiveEvalByDr.incidents - aiEvalByDr.incidents) * weeklyFactor;
    const latencyDeltaMs = aiEvalByDr.latency - naiveEvalByDr.latency;
    const riskCostImpactUsdWeekly = incidentsAvoidedWeekly * INCIDENT_COST_USD;

    const scenariosEvaluated = drResult.dose_response.reduce((acc, segment) => {
      const available = segment.points.filter((point) => point.policy_level <= DEMO_MAX_POLICY_LEVEL).length;
      return acc + available;
    }, 0);

    const totalSegments = Object.keys(aiPolicy).length;
    const changedRules = Object.keys(aiPolicy).filter((segment) => aiPolicy[segment] !== naivePolicy[segment]).length;

    return {
      recommendationLine: `AI recommendation: ${buildPolicyPhrase(aiPolicy)}.`,
      evidenceLine: `Counterfactual search scored ${formatInteger(scenariosEvaluated)} actions and changed ${changedRules}/${totalSegments} segment rules vs naive policy search.`,
      policyDiffLine: buildPolicyDiffLine(naivePolicy, aiPolicy),
      successLiftWeekly,
      incidentsAvoidedWeekly,
      riskCostImpactUsdWeekly,
      latencyDeltaMs,
      aiPolicy,
      naivePolicy
    };
  }, [naiveResult, drResult]);

  const showDone = hasResults && !loading;

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">Counterfactual AI Runner</p>
        <h1>Policy action search (live)</h1>
        <p className="hero-copy" data-testid="single-story">
          On load, this demo runs a doubly-robust policy search over segment-level actions and outputs the highest-value policy to ship.
        </p>
        <p className="build-proof" data-testid="build-proof">
          Live build marker: value-v7
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

      {hasResults && score && drResult ? (
        <section className="panel result-panel" data-testid="results-block">
          <p className="recommendation-line" data-testid="recommendation-line">
            {score.recommendationLine}
          </p>
          <p className="evidence-line" data-testid="evidence-line">
            {score.evidenceLine}
          </p>
          <p className="policy-diff-line" data-testid="policy-diff-line">
            {score.policyDiffLine}
          </p>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-success">
              <p>Weekly successful responses vs naive optimizer</p>
              <strong>{formatSignedInteger(score.successLiftWeekly)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incidents">
              <p>Weekly incidents avoided vs naive optimizer</p>
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
                dr: drResult,
                score
              })
            }
            data-testid="apply-policy"
            disabled={!drResult}
          >
            Apply policy (export JSON)
          </button>
        </section>
      ) : null}
    </main>
  );
}
