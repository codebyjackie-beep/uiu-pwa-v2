// Unit test for the coverage-aware price display helpers in @uiu/shared
// (cc_prompt_recipe_data_cleanup.md Part 1). Pure functions, no DB / network.
// Run (after `npm run build` in packages/shared): node scripts/test_cost_coverage_display.mjs
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = await import(path.resolve(here, "../../../packages/shared/dist/index.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { costDisplayTier, costIsIncomplete, formatCostWithCoverage, formatTotalWithIncomplete, recipePerServingPrice } = shared;

let n = 0;
function check(name, fn) {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
}

// --- formatCostWithCoverage: the six boundary cases from the prompt ------------------------------
check("100% → £X.XX, no note", () => {
  assert.deepEqual(formatCostWithCoverage(1.234, 100), { tier: "full", text: "£1.23" });
});
check("80% (boundary, inclusive) → £X.XX", () => {
  assert.deepEqual(formatCostWithCoverage(2, 80), { tier: "full", text: "£2.00" });
});
check("79.9% → £X.XX+ with note", () => {
  assert.deepEqual(formatCostWithCoverage(2, 79.9), {
    tier: "partial",
    text: "£2.00+",
    note: "Some ingredients aren't priced yet",
  });
});
check("50% (boundary, inclusive) → £X.XX+", () => {
  const d = formatCostWithCoverage(0.5, 50);
  assert.equal(d.tier, "partial");
  assert.equal(d.text, "£0.50+");
});
check("49.9% → Price unavailable, no number", () => {
  const d = formatCostWithCoverage(0.02, 49.9);
  assert.equal(d.tier, "unavailable");
  assert.equal(d.text, "Price unavailable");
  assert.equal(d.note, undefined);
  assert.ok(!/\d/.test(d.text));
});
check("null / undefined / NaN coverage → Price unavailable (unverifiable number is never shown)", () => {
  for (const pct of [null, undefined, Number.NaN]) {
    const d = formatCostWithCoverage(3.5, pct);
    assert.equal(d.tier, "unavailable");
    assert.equal(d.text, "Price unavailable");
  }
});

// --- tier / incomplete helpers ----------------------------------------------------------------
check("costDisplayTier thresholds", () => {
  assert.equal(costDisplayTier(100), "full");
  assert.equal(costDisplayTier(80), "full");
  assert.equal(costDisplayTier(79.99), "partial");
  assert.equal(costDisplayTier(50), "partial");
  assert.equal(costDisplayTier(49.99), "unavailable");
  assert.equal(costDisplayTier(0), "unavailable");
});
check("costIsIncomplete: only >= 80 is complete", () => {
  assert.equal(costIsIncomplete(80), false);
  assert.equal(costIsIncomplete(79.9), true);
  assert.equal(costIsIncomplete(10), true);
  assert.equal(costIsIncomplete(null), true);
});

// --- totals: "+" appended when any contributing recipe is partial/unavailable ---------------------
check("formatTotalWithIncomplete", () => {
  assert.equal(formatTotalWithIncomplete(12.5, false), "£12.50");
  assert.equal(formatTotalWithIncomplete(12.5, true), "£12.50+");
  assert.equal(formatTotalWithIncomplete(0, false), "£0.00");
  assert.equal(formatTotalWithIncomplete(0, true), "£0.00"); // nothing priced → no "+" on a zero
});

// --- per-serving price (cards + price filter use perServing, never the whole-recipe basket) ------
check("recipePerServingPrice: finite positive perServing only", () => {
  assert.equal(recipePerServingPrice({ perServing: 1.05 }), 1.05);
  for (const bad of [null, undefined, {}, { perServing: 0 }, { perServing: -1 }, { perServing: Number.NaN }, { perServing: null }]) {
    assert.equal(recipePerServingPrice(bad), null);
  }
});
check("card price == detail price: Almond-Matcha Smoothie basket 2.10 / 2 servings -> 1.05", () => {
  const cost = { basket: 2.1, perServing: 1.05, adjustedCoveragePct: 100 };
  assert.equal(formatCostWithCoverage(recipePerServingPrice(cost), cost.adjustedCoveragePct).text, "£1.05");
});
check("partial coverage keeps the + on a per-serving number", () => {
  const cost = { basket: 21, perServing: 2.625, adjustedCoveragePct: 70 };
  assert.equal(formatCostWithCoverage(recipePerServingPrice(cost), cost.adjustedCoveragePct).text, "£2.63+");
});
const filters = await import(pathToFileURL(path.resolve(here, "../../web/app/lib/recipeFilters.ts")).href);
check("per-serving buckets: <1.50 / 1.50 to <3 / >=3, lower edge inclusive", () => {
  const key = (p) => filters.PRICE_BUCKETS.filter((b) => b.test(p)).map((b) => b.key);
  assert.deepEqual(key(0.5), ["under1_5"]);
  assert.deepEqual(key(1.49), ["under1_5"]);
  assert.deepEqual(key(1.5), ["1_5to3"]);
  assert.deepEqual(key(2.99), ["1_5to3"]);
  assert.deepEqual(key(3), ["3plus"]);
  assert.deepEqual(key(23.35), ["3plus"]);
  assert.deepEqual(filters.PRICE_BUCKETS.map((b) => b.label), ["Under £1.50", "£1.50–£3", "£3+"]);
});

console.log(`\n${n} checks passed`);
