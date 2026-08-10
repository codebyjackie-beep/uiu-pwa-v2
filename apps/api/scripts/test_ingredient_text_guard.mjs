// Unit test for ingredientTextGuard() (packages/shared), per
// HANDOFF_recipe-import-french-label-bug-execute.md decision 2.
// Run: node apps/api/scripts/test_ingredient_text_guard.mjs
import assert from "node:assert/strict";
import { ingredientTextGuard, INGREDIENT_TEXT_GUARD_THRESHOLD } from "../../../packages/shared/dist/index.js";

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

console.log(`\n${passed}/${passed} tests passed.`);
