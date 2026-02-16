import { Objective, SegmentBy } from "../api/client";

interface ControlsProps {
  objective: Objective;
  maxDiscountPct: number;
  segmentBy: SegmentBy;
  onObjectiveChange: (value: Objective) => void;
  onMaxDiscountChange: (value: number) => void;
  onSegmentByChange: (value: SegmentBy) => void;
  onGenerate: () => void;
  loading: boolean;
}

export function Controls({
  objective,
  maxDiscountPct,
  segmentBy,
  onObjectiveChange,
  onMaxDiscountChange,
  onSegmentByChange,
  onGenerate,
  loading
}: ControlsProps): JSX.Element {
  return (
    <section className="panel controls-panel" aria-label="Controls">
      <div className="controls-grid">
        <label className="field">
          <span>Objective</span>
          <select
            data-testid="objective-select"
            value={objective}
            onChange={(event) => onObjectiveChange(event.target.value as Objective)}
          >
            <option value="bookings">Maximize bookings</option>
            <option value="net_value">Maximize net value</option>
          </select>
        </label>

        <label className="field">
          <span>Segmentation</span>
          <select
            data-testid="segment-select"
            value={segmentBy}
            onChange={(event) => onSegmentByChange(event.target.value as SegmentBy)}
          >
            <option value="none">None</option>
            <option value="loyalty_tier">Loyalty tier</option>
            <option value="price_sensitivity">Price sensitivity</option>
            <option value="device">Device</option>
          </select>
        </label>

        <label className="field">
          <span>Max discount: {maxDiscountPct}%</span>
          <input
            data-testid="discount-slider"
            type="range"
            min={0}
            max={20}
            step={5}
            value={maxDiscountPct}
            onChange={(event) => onMaxDiscountChange(Number(event.target.value))}
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
        {loading ? "Computing..." : "Generate policy"}
      </button>
    </section>
  );
}
