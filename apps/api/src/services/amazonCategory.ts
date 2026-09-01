/**
 * Real Amazon category detection for the commission-rate product filter
 * (cc_prompt_commission_rate_filter.md, 2026-09-01). igContentGen.ts's suggestAffiliateProduct()
 * asks the LLM for a freeform "category" string, which is never checked against Amazon's actual
 * taxonomy — it could say "kitchen storage" for a product Amazon itself files under something
 * that pays 3% or 0%. This module verifies against the real listing instead of trusting the LLM.
 *
 * Confirmed live (scrape.serper.dev on B081JTZNRS / B07DZN4GKF) that Amazon's own page title
 * always ends " : Amazon.co.uk: {Top-Level Category}" (e.g. "Home & Kitchen", "Pet Supplies"),
 * and the "Best Sellers Rank" block lists real browse-node names — a top-level one plus a more
 * specific sub-category (e.g. "1,445 in Home & Kitchen" + "20 in Container Sets"). Both come
 * from the same scrape.serper.dev call scrapeProductImage() already makes for the product photo
 * — no extra request needed per product.
 *
 * KNOWN LIMITATION (told to Jackie, not hidden): Amazon UK's top-level node for most kitchen
 * items is the combined "Home & Kitchen", not a clean split matching the commission table's
 * 4.5% Kitchen vs 3% Home. This is disambiguated below using the BSR sub-category keywords
 * (cookware/bakeware/container/utensil etc. -> Kitchen), falling back to Home (3%) when nothing
 * kitchen-specific is found. That's a best-effort keyword match on Amazon's own category text,
 * not a guess from the product name — but it is still an approximation, not the exact rate
 * Amazon will actually pay on that sale. Good enough to keep product *selection* on-niche; not
 * a substitute for checking real payout reports.
 */
import type { SerperEnv } from "./serper";

export type TargetedCategory = "Kitchen" | "Furniture" | "Home" | "Home Improvement" | "Lawn & Garden" | "Pets Products" | "Tools";

export const CATEGORY_RATES: Record<TargetedCategory, number> = {
  Kitchen: 4.5,
  Furniture: 3,
  Home: 3,
  "Home Improvement": 3,
  "Lawn & Garden": 3,
  "Pets Products": 3,
  Tools: 3,
};

export type CategoryDetection =
  | { ok: true; category: TargetedCategory; rate: number; rawAmazonCategory: string }
  | { ok: false; reason: "no_signal" | "out_of_scope" | "scrape_failed"; rawAmazonCategory?: string };

/** Checked in priority order (most specific first) — a Home & Kitchen listing whose BSR sub-category
 * mentions cookware wins Kitchen over the generic Home catch-all at the bottom of the list.
 *
 * 2026-09-01 fix: the Kitchen rule used to include a bare `container` keyword, which matched
 * Amazon's generic "Storage Containers" BSR sub-category on non-food storage products (under-bed
 * boxes, drawer dividers, vacuum storage bags, etc.) — confirmed live on a "furniture and home
 * organisation" collage where all 9 resolved products were wrongly bucketed into Kitchen (4.5%)
 * instead of Furniture/Home (3%), which also skewed hashtag generation toward kitchen terms
 * (igContentGen.ts builds the hashtag query from the resolved categories). Narrowed to
 * `food container` so it only fires on Amazon's actual food-storage sub-categories. */
const RULES: Array<{ category: TargetedCategory; keywords: RegExp }> = [
  { category: "Kitchen", keywords: /kitchen|cookware|bakeware|food container|cutlery|dinnerware|kettle|toaster|utensil|\bknives?\b|\bpans?\b|\bpots?\b|blender|mixer|dining|tableware|food storage/i },
  { category: "Furniture", keywords: /furniture|\bsofa\b|\bchairs?\b|\btables?\b|\bdesks?\b|shelv|cabinet|wardrobe|bed frame|mattress/i },
  { category: "Tools", keywords: /\btools?\b|power tool|hand tool|\bdrill\b|screwdriver/i },
  { category: "Home Improvement", keywords: /home improvement|\bdiy\b|lighting|plumbing|\bpaint\b|hardware/i },
  { category: "Lawn & Garden", keywords: /garden|outdoor|\bpatio\b|\blawn\b|plant pot|greenhouse/i },
  { category: "Pets Products", keywords: /pet supplies|\bpets?\b|\bdogs?\b|\bcats?\b/i },
  { category: "Home", keywords: /\bhome\b/i },
];

function extractSignals(text: string): { topLevel: string | null; bsr: string[] } {
  const firstLine = text.split("\n")[0] ?? "";
  const titleMatch = /Amazon\.co\.uk:\s*(.+)$/i.exec(firstLine);
  const topLevel = titleMatch?.[1]?.trim() ?? null;

  const bsr: string[] = [];
  const bsrBlockMatch = /Best Sellers Rank([\s\S]{0,400})/i.exec(text);
  if (bsrBlockMatch) {
    const itemRe = /\*\s*[\d,]+\s+in\s+([^\n(*]+)/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(bsrBlockMatch[1]!)) !== null) {
      bsr.push(m[1]!.trim());
    }
  }
  return { topLevel, bsr };
}

/** productUrl: found.productUrl from serper.ts's lookupAsin(), same input scrapeProductImage() uses. */
export async function detectAmazonCategory(env: SerperEnv, productUrl: string): Promise<CategoryDetection> {
  const res = await fetch("https://scrape.serper.dev", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ url: productUrl }),
  });
  if (!res.ok) return { ok: false, reason: "scrape_failed" };
  const data = (await res.json()) as { text?: string };
  const { topLevel, bsr } = extractSignals(data.text ?? "");
  const signals = [...bsr, topLevel].filter((s): s is string => Boolean(s));
  if (signals.length === 0) return { ok: false, reason: "no_signal" };

  for (const rule of RULES) {
    const matched = signals.find((s) => rule.keywords.test(s));
    if (matched) return { ok: true, category: rule.category, rate: CATEGORY_RATES[rule.category], rawAmazonCategory: matched };
  }
  return { ok: false, reason: "out_of_scope", rawAmazonCategory: signals[0] };
}
