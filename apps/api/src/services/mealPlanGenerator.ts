/**
 * AI meal plan generator (HANDOFF_ai-meal-plan-generator.md Part A).
 *
 * Reads existing recipes/recipe_cost/nutrition and picks a plan — never
 * recomputes cost or nutrition (that stays the cost engine's job, see
 * ../services/recipeCost.ts). Output is a preview; nothing is written to
 * meal_plans here (the caller posts each chosen entry via the existing
 * POST /api/meal-plan route once the user confirms).
 *
 * Two data gaps this deliberately works around (see handoff for the audit):
 *  - `mealType` is unreliable (167/197 recipes have no value) — meal-slot
 *    eligibility is derived from `tags` instead, via deriveMealSlots().
 *  - `canonical_ingredients` has no allergen field — allergen/dislike
 *    exclusion is keyword-based against raw ingredient names, best-effort
 *    only (see ALLERGEN_KEYWORDS). The UI must disclose this, not this file.
 */
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  GeneratedMealPlan,
  GeneratedMealPlanDay,
  GeneratedMealSlotEntry,
  MealPlanGeneratorInput,
  MealSlot,
  UkAllergen,
} from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

// ---------------------------------------------------------------------------
// Pool: one flattened, filter-ready record per public recipe.
// ---------------------------------------------------------------------------

export interface PoolRecipe {
  id: string;
  title: string;
  imageUrl: string;
  servings: number;
  /** Lowercased tags, for slot/cuisine/dietary matching. */
  tags: string[];
  cuisineType: string | null;
  /** Lowercased ingredient names, for allergen/exclude-keyword matching. */
  ingredientNames: string[];
  cookMinutes: number;
  calories: number | null;
  protein: number | null;
  /** Null when recipe_cost has no basket yet (cost engine gap, not this generator's job to fill). */
  costPerServing: number | null;
  /** Total basket cost in GBP, same null-when-uncomputed convention as costPerServing. */
  basket: number | null;
  /** RecipeCost.adjustedCoveragePct, null when recipe_cost has no doc yet. Added for meal-suggestions'
   * coverage-threshold filter (HANDOFF_tonight-suggestion.md) — read-only, doesn't change selectMealPlan. */
  adjustedCoveragePct: number | null;
  mealSlots: Set<MealSlot>;
}

const MEAL_SLOT_TAGS: Record<string, MealSlot[]> = {
  breakfast: ["breakfast"],
  brunch: ["breakfast", "lunch"],
  lunch: ["lunch"],
  dinner: ["dinner"],
  snack: ["snack"],
};

/**
 * Soup keyword list (HANDOFF_meal-planner-slot-scoring-fix.md Bug 1,
 * 2026-08-03). Keyword-based against title+tags, not calorie-threshold-based
 * — some desserts exceed 500 kcal, so calories can't distinguish them.
 * Deliberately no "broth" in SOUP_KEYWORDS: some pasta dishes are "with
 * broth" and would be wrongly caught.
 *
 * Dessert used to be keyword-matched the same way (DESSERT_KEYWORDS incl.
 * "cake"/"pie"/"tart"/"pudding"/"muffin") but a full production scan
 * (HANDOFF_dessert-keyword-savory-fix.md, 2026-08-04) found that produced 35
 * false positives — genuine savory dishes whose name/tags happen to contain
 * a dessert word (Crab Cakes Eggs Benedict, Fish Pie, Shepherd's Pie, Yorkshire
 * Puddings, Flamiche, Cream Cheese Tart, etc.) — and 0 true positives it
 * caught that the "dessert" tag didn't already cover (all 77 dessert-tagged
 * recipes without a keyword match, e.g. Churros/Flan/Tiramisu-style dishes,
 * were being silently mis-slotted into lunch/dinner anyway). Dessert
 * detection is now tag-based only (see isDessert below), consistent with
 * how every other meal slot (breakfast/lunch/dinner/snack) is already
 * determined via MEAL_SLOT_TAGS.
 */
const SOUP_KEYWORDS = ["soup", "chowder", "bisque"];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match, not raw substring (HANDOFF_dessert-keyword-substring-fix.md,
 * 2026-08-04) — plain .includes() let the "starter" tag false-match "tart" in
 * DESSERT_KEYWORDS, misclassifying starter/soup recipes as dessert. \b boundaries
 * still match "tart" as a whole word (e.g. a recipe/tag literally called "tart").
 * Trailing `s?` keeps plural titles/tags matching (e.g. "Cookies", "Muffins") —
 * without it \b...\b stops matching once a plural "s" is appended, which would
 * be a regression (verified against all 200 recipes, see the summary's diff).
 */
function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => new RegExp(`\\b${escapeRegex(k)}s?\\b`, "i").test(text));
}

