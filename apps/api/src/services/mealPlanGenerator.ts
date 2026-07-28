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

interface PoolRecipe {
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
 * Tags-based, not mealType-based (see file header). Recipes with no
 * recognizable meal-slot tag default to lunch+dinner — a product judgment
 * call for the 58/197 recipes with zero signal (mostly savoury mains),
 * not a hard rule.
 */
function deriveMealSlots(tagsLower: string[]): Set<MealSlot> {
  const slots = new Set<MealSlot>();
  for (const tag of tagsLower) {
    const mapped = MEAL_SLOT_TAGS[tag];
    if (mapped) for (const s of mapped) slots.add(s);
  }
  if (slots.size === 0) {
    slots.add("lunch");
    slots.add("dinner");
  }
  return slots;
}

function toPoolRecipe(doc: Document, costDoc: Document | null): PoolRecipe {
  const tags: string[] = Array.isArray(doc.tags) ? (doc.tags as string[]).map((t) => String(t).toLowerCase()) : [];
  const ingredients: Document[] = Array.isArray(doc.ingredients) ? (doc.ingredients as Document[]) : [];
  const nutrition = doc.nutrition as Document | undefined;
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
    mealSlots: deriveMealSlots(tags),
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
 */
export const ALLERGEN_KEYWORDS: Record<UkAllergen, string[]> = {
  celery: ["celery", "celeriac"],
  cereals_gluten: ["wheat", "flour", "bread", "pasta", "noodle", "barley", "rye", "oats", "oat", "breadcrumb", "couscous", "semolina"],
  crustaceans: ["prawn", "shrimp", "crab", "lobster", "crayfish", "langoustine"],
  eggs: ["egg"],
  fish: ["fish", "salmon", "tuna", "cod", "anchov", "haddock", "trout", "sardine", "mackerel"],
  lupin: ["lupin"],
  milk: ["milk", "cheese", "butter", "cream", "yoghurt", "yogurt", "dairy", "mozzarella", "parmesan", "ricotta", "paneer"],
  molluscs: ["mussel", "oyster", "squid", "octopus", "clam", "scallop", "snail", "cockle"],
  mustard: ["mustard"],
  tree_nuts: ["almond", "hazelnut", "walnut", "cashew", "pecan", "pistachio", "brazil nut", "macadamia"],
  peanuts: ["peanut", "groundnut"],
  sesame: ["sesame", "tahini"],
  soybeans: ["soy", "soya", "tofu", "edamame"],
  sulphites: ["sulphite", "sulfite"],
};

function matchesCuisine(r: PoolRecipe, cuisine: string): boolean {
  const needle = cuisine.toLowerCase();
  if (r.cuisineType && r.cuisineType.toLowerCase().includes(needle)) return true;
  return r.tags.some((t) => t.includes(needle));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

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

function chooseBest(candidates: PoolRecipe[], targetCost: number, targetCalories: number | null): PoolRecipe | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = Infinity;
  for (const r of candidates) {
    const cost = r.costPerServing ?? targetCost;
    const costDiff = targetCost > 0 ? Math.abs(cost - targetCost) / targetCost : 0;
    let calDiff = 0;
    if (targetCalories != null && r.calories != null) {
      calDiff = Math.abs(r.calories - targetCalories) / targetCalories;
    }
    const score = targetCalories != null ? costDiff * 0.5 + calDiff * 0.5 : costDiff;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
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

    for (const slot of slots) {
      const slotPool = slotPools.get(slot) ?? [];
      let candidates = slotPool.filter((r) => (usageCount.get(r.id) ?? 0) < repeatCap);
      // Best-effort fallback: if the repeat cap has exhausted every candidate
      // for this slot, allow reuse rather than leaving the slot empty.
      if (candidates.length === 0) candidates = slotPool;

      const targetCost = remainingSlots > 0 ? remainingBudget / remainingSlots : 0;
      const chosen = chooseBest(candidates, targetCost, perMealCalorieTarget);
      remainingSlots -= 1;

      if (chosen) {
        usageCount.set(chosen.id, (usageCount.get(chosen.id) ?? 0) + 1);
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
    },
  };
}

/** Convenience wrapper: fetch the pool then select. Read-only end to end. */
export async function generateMealPlan(env: DbEnv, input: MealPlanGeneratorInput): Promise<GeneratedMealPlan> {
  const pool = await buildPool(env);
  return selectMealPlan(pool, input);
}
