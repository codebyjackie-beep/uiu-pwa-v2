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
  test: (basket: number) => boolean;
}

/** Buckets chosen from the live basket-price distribution (2026-08-04): p25≈£1.5, median≈£4.4, p75≈£9.5. */
export const PRICE_BUCKETS: PriceBucket[] = [
  { key: "under3", label: "Under £3", test: (b) => b < 3 },
  { key: "3to7", label: "£3–£7", test: (b) => b >= 3 && b < 7 },
  { key: "7plus", label: "£7+", test: (b) => b >= 7 },
];
