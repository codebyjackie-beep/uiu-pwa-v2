// Unit test for ingredientTextGuard() (packages/shared), per
// HANDOFF_recipe-import-french-label-bug-execute.md decision 2.
// Run: node apps/api/scripts/test_ingredient_text_guard.mjs
import assert from "node:assert/strict";
import { ingredientTextGuard, ingredientNameLooksLikeFragment, INGREDIENT_TEXT_GUARD_THRESHOLD } from "../../../packages/shared/dist/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

// Fixture: recipe_id 69b4a8c564f3ba3a3aebef07 "Roast chicken & caramelised onion" —
// one of the 8 confirmed open_food_facts label-blob recipes. Raw ingredient names from
// summaries/2026-08-10_recipe-import-french-label-bug-dry-run.json / production `recipes`.
const AEBEF07_INGREDIENTS = [
  { name: "pommes de terre", quantity: 0, unit: "" },
  { name: "huile végétales (tournesol", quantity: 0, unit: "" },
  { name: "colza en proportion variable)", quantity: 0, unit: "" },
  { name: "sucre", quantity: 0, unit: "" },
  { name: "sel", quantity: 0, unit: "" },
  { name: "oignon en poudre", quantity: 0, unit: "" },
  { name: "arôme naturel", quantity: 0, unit: "" },
  { name: "ail en poudre", quantity: 0, unit: "" },
  { name: "épices.", quantity: 0, unit: "" },
];

// A real, unaffected recipe's ingredient list (mixed quantities/units, real measurements).
const NORMAL_RECIPE_INGREDIENTS = [
  { name: "chicken breast", quantity: 500, unit: "g" },
  { name: "onion", quantity: 1, unit: "pc" },
  { name: "olive oil", quantity: 2, unit: "tbsp" },
  { name: "salt", quantity: 0, unit: "" }, // "to taste" — a lone 0-qty line is normal, not a run
  { name: "garlic", quantity: 2, unit: "clove" },
];

test("trips on the known-bad aebef07 fixture (9/9 consecutive zero-qty lines)", () => {
  const result = ingredientTextGuard(AEBEF07_INGREDIENTS);
  assert.equal(result.suspicious, true);
  assert.equal(result.maxConsecutiveZeroQtyRun, 9);
  assert.ok(result.reason);
});

test("does not trip on a normal recipe (isolated 'salt to taste' zero-qty line)", () => {
  const result = ingredientTextGuard(NORMAL_RECIPE_INGREDIENTS);
  assert.equal(result.suspicious, false);
  assert.equal(result.maxConsecutiveZeroQtyRun, 1);
});

test("threshold boundary: exactly N-1 consecutive zero-qty lines does not trip", () => {
  const lines = Array.from({ length: INGREDIENT_TEXT_GUARD_THRESHOLD - 1 }, () => ({ quantity: 0, unit: "" }));
  const result = ingredientTextGuard(lines);
  assert.equal(result.suspicious, false);
});

test("threshold boundary: exactly N consecutive zero-qty lines trips", () => {
  const lines = Array.from({ length: INGREDIENT_TEXT_GUARD_THRESHOLD }, () => ({ quantity: 0, unit: "" }));
  const result = ingredientTextGuard(lines);
  assert.equal(result.suspicious, true);
});

test("empty ingredient list does not trip", () => {
  const result = ingredientTextGuard([]);
  assert.equal(result.suspicious, false);
  assert.equal(result.maxConsecutiveZeroQtyRun, 0);
});

// cc_prompt_recipe_import_parser_fragments.md (2026-09-09) — the 4 real fragment
// names that were flagged during the 28-entry canonical_ingredients cleanup.
const FRAGMENT_NAMES = ["to 5 garlic cloves", "pcs lemon", "you can use regular basil", "i gem lettuce"];

test("ingredientNameLooksLikeFragment() catches all 4 known real-world fragment names", () => {
  for (const name of FRAGMENT_NAMES) {
    assert.equal(ingredientNameLooksLikeFragment(name), true, `expected "${name}" to be flagged`);
  }
});

test("ingredientNameLooksLikeFragment() does not flag normal ingredient names, including ones with (optional)/(regular)", () => {
  const NORMAL_NAMES = [
    "garlic cloves", "lemon", "basil", "little gem lettuce", "olive oil", "chicken broth",
    "red pepper flakes", "cola (regular)", "bacon bits (optional)", "saffron threads (optional)",
    "double cream", "salt", "black pepper",
  ];
  for (const name of NORMAL_NAMES) {
    assert.equal(ingredientNameLooksLikeFragment(name), false, `expected "${name}" NOT to be flagged`);
  }
});

test("ingredientTextGuard() trips (via fragmentLikeNames) on a recipe with one fragment-style name, even with normal quantity/unit", () => {
  const lines = [
    { name: "chicken breast", quantity: 500, unit: "g" },
    { name: "to 5 garlic cloves", quantity: 5, unit: "cloves" },
    { name: "olive oil", quantity: 2, unit: "tbsp" },
  ];
  const result = ingredientTextGuard(lines);
  assert.equal(result.suspicious, true);
  assert.deepEqual(result.fragmentLikeNames, ["to 5 garlic cloves"]);
  assert.ok(result.reason);
});

test("ingredientTextGuard() still does not trip on a fully normal recipe (no fragments, no zero-qty run)", () => {
  const result = ingredientTextGuard(NORMAL_RECIPE_INGREDIENTS);
  assert.equal(result.suspicious, false);
  assert.deepEqual(result.fragmentLikeNames, []);
});

console.log(`\n${passed}/${passed} tests passed.`);
