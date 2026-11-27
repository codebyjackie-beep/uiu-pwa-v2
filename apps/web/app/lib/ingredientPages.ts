/**
 * Main-ingredient hub pages: /recipes/ingredient/<slug>.
 *
 * The public list API has no ingredient names (only title / tags / cost), so membership is a curated
 * whitelist matched on the recipe title + tags with word-boundary patterns (eggs ≠ eggplant, potatoes ≠
 * sweet potatoes, rice ≠ cauliflower rice). A hub only exists while it has >= INGREDIENT_MIN_RECIPES
 * public recipes — fewer and the page 404s and is left out of links + sitemap.
 *
 * Pure: no Next / React / @uiu/shared runtime imports (tests run under tsx).
 */
import { formatGbp, fullTierPriceRange, sortForHub, type HubRecipe } from "./recipeHub";

export const INGREDIENT_MIN_RECIPES = 5;
export const INGREDIENT_PATH_PREFIX = "/recipes/ingredient/";

export interface IngredientHubDef {
  slug: string;
  /** Modifier form for "<label> recipes" (title, heading, chips): "Prawn", "Chickpea", "Sweet potato". */
  label: string;
  /** Plural / mass noun for "recipes with <name>": "Prawns", "Chickpeas". */
  name: string;
  /** Matched against lower-cased "title + tags" (see hubSearchText). */
  match: RegExp;
  /** Phrases that don't count as the ingredient (e.g. "chicken stock"); a recipe still matches on any other hit. */
  exclude?: RegExp;
}

export const INGREDIENT_HUBS: readonly IngredientHubDef[] = [
  { slug: "chicken", label: "Chicken", name: "Chicken", match: /\bchicken\b/, exclude: /\bchicken (?:free|stock|broth)\b/ },
  { slug: "prawns", label: "Prawn", name: "Prawns", match: /\b(?:prawns?|shrimps?)\b/ },
  { slug: "salmon", label: "Salmon", name: "Salmon", match: /\bsalmon\b/ },
  { slug: "beef", label: "Beef", name: "Beef", match: /\bbeef\b/, exclude: /\bbeef (?:stock|broth)\b/ },
  { slug: "eggs", label: "Egg", name: "Eggs", match: /\beggs?\b/ },
  { slug: "chickpeas", label: "Chickpea", name: "Chickpeas", match: /\bchick ?peas?\b/ },
  { slug: "lentils", label: "Lentil", name: "Lentils", match: /\blentils?\b/ },
  { slug: "quinoa", label: "Quinoa", name: "Quinoa", match: /\bquinoa\b/ },
  {
    slug: "rice",
    label: "Rice",
    name: "Rice",
    match: /\brice\b/,
    exclude: /\b(?:cauliflower|broccoli) rice\b|\brice (?:paper|vinegar|noodles?|wine|flour|cakes?|crackers?)\b/,
  },
  { slug: "potatoes", label: "Potato", name: "Potatoes", match: /\bpotato(?:es)?\b/, exclude: /\bsweet potato(?:es)?\b/ },
  { slug: "sweet-potatoes", label: "Sweet potato", name: "Sweet potatoes", match: /\bsweet potato(?:es)?\b/ },
  { slug: "avocado", label: "Avocado", name: "Avocado", match: /\bavocados?\b/ },
  { slug: "tomatoes", label: "Tomato", name: "Tomatoes", match: /\btomato(?:es)?\b/ },
  { slug: "spinach", label: "Spinach", name: "Spinach", match: /\bspinach\b/ },
  { slug: "mushrooms", label: "Mushroom", name: "Mushrooms", match: /\bmushrooms?\b/ },
  {
    slug: "pasta",
    label: "Pasta",
    name: "Pasta",
    match: /\b(?:pasta|spaghetti|penne|fusilli|linguine|tagliatelle|macaroni|rigatoni|orzo|lasagne|lasagna|gnocchi)\b/,
  },
  { slug: "cabbage", label: "Cabbage", name: "Cabbage", match: /\bcabbages?\b/ },
  { slug: "cucumber", label: "Cucumber", name: "Cucumber", match: /\bcucumbers?\b/ },
  { slug: "coconut", label: "Coconut", name: "Coconut", match: /\bcoconut\b/ },
  { slug: "beans", label: "Bean", name: "Beans", match: /\bbeans?\b/, exclude: /\b(?:jelly|coffee|vanilla|cocoa) beans?\b|\bbean ?sprouts?\b/ },
  { slug: "mango", label: "Mango", name: "Mango", match: /\bmango(?:es|s)?\b/ },
  { slug: "broccoli", label: "Broccoli", name: "Broccoli", match: /\bbroccoli\b/, exclude: /\bbroccoli rice\b/ },
  { slug: "butternut-squash", label: "Butternut squash", name: "Butternut squash", match: /\bbutternut\b/ },
  { slug: "cheese", label: "Cheese", name: "Cheese", match: /\bcheese\b/ },
  { slug: "asparagus", label: "Asparagus", name: "Asparagus", match: /\basparagus\b/ },
];

