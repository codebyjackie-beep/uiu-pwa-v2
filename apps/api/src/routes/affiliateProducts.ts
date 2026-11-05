/**
 * Public, read-only feed for shop.useitup.uk (HANDOFF_ig-marketing-affiliate-agent-design.md).
 * No X-Admin-Token — affiliate_products only ever holds marketing data (product name, category,
 * public Amazon link, public image URL), nothing secret.
 */
import { Hono } from "hono";
import type { AffiliateProduct, ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const affiliateProductsRouter = new Hono<{ Bindings: DbEnv }>();

// 2026-11-04 (Jackie): the in-app "Kitchen & Home Picks" list is kitchen + home only. These are HIDDEN from the
// public feed, not deleted — nothing is written to the DB; revert this block to bring them back (59 rows).
//  - whole categories: Pets Products (22), Lawn & Garden (22), Home Improvement (2)
//  - 13 hand tools in the "Tools" category, by ASIN (the other Tools rows — shoe organiser, hooks, pegboard
//    organiser, cable box, grass rug, hose reel — stay).
const HIDDEN_CATEGORIES = ["Pets Products", "Lawn & Garden", "Home Improvement"];
const HIDDEN_TOOL_ASINS = [
  "B0837F9CZW", // Cordless screwdriver
  "B0C2ZRJ3H8", // Multi-bit screwdriver set
  "B09PHTWN6B", // Cordless electric screwdriver set
  "B001B1WBGI", // Spirit level
  "B08C77QPPH", // Spirit level
  "B09X5G4KZF", // Utility knife set
  "B08FQTDLNR", // Needle nose pliers
  "B00V4PEHNG", // Pipe wrench
  "B000LFXLFA", // Adjustable wrench set
  "B096MXZPJ5", // Hex key set
  "B0GY951YBW", // Caulking gun
  "B0GWMCLD52", // Cordless electric drill
  "B0DPB3NDJS", // Workbench clamp set
];

affiliateProductsRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) =>
      db
        .collection("affiliate_products")
        .find({
          imageUrl: { $type: "string", $ne: "" },
          category: { $nin: HIDDEN_CATEGORIES },
          asin: { $nin: HIDDEN_TOOL_ASINS },
        })
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
