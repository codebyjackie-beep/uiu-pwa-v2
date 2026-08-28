"use client";

import { useMemo, useState } from "react";
import type { AffiliateProduct } from "@uiu/shared";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function PublicShopGrid({ products }: { products: AffiliateProduct[] }) {
  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))).sort(), [products]);
  const [active, setActive] = useState<string | null>(null);
  const visible = active ? products.filter((p) => p.category === active) : products;

  return (
    <div className="public-shop-layout">
      {categories.length > 1 && (
        <div className="public-shop-categories">
          <button type="button" onClick={() => setActive(null)} style={pillStyle(active === null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" onClick={() => setActive(c)} style={pillStyle(active === c)}>
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="public-shop-content">
        {visible.length === 0 && <p style={{ textAlign: "center", color: "#9ca89e" }}>No products in this category yet.</p>}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 18,
          }}
        >
          {visible.map((p) => (
            <a
              key={p.asin}
              href={p.affiliateLink}
              target="_blank"
              rel="noopener noreferrer sponsored"
              style={{
                display: "block",
                borderRadius: 14,
                overflow: "hidden",
                textDecoration: "none",
                color: "inherit",
                background: "#0f1f16",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div style={{ width: "100%", aspectRatio: "1 / 1", overflow: "hidden", background: "#0a1510" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.imageUrl} alt={p.productName} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </div>
              <div style={{ padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35, color: "#f2f7f3" }}>{p.productName}</div>
                <div style={{ fontSize: 11, color: "#7fa88c", marginTop: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{p.category}</div>
                <div
                  style={{
                    display: "inline-block",
                    marginTop: 10,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#1a1a1a",
                    background: "#FF9900",
                    borderRadius: 999,
                    padding: "7px 14px",
                    transition: "filter 0.15s ease",
                  }}
                >
                  Shop on Amazon →
                </div>
                <div style={{ fontSize: 10, color: "#5f7a68", marginTop: 8 }}>Recommended {formatDate(p.lastUsedAt)}</div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function pillStyle(isActive: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    padding: "8px 16px",
    borderRadius: 999,
    border: isActive ? "1px solid #16a34a" : "1px solid rgba(255,255,255,0.14)",
    background: isActive ? "#16a34a" : "transparent",
    color: isActive ? "#0a0a0a" : "#cfe0d5",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
