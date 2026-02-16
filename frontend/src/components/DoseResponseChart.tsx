import { useMemo, useState } from "react";
import { DoseResponsePoint, Objective, SegmentDoseResponse } from "../api/client";

interface DoseResponseChartProps {
  objective: Objective;
  doseResponse: SegmentDoseResponse[];
}

const WIDTH = 680;
const HEIGHT = 320;
const MARGIN = { top: 18, right: 18, bottom: 36, left: 56 };

function yValue(point: DoseResponsePoint, objective: Objective): number {
  return objective === "bookings" ? point.bookings_per_10k : point.net_value_per_10k;
}

export function DoseResponseChart({ objective, doseResponse }: DoseResponseChartProps): JSX.Element {
  const [activeSegment, setActiveSegment] = useState<string>(doseResponse[0]?.segment ?? "");

  const segmentOptions = useMemo(() => doseResponse.map((entry) => entry.segment), [doseResponse]);
  const selected = doseResponse.find((entry) => entry.segment === activeSegment) ?? doseResponse[0];

  if (!selected) {
    return (
      <section className="panel">
        <h3>Dose-response</h3>
        <p className="subtle">No chart data available.</p>
      </section>
    );
  }

  const points = selected.points;
  const xMin = Math.min(...points.map((point) => point.discount_pct));
  const xMax = Math.max(...points.map((point) => point.discount_pct));
  const yMin = Math.min(...points.map((point) => point.ci_low));
  const yMax = Math.max(...points.map((point) => point.ci_high));

  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const xScale = (value: number): number =>
    MARGIN.left + ((value - xMin) / Math.max(xMax - xMin, 1)) * innerWidth;
  const yScale = (value: number): number =>
    MARGIN.top + (1 - (value - yMin) / Math.max(yMax - yMin, 1)) * innerHeight;

  const linePath = points
    .map((point, idx) => `${idx === 0 ? "M" : "L"}${xScale(point.discount_pct)} ${yScale(yValue(point, objective))}`)
    .join(" ");

  return (
    <section className="panel chart-panel" data-testid="dose-response-chart">
      <div className="chart-header">
        <h3>Dose-response</h3>
        <label>
          Segment
          <select
            value={selected.segment}
            onChange={(event) => setActiveSegment(event.target.value)}
            data-testid="chart-segment-select"
          >
            {segmentOptions.map((segment) => (
              <option key={segment} value={segment}>
                {segment}
              </option>
            ))}
          </select>
        </label>
      </div>

      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Dose-response chart">
        <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={HEIGHT - MARGIN.bottom} stroke="var(--line)" />
        <line
          x1={MARGIN.left}
          y1={HEIGHT - MARGIN.bottom}
          x2={WIDTH - MARGIN.right}
          y2={HEIGHT - MARGIN.bottom}
          stroke="var(--line)"
        />

        {points.map((point) => {
          const x = xScale(point.discount_pct);
          return (
            <g key={`whisker-${point.discount_pct}`}>
              <line x1={x} y1={yScale(point.ci_low)} x2={x} y2={yScale(point.ci_high)} stroke="var(--whisker)" />
            </g>
          );
        })}

        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={3} />

        {points.map((point) => (
          <g key={`point-${point.discount_pct}`}>
            <circle cx={xScale(point.discount_pct)} cy={yScale(yValue(point, objective))} r={4} fill="var(--accent)" />
            <text
              x={xScale(point.discount_pct)}
              y={HEIGHT - MARGIN.bottom + 18}
              textAnchor="middle"
              className="axis-label"
            >
              {point.discount_pct}%
            </text>
          </g>
        ))}

        <text x={18} y={MARGIN.top + 8} className="axis-label">
          {objective === "bookings" ? "Bookings / 10k" : "Net value / 10k"}
        </text>
      </svg>
    </section>
  );
}
