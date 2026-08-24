/**
 * Public, read-only feed for shop.useitup.uk (HANDOFF_ig-marketing-affiliate-agent-design.md).
 * No X-Admin-Token — affiliate_products only ever holds marketing data (product name, category,
 * public Amazon link, public image URL), nothing secret.
 */
import { Hono } from "hono";
import type { AffiliateProduct, ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const affiliateProductsRouter = new Hono<{ Bindings: DbEnv }>();

affiliateProductsRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) =>
      db
        .collection("affiliate_products")
        .find({ imageUrl: { $type: "string", $ne: "" } })
        .sort({ lastUsedAt: -1 })
        .limit(60)
        .toArray(),
    );
    const data: AffiliateProduct[] = docs.map((doc) => ({
      productName: String(doc.productName),
      category: String(doc.category),
      asin: String(doc.asin),
      affiliateLink: String(doc.affiliateLink),
      imageUrl: String(doc.imageUrl),
      lastUsedAt: String(doc.lastUsedAt),
    }));
    const body: ApiResponse<AffiliateProduct[]> = { ok: true, data };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] affiliate-products list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch affiliate_products" } };
    return c.json(body, 502);
  }
});
