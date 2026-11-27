/**
 * The one place a hub decides "is this recipe fully priced?" — with the shared costDisplayTier, so hub
 * pages, titles and descriptions follow exactly the same £ rule as recipe pages (tier "full" only).
 * Kept apart from recipeHub.ts because @uiu/shared can't be loaded at runtime by the tsx test scripts.
 */
import { costDisplayTier, recipePerServingPrice, type RecipeListItem } from "@uiu/shared";
import type { HubRecipe } from "./recipeHub";

export type HubSource = Pick<RecipeListItem, "_id" | "title" | "cost"> & { tags?: string[] | null; updatedAt?: unknown };

export function toHubRecipe(r: HubSource): HubRecipe {
  const price = recipePerServingPrice(r.cost);
  const full = price != null && costDisplayTier(r.cost?.adjustedCoveragePct) === "full";
  return {
    _id: r._id,
    title: typeof r.title === "string" ? r.title : "",
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    fullTierPrice: full ? price : null,
    ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
  };
}

export function toHubRecipes(items: HubSource[]): HubRecipe[] {
  return items.map(toHubRecipe);
}
