// Unit test for src/services/nutritionGrams.ts (cc prompt 2026-10-12, Nutrition Part 1).
// Pure functions, no DB / network. esbuild-bundles the TS (same technique as
// test_recipe_draft_gap_rotation.mjs).
// Run: node scripts/test_nutrition_grams.mjs   (from apps/api)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const entry = path.join(here, "_nutrition_test_entry.mjs");
const out = path.join(here, "_nutrition_test_bundle.mjs");
fs.writeFileSync(entry, `export * from "../src/services/nutritionGrams.ts";\n`);
let mod;
try {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
  mod = await import(`file://${out.replace(/\\/g, "/")}?t=${Date.now()}`);
} finally {
  fs.rmSync(entry, { force: true });
  fs.rmSync(out, { force: true });
}
const { ingredientGrams, computeRecipeNutrition, liquidFallbackGPerMl } = mod;

let n = 0;
function check(name, fn) {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
}
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} not within ${tol} of ${expected}`);

// canonical docs (values as in CoFID-derived nutrition_per_100g; coconut milk = CoFID 14-889 AFTER the mapping fix —
// the DB row held 22 kcal/100g before it)
const oliveOil = { canonical_name: "olive oil", density_cup: null, per_item_g: null, is_pantry: false, nutrition_per_100g: { kcal: 899, protein: 0, carbs: 0, fat: 99.9 } };
const egg = { canonical_name: "egg", density_cup: null, per_item_g: 55, is_pantry: false, nutrition_per_100g: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.9 } };
const coconutMilk = { canonical_name: "coconut milk", density_cup: 240, per_item_g: null, is_pantry: false, nutrition_per_100g: { kcal: 169, protein: 1.1, carbs: 3.3, fat: 16.9 } };
const weirdLiquid = { canonical_name: "mystery liqueur blend", density_cup: null, per_item_g: null, is_pantry: false, nutrition_per_100g: { kcal: 250, protein: 0, carbs: 20, fat: 0 } };
const flour = { canonical_name: "plain flour", density_cup: 125, per_item_g: null, is_pantry: false, nutrition_per_100g: { kcal: 364, protein: 10, carbs: 76, fat: 1 } };
const salt = { canonical_name: "salt", density_cup: null, per_item_g: null, is_pantry: true, nutrition_per_100g: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
const water = { canonical_name: "water", density_cup: null, per_item_g: null, is_pantry: false, nutrition_per_100g: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
const noNutrition = { canonical_name: "garam masala", density_cup: null, per_item_g: null, is_pantry: false, nutrition_per_100g: null };

// --- ingredientGrams ------------------------------------------------------------------------
check("olive oil 15 ml, no density → liquid fallback 0.92 g/ml = 13.8 g → ~124 kcal", () => {
  const g = ingredientGrams(15, "ml", oliveOil);
  assert.equal(g.method, "liquid_fallback");
  near(g.grams, 13.8, 0.01, "grams");
  near((g.grams / 100) * oliveOil.nutrition_per_100g.kcal, 124, 4, "kcal");
});
check("olive oil 1 tbsp ≈ 15 ml → ~13.8 g", () => {
  const g = ingredientGrams(1, "tbsp", oliveOil);
  near(g.grams, 13.8, 0.4, "grams");
});
check("density_cup wins over the liquid fallback: ml/240 × density_cup", () => {
  const g = ingredientGrams(120, "ml", { ...oliveOil, density_cup: 216 });
  assert.equal(g.method, "density_cup");
  near(g.grams, 108, 0.01, "grams");
});
check("egg 2 (raw unit \"\" and \"large\" — normUnit \"pc\" is price-side) with per_item_g 55 → 110 g → ~157 kcal (50–60 g band → 143–172)", () => {
  assert.equal(ingredientGrams(2, "large", egg).grams, 110);
  const g = ingredientGrams(2, "", egg);
  assert.equal(g.method, "per_item_g");
  near(g.grams, 110, 0.01, "grams");
  const kcal = (g.grams / 100) * egg.nutrition_per_100g.kcal;
  assert.ok(kcal >= 143 && kcal <= 172, `egg kcal ${kcal}`);
});
check("coconut milk 400 g → 676 kcal", () => {
  const g = ingredientGrams(400, "g", coconutMilk);
  assert.equal(g.method, "weight");
  near((g.grams / 100) * coconutMilk.nutrition_per_100g.kcal, 676, 0.01, "kcal");
});
check("coconut milk 1 can (400 ml tin) path: 400 ml with density_cup 240 → 400 g", () => {
  near(ingredientGrams(400, "ml", coconutMilk).grams, 400, 0.01, "grams");
});
check("weird liquid without density → null / missing_density (not guessed)", () => {
  const g = ingredientGrams(100, "ml", weirdLiquid);
  assert.equal(g.grams, null);
  assert.equal(g.reason, "missing_density");
});
check("count with no per_item_g and no Table C match → null / missing_per_item_g", () => {
  const g = ingredientGrams(2, "piece", { ...weirdLiquid, canonical_name: "dragon thing" });
  assert.equal(g.grams, null);
  assert.equal(g.reason, "missing_per_item_g");
});
check("raw unit \"unit\"/\"pcs\" counts like a piece (per_item_g), still null without per_item_g", () => {
  assert.equal(ingredientGrams(2, "unit", egg).grams, 110);
  assert.equal(ingredientGrams(3, "pcs", egg).grams, 165);
  assert.equal(ingredientGrams(2, "unit", { ...weirdLiquid, canonical_name: "dragon thing" }).reason, "missing_per_item_g");
});
check("bad quantity → null", () => {
  assert.equal(ingredientGrams(0, "g", flour).reason, "bad_quantity");
  assert.equal(ingredientGrams(NaN, "g", flour).reason, "bad_quantity");
});
check("liquid fallback table: excluded forms stay null (powder / cheese / paste)", () => {
  assert.equal(liquidFallbackGPerMl("chicken stock cube"), null);
  assert.equal(liquidFallbackGPerMl("tomato paste"), null);
  assert.equal(liquidFallbackGPerMl("cream cheese"), null);
  assert.equal(liquidFallbackGPerMl("coconut milk"), 1.03);
  assert.equal(liquidFallbackGPerMl("sesame oil"), 0.92);
  assert.equal(liquidFallbackGPerMl("maple syrup"), 1.36);
  assert.equal(liquidFallbackGPerMl("chicken stock"), 1.0);
});

// --- computeRecipeNutrition -----------------------------------------------------------------
const docs = new Map([oliveOil, egg, coconutMilk, flour, salt, water, noNutrition, weirdLiquid].map((d) => [d.canonical_name, d]));
const resolveFn = (raw) => (docs.has(raw) ? { canonical_name: raw, method: "exact" } : { unresolved: true });

check("per-serving maths + coverage: oil/egg/flour counted, salt+water excluded, one unconvertible line", () => {
  const r = computeRecipeNutrition(
    [
      { name: "olive oil", quantity: 30, unit: "ml" },
      { name: "egg", quantity: 2, unit: "large" },
      { name: "plain flour", quantity: 120, unit: "g" },
      { name: "salt", quantity: 1, unit: "tsp" },
      { name: "water", quantity: 200, unit: "ml" },
      { name: "mystery liqueur blend", quantity: 50, unit: "ml" },
    ],
    2,
    resolveFn,
    docs,
  );
  // oil 27.6 g × 8.99 = 248.1; eggs 110 g × 1.43 = 157.3; flour 120 × 3.64 = 436.8 → 842.2 / 2 = 421
  near(r.nutrition.calories, 421, 1, "calories/serving");
  // countable lines: oil, egg, flour, liqueur (salt pantry, water excluded) → 3 / 4
  assert.equal(r.nutrition.nutritionLineCoverage, 0.75);
  const liqueur = r.lines.find((l) => l.rawName === "mystery liqueur blend");
  assert.equal(liqueur.reason, "missing_density");
  assert.equal(r.lines.find((l) => l.rawName === "salt").inCoverage, false);
  assert.equal(r.lines.find((l) => l.rawName === "water").inCoverage, false);
});
check("unresolved ingredient lines count against coverage", () => {
  const r = computeRecipeNutrition(
    [
      { name: "plain flour", quantity: 100, unit: "g" },
      { name: "unicorn tears", quantity: 10, unit: "ml" },
    ],
    1,
    resolveFn,
    docs,
  );
  assert.equal(r.nutrition.nutritionLineCoverage, 0.5);
  assert.equal(r.lines[1].reason, "unresolved");
});
check("canonical with no nutrition data counts against coverage (reason no_nutrition)", () => {
  const r = computeRecipeNutrition([{ name: "garam masala", quantity: 5, unit: "g" }], 1, resolveFn, docs);
  assert.equal(r.nutrition.nutritionLineCoverage, 0);
  assert.equal(r.lines[0].reason, "no_nutrition");
});
check("servings <= 0 falls back to divisor 1; empty recipe → coverage 0, no NaN", () => {
  const r = computeRecipeNutrition([{ name: "plain flour", quantity: 100, unit: "g" }], 0, resolveFn, docs);
  assert.equal(r.servingsDivisor, 1);
  assert.equal(r.nutrition.calories, 364);
  const empty = computeRecipeNutrition([], 4, resolveFn, docs);
  assert.equal(empty.nutrition.calories, 0);
  assert.equal(empty.nutrition.nutritionLineCoverage, 0);
});

console.log(`\nall ${n} checks passed`);
