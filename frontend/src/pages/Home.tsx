import { useCallback, useMemo, useState } from "react";
import {
  ApiError,
  Objective,
  RecommendResponse,
  SegmentBy,
  SegmentRecommendation,
  recommendPolicy
} from "../api/client";
import { Controls } from "../components/Controls";

interface UiError {
  message: string;
  requestId?: string;
}

interface MethodRollup {
  successes: number;
  safeValue: number;
  incidents: number;
  latency: number;
  avgPolicyLevel: number;
}

type DecisionTone = "ship" | "pilot" | "hold";

interface DecisionSummary {
  tone: DecisionTone;
  status: "SHIP" | "PILOT" | "HOLD";
  line: string;
}

interface ImpactScore {
  decision: DecisionSummary;
  objectiveLabel: string;
  objectiveUnit: string;
  objectiveLiftPer10k: number;
  objectiveLiftWeekly: number;
  incidentsAvoidedPer10k: number;
  incidentsAvoidedWeekly: number;
  latencyDelta: number;
  noAiCostLine: string;
  nextActionLine: string;
}

const DEFAULT_MAX_POLICY_LEVEL = 3;
const WEEKLY_REQUESTS = 5_000_000;
const WEEKLY_FACTOR = WEEKLY_REQUESTS / 10_000;
const UI_VERSION = "interactive-v2";

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function signedInteger(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatInteger(value)}`;
}

function rollupMethod(response: RecommendResponse): MethodRollup {
  const count = Math.max(response.segments.length, 1);
  const successes = response.segments.reduce((acc, segment) => acc + segment.expected_successes_per_10k, 0) / count;
  const safeValue = response.segments.reduce((acc, segment) => acc + segment.expected_safe_value_per_10k, 0) / count;
  const incidents = response.segments.reduce((acc, segment) => acc + segment.expected_incidents_per_10k, 0) / count;
  const latency = response.segments.reduce((acc, segment) => acc + segment.expected_latency_ms, 0) / count;
  const avgPolicyLevel = response.segments.reduce((acc, segment) => acc + segment.recommended_policy_level, 0) / count;

  return {
    successes,
    safeValue,
    incidents,
    latency,
    avgPolicyLevel
  };
}

function findRiskLevel(segments: SegmentRecommendation[], risk: "low" | "medium" | "high"): number | null {
  const target = segments.find((segment) => segment.segment.toLowerCase() === `risk=${risk}`);
  return target ? target.recommended_policy_level : null;
}

function buildPolicyLine(segmentBy: SegmentBy, dr: RecommendResponse): string {
  if (dr.segments.length === 0) {
    return "Policy to ship: not available.";
  }

  if (segmentBy === "none") {
    return `Policy to ship: L${dr.segments[0].recommended_policy_level} for all traffic.`;
  }

  if (segmentBy === "prompt_risk") {
    const low = findRiskLevel(dr.segments, "low");
    const medium = findRiskLevel(dr.segments, "medium");
    const high = findRiskLevel(dr.segments, "high");
    if (low !== null && medium !== null && high !== null) {
      return `Policy to ship: Low-risk L${low}, Medium-risk L${medium}, High-risk L${high}.`;
    }
  }

  const top = dr.segments
    .slice(0, 3)
    .map((segment) => `${segment.segment} -> L${segment.recommended_policy_level}`)
    .join(" | ");

  return `Policy to ship: ${top}.`;
}

function chooseDecision(
  objectiveLiftPer10k: number,
  incidentsAvoidedPer10k: number,
  latencyDelta: number,
  objectiveUnit: string
): DecisionSummary {
  const objectiveWeekly = objectiveLiftPer10k * WEEKLY_FACTOR;
  const incidentWeekly = incidentsAvoidedPer10k * WEEKLY_FACTOR;

  if (objectiveLiftPer10k > 0 && incidentsAvoidedPer10k >= 0 && latencyDelta <= 8) {
    return {
      tone: "ship",
      status: "SHIP",
      line: `Decision: SHIP. Improves ${objectiveUnit} by ${signedInteger(objectiveWeekly)}/week and prevents ${signedInteger(incidentWeekly)} incidents/week vs naive.`
    };
  }

  if (objectiveLiftPer10k > 0 && incidentsAvoidedPer10k > -2 && latencyDelta <= 12) {
    return {
      tone: "pilot",
      status: "PILOT",
      line: `Decision: PILOT. Upside is ${signedInteger(objectiveWeekly)} ${objectiveUnit}/week, but safety/latency needs controlled rollout.`
    };
  }

  return {
    tone: "hold",
    status: "HOLD",
    line: "Decision: HOLD. Under current constraints this is not safer than naive to deploy at full traffic."
  };
}

function buildNoAiCostLine(objectiveUnit: string, objectiveLiftWeekly: number, incidentsAvoidedWeekly: number): string {
  const objectiveMagnitude = formatInteger(Math.abs(objectiveLiftWeekly));
  const incidentsMagnitude = formatInteger(Math.abs(incidentsAvoidedWeekly));

  if (objectiveLiftWeekly > 0 && incidentsAvoidedWeekly > 0) {
    return `Without AI optimization, keeping naive is projected to lose ${objectiveMagnitude} ${objectiveUnit}/week and add ${incidentsMagnitude} incidents/week.`;
  }

  if (objectiveLiftWeekly > 0) {
    return `Without AI optimization, keeping naive is projected to lose ${objectiveMagnitude} ${objectiveUnit}/week.`;
  }

  if (incidentsAvoidedWeekly > 0) {
    return `Without AI optimization, keeping naive is projected to add ${incidentsMagnitude} incidents/week.`;
  }

  return "Current model does not show practical advantage over naive under these constraints; hold until constraints/features change.";
}

function buildNextActionLine(decision: DecisionSummary): string {
  if (decision.status === "SHIP") {
    return "Next action: import bundle into policy service, run 10% canary for 24h, then ramp to 100% if gates hold.";
  }

  if (decision.status === "PILOT") {
    return "Next action: run a 10% pilot only; monitor safety and latency gates before any ramp-up.";
  }

  return "Next action: keep naive policy in production and review feature coverage before re-running.";
}

function exportPolicyBundle(params: {
  naive: RecommendResponse;
  dr: RecommendResponse;
  objective: Objective;
  segmentBy: SegmentBy;
  maxPolicyLevel: number;
  score: ImpactScore;
  policyLine: string;
}): void {
  const { naive, dr, objective, segmentBy, maxPolicyLevel, score, policyLine } = params;

  const bundle = {
    generated_at_utc: new Date().toISOString(),
    artifact_version: dr.artifact_version,
    ui_version: UI_VERSION,
    decision: {
      status: score.decision.status,
      summary: score.decision.line,
      policy: policyLine
    },
    practical_value: {
      no_ai_cost: score.noAiCostLine,
      next_action: score.nextActionLine,
      objective_delta_weekly: Number(score.objectiveLiftWeekly.toFixed(0)),
      incidents_avoided_weekly: Number(score.incidentsAvoidedWeekly.toFixed(0)),
      latency_delta_ms: Number(score.latencyDelta.toFixed(2))
    },
    inputs: {
      objective,
      segment_by: segmentBy,
      max_policy_level: maxPolicyLevel,
      weekly_request_assumption: WEEKLY_REQUESTS
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
  link.download = "edgealign-deployment-bundle.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export function Home(): JSX.Element {
  const [objective, setObjective] = useState<Objective>("task_success");
  const [maxPolicyLevel, setMaxPolicyLevel] = useState<number>(DEFAULT_MAX_POLICY_LEVEL);
  const [segmentBy, setSegmentBy] = useState<SegmentBy>("prompt_risk");
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
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
          objective,
          max_policy_level: maxPolicyLevel,
          segment_by: segmentBy,
          method: "naive"
        }),
        recommendPolicy({
          objective,
          max_policy_level: maxPolicyLevel,
          segment_by: segmentBy,
          method: "dr"
        })
      ]);

      setResults({ naive, dr });
      setHasRun(true);
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
  }, [maxPolicyLevel, objective, segmentBy]);

  const score = useMemo<ImpactScore | null>(() => {
    if (!naiveResult || !drResult) {
      return null;
    }

    const naive = rollupMethod(naiveResult);
    const dr = rollupMethod(drResult);

    const objectiveLiftPer10k = objective === "task_success" ? dr.successes - naive.successes : dr.safeValue - naive.safeValue;
    const objectiveLabel = objective === "task_success" ? "Weekly successful responses" : "Weekly safety-adjusted value";
    const objectiveUnit = objective === "task_success" ? "responses" : "value units";
    const incidentsAvoidedPer10k = naive.incidents - dr.incidents;
    const latencyDelta = dr.latency - naive.latency;

    const objectiveLiftWeekly = objectiveLiftPer10k * WEEKLY_FACTOR;
    const incidentsAvoidedWeekly = incidentsAvoidedPer10k * WEEKLY_FACTOR;

    const decision = chooseDecision(objectiveLiftPer10k, incidentsAvoidedPer10k, latencyDelta, objectiveUnit);

    return {
      decision,
      objectiveLabel,
      objectiveUnit,
      objectiveLiftPer10k,
      objectiveLiftWeekly,
      incidentsAvoidedPer10k,
      incidentsAvoidedWeekly,
      latencyDelta,
      noAiCostLine: buildNoAiCostLine(objectiveUnit, objectiveLiftWeekly, incidentsAvoidedWeekly),
      nextActionLine: buildNextActionLine(decision)
    };
  }, [drResult, naiveResult, objective]);

  const policyLine = useMemo(() => {
    if (!drResult) {
      return null;
    }
    return buildPolicyLine(segmentBy, drResult);
  }, [drResult, segmentBy]);

  return (
    <main className="page-shell">
      <header className="panel hero" data-testid="hero">
        <p className="eyebrow">EdgeAlign-DR</p>
        <h1>Interactive policy decision simulator</h1>
        <p className="hero-copy" data-testid="single-story">
          Change assumptions, click Run, and see the deployment decision, the cost of staying naive, and the exact bundle
          to apply.
        </p>
        <p className="version-chip" data-testid="version-chip">
          UI version: {UI_VERSION}
        </p>
      </header>

      <section className="panel controls-wrap" data-testid="assumptions-panel">
        <Controls
          objective={objective}
          maxPolicyLevel={maxPolicyLevel}
          segmentBy={segmentBy}
          onObjectiveChange={setObjective}
          onMaxPolicyLevelChange={setMaxPolicyLevel}
          onSegmentByChange={setSegmentBy}
          onGenerate={runAnalysis}
          loading={loading}
          hasResults={hasResults}
        />
      </section>

      {loading ? (
        <p className="loading-line" data-testid="loading-line">
          Running analysis...
        </p>
      ) : null}

      {error ? (
        <p className="error-line" data-testid="error-line">
          {error.message}
          {error.requestId ? ` Request ID: ${error.requestId}` : ""}
        </p>
      ) : null}

      {hasResults && score && policyLine && naiveResult && drResult ? (
        <section className="panel result-panel" data-testid="results-block">
          <p className={`recommendation-line ${score.decision.tone}`} data-testid="recommendation-line">
            {score.decision.line}
          </p>

          <p className="result-footnote" data-testid="policy-line">
            {policyLine}
          </p>

          <section className="utility-card" data-testid="utility-card">
            <p className="utility-title">Practical value this week</p>
            <p className="result-footnote" data-testid="no-ai-line">
              {score.noAiCostLine}
            </p>
            <p className="result-footnote" data-testid="next-action-line">
              {score.nextActionLine}
            </p>
          </section>

          <div className="kpi-row">
            <article className="kpi-card" data-testid="kpi-objective">
              <p>{score.objectiveLabel}</p>
              <strong>{signedInteger(score.objectiveLiftWeekly)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-incident">
              <p>Weekly incidents avoided</p>
              <strong>{signedInteger(score.incidentsAvoidedWeekly)}</strong>
            </article>

            <article className="kpi-card" data-testid="kpi-latency">
              <p>Latency delta (ms)</p>
              <strong>{signed(score.latencyDelta, 1)}</strong>
            </article>
          </div>

          <button
            type="button"
            className="button-primary"
            onClick={() =>
              exportPolicyBundle({
                naive: naiveResult,
                dr: drResult,
                objective,
                segmentBy,
                maxPolicyLevel,
                score,
                policyLine
              })
            }
            data-testid="apply-policy"
            disabled={!naiveResult || !drResult}
          >
            Apply policy (download deployment bundle)
          </button>
        </section>
      ) : (
        <section className="panel empty-state" data-testid="empty-state">
          <p>{hasRun ? "No recommendation available." : "Set assumptions and click Run to generate a decision."}</p>
        </section>
      )}
    </main>
  );
}
