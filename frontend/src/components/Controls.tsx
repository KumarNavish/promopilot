import { Objective, SegmentBy } from "../api/client";

interface ControlsProps {
  objective: Objective;
  maxPolicyLevel: number;
  segmentBy: SegmentBy;
  onObjectiveChange: (value: Objective) => void;
  onMaxPolicyLevelChange: (value: number) => void;
  onSegmentByChange: (value: SegmentBy) => void;
  onGenerate: () => void;
  loading: boolean;
  hasResults: boolean;
}

const POLICY_HINTS: Record<number, string> = {
  0: "Very light guardrails, fastest responses.",
  1: "Light guardrails with small safety checks.",
  2: "Balanced guardrails for most launches.",
  3: "Strict guardrails for higher-risk traffic.",
  4: "Maximum strictness, strongest blocking."
};

export function Controls({
  objective,
  maxPolicyLevel,
  segmentBy,
  onObjectiveChange,
  onMaxPolicyLevelChange,
  onSegmentByChange,
  onGenerate,
  loading,
  hasResults
}: ControlsProps): JSX.Element {
  return (
    <section className="controls-panel" aria-label="Controls">
      <div className="controls-grid">
        <label className="field">
          <span>Goal</span>
          <select
            data-testid="objective-select"
            value={objective}
            onChange={(event) => onObjectiveChange(event.target.value as Objective)}
          >
            <option value="task_success">Successful responses</option>
            <option value="safe_value">Safety-adjusted value</option>
          </select>
        </label>

        <label className="field">
          <span>Segment by</span>
          <select
            data-testid="segment-select"
            value={segmentBy}
            onChange={(event) => onSegmentByChange(event.target.value as SegmentBy)}
          >
            <option value="prompt_risk">Prompt risk</option>
            <option value="device_tier">Device tier</option>
            <option value="task_domain">Task type</option>
            <option value="none">No segmentation</option>
          </select>
        </label>

        <label className="field">
          <span>Max strictness: L{maxPolicyLevel}</span>
          <input
            data-testid="policy-slider"
            type="range"
            min={0}
            max={4}
            step={1}
            value={maxPolicyLevel}
            onChange={(event) => onMaxPolicyLevelChange(Number(event.target.value))}
          />
          <small className="field-help">{POLICY_HINTS[maxPolicyLevel]}</small>
        </label>
      </div>

      <button
        data-testid="generate-policy"
        className="button-primary"
        type="button"
        onClick={onGenerate}
        disabled={loading}
      >
        {loading ? "Running..." : hasResults ? "Run again" : "Run now"}
      </button>
    </section>
  );
}
