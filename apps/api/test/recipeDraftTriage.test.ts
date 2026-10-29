/**
 * Pure-rule tests for services/recipeDraftTriage.ts (no DB). Run with:
 *   npx tsx apps/api/test/recipeDraftTriage.test.ts
 * Rule thresholds must match scripts/triage_recipe_drafts.cjs (the 2026-10-08 run).
 */
import { cleanTags, isValidBatchId, newBatchId, normalizeTitle, passesApproveGate, rejectReasonsFor } from "../src/services/recipeDraftTriage";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const ok = { calories: 450, protein: 20, carbs: 40, fat: 15, steps: 4, ingredientNames: ["chicken", "rice", "garlic", "onion"], servings: 2 };

eq("good draft has no reject reasons", rejectReasonsFor(ok), []);
eq("6 kcal guacamole (Jackie's screenshot) rejected", rejectReasonsFor({ ...ok, calories: 6, protein: 0.3, carbs: 1.3, fat: 0.1 }), ["calories_out_of_range:6"]);
eq("49 kcal rejected", rejectReasonsFor({ ...ok, calories: 49 }), ["calories_out_of_range:49"]);
eq("50 kcal not rejected", rejectReasonsFor({ ...ok, calories: 50 }), []);
eq("1501 kcal rejected", rejectReasonsFor({ ...ok, calories: 1501 }), ["calories_out_of_range:1501"]);
eq("macros zero but kcal > 0", rejectReasonsFor({ ...ok, protein: 0, carbs: 0, fat: 0 }), ["macro_calorie_mismatch"]);
eq("1 step", rejectReasonsFor({ ...ok, steps: 1 }), ["too_few_steps:1"]);
eq("2 ingredients", rejectReasonsFor({ ...ok, ingredientNames: ["chicken", "rice"] }), ["too_few_ingredients:2"]);
eq("fragment name", rejectReasonsFor({ ...ok, ingredientNames: [...ok.ingredientNames, "to 5 garlic cloves"] }), ["fragment_ingredient_name:to 5 garlic cloves"]);
eq("servings 0", rejectReasonsFor({ ...ok, servings: 0 }), ["servings_out_of_range:0"]);
eq("servings 13", rejectReasonsFor({ ...ok, servings: 13 }), ["servings_out_of_range:13"]);

const gate = { adjustedCoveragePct: 80, calories: 150, steps: 3, ingredients: 4, mealType: "dinner" };
eq("approve gate: boundary pass", passesApproveGate(gate), true);
eq("approve gate: coverage 79.9", passesApproveGate({ ...gate, adjustedCoveragePct: 79.9 }), false);
eq("approve gate: 64 kcal (Sea King Fan Pot) not approved", passesApproveGate({ ...gate, calories: 64 }), false);
eq("approve gate: 1201 kcal", passesApproveGate({ ...gate, calories: 1201 }), false);
eq("approve gate: no mealType", passesApproveGate({ ...gate, mealType: undefined }), false);

eq("cleanTags strips leaked key", cleanTags(["korean", "mealType dinner", 3, "spicy"]), ["korean", "spicy"]);
eq("normalizeTitle", normalizeTitle("  Lean Bibimbap — Bowl!! "), "lean bibimbap bowl");
eq("2026-10-08 batch id valid", isValidBatchId("triage_2026-10-08_aca5bfe1"), true);
eq("bad batch id", isValidBatchId("triage_2026-10-08_ACA5"), false);
eq("injection batch id", isValidBatchId({ $ne: null }), false);
eq("newBatchId format", isValidBatchId(newBatchId(new Date("2026-10-29T12:00:00Z"))), true);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("recipeDraftTriage rules: all checks passed");
