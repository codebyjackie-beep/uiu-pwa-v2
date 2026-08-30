import type { AffiliateProduct } from "@uiu/shared";
import { apiGet } from "../lib/api";
import ShopAffiliateGrid from "./ShopAffiliateGrid";

export const metadata = { title: "Kitchen Picks · UseItUp" };

/**
 * 2026-08-31 brand merge (Jackie: drop the standalone Kura Nook site/account) — this replaces
 * shop.useitup.uk/public-shop as the affiliate product listing, now living inside the PWA
 * itself under the app shell (BottomNav included, since this isn't the shop.useitup.uk host —
 * see layout.tsx's isPublicShop check). Deliberately no KN branding: plain product grid using
 * the app's own tokens/classes, same direction as minimalistbaker.com/shop/.
 */
export default async function ShopAffiliatePage() {
  const res = await apiGet<AffiliateProduct[]>("/api/affiliate-products");
  const products = res.ok ? res.data : [];

  return (
    <div className="shop-page">
      <h1>Kitchen Picks</h1>
      <p className="admin-drafts-page__sub">
        Products we&apos;ve recommended on Instagram.{" "}
        <span style={{ color: "var(--uiu-muted)" }}>#ad — as an Amazon Associate we earn from qualifying purchases.</span>
      </p>

      {!res.ok && <p className="admin-drafts-error">Couldn&apos;t load products right now — please check back soon.</p>}
      {res.ok && products.length === 0 && <p className="admin-drafts-page__sub">No products yet — check back soon.</p>}

      <ShopAffiliateGrid products={products} />
    </div>
  );
}
