/**
 * HANDOFF_recipe-photos-and-scan-icons.md — image lookup for approved AI drafts.
 * Separate vendor from spoonacular.ts on purpose: RapidAPI Basic tier ToS forbids
 * persisting Spoonacular's image URLs, Pexels has no such restriction.
 */
export interface PexelsEnv {
  PEXELS_API_KEY: string;
}

export async function findRecipePhoto(env: PexelsEnv, title: string): Promise<string | null> {
  return searchPhoto(env, `${title} food dish`);
}

/** Generic Pexels search — used by findRecipePhoto and igContentGen (organic/affiliate post images). */
export async function searchPhoto(env: PexelsEnv, query: string): Promise<string | null> {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "1");
  url.searchParams.set("orientation", "landscape");
  const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
  if (!res.ok) return null;
  const data = (await res.json()) as { photos?: Array<{ src?: { large?: string; medium?: string } }> };
  return data.photos?.[0]?.src?.large ?? data.photos?.[0]?.src?.medium ?? null;
}
