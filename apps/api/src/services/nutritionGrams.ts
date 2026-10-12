/**
 * Nutrition gram conversion — the ONE place that turns an ingredient line into grams for
 * calorie/macro maths (cc prompt 2026-10-12 15:13, Part 1).
 *
 * Why this exists: recipeCost.ts' normalizeQty keeps `ml` (display_unit === "ml") and `pc`
 * (price per unit count) lines un-converted because that is what the PRICE needs. The old
 * nutrition loop only counted `normUnit === "g"` lines of *priceable* rows, so oils, milks,
 * eggs, avocados etc. contributed 0 kcal. Nutrition has its own conversion here and never
 * depends on whether a line is priceable. The price branch in recipeCost.ts is untouched.
 *
 * Order (per prompt):
 *   weight -> g
 *   volume -> ml -> g:  density_cup (ml / 240 * density_cup), else the liquid fallback table
 *                       below, else null (missing_density) — never guessed
 *   count  -> per_item_g, else Table C (unit-word specific, recipeCost.ts), else null
 */
import type { CanonicalIngredient, RecipeIngredient, RecipeNutrition } from "@uiu/shared";
import { classifyUnit, lookupPerItemUnitG, VOLUME_TO_ML, WEIGHT_TO_G } from "./recipeCost";

export type NutritionGramsReason =
  | "bad_quantity"
  | "unit_unconvertible"
  | "unmapped_unit"
  | "missing_density"
  | "missing_per_item_g";

export type NutritionGramsMethod = "weight" | "density_cup" | "liquid_fallback" | "per_item_g" | "table_c";

export type NutritionGramsResult =
  | { grams: number; method: NutritionGramsMethod }
  | { grams: null; reason: NutritionGramsReason };

/**
 * Liquid fallback (g per ml) — ONLY used when the canonical doc has no `density_cup`.
 * Standard kitchen conversions: water-like liquids ~1.0 g/ml (milks 1.03), oils 0.92,
 * honey 1.42, syrups 1.36. Anything not matched here stays null: do not extend this table by
 * guessing, add `density_cup` to the canonical doc instead.
 */
const LIQUID_EXCLUDE =
  /\b(powder|cube|cubes|granules|paste|concentrate|cheese|tartar|chocolate|ice cream|flour|zest|seeds?)\b|\bin oil\b|oil[- ]packed/;
const LIQUID_FALLBACK: Array<{ label: string; pattern: RegExp; gPerMl: number }> = [
  { label: "oil", pattern: /\boil\b/, gPerMl: 0.92 },
  { label: "honey", pattern: /\bhoney\b/, gPerMl: 1.42 },
  { label: "syrup", pattern: /\bsyrup\b/, gPerMl: 1.36 },
  { label: "milk", pattern: /\bmilk\b/, gPerMl: 1.03 },
  {
    label: "water-like",
    pattern: /\b(water|stock|broth|juice|vinegar|wine|soy sauce|cream|kefir|yog(h)?urt drink|drinking yog(h)?urt)\b/,
    gPerMl: 1.0,
  },
];

export function liquidFallbackGPerMl(canonicalName: string): number | null {
  const name = canonicalName.toLowerCase();
  if (LIQUID_EXCLUDE.test(name)) return null;
  for (const rule of LIQUID_FALLBACK) if (rule.pattern.test(name)) return rule.gPerMl;
  return null;
}

/**
 * Raw unit words that mean "a count of the thing" but that classifyUnit() (price-side) leaves
 * unmapped ("2 unit bananas", "3 pcs"). Nutrition treats them as count; the price branch is untouched.
 */
const COUNT_ALIAS_UNIT_WORDS = new Set(["unit", "units", "pc", "pcs", "ea", "x", "count", "counts"]);

