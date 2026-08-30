"use client";

import { useMemo, useState } from "react";
import type { AffiliateProduct } from "@uiu/shared";

/** Plain functional grid (minimalistbaker.com/shop/ reference) — no brand skin, just the app's
 * own tokens/classes. Category filter reuses the existing .chip/.chip--active pattern. */
export default function ShopAffiliateGrid({ products }: { products: AffiliateProduct[] }) {
  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))).sort(), [products]);
  const [active, setActive] = useState<string | null>(null);
  const visible = active ? products.filter((p) => p.category === active) : products;

  return (
    <div>
      {categories.length > 1 && (
        <div className="recipes-filters__chips" style={{ marginBottom: "var(--space)" }}>
          <button type="button" className={`chip${active === null ? " chip--active" : ""}`} onClick={() => setActive(null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" className={`chip${active === c ? " chip--active" : ""}`} onClick={() => setActive(c)}>
              {c}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 && <p className="admin-drafts-page__sub">No products in this category yet.</p>}

      <div className="affiliate-grid">
        {visible.map((p) => (
          <div key={p.asin} className="affiliate-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="affiliate-card__image" src={p.imageUrl} alt={p.productName} />
            <div className="affiliate-card__body">
              <span className="affiliate-card__name">{p.productName}</span>
              <span className="badge">{p.category}</span>
              <a
                href={p.affiliateLink}
                target="_blank"
                rel="noopener noreferrer sponsored"
                className="wizard-primary-button affiliate-card__cta"
              >
                Shop on Amazon
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
