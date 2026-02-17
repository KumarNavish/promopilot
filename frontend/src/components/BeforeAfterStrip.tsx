import { useEffect, useMemo, useState } from "react";
import { Objective } from "../api/client";

export interface MethodSummary {
  bookings: number;
  netValue: number;
  avgDiscount: number;
}

interface BeforeAfterStripProps {
  objective: Objective;
  naive: MethodSummary;
  dr: MethodSummary;
}

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function BeforeAfterStrip({ objective, naive, dr }: BeforeAfterStripProps): JSX.Element {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(false);
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, [objective, naive.avgDiscount, naive.bookings, naive.netValue, dr.avgDiscount, dr.bookings, dr.netValue]);

  const objectiveLabel = objective === "bookings" ? "Bookings / 10k" : "Net value / 10k";
  const naiveObjective = objective === "bookings" ? naive.bookings : naive.netValue;
  const drObjective = objective === "bookings" ? dr.bookings : dr.netValue;
  const objectiveScale = Math.max(naiveObjective, drObjective, 1);
  const discountScale = Math.max(naive.avgDiscount, dr.avgDiscount, 1);

  const barWidths = useMemo(
    () => ({
      naiveObjective: (naiveObjective / objectiveScale) * 100,
      drObjective: (drObjective / objectiveScale) * 100,
      naiveDiscount: (naive.avgDiscount / discountScale) * 100,
      drDiscount: (dr.avgDiscount / discountScale) * 100
    }),
    [discountScale, dr.avgDiscount, drObjective, naive.avgDiscount, naiveObjective, objectiveScale]
  );

  const objectiveDelta = drObjective - naiveObjective;
  const discountDelta = dr.avgDiscount - naive.avgDiscount;

  return (
    <section className="panel before-after-panel" data-testid="before-after-strip">
      <div className="before-after-head">
        <p className="eyebrow">Before / After</p>
        <h3>Naive over-discount vs bias-adjusted policy</h3>
      </div>

      <div className="before-after-columns">
        <article className="strip-card strip-before">
          <p className="strip-title">Before: Naive observed</p>
          <p className="strip-meta">
            {objectiveLabel}: {formatNumber(naiveObjective, objective === "bookings" ? 1 : 0)} | Avg discount{" "}
            {naive.avgDiscount.toFixed(1)}%
          </p>

          <div className="strip-row">
            <span>{objectiveLabel}</span>
            <div className="strip-track">
              <div className="strip-fill objective before" style={{ width: animate ? `${barWidths.naiveObjective}%` : "0%" }} />
            </div>
          </div>
          <div className="strip-row">
            <span>Avg discount</span>
            <div className="strip-track">
              <div className="strip-fill discount before" style={{ width: animate ? `${barWidths.naiveDiscount}%` : "0%" }} />
            </div>
          </div>
        </article>

        <article className="strip-card strip-after">
          <p className="strip-title">After: Bias-adjusted</p>
          <p className="strip-meta">
            {objectiveLabel}: {formatNumber(drObjective, objective === "bookings" ? 1 : 0)} | Avg discount{" "}
            {dr.avgDiscount.toFixed(1)}%
          </p>

          <div className="strip-row">
            <span>{objectiveLabel}</span>
            <div className="strip-track">
              <div className="strip-fill objective after" style={{ width: animate ? `${barWidths.drObjective}%` : "0%" }} />
            </div>
          </div>
          <div className="strip-row">
            <span>Avg discount</span>
            <div className="strip-track">
              <div className="strip-fill discount after" style={{ width: animate ? `${barWidths.drDiscount}%` : "0%" }} />
            </div>
          </div>
        </article>
      </div>

      <p className="strip-delta">
        Objective delta: <strong>{signed(objectiveDelta, objective === "bookings" ? 1 : 0)}</strong> | Discount delta:{" "}
        <strong>{signed(discountDelta)}</strong> percentage points (DR - Naive).
      </p>
    </section>
  );
}
