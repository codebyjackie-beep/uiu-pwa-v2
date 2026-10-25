import type { ApiResponse, RecipeListItem, RecipeListPage } from "@uiu/shared";
import { apiGet } from "../lib/api";
import RecipesBrowser from "./RecipesBrowser";

export const metadata = { title: "Recipes · UseItUp" };

// Page size per API call (the API caps `limit` at 250). The full set is assembled by paging
// through `total`, so the client-side filter UI below keeps working as the library grows —
// don't turn this into a bigger hard-coded "fetch everything" number.
const PAGE_SIZE = 250;

type AllRecipes = { items: RecipeListItem[]; total: number };

// Lighthouse / TTFB review 2026-10-25: /recipes took 5.6–6.2 s to first byte because every request paged
// through /api/recipes (3–4 s per call, one after the other). The public list is the same for everyone and
// prices only change weekly, so it is cached for 10 minutes: first in this isolate's memory, then in the
// Cloudflare edge cache of the useitup.uk zone (shared by isolates in the same data centre).
const CACHE_TTL_S = 600;
const EDGE_CACHE_KEY = "https://useitup.uk/__cache/recipes-all-v1";
let memoryCache: { at: number; value: AllRecipes } | null = null;

function edgeCache(): Cache | null {
  const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

async function fetchAllRecipesUncached(): Promise<AllRecipes | null> {
  // Pages 1 and 2 go out together (328 recipes today = 2 pages); any further pages follow once total is known.
  const [first, second] = await Promise.all([
    apiGet<RecipeListPage>(`/api/recipes?limit=${PAGE_SIZE}&page=1`),
    apiGet<RecipeListPage>(`/api/recipes?limit=${PAGE_SIZE}&page=2`),
  ]);
  if (!first.ok) return null;

  const { total } = first.data;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages: ApiResponse<RecipeListPage>[] = [first];
  if (pageCount >= 2) {
    if (!second.ok) return null;
    pages.push(second);
  }
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 2) }, (_, i) =>
      apiGet<RecipeListPage>(`/api/recipes?limit=${PAGE_SIZE}&page=${i + 3}`),
    ),
  );
  if (rest.some((r) => !r.ok)) return null;
  pages.push(...rest);

  const seen = new Set<string>();
  const items: RecipeListItem[] = [];
  for (const page of pages) {
    if (!page.ok) continue;
    for (const item of page.data.items) {
      if (seen.has(item._id)) continue;
      seen.add(item._id);
      items.push(item);
    }
  }
  return { items, total };
}

async function fetchAllRecipes(): Promise<AllRecipes | null> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.at < CACHE_TTL_S * 1000) return memoryCache.value;

  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(EDGE_CACHE_KEY);
      if (hit) {
        const value = (await hit.json()) as AllRecipes;
        memoryCache = { at: now, value };
        return value;
      }
    } catch {
      // cache unavailable (local dev) — fall through to the API
    }
  }

  const value = await fetchAllRecipesUncached();
  if (!value) return null;
  memoryCache = { at: now, value };
  if (cache) {
    try {
      await cache.put(
        EDGE_CACHE_KEY,
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_TTL_S}` },
        }),
      );
    } catch {
      // best effort
    }
  }
  return value;
}

export default async function RecipesPage() {
  const all = await fetchAllRecipes();

  if (!all) {
    return (
      <div className="recipes-page">
        <div className="recipes-page__header">
          <h1>Recipes</h1>
          <p>Couldn&apos;t load recipes right now — please try again shortly.</p>
        </div>
      </div>
    );
  }

  const { items, total } = all;

  return (
    <div className="recipes-page">
      <div className="recipes-page__header">
        <h1>Recipes</h1>
        <p>{total} recipes</p>
      </div>

      <RecipesBrowser items={items} />
    </div>
  );
}
