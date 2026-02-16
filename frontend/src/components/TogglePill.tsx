import { Method } from "../api/client";

interface TogglePillProps {
  value: Method;
  onChange: (value: Method) => void;
}

export function TogglePill({ value, onChange }: TogglePillProps): JSX.Element {
  return (
    <div className="toggle-pill" role="tablist" aria-label="Method toggle" data-testid="method-toggle">
      <button
        type="button"
        className={value === "naive" ? "active" : ""}
        data-testid="toggle-naive"
        onClick={() => onChange("naive")}
      >
        Naive
      </button>
      <button
        type="button"
        className={value === "dr" ? "active" : ""}
        data-testid="toggle-dr"
        onClick={() => onChange("dr")}
      >
        Counterfactual (DR)
      </button>
    </div>
  );
}
