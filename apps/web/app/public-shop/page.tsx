import type { AffiliateProduct } from "@uiu/shared";
import { apiGet } from "../lib/api";
import PublicShopGrid from "./PublicShopGrid";

export const metadata = { title: "Kitchen Picks · Kura Nook" };

/** @kura.nook bio logo (apps/web/public/kn-logo.png, resized+quantized to 200x200/~5KB from the 1024x1024 source). */
function KnLogo() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/kn-logo.png" alt="Kura Nook" width={40} height={40} style={{ borderRadius: 10 }} />;
}

export default async function PublicShopPage() {
  const res = await apiGet<AffiliateProduct[]>("/api/affiliate-products");
  const products = res.ok ? res.data : [];

  return (
    <div style={{ background: "#081a10", minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 16px 48px" }}>
        <header style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: 32, gap: 12 }}>
          <KnLogo />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f2f7f3", margin: 0 }}>Kura Nook — Kitchen Picks</h1>
          <p style={{ fontSize: 14, color: "#9cb5a6", margin: 0, maxWidth: 520 }}>
            Kitchen &amp; cooking products we&apos;ve recommended on{" "}
            <a href="https://www.instagram.com/kura.nook" target="_blank" rel="noreferrer" style={{ color: "#4ade80" }}>
              @kura.nook
            </a>
            .
          </p>
        </header>

        {!res.ok && <p style={{ textAlign: "center", color: "#9cb5a6" }}>Couldn&apos;t load products right now — please check back soon.</p>}
        {res.ok && products.length === 0 && <p style={{ textAlign: "center", color: "#9cb5a6" }}>No products yet — check back soon.</p>}

        <PublicShopGrid products={products} />

        <footer
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            textAlign: "center",
          }}
        >
          <a
            href="https://www.instagram.com/kura.nook"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#cfe0d5", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            @kura.nook on Instagram
          </a>
          <p style={{ fontSize: 11, color: "#5f7a68", marginTop: 16, lineHeight: 1.6, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
            #ad As an Amazon Associate, Kura Nook earns from qualifying purchases. Product links on this page are affiliate
            links — if you buy through them we may earn a small commission at no extra cost to you. We only recommend
            products we&apos;ve genuinely used or researched for our kitchen &amp; cooking content.
          </p>
        </footer>
      </div>
    </div>
  );
}
