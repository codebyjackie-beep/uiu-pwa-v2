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
  source: "amazon_scrape" | "images_search";
}

// Only matches an EMPTY-alt image markdown tag `![](url)` — confirmed live that Amazon's own
// product-gallery image always renders with no alt text and no enclosing link, while page-top
// promo/campaign banners ("Second Chance Deal Days", "Back to Hogwarts. Harry Potter Shop Now.")
// always carry descriptive alt text and are wrapped in a `[![alt](img)](link)` markdown link.
// The `(?<!\[)` lookbehind excludes exactly that wrapped case. Do NOT loosen this to "first
// m-media-amazon image, any alt" — that regressed to picking up banner images (2026-08-28,
// caught re-verifying the force-backfill run below: B081JTZNRS, the one actually-published
// affiliate post, got overwritten with a Harry Potter promo banner under the looser regex).
const AMAZON_IMAGE_RE = /(?<!\[)!\[\]\((https?:\/\/m\.media-amazon\.com\/images\/I\/[^)\s]+\.(?:jpg|jpeg|png))\)/;
/** Amazon media CDN size modifier, e.g. `._SS75_` / `._SL1500_` in `.../41abc._SS75_.jpg` — stripping it serves the unscaled original. */
const AMAZON_SIZE_SUFFIX_RE = /\._[A-Z]{2}\d+_(?=\.[a-z]+$)/;

/**
 * 2026-08-28 rewrite (Jackie: a real live post linked a TOMEEM double-grinder ASIN but
 * showed a single-grinder photo) — the previous version searched Serper Shopping/Images by
 * product-name *keywords*, which finds *a* plausible-looking result, not necessarily a photo
 * of *this* ASIN's listing. Confirmed live: Shopping results carry no `/dp/{asin}` link (their
 * `link` field is an opaque Google Shopping redirect), and the organic search used by
 * lookupAsin() carries no image field at all — so neither response can be cross-checked
 * against the ASIN.
 *
 * Fix: scrape the ASIN's own `/dp/{asin}` page (`found.productUrl` from lookupAsin) via
 * Serper's `/scrape` endpoint with `includeMarkdown: true` and pull the product's own gallery
 * image out of the returned markdown (see AMAZON_IMAGE_RE comment for how it's distinguished
 * from a promo banner). Since the image comes from the exact ASIN's page, there's no keyword
 * ambiguity to resolve once the banner case is excluded. Returns null if the page has no
 * matching image (caller skips the product-photo and falls back to the generic Pexels search)
 * — never falls back to a keyword search that could return a different product's photo, and
 * never falls back to "just take the first image" that could return a banner ad.
 */
export async function scrapeProductImage(env: SerperEnv, productUrl: string): Promise<ProductImageResult | null> {
  const res = await fetch("https://scrape.serper.dev", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ url: productUrl, includeMarkdown: true }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { markdown?: string };
  const match = AMAZON_IMAGE_RE.exec(data.markdown ?? "");
  if (!match) return null;
  const imageUrl = match[1]!.replace(AMAZON_SIZE_SUFFIX_RE, "");
  return { imageUrl, source: "amazon_scrape" };
}

/**
 * 2026-08-30 fallback for when scrapeProductImage() finds nothing — investigated live why
 * B081JTZNRS (a real published post) had no image: `scrape.serper.dev`'s markdown extraction
 * is not a full-page render, it's a readability-style excerpt that varies call to call (10
 * live samples across 2 ASINs returned "About this Item" bullets, a review blurb, a ClimeCo
 * badge, or an outright 500 — never once the gallery image markdown). Retrying the scrape
 * would not reliably fix this.
 *
 * Fix: query Google Images (via Serper) for `site:amazon.co.uk {asin}` — when Google has the
 * ASIN indexed on the listing page, this returns results whose `link` is the exact
 * `/dp/{asin}` URL, so the match is verified against the ASIN itself (no keyword-mismatch risk
 * like the pre-2026-08-28 bug). Confirmed live: this query found B081JTZNRS's real product
 * photos on the first try. It is NOT universal — a keyword-based images search for
 * B0CJ974CT4 returned 10 results and none linked to `/dp/B0CJ974CT4` (that ASIN just isn't
 * indexed by Google under a searchable title), so this fallback intentionally only accepts a
 * result whose link contains the exact ASIN, and returns null (never a best-guess) otherwise.
 */
export async function searchProductImageByAsin(env: SerperEnv, asin: string): Promise<ProductImageResult | null> {
  const res = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: `site:amazon.co.uk ${asin}`, gl: "uk" }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    images?: Array<{ imageUrl?: string; link?: string; imageWidth?: number; imageHeight?: number }>;
  };
  const matches = (data.images ?? []).filter((img) => img.link?.includes(`/dp/${asin}`) && img.imageUrl?.includes("m.media-amazon.com"));
  // Prefer the largest result — the ASIN-verified matches include both full-size gallery
  // photos and small thumbnail crops, and the thumbnail isn't worth publishing.
  matches.sort((a, b) => (b.imageWidth ?? 0) * (b.imageHeight ?? 0) - (a.imageWidth ?? 0) * (a.imageHeight ?? 0));
  const best = matches[0];
  if (!best?.imageUrl) return null;
  const imageUrl = best.imageUrl.replace(AMAZON_SIZE_SUFFIX_RE, "");
  return { imageUrl, source: "images_search" };
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
