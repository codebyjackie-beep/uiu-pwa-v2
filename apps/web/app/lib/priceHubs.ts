/**
 * Price hub pages: /recipes/price/<slug> — "recipes under £1 / £2 / £3 per serving".
 *
 * Only cost tier "full" recipes (>= 80% of ingredient lines priced, the same rule as recipe pages; see
 * hubPricing.ts) ever count — copy must not claim "every ingredient" is priced. A partial
 * price is a floor, not a real cost, so it can't prove "under £X". Comparison is on the figure the
 * site shows (rounded to the penny), so a £0.996 recipe — shown as £1.00 — is not "under £1".
 * Hubs are nested (under £3 includes under £1). A hub exists only with >= PRICE_HUB_MIN_RECIPES members;
 * fewer and the page 404s and is left out of links + sitemap.
 *
 * Pure: no Next / React / @uiu/shared runtime imports (tests run under tsx).
 */
import { formatGbp, fullTierPerServing, type HubRecipe } from "./recipeHub";

export const PRICE_HUB_MIN_RECIPES = 5;
export const PRICE_PATH_PREFIX = "/recipes/price/";

export interface PriceHubDef {
  slug: string;
  /** Strict upper bound in £ per serving. */
  max: number;
}

export const PRICE_HUBS: readonly PriceHubDef[] = [
  { slug: "under-1-pound", max: 1 },
  { slug: "under-2-pounds", max: 2 },
  { slug: "under-3-pounds", max: 3 },
];

const BY_SLUG = new Map(PRICE_HUBS.map((h) => [h.slug, h]));

export function priceHubBySlug(slug: string): PriceHubDef | undefined {
  return BY_SLUG.get(slug);
}

export function priceHubPath(slug: string): string {
  return `${PRICE_PATH_PREFIX}${slug}`;
}

/** "£1" / "£2" — whole pounds, as used in titles and chips. */
export function priceHubAmount(def: PriceHubDef): string {
  return Number.isInteger(def.max) ? `£${def.max}` : formatGbp(def.max);
}

/** Fully priced and strictly under the cap, compared in whole pence (what the page displays). */
export function recipeInPriceHub(def: PriceHubDef, r: Pick<HubRecipe, "fullTierPrice">): boolean {
  const p = fullTierPerServing(r);
  return p != null && Math.round(p * 100) < Math.round(def.max * 100);
}

/** The hub's recipes, cheapest first (ties by title, then id). */
export function recipesForPriceHub<T extends HubRecipe>(def: PriceHubDef, items: T[]): T[] {
  return items
    .filter((r) => recipeInPriceHub(def, r))
    .sort(
      (a, b) =>
        (fullTierPerServing(a) ?? 0) - (fullTierPerServing(b) ?? 0) ||
        a.title.localeCompare(b.title) ||
        a._id.localeCompare(b._id),
    );
}

/** Hubs with enough recipes to get a page, cheapest cap first, with their (sorted) members. */
export function livePriceHubs<T extends HubRecipe>(items: T[]): { def: PriceHubDef; recipes: T[] }[] {
  return PRICE_HUBS.map((def) => ({ def, recipes: recipesForPriceHub(def, items) })).filter(
    (h) => h.recipes.length >= PRICE_HUB_MIN_RECIPES,
  );
}

/** The cheapest live hub this recipe is in (one link per recipe page, not three nested ones). */
export function tightestPriceHubFor<T extends HubRecipe>(recipe: HubRecipe, items: T[]): PriceHubDef | undefined {
  return livePriceHubs(items).find(({ def }) => recipeInPriceHub(def, recipe))?.def;
}

export interface PriceHubMeta {
  title: string;
  heading: string;
  description: string;
  intro: string;
}

/**
 * Copy for one hub. Every £ here is either the hub's own cap or the cheapest member's real tier-"full"
 * per-serving price. Title ≤ 60 and description ≤ 155 chars (tested).
 */
export function priceHubMeta(def: PriceHubDef, recipes: Pick<HubRecipe, "fullTierPrice">[]): PriceHubMeta {
  const n = recipes.length;
  const cap = priceHubAmount(def);
  const prices = recipes.map(fullTierPerServing).filter((p): p is number => p != null);
  const cheapest = prices.length ? formatGbp(Math.min(...prices)) : null;
  const from = cheapest ? `, from ${cheapest}` : "";
  return {
    title: `Recipes Under ${cap} Per Serving, UK Prices · UseItUp`,
    heading: `Recipes under ${cap} per serving`,
    description: `${n} recipes under ${cap} a serving at UK supermarkets${from}. See what a meal costs before you shop.`,
    intro: `${n} recipes that cost under ${cap} a serving at UK supermarket prices${cheapest ? ` (cheapest ${cheapest})` : ""}.`,
  };
}
