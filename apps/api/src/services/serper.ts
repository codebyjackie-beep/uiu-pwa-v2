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

const HASHTAG_RE = /#[a-zA-Z][a-zA-Z0-9]{2,29}/g;

/**
 * 2026-08-25 addendum (Jackie: hashtags must not be a hardcoded reused list) — searches
 * `"{topic} instagram hashtags"` and pulls real `#tag` tokens out of the organic result
 * titles/snippets, so the tag set actually reflects live usage for this specific topic
 * rather than a fixed static list. `exclude` filters out tags used in the last N drafts
 * (caller passes recent history) so back-to-back posts don't repeat the same set.
 * `fallback` is a small last-resort list used ONLY if the live search returns nothing
 * (e.g. Serper outage) — not the primary source.
 */
export async function researchHashtags(env: SerperEnv, topic: string, exclude: string[], fallback: string[], count = 5): Promise<string[]> {
  const excludeSet = new Set(exclude.map((h) => h.toLowerCase().replace(/^#/, "")));
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${topic} instagram hashtags`, gl: "uk" }),
    });
    if (res.ok) {
      const data = (await res.json()) as { organic?: Array<{ title?: string; snippet?: string }> };
      const text = (data.organic ?? []).map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`).join(" ");
      const found = Array.from(new Set((text.match(HASHTAG_RE) ?? []).map((h) => h.toLowerCase())));
      const filtered = found.filter((h) => !excludeSet.has(h.replace(/^#/, "")));
      if (filtered.length > 0) return filtered.slice(0, count);
    }
  } catch {
    // fall through to fallback list below
  }
  return fallback.filter((h) => !excludeSet.has(h.toLowerCase().replace(/^#/, ""))).slice(0, count);
}