const BY_SLUG = new Map(INGREDIENT_HUBS.map((h) => [h.slug, h]));

export function ingredientHubBySlug(slug: string): IngredientHubDef | undefined {
  return BY_SLUG.get(slug);
}

export function ingredientHubPath(slug: string): string {
  return `${INGREDIENT_PATH_PREFIX}${slug}`;
}

/** "Black Bean Tacos" + ["vegan","high-protein"] → "black bean tacos vegan high protein". */
export function hubSearchText(r: Pick<HubRecipe, "title" | "tags">): string {
  return `${r.title} ${(r.tags ?? []).join(" ")}`
    .toLowerCase()
    .replace(/[-_/,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function recipeMatchesIngredient(def: IngredientHubDef, r: Pick<HubRecipe, "title" | "tags">): boolean {
  let text = hubSearchText(r);
  // Blank out excluded phrases first, so "chicken stock" alone isn't a chicken recipe but
  // "chicken thighs in chicken stock" still is.
  if (def.exclude) text = text.replace(new RegExp(def.exclude.source, "g"), " ");
  return def.match.test(text);
}

/** The hub's recipes, sorted (fully priced cheapest first). */
export function recipesForIngredient<T extends HubRecipe>(def: IngredientHubDef, items: T[]): T[] {
  return sortForHub(items.filter((r) => recipeMatchesIngredient(def, r)));
}

/** Hubs with enough recipes to get a page, in whitelist order, with their (sorted) members. */
export function liveIngredientHubs<T extends HubRecipe>(items: T[]): { def: IngredientHubDef; recipes: T[] }[] {
  return INGREDIENT_HUBS.map((def) => ({ def, recipes: recipesForIngredient(def, items) })).filter(
    (h) => h.recipes.length >= INGREDIENT_MIN_RECIPES,
  );
}

export interface HubMeta {
  title: string;
  heading: string;
  description: string;
  intro: string;
}

/** "£0.93–£2.40 per serving" (or one figure when min and max round the same); null when nothing is fully priced. */
export function perServingRangeText(recipes: Pick<HubRecipe, "fullTierPrice">[]): string | null {
  const range = fullTierPriceRange(recipes);
  if (!range) return null;
  const lo = formatGbp(range.min);
  const hi = formatGbp(range.max);
  return lo === hi ? `${lo} per serving` : `${lo}–${hi} per serving`;
}

/**
 * Title / description / intro. A £ range only from tier-"full" recipes; when none is fully priced the copy
 * carries no £ at all. Title ≤ 60 and description ≤ 155 chars for every whitelisted name (tested).
 */
export function ingredientHubMeta(def: IngredientHubDef, recipes: Pick<HubRecipe, "fullTierPrice">[]): HubMeta {
  const n = recipes.length;
  const range = fullTierPriceRange(recipes);
  const price = perServingRangeText(recipes);
  const label = def.label.toLowerCase();
  const name = def.name.toLowerCase();
  const heading = `${def.label} recipes`;
  const title = `${def.label} Recipes UK, Cost Per Serving · UseItUp`;
  const description = price
    ? `${n} ${label} recipes priced at UK supermarkets: ${price}. See the cost before you shop.`
    : `${n} ${label} recipes with ingredients priced at UK supermarkets. See the cost before you shop.`;
  const cost = range ? (formatGbp(range.min) === formatGbp(range.max) ? formatGbp(range.min) : `${formatGbp(range.min)}–${formatGbp(range.max)}`) : null;
  const intro =
    cost && range
      ? `${n} recipes with ${name}. For the ${range.count} with most ingredients priced, a serving costs ${cost} at UK supermarkets.`
      : `${n} recipes with ${name}. Ingredients are priced at UK supermarkets where we have prices.`;
  return { title, heading, description, intro };
}
