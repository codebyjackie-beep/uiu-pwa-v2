/**
 * The one place that lists which SEO hub families exist (ingredient pages, price hubs, ...).
 * /recipes (chip rows), the recipe detail page ("More recipes like this") and /sitemap.xml all read
 * from here, so a hub URL is only ever linked or listed when its own page would render (no 404 links).
 *
 * Each hub family adds one entry per function below. Pure — no Next / React imports.
 */
import { latestUpdatedAt, type HubLink, type HubNavGroup, type HubRecipe } from "./recipeHub";
import type { SitemapEntry } from "./sitemapEntries";
import { SITE_BASE } from "./sitemapEntries";
import { ingredientHubPath, liveIngredientHubs, recipeMatchesIngredient } from "./ingredientPages";
import { livePriceHubs, priceHubAmount, priceHubPath, tightestPriceHubFor } from "./priceHubs";

/** Chip rows shown on /recipes. */
export function hubNavGroups(items: HubRecipe[]): HubNavGroup[] {
  const groups: HubNavGroup[] = [];
  groups.push({
    title: "Recipes by main ingredient",
    links: liveIngredientHubs(items).map(({ def }) => ({ href: ingredientHubPath(def.slug), label: def.label })),
  });
  groups.push({
    title: "Recipes by price per serving",
    links: livePriceHubs(items).map(({ def }) => ({ href: priceHubPath(def.slug), label: `Under ${priceHubAmount(def)}` })),
  });
  return groups.filter((g) => g.links.length > 0);
}

/** Hub links for one recipe's detail page (only hubs that contain this recipe and are live). */
export function hubLinksForRecipe(recipe: HubRecipe, items: HubRecipe[]): HubLink[] {
  const links: HubLink[] = [];
  for (const { def } of liveIngredientHubs(items)) {
    if (recipeMatchesIngredient(def, recipe)) links.push({ href: ingredientHubPath(def.slug), label: `${def.label} recipes` });
  }
  const price = tightestPriceHubFor(recipe, items);
  if (price) links.push({ href: priceHubPath(price.slug), label: `Recipes under ${priceHubAmount(price)} per serving` });
  return links;
}

/**
 * Extra /sitemap.xml entries, built from the same items the sitemap already fetched (no extra API calls).
 * Price hubs carry no lastmod: membership moves with price refreshes, which don't touch recipes.updatedAt.
 */
export function hubSitemapEntries(items: HubRecipe[]): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const { def, recipes } of liveIngredientHubs(items)) {
    const lastModified = latestUpdatedAt(recipes);
    entries.push({ url: `${SITE_BASE}${ingredientHubPath(def.slug)}`, ...(lastModified ? { lastModified } : {}) });
  }
  for (const { def } of livePriceHubs(items)) entries.push({ url: `${SITE_BASE}${priceHubPath(def.slug)}` });
  return entries;
}
