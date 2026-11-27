/**
 * Pure tests for services/recipeSteps.ts (recipe steps → string[]). Run with:
 *   npx tsx apps/api/test/recipeSteps.test.ts
 */
import { normalizeRecipeSteps, stepsAreNormalized } from "../src/services/recipeSteps";

let failures = 0;
let passes = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  } else {
    passes++;
  }
}

// Already-good input is unchanged (apart from trim / blank removal).
eq("strings kept in order", normalizeRecipeSteps(["Chop.", "Fry."]), ["Chop.", "Fry."]);
eq("strings trimmed", normalizeRecipeSteps(["  Chop.  ", "\nFry.\t"]), ["Chop.", "Fry."]);
eq("blank strings dropped", normalizeRecipeSteps(["Chop.", "", "   ", "Fry."]), ["Chop.", "Fry."]);

// Shapes the drafting model actually returned (recipe_drafts, 2026-08/09).
eq(
  "{name, quantity, unit:'step'} → name",
  normalizeRecipeSteps([
    { name: " Drain the chickpeas. ", quantity: 1, unit: "step" },
    { name: "Roast for 20 minutes.", quantity: 2, unit: "step" },
  ]),
  ["Drain the chickpeas.", "Roast for 20 minutes."],
);
eq(
  "{name label, text} → text wins over label",
  normalizeRecipeSteps([{ name: "Preheat", text: "Set the oven to 190C." }, { name: "2", text: "Warm the oil." }]),
  ["Set the oven to 190C.", "Warm the oil."],
);
eq(
  "{name 'step 1', instruction} → instruction",
  normalizeRecipeSteps([{ name: "step 1", quantity: 0, unit: "count", instruction: "Whisk the batter." }]),
  ["Whisk the batter."],
);
eq("{step} → step", normalizeRecipeSteps([{ step: "Rinse the quinoa." }]), ["Rinse the quinoa."]);
eq("{description} → description", normalizeRecipeSteps([{ description: "Serve." }]), ["Serve."]);
eq("empty text falls back to name", normalizeRecipeSteps([{ name: "Serve warm.", text: "  " }]), ["Serve warm."]);

// Mixed / junk input.
eq(
  "mixed strings and objects keep order",
  normalizeRecipeSteps(["Chop.", { text: "Fry." }, "Serve."]),
  ["Chop.", "Fry.", "Serve."],
);
eq("number → String()", normalizeRecipeSteps([3]), ["3"]);
eq("null / undefined / arrays / textless objects dropped", normalizeRecipeSteps([null, undefined, ["x"], { quantity: 1 }, "Ok."]), ["Ok."]);
eq("non-array → []", normalizeRecipeSteps(undefined), []);
eq("string (not array) → []", normalizeRecipeSteps("Chop."), []);
eq("object (not array) → []", normalizeRecipeSteps({ text: "Chop." }), []);

// stepsAreNormalized
eq("normalized: clean strings", stepsAreNormalized(["Chop.", "Fry."]), true);
eq("normalized: empty array", stepsAreNormalized([]), true);
eq("not normalized: object", stepsAreNormalized([{ name: "Chop." }]), false);
eq("not normalized: untrimmed", stepsAreNormalized([" Chop."]), false);
eq("not normalized: blank", stepsAreNormalized(["Chop.", ""]), false);
eq("not normalized: missing", stepsAreNormalized(undefined), false);

console.log(`recipeSteps: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
