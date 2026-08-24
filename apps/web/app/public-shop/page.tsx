import type { AffiliateProduct } from "@uiu/shared";
import { apiGet } from "../lib/api";

export const metadata = { title: "Kitchen Picks · Kura Nook" };

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default async function PublicShopPage() {
  const res = await apiGet<AffiliateProduct[]>("/api/affiliate-products");
  const products = res.ok ? res.data : [];

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px 64px", fontFamily: "var(--font)" }}>
      <header style={{ textAlign: "center", marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--uiu-green-ink)", margin: 0 }}>Kura Nook — Kitchen Picks</h1>
        <p style={{ fontSize: 14, color: "#555", marginTop: 8 }}>
          Kitchen &amp; cooking products we&apos;ve recommended on{" "}
          <a href="https://www.instagram.com/kura.nook" target="_blank" rel="noreferrer" style={{ color: "var(--uiu-green)" }}>
            @kura.nook
          </a>
          . As an Amazon Associate we earn from qualifying purchases.
        </p>
      </header>

      {!res.ok && <p style={{ textAlign: "center", color: "#999" }}>Couldn&apos;t load products right now — please check back soon.</p>}
      {res.ok && products.length === 0 && <p style={{ textAlign: "center", color: "#999" }}>No products yet — check back soon.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 20 }}>
        {products.map((p) => (
          <a
            key={p.asin}
            href={p.affiliateLink}
            target="_blank"
            rel="noopener noreferrer sponsored"
            style={{
              display: "block",
              border: "1px solid #eee",
              borderRadius: 12,
              overflow: "hidden",
              textDecoration: "none",
              color: "inherit",
              background: "#fff",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.imageUrl} alt={p.productName} style={{ width: "100%", height: 200, objectFit: "cover", display: "block" }} />
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{p.productName}</div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{p.category}</div>
              <div
                style={{
                  display: "inline-block",
                  marginTop: 10,
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--uiu-green-ink)",
                  background: "#eafbf1",
                  borderRadius: 999,
                  padding: "4px 10px",
                }}
              >
                Shop on Amazon →
              </div>
              <div style={{ fontSize: 10, color: "#aaa", marginTop: 8 }}>Recommended {formatDate(p.lastUsedAt)}</div>
            </div>
          </a>
        ))}
      </div>

      <p style={{ textAlign: "center", fontSize: 11, color: "#aaa", marginTop: 40 }}>#ad Affiliate links — as an Amazon Associate we earn from qualifying purchases.</p>
    </div>
  );
}