/**
 * Tags-based, not mealType-based (see file header). Recipes with no
 * recognizable meal-slot tag default to lunch+dinner — a product judgment
 * call for the 58/197 recipes with zero signal (mostly savoury mains),
 * not a hard rule. Soup and dessert overrides below apply regardless of
 * whether the slots came from a tag or the fallback (a recipe tagged
 * "dinner" that's actually soup still shouldn't show up at dinner).
 */
function deriveMealSlots(titleLower: string, tagsLower: string[]): Set<MealSlot> {
  const isDessert = tagsLower.includes("dessert");
  const isSoup = matchesAny(titleLower, SOUP_KEYWORDS) || tagsLower.some((t) => matchesAny(t, SOUP_KEYWORDS));

  const slots = new Set<MealSlot>();
  for (const tag of tagsLower) {
    const mapped = MEAL_SLOT_TAGS[tag];
    if (mapped) for (const s of mapped) slots.add(s);
  }

  if (slots.size === 0) {
    if (isDessert) {
      slots.add("snack");
    } else if (isSoup) {
      slots.add("lunch");
    } else {
      slots.add("lunch");
      slots.add("dinner");
    }
  }

  // Soup is never dinner-eligible (lunch is fine); dessert is never
  // lunch/dinner-eligible — regardless of tag vs fallback origin above.
  if (isSoup) slots.delete("dinner");
  if (isDessert) {
    slots.delete("lunch");
    slots.delete("dinner");
  }

  return slots;
}

function toPoolRecipe(doc: Document, costDoc: Document | null): PoolRecipe {
  const tags: string[] = Array.isArray(doc.tags) ? (doc.tags as string[]).map((t) => String(t).toLowerCase()) : [];
  const ingredients: Document[] = Array.isArray(doc.ingredients) ? (doc.ingredients as Document[]) : [];
  const nutrition = doc.nutrition as Document | undefined;
  const titleLower = String(doc.title ?? "").toLowerCase();
  return {
    id: (doc._id as ObjectIdType).toString(),
    title: doc.title as string,
    imageUrl: (doc.imageUrl as string) ?? "",
    servings: (doc.servings as number) ?? 1,
    tags,
    cuisineType: (doc.cuisineType as string | null | undefined) ?? null,
    ingredientNames: ingredients.map((i) => String(i.name ?? "").toLowerCase()),
    cookMinutes: ((doc.cookTimeMinutes as number) ?? 0) + ((doc.prepTimeMinutes as number) ?? 0),
    calories: nutrition?.calories != null ? Math.round(nutrition.calories as number) : null,
    protein: (nutrition?.protein as number | undefined) ?? null,
    costPerServing: costDoc && (costDoc.perServing as number) > 0 ? (costDoc.perServing as number) : null,
    basket: costDoc && (costDoc.basket as number) > 0 ? (costDoc.basket as number) : null,
    adjustedCoveragePct: costDoc ? (costDoc.adjustedCoveragePct as number) : null,
    mealSlots: deriveMealSlots(titleLower, tags),
  };
}

