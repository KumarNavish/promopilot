import { Method, RecommendResponse } from "../api/client";

interface PolicyCardProps {
  method: Method;
  response: RecommendResponse;
  objective: "bookings" | "net_value";
  highlighted?: boolean;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}

export function PolicyCard({ method, response, objective, highlighted = false }: PolicyCardProps): JSX.Element {
  const avgDiscount =
    response.segments.reduce((acc, item) => acc + item.recommended_discount_pct, 0) /
    Math.max(response.segments.length, 1);

  const totalPrimary = response.segments.reduce((acc, segment) => {
    return acc + (objective === "bookings" ? segment.expected_bookings_per_10k : segment.expected_net_value_per_10k);
  }, 0);

  const methodLabel = method === "dr" ? "Bias-adjusted counterfactual policy" : "Naive observed policy";
  const methodNote =
    method === "dr"
      ? "Adjusts for targeted promotion patterns before estimating impact."
      : "Uses raw historical outcomes without correcting for targeting bias.";
  const baselineDiscount = response.baseline.discount_pct;

  return (
    <section className={`panel policy-card ${highlighted ? "highlight" : ""}`} data-testid={`policy-card-${method}`}>
      <header className="policy-card-header">
        <h2>{methodLabel}</h2>
        <p>
          Avg discount <strong>{avgDiscount.toFixed(1)}%</strong> | Baseline <strong>{baselineDiscount}%</strong> | Primary
          objective <strong>{formatNumber(totalPrimary)}</strong>
        </p>
        <p className="method-note">{methodNote}</p>
      </header>

      <div className="policy-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Discount</th>
              <th>Bookings / 10k</th>
              <th>Net value / 10k</th>
              <th>Delta vs baseline</th>
            </tr>
          </thead>
          <tbody>
            {response.segments.map((segment, idx) => (
              <tr key={`${method}-${segment.segment}`}>
                <td>{segment.segment}</td>
                <td data-testid={`${method}-discount-${idx}`}>{segment.recommended_discount_pct}%</td>
                <td>{formatNumber(segment.expected_bookings_per_10k)}</td>
                <td>{formatNumber(segment.expected_net_value_per_10k)}</td>
                <td>
                  {objective === "bookings"
                    ? `${segment.delta_vs_baseline.bookings_per_10k.toFixed(1)} bookings`
                    : `${segment.delta_vs_baseline.net_value_per_10k.toFixed(1)} value`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {response.warnings.length > 0 ? <p className="subtle">{response.warnings.join(" | ")}</p> : null}
    </section>
  );
}
