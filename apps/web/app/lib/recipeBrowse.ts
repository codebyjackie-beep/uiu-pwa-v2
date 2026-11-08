import type { RecipeListItem } from "@uiu/shared";

/** How many recipes /recipes shows when no filter is active (HANDOFF_recipes-page-manual-entry-and-refresh.md §B). */
export const RANDOM_BROWSE_SIZE = 10;

/**
 * What the Recipes browser needs per recipe. `nutrition` is not read anywhere on the list page (detail page only),
 * so it is dropped before the ~435-item list is serialised into the page — smaller HTML/RSC payload, less to parse.
 */
export type BrowseRecipe = Omit<RecipeListItem, "nutrition">;

export function toBrowseRecipe(item: RecipeListItem): BrowseRecipe {
  const copy: Partial<RecipeListItem> = { ...item };
  delete copy.nutrition;
  return copy as BrowseRecipe;
}

/** Fisher-Yates. Safe on server and client (no DOM). */
export function pickRandom<T>(items: T[], count: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * Card-sized image URL. Pexels URLs carry their own resize params (stored as w=940&h=650); a list card is at most
 * ~600px wide x 168px tall, so ask Pexels for 640px wide instead. Other hosts are returned unchanged.
 */
export function cardImageUrl(url: string): string {
  if (!url.startsWith("https://images.pexels.com/")) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("auto", "compress");
    u.searchParams.set("cs", "tinysrgb");
    u.searchParams.set("w", "640");
    u.searchParams.delete("h");
    return u.toString();
  } catch {
    return url;
  }
}
