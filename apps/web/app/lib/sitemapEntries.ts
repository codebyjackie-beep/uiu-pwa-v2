/**
 * Builds /sitemap.xml entries: 4 static public pages + every public recipe.
 *
 * Failure-safe by design (Lighthouse 2026-10-25 saw /sitemap.xml return HTTP 500): any API error,
 * thrown error or timeout falls back to the static pages — buildSitemapEntries never throws.
 *
 * No imports with runtime side effects (Clerk / next/headers / opennext) so the test can run under plain Node.
 */
import type { ApiResponse, RecipeListPage } from "@uiu/shared";

export const SITE_BASE = "https://useitup.uk";

/** GET /api/recipes caps `limit` at 250 (MAX_LIMIT in apps/api/src/routes/recipes.ts). 293 public on 2026-11-26 → 2 calls. */
export const SITEMAP_PAGE_SIZE = 250;
/** Hard cap on API calls per sitemap request (Workers subrequest budget). 4 × 250 = 1,000 recipes. */
export const SITEMAP_MAX_PAGES = 4;
/** Per-call timeout; apiGet itself has none. */
export const SITEMAP_FETCH_TIMEOUT_MS = 8000;

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

export type FetchRecipePage = (page: number, limit: number) => Promise<ApiResponse<RecipeListPage>>;

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sitemap fetch timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Public recipe entries, or null on any failure (caller falls back to static pages only). */
async function recipeEntries(fetchPage: FetchRecipePage, timeoutMs: number): Promise<SitemapEntry[] | null> {
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  for (let page = 1; page <= SITEMAP_MAX_PAGES; page++) {
    const res = await withTimeout(fetchPage(page, SITEMAP_PAGE_SIZE), timeoutMs);
    if (!res || !res.ok || !Array.isArray(res.data?.items)) return null;
    const { items, total } = res.data;
    for (const item of items) {
      // The API already filters isPublic:true; the list item has no isPublic field. This is belt-and-braces only.
      if ((item as { isPublic?: unknown }).isPublic === false) continue;
      const id = typeof item?._id === "string" ? item._id : "";
      if (!OBJECT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      const lastModified = parseLastModified(item);
      entries.push({
        url: `${SITE_BASE}/recipes/${id}`,
        ...(lastModified ? { lastModified } : {}),
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
    const totalNum = typeof total === "number" && Number.isFinite(total) ? total : 0;
    if (items.length < SITEMAP_PAGE_SIZE || page * SITEMAP_PAGE_SIZE >= totalNum) break;
  }
  return entries;
}

export async function buildSitemapEntries(
  fetchPage: FetchRecipePage,
  opts: { timeoutMs?: number; onError?: (message: string) => void } = {},
): Promise<SitemapEntry[]> {
  const base = staticSitemapEntries();
  try {
    const recipes = await recipeEntries(fetchPage, opts.timeoutMs ?? SITEMAP_FETCH_TIMEOUT_MS);
    if (!recipes) {
      opts.onError?.("recipes API returned a non-ok response");
      return base;
    }
    return [...base, ...recipes];
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return base;
  }
}
