/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — ASIN lookup via Serper
 * (serper.dev Google Search API), not direct Amazon scraping. Amazon's own
 * robots.txt disallows ClaudeBot/most crawlers site-wide (confirmed live —
 * `/dp/` and `/s` returned 500/503 to WebFetch before robots.txt was even
 * checked), so this queries Google's indexed results instead: Serper never
 * touches amazon.co.uk directly, it proxies a Google SERP that already
 * contains `/dp/{ASIN}` links.
 */
export interface SerperEnv {
  SERPER_API_KEY: string;
}

export interface AsinLookupResult {
  asin: string;
  title: string;
  productUrl: string;
}

const ASIN_RE = /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/;

/**
 * Searches `"{query} site:amazon.co.uk"` and returns the first organic
 * result whose link contains a `/dp/{ASIN}` product path. Returns null if
 * Serper has no matching result — callers must handle that (skip the
 * product, do not fabricate an ASIN).
 */
export async function lookupAsin(env: SerperEnv, query: string): Promise<AsinLookupResult | null> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: `${query} site:amazon.co.uk`, gl: "uk" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Serper search failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { organic?: Array<{ link?: string; title?: string }> };
  for (const result of data.organic ?? []) {
    const link = result.link;
    if (!link) continue;
    const match = ASIN_RE.exec(link);
    if (match) {
      return { asin: match[1]!, title: result.title ?? query, productUrl: link };
    }
  }
  return null;
}

export function buildAffiliateLink(asin: string, associateTag: string): string {
  return `https://www.amazon.co.uk/dp/${asin}?tag=${associateTag}`;
}

export interface ProductImageResult {
  imageUrl: string;
  source: "serper_shopping" | "serper_images";
}

/**
 * Real product-photo search for affiliate posts (2026-08-24 addendum — the
 * imageQuery/Pexels path in igContentGen.ts only ever returns generic stock
 * lifestyle photos, never the actual listing photo). Tries Serper's Shopping
 * endpoint first (results are genuine product-listing photos, usually
 * white-background), falls back to Serper Images with a "product photo white
 * background" qualifier if Shopping has no hit. Returns null if neither
 * finds anything — caller falls back to Pexels.
 */
export async function searchProductImage(env: SerperEnv, query: string): Promise<ProductImageResult | null> {
  const shoppingRes = await fetch("https://google.serper.dev/shopping", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "uk" }),
  });
  if (shoppingRes.ok) {
    const data = (await shoppingRes.json()) as { shopping?: Array<{ imageUrl?: string }> };
    const imageUrl = data.shopping?.find((item) => item.imageUrl)?.imageUrl;
    if (imageUrl) return { imageUrl, source: "serper_shopping" };
  }

  const imagesRes = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: `${query} product photo white background`, gl: "uk" }),
  });
  if (imagesRes.ok) {
    const data = (await imagesRes.json()) as { images?: Array<{ imageUrl?: string }> };
    const imageUrl = data.images?.find((item) => item.imageUrl)?.imageUrl;
    if (imageUrl) return { imageUrl, source: "serper_images" };
  }

  return null;
}