/** Grams for one ingredient line, or null + reason. Pure; no DB. */
export function ingredientGrams(
  quantity: number,
  rawUnit: string,
  canonicalDoc: Pick<CanonicalIngredient, "canonical_name" | "density_cup" | "per_item_g">,
): NutritionGramsResult {
  if (!Number.isFinite(quantity) || quantity <= 0) return { grams: null, reason: "bad_quantity" };
  const cls = classifyUnit(rawUnit);

  if (cls.type === "unconvertible") return { grams: null, reason: "unit_unconvertible" };

  const unmappedWords = cls.type === "unmapped" ? cls.raw.split(/\s+/).filter(Boolean) : [];
  const countAlias = unmappedWords.length > 0 && unmappedWords.every((w) => COUNT_ALIAS_UNIT_WORDS.has(w));
  if (cls.type === "unmapped" && !countAlias) {
    const g = lookupPerItemUnitG(unmappedWords, canonicalDoc.canonical_name);
    return g != null ? { grams: quantity * g, method: "table_c" } : { grams: null, reason: "unmapped_unit" };
  }

  if (cls.type === "weight") return { grams: quantity * WEIGHT_TO_G[cls.unit]!, method: "weight" };

  if (cls.type === "volume") {
    const ml = quantity * VOLUME_TO_ML[cls.unit]!;
    if (canonicalDoc.density_cup != null && canonicalDoc.density_cup > 0) {
      return { grams: (ml / 240) * canonicalDoc.density_cup, method: "density_cup" };
    }
    const gPerMl = liquidFallbackGPerMl(canonicalDoc.canonical_name);
    if (gPerMl != null) return { grams: ml * gPerMl, method: "liquid_fallback" };
    return { grams: null, reason: "missing_density" };
  }

  // count
  if (canonicalDoc.per_item_g != null && canonicalDoc.per_item_g > 0) {
    return { grams: quantity * canonicalDoc.per_item_g, method: "per_item_g" };
  }
  const words = String(rawUnit || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  const g = lookupPerItemUnitG(words, canonicalDoc.canonical_name);
  if (g != null) return { grams: quantity * g, method: "table_c" };
  return { grams: null, reason: "missing_per_item_g" };
}

/** Lines that do not count towards nutritionLineCoverage: pantry staples, water, salt. */
const WATER_SALT_NAME =
  /^((sea|kosher|table|flaky|fine|coarse|himalayan|rock|flake|iodi[sz]ed|cold|hot|warm|boiling|ice|iced|lukewarm|filtered|tap) )*(water|salt)$/;

export interface NutritionLine {
  rawName: string;
  quantity: number;
  rawUnit: string;
  canonical_name: string | null;
  grams: number | null;
  method: NutritionGramsMethod | null;
  /** Why this line contributes 0 kcal (null when it contributed). */
  reason: NutritionGramsReason | "unresolved" | "canonical_doc_missing" | "no_nutrition" | null;
  kcal: number;
  /** false for pantry / water / salt lines (they stay out of nutritionLineCoverage). */
  inCoverage: boolean;
}

export interface RecipeNutritionResult {
  /** Per serving, same rounding as the old inline formula (calories integer, macros 1 dp). */
  nutrition: Pick<RecipeNutrition, "calories" | "protein" | "carbs" | "fat" | "nutritionLineCoverage">;
  /** Whole-recipe totals before dividing by servings. */
  totals: { calories: number; protein: number; carbs: number; fat: number };
  servingsDivisor: number;
  lines: NutritionLine[];
}

export type NutritionResolveFn = (rawName: string) => { canonical_name: string; method: string } | { unresolved: true };

/**
 * Per-serving nutrition for a recipe from its ingredient lines. Replaces the four hand-copied
 * "priceable && normUnit === 'g'" loops (recipeImport x2, dailyRecipeDraft, fridgeRecipeGen) and
 * the approval/triage paths.
 */
export function computeRecipeNutrition(
  ingredients: RecipeIngredient[],
  servings: number,
  resolveFn: NutritionResolveFn,
  ingredientsMap: Map<string, CanonicalIngredient>,
): RecipeNutritionResult {
  const servingsDivisor = servings > 0 ? servings : 1;
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const lines: NutritionLine[] = [];
  let covDenominator = 0;
  let covNumerator = 0;

  for (const ing of ingredients || []) {
    const base = { rawName: ing.name, quantity: ing.quantity, rawUnit: ing.unit };
    const resolved = resolveFn(ing.name);
    if ("unresolved" in resolved) {
      covDenominator += 1;
      lines.push({ ...base, canonical_name: null, grams: null, method: null, reason: "unresolved", kcal: 0, inCoverage: true });
      continue;
    }
    const doc = ingredientsMap.get(resolved.canonical_name);
    if (!doc) {
      covDenominator += 1;
      lines.push({ ...base, canonical_name: resolved.canonical_name, grams: null, method: null, reason: "canonical_doc_missing", kcal: 0, inCoverage: true });
      continue;
    }
    const inCoverage = !doc.is_pantry && !WATER_SALT_NAME.test(doc.canonical_name.toLowerCase().trim());
    if (inCoverage) covDenominator += 1;

    const g = ingredientGrams(ing.quantity, ing.unit, doc);
    if (g.grams == null) {
      lines.push({ ...base, canonical_name: doc.canonical_name, grams: null, method: null, reason: g.reason, kcal: 0, inCoverage });
      continue;
    }
    const n = doc.nutrition_per_100g;
    if (!n || n.kcal == null) {
      lines.push({ ...base, canonical_name: doc.canonical_name, grams: g.grams, method: g.method, reason: "no_nutrition", kcal: 0, inCoverage });
      continue;
    }
    const factor = g.grams / 100;
    const kcal = n.kcal * factor;
    totals.calories += kcal;
    totals.protein += (n.protein ?? 0) * factor;
    totals.carbs += (n.carbs ?? 0) * factor;
    totals.fat += (n.fat ?? 0) * factor;
    if (inCoverage) covNumerator += 1;
    lines.push({ ...base, canonical_name: doc.canonical_name, grams: g.grams, method: g.method, reason: null, kcal, inCoverage });
  }

  const coverage = covDenominator > 0 ? covNumerator / covDenominator : 0;
  return {
    nutrition: {
      calories: Math.round(totals.calories / servingsDivisor),
      protein: Math.round((totals.protein / servingsDivisor) * 10) / 10,
      carbs: Math.round((totals.carbs / servingsDivisor) * 10) / 10,
      fat: Math.round((totals.fat / servingsDivisor) * 10) / 10,
      nutritionLineCoverage: Math.round(coverage * 1000) / 1000,
    },
    totals,
    servingsDivisor,
    lines,
  };
}
