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
