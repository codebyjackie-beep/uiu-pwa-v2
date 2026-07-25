/**
 * Recipe cost calculation — classifyUnit + normalizeQty + priceLine + costRecipe.
 *
 * Ported line-for-line from assets/recipe_cost.service.js. Unit table and
 * bucket-selection rules are documented (and locked) in assets/unit_conversion.md
 * — keep that file and this one in sync. Deliberately separate from the
 * shopping-list dedup unit table (that one uses precise scientific
 * conversions; this one uses Jackie's rounded curated values for cost-calc).
 *
 * ⚠️ Do not tune matching or "fix" gaps here — this is a behavior-preserving
 * port. Verify with `node tools/parity_replay.js` (must stay PARITY PASS,
 * 1278/1791 = 71.36%). Improvements land in separate commits.
 */
import type { CanonicalIngredient, CanonicalPriceCacheEntry, Recipe, RecipeIngredient } from "@uiu/shared";

const VOLUME_TO_ML: Record<string, number> = {
  tsp: 5, teaspoon: 5, teaspoons: 5, t: 5,
  tbsp: 15, tablespoon: 15, tablespoons: 15, tbs: 15,
  "fl oz": 30,
  cup: 240, cups: 240, c: 240,
  pint: 568, pints: 568,
  quart: 946, quarts: 946,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  cl: 10,
  ml: 1, mls: 1,
};

const WEIGHT_TO_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.35, ounce: 28.35, ounces: 28.35,
  lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
};

// Real count units — carry unit meaning beyond "one of the thing."
const COUNT_REAL_UNITS = new Set(["each", "piece", "pieces", "clove", "cloves", "stalk", "stalks", "can", "cans"]);

// Size/filler words that mean nothing beyond "bare count" — "2 medium onion" == "2 onion".
const COUNT_FILLER_WORDS = new Set(["medium", "large", "small", "whole", "size"]);

const UNCONVERTIBLE_UNITS = new Set([
  "serving", "servings", "slice", "slices", "to taste",
  "pinch", "pinches", "handful", "dash", "dashes", "drop", "drops",
]);

// Table C — per-(unit word, canonical_name) weight estimates (grams), added
// 2026-07-20 to close the "unmapped_unit" gap list. Unlike per_item_g (a
// generic "one whole item" weight on the canonical doc), these are unit-word
// specific because the same ingredient means very different quantities under
// "head" vs "bunch" vs "sprig" etc — a single per_item_g can't cover all of
// them. Values are standard kitchen/produce reference weights (manual
// estimates, not fabricated/random) — flag to Jackie for correction if off.
// Sprig/leaf entries for herbs are deliberately nominal (garnish-scale).
const PER_ITEM_UNIT_G: Record<string, Record<string, number>> = {
  head: { broccoli: 300, cabbage: 900, "savoy cabbage": 700, "boston lettuce": 150, "i gem lettuce": 80 },
  bunch: {
    spinach: 300, "spinach leaves": 300, kale: 250, thyme: 15, "yu choy": 300,
    "basil leaves": 30, "swiss chard": 350, "flat leaf parsley": 30, "flat parsley": 30,
    "butter lettuce": 150, sage: 10, radishes: 150,
  },
  fillet: { anchovy: 4, salmon: 150, "salmon fillet": 150 },
  fillets: { anchovy: 4, salmon: 150, "salmon fillet": 150 },
  rib: { celery: 40 },
  inch: { ginger: 6, "ginger piece": 6, "fresh ginger": 6, "cinnamon stick": 2 },
  inches: { ginger: 6, "ginger piece": 6, "fresh ginger": 6, "long beans": 5 },
  sprig: { savory: 1, "curry leaves": 1 },
  sprigs: { parsley: 2, thyme: 2, rosemary: 2 },
  leaf: { "flat parsley": 1, "lettuce leaves": 15 },
  leaves: { "lettuce leaves": 15, "kaffir lime leaves": 0.5, "bok choy": 20 },
  box: { gelatine: 85, "lasagna noodles": 375 },
  packet: { stevia: 1 },
  container: { "basil leaves": 20 },
  bag: { asparagus: 300, "romaine lettuce": 300 },
  package: { "knorr hollandaise sauce mix": 25 },
  packages: { "chavrie goat cheese": 113, "puff pastry": 375 },
  stick: { "celery finelly": 40 },
  strips: { bacon: 20 },
  loaf: { "crusty bread (e.g., small baguette)": 400 },
  patties: { "black bean burgers (store-bought or homemade)": 100 },
  buns: { "burger buns": 60 },
};

function lookupPerItemUnitG(words: string[], canonicalName: string): number | null {
  for (const word of words) {
    const table = PER_ITEM_UNIT_G[word];
    if (table && table[canonicalName] != null) return table[canonicalName];
  }
  return null;
}

export type UnitClassification =
  | { type: "count"; unit: string }
  | { type: "volume"; unit: string }
  | { type: "weight"; unit: string }
  | { type: "unconvertible"; unit: string }
  | { type: "unmapped"; raw: string };

