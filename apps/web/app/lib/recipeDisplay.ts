import type { RecipeDetailCostLine } from "@uiu/shared";

interface MealTagged {
  mealType?: string;
  tags: string[];
}

/**
 * Source descriptions (scraped from Spoonacular) embed USD price mentions
 * ("costs $4.41 per serving", "For 72 cents per serving, ...") that clash with
 * our own GBP price display on the same card. Strip just those sentences —
 * the rest of the description is left as-is.
 */
export function stripUsdMentions(description: string): string {
  const sentences = description.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => !/\$\d|\bcents? per serving\b/i.test(s)).join(" ").trim();
}

const MEAL_TYPES = ["breakfast", "brunch", "lunch", "dinner", "snack", "dessert", "appetizer", "side dish"];

export function mealTypeBadge(recipe: MealTagged): string | null {
  if (recipe.mealType) return capitalize(recipe.mealType);
  const match = recipe.tags.map((t) => t.toLowerCase()).find((t) => MEAL_TYPES.includes(t));
  return match ? capitalize(match) : null;
}

export function dietBadges(recipe: MealTagged): string[] {
  const tags = recipe.tags.map((t) => t.toLowerCase());
  const badges: string[] = [];
  if (tags.includes("halal")) badges.push("Halal");
  if (tags.includes("vegan")) badges.push("Vegan");
  else if (tags.some((t) => t.includes("vegetarian"))) badges.push("Veg");
  return badges;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatIngredientLabel(line: RecipeDetailCostLine): string {
  const qty = formatQuantity(line.quantity);
  const unit = line.rawUnit ? ` ${line.rawUnit}` : "";
  return `${capitalize(line.rawName)}${qty ? ` — ${qty}${unit}` : ""}`;
}

export function formatIngredientPrice(line: RecipeDetailCostLine): string | null {
  if (!line.priceable || line.lineCost == null) return null;
  const source = line.productTitle ?? line.store;
  const price = `£${line.lineCost.toFixed(2)}`;
  return source ? `${source} — ${price}` : price;
}

function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) return "";
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
