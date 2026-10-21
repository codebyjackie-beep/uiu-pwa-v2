"use client";

import { useEffect, useState } from "react";
import type { ApiResponse } from "@uiu/shared";

type Bucket = { items: number; valueGbp: number; pricedItems: number; grams: number };
type Impact = { month: { used: Bucket; wasted: Bucket }; allTime: { used: Bucket; wasted: Bucket; since: string | null }; usedRate: number | null };

const gbp = (n: number) => `£${n.toFixed(2)}`;
function kg(g: number): string | null {
  return g >= 100 ? `${(g / 1000).toFixed(1)} kg` : null;
}

/** Impact (claude/research_rminder_competitors.md #2): what left the fridge used vs thrown away, with a £ estimate where the
 * item has a price. Items without a price still count as items, never as £ ("≈" because prices are estimates). */
export function ImpactCard({ version }: { version: number }) {
  const [data, setData] = useState<Impact | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/fridge-stock/impact").catch(() => null);
      const parsed = (await res?.json().catch(() => null)) as ApiResponse<Impact> | null;
      if (!cancelled && parsed?.ok) setData(parsed.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!data) return null;
  const { used, wasted } = data.month;
  const empty = data.allTime.used.items + data.allTime.wasted.items === 0;
  const usedKg = kg(used.grams);

  return (
    <section className="impact-card" aria-label="Your impact">
      <h2 className="impact-card__title">Your impact this month</h2>
      {empty ? (
        <p className="impact-card__hint">Tap <strong>Used</strong> or <strong>Binned</strong> when food leaves your fridge to see what you save.</p>
      ) : (
        <>
          <div className="impact-card__stats">
            <div className="impact-card__stat impact-card__stat--used">
              <span className="impact-card__num">{used.items}</span>
              <span className="impact-card__label">used up{used.pricedItems ? ` · ≈${gbp(used.valueGbp)}` : ""}</span>
            </div>
            <div className="impact-card__stat impact-card__stat--wasted">
              <span className="impact-card__num">{wasted.items}</span>
              <span className="impact-card__label">binned{wasted.pricedItems ? ` · ≈${gbp(wasted.valueGbp)}` : ""}</span>
            </div>
          </div>
          {usedKg ? <p className="impact-card__hint">That&apos;s about {usedKg} of food kept out of the bin.</p> : null}
          {data.usedRate !== null ? (
            <p className="impact-card__hint">All time you&apos;ve used {Math.round(data.usedRate * 100)}% of what left your fridge.</p>
          ) : null}
        </>
      )}
      <p className="impact-card__source">An average UK family of four throws away about £1,000 of food a year (WRAP).</p>
    </section>
  );
}
