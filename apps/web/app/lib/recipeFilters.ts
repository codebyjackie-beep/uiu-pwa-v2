import type { RecipeListItem } from "@uiu/shared";

/**
 * Recipes-page filter classification (HANDOFF_recipes-page-filters.md, 2026-08-04).
 * Meal-type detection is a manual copy of MEAL_SLOT_TAGS/deriveMealSlots/DESSERT_KEYWORDS/
 * SOUP_KEYWORDS from apps/api/src/services/mealPlanGenerator.ts, kept identical on purpose
 * so a recipe's meal-type filter match agrees with what the meal planner would slot it into.
 * That file's PoolRecipe isn't reusable here (different runtime, DB-joined shape), so the
 * keyword lists/logic are duplicated rather than imported — keep both in sync by hand.
 */

export type FilterMealType = "breakfast" | "lunch" | "dinner" | "snack" | "dessert";

const MEAL_SLOT_TAGS: Record<string, Array<"breakfast" | "lunch" | "dinner" | "snack">> = {
  breakfast: ["breakfast"],
  brunch: ["breakfast", "lunch"],
  lunch: ["lunch"],
  dinner: ["dinner"],
  snack: ["snack"],
};

/**
 * Dessert used to be keyword-matched (DESSERT_KEYWORDS incl. "cake"/"pie"/
 * "tart"/"pudding"/"muffin") but a full production scan
 * (HANDOFF_dessert-keyword-savory-fix.md, 2026-08-04) found that produced 35
 * false positives — genuine savory dishes whose name/tags happen to contain
 * a dessert word (Crab Cakes Eggs Benedict, Fish Pie, Shepherd's Pie, Yorkshire
 * Puddings, Flamiche, Cream Cheese Tart, etc.) — and 0 true positives it
 * caught beyond what the "dessert" tag already covers. Dessert detection is
 * now tag-based only (see isDessert below), consistent with mealPlanGenerator.ts.
 */
const SOUP_KEYWORDS = ["soup", "chowder", "bisque"];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match, not raw substring (HANDOFF_dessert-keyword-substring-fix.md,
 * 2026-08-04) — kept in sync with mealPlanGenerator.ts's matchesAny(); see file header.
 * Trailing `s?` keeps plural titles/tags matching (e.g. "Cookies", "Muffins").
 */
function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => new RegExp(`\\b${escapeRegex(k)}s?\\b`, "i").test(text));
}

/** Same fallback/soup/dessert-override rules as deriveMealSlots(); see file header. */
export function classifyMealTypes(recipe: Pick<RecipeListItem, "title" | "tags">): Set<FilterMealType> {
  const titleLower = recipe.title.toLowerCase();
  const tagsLower = recipe.tags.map((t) => t.toLowerCase());

  const isDessert = tagsLower.includes("dessert");
  const isSoup = matchesAny(titleLower, SOUP_KEYWORDS) || tagsLower.some((t) => matchesAny(t, SOUP_KEYWORDS));

  const slots = new Set<"breakfast" | "lunch" | "dinner" | "snack">();
  for (const tag of tagsLower) {
    const mapped = MEAL_SLOT_TAGS[tag];
    if (mapped) for (const s of mapped) slots.add(s);
  }

  if (slots.size === 0) {
    if (isDessert) slots.add("snack");
    else if (isSoup) slots.add("lunch");
    else {
      slots.add("lunch");
      slots.add("dinner");
    }
  }

  if (isSoup) slots.delete("dinner");
  if (isDessert) {
    slots.delete("lunch");
    slots.delete("dinner");
  }

  const result: Set<FilterMealType> = new Set(slots);
  if (isDessert) result.add("dessert");
  return result;
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