/**
 * Classifies a raw recipe unit string into volume/weight/count/unconvertible/unmapped.
 * Handles descriptor noise: "tablespoon grated", "cup, halved", "large can",
 * "medium, thinly sliced" all resolve to their real base unit.
 */
export function classifyUnit(rawUnit: string | null | undefined): UnitClassification {
  let s = String(rawUnit || "").toLowerCase().trim();
  s = s.replace(/\([^)]*\)?/g, "").trim();
  s = s.split(",")[0]!.trim();
  const words = s.split(/\s+/).filter(Boolean);

  if (words.length === 0) return { type: "count", unit: "" };

  for (const word of words) {
    if (VOLUME_TO_ML[word] !== undefined) return { type: "volume", unit: word };
    if (WEIGHT_TO_G[word] !== undefined) return { type: "weight", unit: word };
    if (UNCONVERTIBLE_UNITS.has(word)) return { type: "unconvertible", unit: word };
  }
  for (const word of words) {
    if (COUNT_REAL_UNITS.has(word)) return { type: "count", unit: word };
  }
  if (words.every((w) => COUNT_FILLER_WORDS.has(w))) return { type: "count", unit: words[0]! };

  return { type: "unmapped", raw: s };
}

export type NormalizeQtyResult =
  | { normValue: number; normUnit: "g" | "ml" | "pc"; bucket: "metric" | "count"; displayNote?: string }
  | { unpriceable: true; reason: string; rawUnit?: string };

export function normalizeQty(
  quantity: number,
  rawUnit: string,
  canonicalDoc: CanonicalIngredient,
  priceDoc: CanonicalPriceCacheEntry | null | undefined,
): NormalizeQtyResult {
  const classified = classifyUnit(rawUnit);

  if (classified.type === "unconvertible") {
    return { unpriceable: true, reason: "unit_unconvertible", rawUnit };
  }
  if (classified.type === "unmapped") {
    const words = classified.raw.split(/\s+/).filter(Boolean);
    const perItemG = lookupPerItemUnitG(words, canonicalDoc.canonical_name);
    if (perItemG != null) {
      const gValue = quantity * perItemG;
      return {
        normValue: gValue,
        normUnit: "g",
        bucket: "metric",
        displayNote: `${quantity} ${classified.raw} ${canonicalDoc.canonical_name} (≈${Math.round(gValue)}g, Table C estimate)`,
      };
    }
    return { unpriceable: true, reason: "unmapped_unit", rawUnit: classified.raw };
  }

  if (classified.type === "volume") {
    const mlValue = quantity * VOLUME_TO_ML[classified.unit]!;
    if (canonicalDoc.display_unit === "ml") {
      return { normValue: mlValue, normUnit: "ml", bucket: "metric" };
    }
    if (canonicalDoc.density_cup != null) {
      const gValue = (mlValue / 240) * canonicalDoc.density_cup;
      return { normValue: gValue, normUnit: "g", bucket: "metric" };
    }
    return { unpriceable: true, reason: "missing_density_cup" };
  }

  if (classified.type === "weight") {
    const gValue = quantity * WEIGHT_TO_G[classified.unit]!;
    return { normValue: gValue, normUnit: "g", bucket: "metric" };
  }

  // count
  if (priceDoc && priceDoc.per_unit_count && priceDoc.per_unit_count.value != null) {
    return { normValue: quantity, normUnit: "pc", bucket: "count" };
  }
  if (canonicalDoc.per_item_g != null) {
    const gValue = quantity * canonicalDoc.per_item_g;
    return {
      normValue: gValue,
      normUnit: "g",
      bucket: "metric",
      displayNote: `${quantity} ${canonicalDoc.canonical_name} (≈${Math.round(gValue)}g)`,
    };
  }
  return { unpriceable: true, reason: "missing_per_item_g_and_count_price" };
}

export type ResolveFn = (rawName: string) => { canonical_name: string; method: string } | { unresolved: true };

export interface CostLine {
  priceable: boolean;
  rawName: string;
  quantity: number;
  rawUnit: string;
  canonical_name?: string;
  reason?: string;
  isPantry?: boolean;
  bucket?: "metric" | "count";
  normValue?: number;
  normUnit?: "g" | "ml" | "pc";
  perUnit?: number;
  lineCost?: number;
  displayNote?: string;
  store?: string | null;
  productTitle?: string | null;
}

