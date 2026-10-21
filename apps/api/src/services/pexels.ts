/**
 * HANDOFF_recipe-photos-and-scan-icons.md — image lookup for approved AI drafts.
 * Separate vendor from spoonacular.ts on purpose: RapidAPI Basic tier ToS forbids
 * persisting Spoonacular's image URLs, Pexels has no such restriction.
 *
 * G2 (cc_prompt_recipe_data_cleanup.md Part 2 step 6, Jackie 2026-10-21): recipe photos are unique across the library.
 * findRecipePhoto() skips any Pexels photo id already used by a recipe or a recipe draft and returns null rather than
 * reuse one (the 10-10 clean-up took shared photos from 295 recipes down to 2).
 */
import { withDb, type DbEnv } from "../db";

export interface PexelsEnv {
  PEXELS_API_KEY: string;
}

type PexelsPhoto = { id?: number; src?: { large?: string; medium?: string } };

/** Pexels photo id from an images.pexels.com URL (…/photos/5639286/pexels-photo-5639286.jpeg…), else null. */
export function pexelsPhotoId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /images\.pexels\.com\/photos\/(\d+)\//.exec(url);
  return m ? m[1]! : null;
}

/** Every Pexels photo id already used by recipes or recipe drafts (any status). */
export async function usedPexelsIds(env: DbEnv): Promise<Set<string>> {
  return withDb(env, async (db) => {
    const filter = { imageUrl: { $regex: "images\\.pexels\\.com/photos/" } };
    const [recipes, drafts] = await Promise.all([
      db.collection("recipes").find(filter, { projection: { imageUrl: 1 } }).toArray(),
      db.collection("recipe_drafts").find(filter, { projection: { imageUrl: 1 } }).toArray(),
    ]);
    const ids = new Set<string>();
    for (const d of [...recipes, ...drafts]) {
      const id = pexelsPhotoId(d.imageUrl);
      if (id) ids.add(id);
    }
    return ids;
  });
}

async function searchPhotos(env: PexelsEnv, query: string, perPage: number): Promise<PexelsPhoto[]> {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orientation", "landscape");
  const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
  if (!res.ok) return [];
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  return data.photos ?? [];
}

const photoUrl = (p: PexelsPhoto | undefined) => p?.src?.large ?? p?.src?.medium ?? null;

/** First photo for the title whose Pexels id isn't already used in the library; null if all 15 results are taken. */
export async function findRecipePhoto(env: PexelsEnv & Partial<DbEnv>, title: string, opts: { used?: Set<string> } = {}): Promise<string | null> {
  const used = opts.used ?? (env.MONGODB_URI && env.MONGODB_DB ? await usedPexelsIds(env as DbEnv).catch(() => new Set<string>()) : new Set<string>());
  const photos = await searchPhotos(env, `${title} food dish`, 15);
  for (const p of photos) {
    const url = photoUrl(p);
    const id = p.id !== undefined ? String(p.id) : pexelsPhotoId(url);
    if (url && (!id || !used.has(id))) {
      if (id) used.add(id); // callers looping with a shared `used` set never pick the same photo twice in one run
      return url;
    }
  }
  return null;
}

/** Generic Pexels search — used by igContentGen (organic/affiliate post images). Not de-duplicated. */
export async function searchPhoto(env: PexelsEnv, query: string): Promise<string | null> {
  return photoUrl((await searchPhotos(env, query, 1))[0]);
}
