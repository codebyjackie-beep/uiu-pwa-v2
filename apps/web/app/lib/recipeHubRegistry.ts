/**
 * The one place that lists which SEO hub families exist (ingredient pages, price hubs, ...).
 * /recipes (chip rows), the recipe detail page ("More recipes like this") and /sitemap.xml all read
 * from here, so a hub URL is only ever linked or listed when its own page would render (no 404 links).
 *
 * Each hub family adds one entry per function below. Pure — no Next / React imports.
 */
import type { HubLink, HubNavGroup, HubRecipe } from "./recipeHub";
import type { SitemapEntry } from "./sitemapEntries";

/** Chip rows shown on /recipes. */
export function hubNavGroups(items: HubRecipe[]): HubNavGroup[] {
  void items;
  const groups: HubNavGroup[] = [];
  return groups.filter((g) => g.links.length > 0);
}

/** Hub links for one recipe's detail page (only hubs that contain this recipe and are live). */
export function hubLinksForRecipe(recipe: HubRecipe, items: HubRecipe[]): HubLink[] {
  void recipe;
  void items;
  const links: HubLink[] = [];
  return links;
}

/** Extra /sitemap.xml entries, built from the same items the sitemap already fetched (no extra API calls). */
export function hubSitemapEntries(items: HubRecipe[]): SitemapEntry[] {
  void items;
  const entries: SitemapEntry[] = [];
  return entries;
}
