interface ControlsProps {
  weeklyRequests: number;
  incidentCostUsd: number;
  onWeeklyRequestsChange: (value: number) => void;
  onIncidentCostChange: (value: number) => void;
  onGenerate: () => void;
  loading: boolean;
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

export function Controls({
  weeklyRequests,
  incidentCostUsd,
  onWeeklyRequestsChange,
  onIncidentCostChange,
  onGenerate,
  loading
}: ControlsProps): JSX.Element {
  return (
    <section className="controls-panel" aria-label="Assumptions">
      <div className="controls-grid">
        <label className="field">
          <span>Weekly traffic</span>
          <input
            data-testid="weekly-requests"
            type="number"
            min={10000}
            step={10000}
            value={weeklyRequests}
            onChange={(event) => onWeeklyRequestsChange(clampPositive(Number(event.target.value), 5_000_000))}
          />
        </label>

        <label className="field">
          <span>Cost per safety incident (USD)</span>
          <input
            data-testid="incident-cost"
            type="number"
            min={1}
            step={10}
            value={incidentCostUsd}
            onChange={(event) => onIncidentCostChange(clampPositive(Number(event.target.value), 2500))}
          />
        </label>
      </div>

      <button
        data-testid="recalculate-impact"
        className="button-primary"
        type="button"
        onClick={onGenerate}
        disabled={loading}
      >
        {loading ? "Recalculating..." : "Recalculate impact"}
      </button>
    </section>
  );
}
