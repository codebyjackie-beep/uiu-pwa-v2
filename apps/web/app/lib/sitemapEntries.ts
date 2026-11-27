/**
 * Builds /sitemap.xml entries: 4 static public pages + every public recipe.
 *
 * Failure-safe by design (Lighthouse 2026-10-25 saw /sitemap.xml return HTTP 500): any API error,
 * thrown error or timeout falls back to the static pages — buildSitemapEntries never throws.
 *
 * No imports with runtime side effects (Clerk / next/headers / opennext) so the test can run under plain Node.
 */
import type { ApiResponse, RecipeListItem, RecipeListPage } from "@uiu/shared";

export const SITE_BASE = "https://useitup.uk";

/** GET /api/recipes caps `limit` at 250 (MAX_LIMIT in apps/api/src/routes/recipes.ts). 293 public on 2026-11-26 → 2 calls. */
export const SITEMAP_PAGE_SIZE = 250;
/** Hard cap on API calls per sitemap request (Workers subrequest budget). 4 × 250 = 1,000 recipes. */
export const SITEMAP_MAX_PAGES = 4;
/** Per-call timeout; the in-flight request is aborted (AbortSignal) when it fires, not just abandoned. */
export const SITEMAP_FETCH_TIMEOUT_MS = 8000;
/** Whole-build deadline across all pages, so a slow API cannot stack 4 x 8s = 32s. */
export const SITEMAP_TOTAL_TIMEOUT_MS = 15000;
/** How long a successful build is reused. New recipes show up in /sitemap.xml at most this long after publish. */
export const SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000;
/** After a failed build, don't hit the API again for this long (serve stale / static meanwhile). */
export const SITEMAP_FAILURE_BACKOFF_MS = 30 * 1000;

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

export function staticSitemapEntries(): SitemapEntry[] {
  return [
    { url: `${SITE_BASE}/how-it-works`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_BASE}/recipes`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_BASE}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_BASE}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}

/** `signal` is aborted when the per-call / total timeout fires; implementations should pass it to fetch. */
export type FetchRecipePage = (page: number, limit: number, signal?: AbortSignal) => Promise<ApiResponse<RecipeListPage>>;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * lastmod only from a real, parseable `updatedAt` on the item. GET /api/recipes does not project
 * `updatedAt` today, so this is normally undefined (no lastmod) — we never invent one with `new Date()`.
 */
function parseLastModified(item: unknown): Date | undefined {
  const raw = (item as { updatedAt?: unknown }).updatedAt;
  if (typeof raw !== "string" && !(raw instanceof Date)) return undefined;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms);
}

/**
 * Rejects after `ms` AND aborts `controller`, so a hung request is cancelled rather than left running.
 * The race is kept as a backstop for fetchers that ignore the signal. Reject first, then abort: the
 * abort makes the fetcher settle later, and the timeout error must win the race.
 */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`sitemap fetch timed out after ${ms}ms`));
      controller.abort();
    }, ms);
  });
  // run() may throw synchronously; Promise.resolve().then keeps that inside the promise chain.
  const work = Promise.resolve().then(() => run(controller.signal));
  work.catch(() => {}); // a late rejection after the timeout won must not surface as unhandled
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Public recipe entries (+ the raw items, for hub entries), or null on any failure (caller falls back to static pages only). */
async function recipeEntries(
  fetchPage: FetchRecipePage,
  timeoutMs: number,
  totalTimeoutMs: number,
  onWarn?: (message: string) => void,
): Promise<{ entries: SitemapEntry[]; items: RecipeListItem[] } | null> {
  const deadline = Date.now() + totalTimeoutMs;
  let fetched = 0;
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  const kept: RecipeListItem[] = [];
  for (let page = 1; page <= SITEMAP_MAX_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`sitemap build exceeded ${totalTimeoutMs}ms`);
    const res = await withTimeout((signal) => fetchPage(page, SITEMAP_PAGE_SIZE, signal), Math.min(timeoutMs, remaining));
    if (!res || !res.ok || !Array.isArray(res.data?.items)) return null;
    const { items, total } = res.data;
    for (const item of items) {
      // The API already filters isPublic:true; the list item has no isPublic field. This is belt-and-braces only.
      if ((item as { isPublic?: unknown }).isPublic === false) continue;
      const id = typeof item?._id === "string" ? item._id : "";
      if (!OBJECT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      kept.push(item);
      const lastModified = parseLastModified(item);
      entries.push({
        url: `${SITE_BASE}/recipes/${id}`,
        ...(lastModified ? { lastModified } : {}),
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
    fetched += items.length;
    const totalNum = typeof total === "number" && Number.isFinite(total) ? total : 0;
    if (items.length < SITEMAP_PAGE_SIZE || page * SITEMAP_PAGE_SIZE >= totalNum) break;
    if (page === SITEMAP_MAX_PAGES && totalNum > fetched) {
      onWarn?.(
        `public recipes (${totalNum}) exceed the sitemap cap (${SITEMAP_MAX_PAGES} pages x ${SITEMAP_PAGE_SIZE}); truncated after ${fetched}`,
      );
    }
  }
  return { entries, items: kept };
}

export interface SitemapBuildOptions {
  timeoutMs?: number;
  totalTimeoutMs?: number;
  onError?: (message: string) => void;
  onWarn?: (message: string) => void;
  /** Extra URLs (SEO hub pages) built from the recipe items already fetched — no extra API calls. Only used on success. */
  extraEntries?: (items: RecipeListItem[]) => SitemapEntry[];
}

/** `ok:false` means the static fallback was returned because the API failed (not because there are 0 recipes). */
export async function buildSitemapResult(
  fetchPage: FetchRecipePage,
  opts: SitemapBuildOptions = {},
): Promise<{ entries: SitemapEntry[]; ok: boolean }> {
  const base = staticSitemapEntries();
  try {
    const recipes = await recipeEntries(
      fetchPage,
      opts.timeoutMs ?? SITEMAP_FETCH_TIMEOUT_MS,
      opts.totalTimeoutMs ?? SITEMAP_TOTAL_TIMEOUT_MS,
      opts.onWarn,
    );
    if (!recipes) {
      opts.onError?.("recipes API returned a non-ok response");
      return { entries: base, ok: false };
    }
    let extra: SitemapEntry[] = [];
    try {
      extra = opts.extraEntries?.(recipes.items) ?? [];
    } catch (err) {
      // A hub bug must never cost us the recipe URLs.
      opts.onError?.(`sitemap extra entries failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { entries: [...base, ...recipes.entries, ...extra], ok: true };
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return { entries: base, ok: false };
  }
}

