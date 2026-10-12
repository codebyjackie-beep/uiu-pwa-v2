import { classifyRecipeMealTypes, type RecipeListItem, type RecipeMealClass } from "@uiu/shared";

/**
 * Recipes-page filter classification. Meal-type detection lives in @uiu/shared
 * (classifyRecipeMealTypes) and is also what apps/api/src/services/mealPlanGenerator.ts uses
 * for slot eligibility, so a recipe's chip match always agrees with what the meal planner would
 * slot it into (cc_prompt_recipe_data_cleanup.md Part 10).
 */

export type FilterMealType = RecipeMealClass;

export function classifyMealTypes(recipe: Pick<RecipeListItem, "title" | "tags" | "mealType">): Set<FilterMealType> {
  return classifyRecipeMealTypes(recipe);
}

/**
 * Dietary-habit filter set for the Recipes page — the "real dietary habit" subset of
 * apps/api/src/services/mealPlanGenerator.ts's DIETARY_FILTERS (excludes high-protein/
 * budget/quick, which are thresholds, not dietary habits). Predicates copied verbatim.
 */
export type FilterDietary = "vegetarian" | "vegan" | "pescatarian" | "gluten-free" | "dairy-free" | "keto" | "paleo";

export const DIETARY_PREDICATES: Record<FilterDietary, (tagsLower: string[]) => boolean> = {
  vegetarian: (tags) => tags.some((t) => t.includes("vegetarian")),
  vegan: (tags) => tags.includes("vegan"),
  pescatarian: (tags) => tags.some((t) => t.includes("pescatarian")),
  "gluten-free": (tags) => tags.some((t) => t.includes("gluten free") || t.includes("gluten-free")),
  "dairy-free": (tags) => tags.some((t) => t.includes("dairy free") || t.includes("dairy-free")),
  keto: (tags) => tags.some((t) => t.includes("keto")),
  paleo: (tags) => tags.some((t) => t.includes("paleo") || t.includes("primal")),
};

export interface PriceBucket {
  key: string;
  label: string;
  /** Tested against the price of ONE serving (recipe_cost.perServing), not the whole-recipe basket. */
  test: (perServing: number) => boolean;
}

/**
 * Per-serving buckets chosen from the live distribution of the 328 public recipes (2026-10-12,
 * priced recipes only): under £1.50 = 34%, £1.50–£3 = 43%, £3+ = 23% (p25 £1.17, median £1.94, p75 £2.90).
 */
export const PRICE_BUCKETS: PriceBucket[] = [
  { key: "under1_5", label: "Under £1.50", test: (p) => p < 1.5 },
  { key: "1_5to3", label: "£1.50–£3", test: (p) => p >= 1.5 && p < 3 },
  { key: "3plus", label: "£3+", test: (p) => p >= 3 },
];
