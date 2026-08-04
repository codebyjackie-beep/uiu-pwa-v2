import type { RecipeDetailCostLine } from "@uiu/shared";
import { classifyMealTypes, type FilterMealType } from "./recipeFilters";

interface MealTagged {
  mealType?: string;
  title: string;
  tags: string[];
}

const MEAL_TYPES = ["breakfast", "brunch", "lunch", "dinner", "snack", "dessert", "appetizer", "side dish"];

/**
 * Fixed display priority when classifyMealTypes() returns multiple slots (e.g. a "brunch"
 * tag maps to both breakfast+lunch) — picks the one closest to "this is mainly a morning
 * meal" intent rather than depending on DB tag array order (HANDOFF, 2026-08-04 badge fix).
 */
const BADGE_PRIORITY: FilterMealType[] = ["breakfast", "lunch", "dinner", "snack", "dessert"];

/**
 * Derived from classifyMealTypes() (recipeFilters.ts) — the same logic that decides which
 * meal-type filter a recipe matches — so the badge shown always agrees with the filter that
 * surfaced it. Previously this independently `.find()`-ed the recipe's own `tags` array,
 * which picked whatever meal-type tag happened to be stored first and could show e.g. "Brunch"
 * on a recipe the Breakfast filter matched (2026-08-04 Task B bug).
 */
export function mealTypeBadge(recipe: MealTagged): string | null {
  if (recipe.mealType && MEAL_TYPES.includes(recipe.mealType.toLowerCase())) {
    return capitalize(recipe.mealType);
  }
  const slots = classifyMealTypes(recipe);
  const match = BADGE_PRIORITY.find((slot) => slots.has(slot));
  return match ? capitalize(match) : null;
}

/**
 * Dietary/attribute pills — kept separate from the meal-type badge (Munch reference layout).
 * Mapping built from the actual distinct tags across the 197 production recipes
 * (2026-07-27 handoff) — not guessed. `halal` isn't present in any current recipe but is
 * kept mapped so a future price-cache/tag refresh picks it up automatically.
 */
const DIETARY_TAG_MAP: Record<string, string> = {
  halal: "Halal",
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  "lacto ovo vegetarian": "Vegetarian",
  pescatarian: "Pescatarian",
  "gluten free": "Gluten-Free",
  "gluten-free": "Gluten-Free",
  "dairy free": "Dairy-Free",
  ketogenic: "Keto",
  paleolithic: "Paleo",
  primal: "Paleo",
  "whole 30": "Whole30",
  "fodmap friendly": "FODMAP Friendly",
};

export function dietaryBadges(recipe: MealTagged): string[] {
  const tags = recipe.tags.map((t) => t.toLowerCase());
  const seen = new Set<string>();
  const badges: string[] = [];
  for (const tag of tags) {
    const label = DIETARY_TAG_MAP[tag];
    if (label && !seen.has(label)) {
      seen.add(label);
      badges.push(label);
    }
  }
  return badges;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Store display names — DB `store` values are the raw scrape/canonical-price-cache source
 * strings (10 distinct values, all UK chains, inconsistent casing/domain suffixes). Mapping
 * exhaustively covers all 10 values found in canonical_price_cache (2026-07-27 handoff);
 * anything unmapped (future price-cache refresh) falls back to the raw value rather than
 * being silently dropped.
 */
const STORE_NAME_MAP: Record<string, string> = {
  "sainsburys.co.uk": "Sainsbury's",
  "Morrisons.com": "Morrisons",
  "Asda Groceries": "Asda",
  "George at ASDA": "Asda (George)",
  Tesco: "Tesco",
  Ocado: "Ocado",
  "Waitrose & Partners": "Waitrose",
  Iceland: "Iceland",
  Aldiss: "Aldi",
  "Sunshine Co-operative": "Co-op",
};

export function displayStoreName(store: string): string {
  return STORE_NAME_MAP[store] ?? store;
}

/** Line 1, right side: converted g/ml quantity when available, else raw quantity + unit. */
export function formatIngredientQuantity(
  line: RecipeDetailCostLine | undefined,
  fallback: { quantity: number; unit: string },
): string {
  if (line?.normValue != null && line.normUnit) {
    return `${formatQuantity(line.normValue)}${line.normUnit}`;
  }
  const qty = formatQuantity(fallback.quantity);
  return qty ? `${qty} ${fallback.unit}` : fallback.unit;
}

export function ingredientName(line: RecipeDetailCostLine | undefined, fallback: string): string {
  return capitalize(line?.rawName ?? fallback);
}

export interface IngredientStoreLine {
  /** Store name (mapped) when priceable, else the "no price data" fallback message. */
  label: string;
  /** £price, only set when priceable. */
  price: string | null;
  unpriceable: boolean;
}

/** Line 2: store name (mapped, left) + price (right), or a "no price data" fallback when unpriceable. */
export function formatIngredientStorePrice(line: RecipeDetailCostLine | undefined): IngredientStoreLine {
  if (!line || !line.priceable || line.lineCost == null || !line.store) {
    return { label: "Price unavailable", price: null, unpriceable: true };
  }
  return { label: displayStoreName(line.store), price: `£${line.lineCost.toFixed(2)}`, unpriceable: false };
}

function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) return "";
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
