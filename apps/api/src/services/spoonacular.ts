/**
 * Spoonacular (via RapidAPI) complexSearch — server-side idea fetch for the
 * daily recipe draft cron (Worker-side version of the local-only
 * tools/recipe_ideas/spoonacular_browse.cjs script). number=1-40 requests/day
 * cap on the Basic tier; the daily cron uses at most ~40 requests (20 ideas +
 * dedup retries), same ToS-driven "use once, never persist raw response"
 * rule as the local tool.
 */
export interface SpoonacularEnv {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
}

export interface SpoonacularIdea {
  title: string;
  cuisines: string[];
  diets: string[];
  summary: string;
}

function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

export interface SpoonacularQuery {
  query: string;
  diet?: string;
  cuisine?: string;
  number?: number;
}

/** Raw response is used once and discarded by the caller — this function itself holds nothing after returning. */
export async function fetchSpoonacularIdeas(env: SpoonacularEnv, q: SpoonacularQuery): Promise<SpoonacularIdea[]> {
  const url = new URL(`https://${env.RAPIDAPI_HOST}/recipes/complexSearch`);
  url.searchParams.set("query", q.query);
  if (q.diet) url.searchParams.set("diet", q.diet);
  if (q.cuisine) url.searchParams.set("cuisine", q.cuisine);
  url.searchParams.set("number", String(q.number ?? 5));
  url.searchParams.set("addRecipeInformation", "true");

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": env.RAPIDAPI_HOST,
    },
  });
  if (!res.ok) {
    throw new Error(`Spoonacular request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const results = json.results ?? [];
  return results.map((r) => ({
    title: String((r as Record<string, unknown>).title ?? ""),
    cuisines: Array.isArray((r as Record<string, unknown>).cuisines) ? ((r as Record<string, unknown>).cuisines as string[]) : [],
    diets: Array.isArray((r as Record<string, unknown>).diets) ? ((r as Record<string, unknown>).diets as string[]) : [],
    summary: stripHtml(String((r as Record<string, unknown>).summary ?? "")),
  }));
}