/** ingredientsMap: canonical_name -> canonical_ingredients doc; priceMap: canonical_name -> canonical_price_cache doc */
export function priceLine(
  ingredientLine: RecipeIngredient,
  resolveFn: ResolveFn,
  ingredientsMap: Map<string, CanonicalIngredient>,
  priceMap: Map<string, CanonicalPriceCacheEntry>,
): CostLine {
  const { name: rawName, quantity, unit: rawUnit } = ingredientLine;

  const resolved = resolveFn(rawName);
  if ("unresolved" in resolved) {
    return { priceable: false, rawName, quantity, rawUnit, reason: "unresolved" };
  }

  const canonicalDoc = ingredientsMap.get(resolved.canonical_name);
  if (!canonicalDoc) {
    return { priceable: false, rawName, quantity, rawUnit, canonical_name: resolved.canonical_name, reason: "canonical_doc_missing" };
  }
  const isPantry = !!canonicalDoc.is_pantry;
  if (canonicalDoc.known_gap) {
    return { priceable: false, rawName, quantity, rawUnit, canonical_name: resolved.canonical_name, reason: "known_gap", isPantry };
  }

  const priceDoc = priceMap.get(resolved.canonical_name);
  if (!priceDoc || (priceDoc.per_unit_metric == null && priceDoc.per_unit_count == null)) {
    return { priceable: false, rawName, quantity, rawUnit, canonical_name: resolved.canonical_name, reason: "no_price_in_cache", isPantry };
  }

  const norm = normalizeQty(quantity, rawUnit, canonicalDoc, priceDoc);
  if ("unpriceable" in norm) {
    return { priceable: false, rawName, quantity, rawUnit, canonical_name: resolved.canonical_name, reason: norm.reason, isPantry };
  }

  const perUnit = norm.bucket === "count" ? priceDoc.per_unit_count?.value : priceDoc.per_unit_metric?.value;
  if (perUnit == null) {
    return { priceable: false, rawName, quantity, rawUnit, canonical_name: resolved.canonical_name, reason: "no_price_for_bucket", bucket: norm.bucket, isPantry };
  }

  // Pantry lines are assumed already in stock — carry a real lineCost for
  // transparency, but isPantry:true lets basket/coverage callers zero them
  // out (see costRecipe's pantry-adjusted basket/coverage).
  const lineCost = isPantry ? 0 : norm.normValue * perUnit;
  return {
    priceable: true,
    rawName,
    quantity,
    rawUnit,
    canonical_name: resolved.canonical_name,
    normValue: norm.normValue,
    normUnit: norm.normUnit,
    bucket: norm.bucket,
    perUnit,
    lineCost,
    displayNote: norm.displayNote,
    isPantry,
    store: priceDoc.cheapest?.store || null,
    productTitle: priceDoc.cheapest?.title || null,
  };
}

export interface RecipeCostResult {
  basket: number;
  currency: "GBP";
  coveragePct: number;
  adjustedCoveragePct: number;
  totalLines: number;
  priceableCount: number;
  adjustedTotal: number;
  adjustedPriceable: number;
  pantryLineCount: number;
  junkLineCount: number;
  perServing: number;
  lines: CostLine[];
  unpriceableReasons: Record<string, number>;
}

/**
 * Whole-recipe aggregation — same math backs both the read-only validator and
 * the persisted cost (the Cron Trigger precompute job). Keep in sync with
 * assets/unit_conversion.md.
 */
export function costRecipe(
  recipe: Recipe,
  resolveFn: ResolveFn,
  ingredientsMap: Map<string, CanonicalIngredient>,
  priceMap: Map<string, CanonicalPriceCacheEntry>,
  quarantinedNames: Set<string>,
): RecipeCostResult {
  const lines = recipe.ingredients || [];
  const results = lines.map((line) => priceLine(line, resolveFn, ingredientsMap, priceMap));

  const priceableLines = results.filter((r) => r.priceable);
  const unpriceableLines = results.filter((r) => !r.priceable);

  const unpriceableReasons: Record<string, number> = {};
  for (const u of unpriceableLines) {
    if (u.reason) unpriceableReasons[u.reason] = (unpriceableReasons[u.reason] || 0) + 1;
  }

  // Basket: pantry lines already carry lineCost:0 from priceLine() itself
  // (assumed already in stock), so a plain sum is already pantry-adjusted.
  const basket = priceableLines.reduce((sum, r) => sum + (r.lineCost || 0), 0);
  const coveragePct = lines.length ? (priceableLines.length / lines.length) * 100 : 0;

  // Pantry-adjusted coverage: denominator drops is_pantry lines AND
  // "unresolved-junk" lines (raw text that literally names a quarantined
  // canonical, so it can never resolve to anything — not a real gap).
  // Numerator drops pantry lines too (they're priceable:true with £0 cost,
  // not a real "we know its price" win).
  const junkLines = results.filter((r) => !r.priceable && r.reason === "unresolved"
    && quarantinedNames && quarantinedNames.has(String(r.rawName || "").toLowerCase().trim()));
  const pantryLines = results.filter((r) => r.isPantry);
  const adjustedTotal = lines.length - pantryLines.length - junkLines.length;
  const adjustedPriceable = priceableLines.filter((r) => !r.isPantry).length;
  const adjustedCoveragePct = adjustedTotal > 0 ? (adjustedPriceable / adjustedTotal) * 100 : 0;

  return {
    basket,
    currency: "GBP",
    coveragePct,
    adjustedCoveragePct,
    totalLines: lines.length,
    priceableCount: priceableLines.length,
    adjustedTotal,
    adjustedPriceable,
    pantryLineCount: pantryLines.length,
    junkLineCount: junkLines.length,
    perServing: basket / (recipe.servings || 1),
    lines: results,
    unpriceableReasons,
  };
}

export { VOLUME_TO_ML, WEIGHT_TO_G };
