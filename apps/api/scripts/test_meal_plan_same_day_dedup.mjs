// Regression test for the 2026-07-30 same-day-repeat bug fix in
// selectMealPlan() (mealPlanGenerator.ts). Jackie's click-through repro
// (Japanese cuisine + Quick-to-cook dietary + Milk allergen + Keep it simple)
// is also exercised live against real data in
// summaries/2026-07-30_meal-plan-wizard-fixes-raw.md — this script instead
// uses a synthetic pool to deterministically prove two things pure real-data
// probing can't reliably force:
//   1. same-day dedup: when 2+ recipes are available, no slot repeats a
//      recipe already used earlier the same day.
//   2. poolTooSmallWarning: when literally only 1 recipe is eligible for
//      every slot, the generator still has to repeat it (correctly), but
//      must set poolTooSmallWarning=true so the UI can explain why.
//   3. cross-day rotation (2026-07-30 follow-up): with 3+ eligible recipes
//      for a slot, variation="low" (repeatCap=Infinity) must still rotate
//      across a week instead of picking the same recipe every day — see
//      Case D.
//
// Usage: node apps/api/scripts/test_meal_plan_same_day_dedup.mjs
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");

async function bundleService() {
  const outfile = path.join(apiRoot, "scripts", ".tmp-meal-plan-dedup-test.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/services/mealPlanGenerator.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["mongodb"],
    logLevel: "silent",
  });
  return outfile;
}

function makeRecipe(id, title, costPerServing) {
  return {
    id,
    title,
    imageUrl: "",
    servings: 2,
    tags: [],
    cuisineType: null,
    ingredientNames: ["rice", "water"],
    cookMinutes: 15,
    calories: 400,
    protein: 10,
    costPerServing,
    mealSlots: new Set(["breakfast", "lunch", "dinner"]),
  };
}

const baseInput = {
  lengthDays: 3,
  weeklyBudgetGBP: 40,
  mealSlots: ["breakfast", "lunch", "dinner"],
  variation: "low", // repeatCap = Infinity — the exact condition that exposed the bug
  cuisines: [],
  dietary: [],
  allergens: [],
  excludeKeywords: [],
};