export async function buildSitemapEntries(fetchPage: FetchRecipePage, opts: SitemapBuildOptions = {}): Promise<SitemapEntry[]> {
  return (await buildSitemapResult(fetchPage, opts)).entries;
}

/**
 * Per-isolate in-memory cache around a sitemap build.
 *
 * Why not Next `revalidate` / fetch cache: open-next.config.ts configures no incremental cache, so ISR
 * does nothing on Workers (see the comment in sitemap.ts). Instead we keep the last good result in module
 * scope. Each Worker isolate has its own copy, so worst-case staleness is still `ttlMs`.
 *
 * - Only successful builds are cached; the 4-page static fallback is never stored as "good".
 * - On failure we serve the last good (stale) result if there is one, else the static fallback, and back
 *   off `failureBackoffMs` before touching the API again.
 * - No in-flight sharing between requests: a promise created in one request must not be awaited by another
 *   on Workers (cross-request I/O). A concurrent miss just builds its own copy; cached values are plain data.
 */
export function createCachedSitemap(
  build: () => Promise<{ entries: SitemapEntry[]; ok: boolean }>,
  opts: { ttlMs?: number; failureBackoffMs?: number; now?: () => number } = {},
): () => Promise<SitemapEntry[]> {
  const ttlMs = opts.ttlMs ?? SITEMAP_CACHE_TTL_MS;
  const backoffMs = opts.failureBackoffMs ?? SITEMAP_FAILURE_BACKOFF_MS;
  const now = opts.now ?? Date.now;
  let good: { entries: SitemapEntry[]; at: number } | null = null;
  let retryAfter = 0;
  let lastFallback: SitemapEntry[] | null = null;

  return async () => {
    const t = now();
    if (good && t - good.at < ttlMs) return good.entries;
    if (t < retryAfter) return good?.entries ?? lastFallback ?? staticSitemapEntries();
    const result = await build();
    if (result.ok) {
      good = { entries: result.entries, at: now() };
      retryAfter = 0;
      lastFallback = null;
      return result.entries;
    }
    retryAfter = now() + backoffMs;
    lastFallback = result.entries;
    return good?.entries ?? result.entries;
  };
}
