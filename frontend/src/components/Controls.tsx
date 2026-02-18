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
          <span>Business objective</span>
          <select
            data-testid="objective-select"
            value={objective}
            onChange={(event) => onObjectiveChange(event.target.value as Objective)}
          >
            <option value="task_success">Maximize task success</option>
            <option value="safe_value">Maximize safety-adjusted value</option>
          </select>
        </label>

        <label className="field">
          <span>Segment policy by</span>
          <select
            data-testid="segment-select"
            value={segmentBy}
            onChange={(event) => onSegmentByChange(event.target.value as SegmentBy)}
          >
            <option value="none">None</option>
            <option value="prompt_risk">Prompt risk</option>
            <option value="device_tier">Device tier</option>
            <option value="task_domain">Task domain</option>
          </select>
        </label>

        <label className="field">
          <span>Max guardrail level: {maxPolicyLevel}</span>
          <input
            data-testid="policy-slider"
            type="range"
            min={0}
            max={4}
            step={1}
            value={maxPolicyLevel}
            onChange={(event) => onMaxPolicyLevelChange(Number(event.target.value))}
          />
        </label>
      </div>

      <button
        data-testid="generate-policy"
        className="button-primary"
        type="button"
        onClick={onGenerate}
        disabled={loading}
      >
        {loading ? "Analyzing logs..." : hasResults ? "Recompute policy" : "Generate policy"}
      </button>
    </section>
  );
}