async function main() {
  const outfile = await bundleService();
  const { selectMealPlan } = await import(`file://${outfile.replace(/\\/g, "/")}?t=${Date.now()}`);

  let failed = false;

  // --- Case A: 2 near-identical recipes (same cost -> chooseBest ties)
  // available for every slot. Before the fix, chooseBest()'s tie-break
  // (always keep the first candidate) meant all 3 slots picked recipe A
  // every day. After the fix, same-day dedup must force at least 2 distinct
  // recipes per day. ---
  console.log("=== Case A: 2 tied recipes, 3 slots/day, variation=low (repeatCap=Infinity) ===");
  const poolA = [makeRecipe("A", "Recipe A", 2.0), makeRecipe("B", "Recipe B", 2.0)];
  const planA = selectMealPlan(poolA, baseInput);
  let caseAOk = true;
  for (const day of planA.days) {
    const ids = day.entries.map((e) => e.recipeId);
    const distinct = new Set(ids);
    const ok = distinct.size === Math.min(ids.length, 2); // only 2 recipes exist, so max distinct is 2
    console.log(`  ${day.date}: [${ids.join(", ")}] distinct=${distinct.size} ${ok ? "OK" : "FAIL"}`);
    if (!ok) caseAOk = false;
  }
  console.log(`  poolTooSmallWarning: ${planA.summary.poolTooSmallWarning} (expected true — 2 recipes can't fill 3 slots without a repeat)`);
  if (!caseAOk || planA.summary.poolTooSmallWarning !== true) {
    failed = true;
    console.log("  CASE A: FAIL");
  } else {
    console.log("  CASE A: PASS");
  }

  // --- Case B: exactly 1 recipe eligible for every slot. The dedup rule
  // must NOT blank out slots (better a repeat than an empty plan) but MUST
  // flag poolTooSmallWarning. ---
  console.log("\n=== Case B: only 1 recipe eligible for any slot ===");
  const poolB = [makeRecipe("SOLO", "Only Recipe", 3.0)];
  const planB = selectMealPlan(poolB, baseInput);
  let caseBOk = true;
  for (const day of planB.days) {
    const ids = day.entries.map((e) => e.recipeId);
    const allSolo = ids.every((id) => id === "SOLO") && ids.length === 3;
    console.log(`  ${day.date}: [${ids.join(", ")}] ${allSolo ? "OK (forced repeat, as expected)" : "FAIL"}`);
    if (!allSolo) caseBOk = false;
  }
  console.log(`  poolTooSmallWarning: ${planB.summary.poolTooSmallWarning} (expected true)`);
  if (!caseBOk || planB.summary.poolTooSmallWarning !== true) {
    failed = true;
    console.log("  CASE B: FAIL");
  } else {
    console.log("  CASE B: PASS");
  }

  // --- Case C: wide pool (10 distinct recipes, 3 slots/day) — no forced
  // repeat should occur, poolTooSmallWarning must stay false. Regression
  // guard: the fix must not make the warning fire spuriously. ---
  console.log("\n=== Case C: 10 distinct recipes, 3 slots/day — no repeat needed ===");
  const poolC = Array.from({ length: 10 }, (_, i) => makeRecipe(`R${i}`, `Recipe ${i}`, 2.0 + i * 0.1));
  const planC = selectMealPlan(poolC, baseInput);
  let caseCOk = true;
  for (const day of planC.days) {
    const ids = day.entries.map((e) => e.recipeId);
    const distinct = new Set(ids);
    const ok = distinct.size === ids.length;
    console.log(`  ${day.date}: [${ids.join(", ")}] distinct=${distinct.size} ${ok ? "OK" : "FAIL"}`);
    if (!ok) caseCOk = false;
  }
  console.log(`  poolTooSmallWarning: ${planC.summary.poolTooSmallWarning} (expected false)`);
  if (!caseCOk || planC.summary.poolTooSmallWarning !== false) {
    failed = true;
    console.log("  CASE C: FAIL");
  } else {
    console.log("  CASE C: PASS");
  }

  // --- Case D: 2026-07-30 regression — chooseBest()'s tie-break used to
  // deterministically keep the first candidate on a tied/near-tied score,
  // so with variation="low" (repeatCap=Infinity) a slot with 3+ eligible
  // recipes still picked the same one every day of a 7-day plan (Jackie's
  // real report: same lunch/dinner recipe all week). chooseBest() now
  // breaks ties by preferring the least-used candidate so far, so with 3+
  // recipes available it must rotate across a week even at variation="low".
  // (Distinguishes from Case B: pool too small to rotate MUST still repeat.)
  console.log("\n=== Case D: 4 near-tied recipes, single lunch slot, variation=low, 7 days ===");
  const poolD = [
    makeRecipe("D0", "Recipe D0", 2.0),
    makeRecipe("D1", "Recipe D1", 2.0),
    makeRecipe("D2", "Recipe D2", 2.0),
    makeRecipe("D3", "Recipe D3", 2.0),
  ];
  const inputD = { ...baseInput, lengthDays: 7, mealSlots: ["lunch"] };
  const planD = selectMealPlan(poolD, inputD);
  const lunchIdsD = planD.days.map((day) => day.entries.find((e) => e.mealSlot === "lunch")?.recipeId);
  const distinctLunchD = new Set(lunchIdsD);
  console.log(`  lunch across 7 days: [${lunchIdsD.join(", ")}] distinct=${distinctLunchD.size}`);
  console.log(`  poolTooSmallWarning: ${planD.summary.poolTooSmallWarning} (expected false — 4 recipes, 1 slot/day, no forced repeat needed)`);
  const caseDOk = distinctLunchD.size >= 2 && planD.summary.poolTooSmallWarning === false;
  if (!caseDOk) {
    failed = true;
    console.log("  CASE D: FAIL");
  } else {
    console.log("  CASE D: PASS");
  }

  // --- Case E: 2026-07-31 — structural poolTooSmallWarning. 1 recipe,
  // single slot, 7 days, variation=low. Same-day dedup never fires (only 1
  // slot/day, nothing to dedup against within a day), so before this fix
  // poolTooSmallWarning stayed false even though the plan is forced to repeat
  // the same recipe all 7 days. The new check (pool size < lengthDays/2)
  // must catch this. Distinguishes from Case D: 1 recipe can't cover even
  // half of 7 days, 4 recipes can. ---
  console.log("\n=== Case E: 1 recipe, single lunch slot, variation=low, 7 days ===");
  const poolE = [makeRecipe("E0", "Recipe E0", 2.0)];
  const inputE = { ...baseInput, lengthDays: 7, mealSlots: ["lunch"] };
  const planE = selectMealPlan(poolE, inputE);
  const lunchIdsE = planE.days.map((day) => day.entries.find((e) => e.mealSlot === "lunch")?.recipeId);
  console.log(`  lunch across 7 days: [${lunchIdsE.join(", ")}]`);
  console.log(`  poolTooSmallWarning: ${planE.summary.poolTooSmallWarning} (expected true)`);
  const caseEOk = lunchIdsE.every((id) => id === "E0") && planE.summary.poolTooSmallWarning === true;
  if (!caseEOk) {
    failed = true;
    console.log("  CASE E: FAIL");
  } else {
    console.log("  CASE E: PASS");
  }

  fs.unlinkSync(outfile);
  if (failed) {
    console.log("\nOVERALL: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nOVERALL: PASS");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