/** Fetches every public recipe joined with its recipe_cost doc. Read-only — touches no other collection. */
export async function buildPool(env: DbEnv): Promise<PoolRecipe[]> {
  return withDb(env, async (db) => {
    const recipeDocs = await db.collection("recipes").find({ isPublic: true }).toArray();
    const ids = recipeDocs.map((d) => d._id as ObjectIdType);
    const costDocs = ids.length
      ? await db.collection("recipe_cost").find({ recipeId: { $in: ids } }).toArray()
      : [];
    const costByRecipeId = new Map(costDocs.map((d) => [(d.recipeId as ObjectIdType).toString(), d]));
    return recipeDocs.map((d) => toPoolRecipe(d, costByRecipeId.get((d._id as ObjectIdType).toString()) ?? null));
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Dietary-habit keys the wizard offers (Step 6). Tag-based where a real tag
 * exists in the data; numeric-threshold based where it doesn't (there's no
 * "high-protein" or "budget" tag on any of the 197 curated recipes).
 */
export const DIETARY_FILTERS: Record<string, (r: PoolRecipe) => boolean> = {
  vegetarian: (r) => r.tags.some((t) => t.includes("vegetarian")),
  vegan: (r) => r.tags.includes("vegan"),
  pescatarian: (r) => r.tags.some((t) => t.includes("pescatarian")),
  "gluten-free": (r) => r.tags.some((t) => t.includes("gluten free") || t.includes("gluten-free")),
  "dairy-free": (r) => r.tags.some((t) => t.includes("dairy free") || t.includes("dairy-free")),
  keto: (r) => r.tags.some((t) => t.includes("keto")),
  paleo: (r) => r.tags.some((t) => t.includes("paleo") || t.includes("primal")),
  "high-protein": (r) => (r.protein ?? 0) >= 25,
  budget: (r) => r.costPerServing != null && r.costPerServing <= 2.5,
  quick: (r) => r.cookMinutes > 0 && r.cookMinutes <= 30,
};

/**
 * Best-effort UK FSA 14-allergen keyword map — matched as a substring against
 * ingredient names. NOT a medical-grade check (no allergen field exists on
 * canonical_ingredients to check against instead). The wizard UI must
 * disclose this limitation; do not surface this list as authoritative.
 *
 * French terms added 2026-07-29 after `scripts/audit_ingredient_language.cjs`
 * found 2/191 public recipes (both source=open_food_facts — packaged-food
 * label text) with French-only ingredient names; raw findings at
 * summaries/2026-07-29_ingredient-language-audit.json. `ingredientNames` is
 * only lowercased, not diacritic-stripped (see toPoolRecipe), so both the
 * accented and unaccented spelling are listed where they differ (e.g.
 * "céleri"/"celeri") — except "blé", where only the accented form is kept:
 * an unaccented "ble" is a substring of "vegetable" and was found to
 * wrongly match 37 unrelated recipes during verification, so it was
 * dropped. No other language was found in the 191-recipe scan, so no
 * further expansion beyond French is grounded in evidence yet.
 */
export const ALLERGEN_KEYWORDS: Record<UkAllergen, string[]> = {
  celery: ["celery", "celeriac", "céleri", "celeri"],
  cereals_gluten: [
    "wheat", "flour", "bread", "pasta", "noodle", "barley", "rye", "oats", "oat", "breadcrumb", "couscous", "semolina",
    "blé", "farine", "gluten", "avoine", "orge", "seigle",
  ],
  crustaceans: ["prawn", "shrimp", "crab", "lobster", "crayfish", "langoustine", "crevette", "crevettes", "crabe", "homard"],
  eggs: ["egg", "œuf", "oeuf", "oeufs"],
  fish: ["fish", "salmon", "tuna", "cod", "anchov", "haddock", "trout", "sardine", "mackerel", "poisson"],
  lupin: ["lupin"],
  milk: ["milk", "cheese", "butter", "cream", "yoghurt", "yogurt", "dairy", "mozzarella", "parmesan", "ricotta", "paneer", "lait", "beurre", "fromage"],
  molluscs: ["mussel", "oyster", "squid", "octopus", "clam", "scallop", "snail", "cockle", "moule", "moules", "huître", "huitre", "calmar", "poulpe"],
  mustard: ["mustard", "moutarde"],
  tree_nuts: [
    "almond", "hazelnut", "walnut", "cashew", "pecan", "pistachio", "brazil nut", "macadamia",
    "amande", "amandes", "noisette", "noisettes",
  ],
  peanuts: ["peanut", "groundnut", "arachide", "arachides"],
  sesame: ["sesame", "tahini", "sésame"],
  soybeans: ["soy", "soya", "tofu", "edamame", "soja"],
  sulphites: ["sulphite", "sulfite", "sulfites"],
};

function matchesCuisine(r: PoolRecipe, cuisine: string): boolean {
  const needle = cuisine.toLowerCase();
  if (r.cuisineType && r.cuisineType.toLowerCase().includes(needle)) return true;
  return r.tags.some((t) => t.includes(needle));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

/** Infinity for "low" (Basic) means "repeat as often as needed" — smaller shopping list. */
const REPEAT_CAP: Record<MealPlanGeneratorInput["variation"], number> = {
  low: Infinity,
  medium: 3,
  high: 1,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Score band treated as "tied" for rotation purposes. Scores are normalized
 * (relative cost/calorie difference, roughly 0-1), so 3% is a "practically
 * the same fit" band, not an exact-equality requirement — real recipe costs
 * rarely match to the penny, but two recipes both ~3% off target should
 * still rotate rather than always losing to whichever happens to come first.
 */
const TIE_SCORE_EPSILON = 0.03;

/**
 * Picks the candidate with the lowest cost/calorie-fit score. Among
 * candidates within TIE_SCORE_EPSILON of the best score, prefers whichever
 * has been used least often (usageCount) so that variation="low" (repeatCap
 * = Infinity) still rotates across a week when the pool has 3+ eligible
 * recipes, instead of deterministically picking the same first candidate
 * every time. When usage is also tied, keeps the earlier candidate in
 * `candidates` order — preserves the "run twice, same result" stability
 * guarantee.
 */
/**
 * Null cost is penalized as maximally off-target, not treated as a perfect
 * budget match (HANDOFF_meal-planner-slot-scoring-fix.md Bug 2,
 * 2026-08-03) — otherwise unpriced recipes systematically win selection
 * over priced ones ("only breakfast shows a price" bug).
 */
const NULL_COST_PENALTY = 1;

function scoreOf(r: PoolRecipe, targetCost: number, targetCalories: number | null): number {
  const costDiff =
    r.costPerServing != null && targetCost > 0 ? Math.abs(r.costPerServing - targetCost) / targetCost : NULL_COST_PENALTY;
  let calDiff = 0;
  if (targetCalories != null && r.calories != null) {
    calDiff = Math.abs(r.calories - targetCalories) / targetCalories;
  }
  return targetCalories != null ? costDiff * 0.5 + calDiff * 0.5 : costDiff;
}

function chooseBest(
  candidates: PoolRecipe[],
  targetCost: number,
  targetCalories: number | null,
  usageCount: Map<string, number>,
): PoolRecipe | null {
  if (candidates.length === 0) return null;

  let bestScore = Infinity;
  for (const r of candidates) {
    const score = scoreOf(r, targetCost, targetCalories);
    if (score < bestScore) bestScore = score;
  }

  // Among candidates within the tie band of bestScore, pick the one used
  // least often so far; ties within that go to whichever comes first in
  // `candidates` (keeps selection deterministic run-to-run).
  let chosen: PoolRecipe | null = null;
  let chosenUsage = Infinity;
  for (const r of candidates) {
    if (scoreOf(r, targetCost, targetCalories) - bestScore > TIE_SCORE_EPSILON) continue;
    const usage = usageCount.get(r.id) ?? 0;
    if (chosen === null || usage < chosenUsage) {
      chosen = r;
      chosenUsage = usage;
    }
  }
  return chosen;
}

/**
 * Pure — no I/O. Takes an already-fetched pool (see buildPool) and picks a
 * plan. Deterministic given the same pool + input (no randomness), which is
 * what the handoff's "run twice, results should be stable" acceptance check
 * relies on.
 */
export function selectMealPlan(pool: PoolRecipe[], input: MealPlanGeneratorInput): GeneratedMealPlan {
  const slots = SLOT_ORDER.filter((s) => input.mealSlots.includes(s));
  const dietaryFns = input.dietary.map((d) => DIETARY_FILTERS[d]).filter((fn): fn is (r: PoolRecipe) => boolean => !!fn);
  const excludeKeywords = input.excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean);
  const allergenKeywords = input.allergens.flatMap((a) => ALLERGEN_KEYWORDS[a] ?? []);

  const hasAllergyConstraint = allergenKeywords.length > 0 || excludeKeywords.length > 0;

  function passesHardFilters(r: PoolRecipe): boolean {
    if (dietaryFns.length && !dietaryFns.every((fn) => fn(r))) return false;
    // 28/191 public recipes have an empty ingredients[] (pre-existing data
    // gap, audited 2026-07-29 during Part A verification — not in the
    // handoff's original two gaps). Keyword matching against zero ingredient
    // names would silently "pass" them with no evidence either way, which is
    // exactly the false-negative risk the handoff calls out for the allergy
    // filter — so treat "nothing to check" as unverifiable, not safe.
    if (hasAllergyConstraint && r.ingredientNames.length === 0) return false;
    if (allergenKeywords.length && r.ingredientNames.some((n) => allergenKeywords.some((k) => n.includes(k)))) return false;
    if (excludeKeywords.length && r.ingredientNames.some((n) => excludeKeywords.some((k) => n.includes(k)))) return false;
    return true;
  }

  const basePool = pool.filter(passesHardFilters);

  let cuisineFilterRelaxed = false;
  function poolForSlot(slot: MealSlot): PoolRecipe[] {
    const bySlot = basePool.filter((r) => r.mealSlots.has(slot));
    if (!input.cuisines.length) return bySlot;
    const withCuisine = bySlot.filter((r) => input.cuisines.some((c) => matchesCuisine(r, c)));
    if (withCuisine.length > 0) return withCuisine;
    cuisineFilterRelaxed = true;
    return bySlot;
  }

  const slotPools = new Map(slots.map((s) => [s, poolForSlot(s)]));
  const repeatCap = REPEAT_CAP[input.variation];
  const usageCount = new Map<string, number>();
  let poolTooSmallWarning = false;

  // Structural check, independent of the day-loop's same-day dedup trigger
  // below: a slot whose eligible pool can't even cover half the plan's days
  // with distinct recipes is guaranteed to repeat heavily regardless of
  // variation/repeatCap, even if same-day dedup never fires (e.g. only one
  // slot/day). Half the length (not the full length) is the threshold so a
  // pool that already supports reasonable rotation (e.g. 4 recipes over 7
  // days) doesn't spuriously warn.
  for (const slot of slots) {
    if ((slotPools.get(slot) ?? []).length < input.lengthDays / 2) {
      poolTooSmallWarning = true;
    }
  }

  const totalSlots = input.lengthDays * slots.length;
  const totalBudget = (input.weeklyBudgetGBP / 7) * input.lengthDays;
  let remainingBudget = totalBudget;
  let remainingSlots = totalSlots;

  const perMealCalorieTarget = input.calorieTargetPerDay ? input.calorieTargetPerDay / (slots.length || 1) : null;

  const startDate = input.startDate ? new Date(`${input.startDate}T00:00:00Z`) : new Date(formatDate(new Date()) + "T00:00:00Z");

  const days: GeneratedMealPlanDay[] = [];
  for (let d = 0; d < input.lengthDays; d++) {
    const date = formatDate(addDaysUtc(startDate, d));
    const entries: GeneratedMealSlotEntry[] = [];
    // Same-day dedup floor: independent of `variation`, which only governs
    // cross-day repeat frequency. Without this, a tied/near-tied chooseBest()
    // score plus a permissive repeatCap (e.g. "low" = Infinity) can pick the
    // same recipe for every slot in one day.
    const usedToday = new Set<string>();

    for (const slot of slots) {
      const slotPool = slotPools.get(slot) ?? [];
      let candidates = slotPool.filter((r) => (usageCount.get(r.id) ?? 0) < repeatCap);
      // Best-effort fallback: if the repeat cap has exhausted every candidate
      // for this slot, allow reuse rather than leaving the slot empty.
      if (candidates.length === 0) candidates = slotPool;

      const notUsedToday = candidates.filter((r) => !usedToday.has(r.id));
      if (notUsedToday.length > 0) {
        candidates = notUsedToday;
      } else if (candidates.length > 0) {
        // Every remaining candidate for this slot was already used earlier
        // today — the pool is too small to honour the same-day dedup rule,
        // so fall back to repeating and surface it via the warning flag
        // rather than silently producing a monotonous plan.
        poolTooSmallWarning = true;
      }

      const targetCost = remainingSlots > 0 ? remainingBudget / remainingSlots : 0;
      const chosen = chooseBest(candidates, targetCost, perMealCalorieTarget, usageCount);
      remainingSlots -= 1;

      if (chosen) {
        usageCount.set(chosen.id, (usageCount.get(chosen.id) ?? 0) + 1);
        usedToday.add(chosen.id);
        remainingBudget -= chosen.costPerServing ?? targetCost;
        entries.push({
          mealSlot: slot,
          recipeId: chosen.id,
          title: chosen.title,
          imageUrl: chosen.imageUrl,
          servings: chosen.servings,
          calories: chosen.calories,
          costPerServing: chosen.costPerServing,
        });
      }
    }

    days.push({
      date,
      entries,
      totalCost: round2(entries.reduce((sum, e) => sum + (e.costPerServing ?? 0), 0)),
      totalCalories: entries.reduce((sum, e) => sum + (e.calories ?? 0), 0),
    });
  }

  const totalMeals = days.reduce((sum, day) => sum + day.entries.length, 0);
  const totalCostAll = days.reduce((sum, day) => sum + day.totalCost, 0);
  const totalCaloriesAll = days.reduce((sum, day) => sum + day.totalCalories, 0);

  return {
    days,
    summary: {
      totalMeals,
      totalCost: round2(totalCostAll),
      avgCaloriesPerDay: input.lengthDays ? Math.round(totalCaloriesAll / input.lengthDays) : 0,
      budgetGBP: round2(totalBudget),
      lengthDays: input.lengthDays,
      cuisineFilterRelaxed,
      poolTooSmallWarning,
    },
  };
}

/** Convenience wrapper: fetch the pool then select. Read-only end to end. */
export async function generateMealPlan(env: DbEnv, input: MealPlanGeneratorInput): Promise<GeneratedMealPlan> {
  const pool = await buildPool(env);
  return selectMealPlan(pool, input);
}
