// Verification harness for HANDOFF_ai-meal-plan-generator.md Part A
// (mealPlanGenerator.ts). Not part of the app bundle — dev-only tool.
//
// Bundles the real TS service with esbuild (no source duplication) and runs
// it twice against the live pool with the same input to check stability, then
// spot-checks the allergen keyword filter against real ingredient names.
//
// Usage: node apps/api/scripts/verify_meal_plan_generator.mjs
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");

function loadDevVars() {
  const p = path.join(apiRoot, ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function bundleService() {
  const outfile = path.join(apiRoot, "scripts", ".tmp-meal-plan-generator.mjs");
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

function summarize(plan) {
  return {
    totalMeals: plan.summary.totalMeals,
    totalCost: plan.summary.totalCost,
    avgCaloriesPerDay: plan.summary.avgCaloriesPerDay,
    budgetGBP: plan.summary.budgetGBP,
    cuisineFilterRelaxed: plan.summary.cuisineFilterRelaxed,
    recipeIds: plan.days.flatMap((d) => d.entries.map((e) => e.recipeId)).sort(),
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const outfile = await bundleService();
  const { generateMealPlan, buildPool, selectMealPlan, ALLERGEN_KEYWORDS } = await import(
    `file://${outfile.replace(/\\/g, "/")}?t=${Date.now()}`
  );

  const env = loadDevVars();

  const baseInput = {
    lengthDays: 7,
    weeklyBudgetGBP: 40,
    mealSlots: ["breakfast", "lunch", "dinner"],
    variation: "medium",
    cuisines: [],
    dietary: [],
    allergens: ["milk", "peanuts", "fish"],
    excludeKeywords: ["garlic"],
    calorieTargetPerDay: 2000,
    startDate: "2026-08-03",
  };

  console.log("=== Run 1 ===");
  const plan1 = await generateMealPlan(env, baseInput);
  const s1 = summarize(plan1);
  console.log(JSON.stringify(s1, null, 2));

  console.log("\n=== Run 2 (same input) ===");
  const plan2 = await generateMealPlan(env, baseInput);
  const s2 = summarize(plan2);
  console.log(JSON.stringify(s2, null, 2));

  const stable = deepEqual(s1, s2);
  console.log(`\nStability check: ${stable ? "PASS (byte-identical)" : "FAIL (differs between runs)"}`);
  if (!stable) process.exitCode = 1;

  // --- Allergy compliance spot-check: pull the real pool once, then verify
  // every chosen recipe's ingredient names against the same keyword list the
  // generator used, on 5 distinct recipes from plan1. ---
  console.log("\n=== Allergy compliance spot-check (5 recipes, allergens: milk/peanuts/fish) ===");
  const pool = await buildPool(env);
  const poolById = new Map(pool.map((r) => [r.id, r]));
  const forbidden = baseInput.allergens.flatMap((a) => ALLERGEN_KEYWORDS[a] ?? []);
  const seen = new Set();
  let checked = 0;
  let violations = 0;
  for (const day of plan1.days) {
    for (const entry of day.entries) {
      if (seen.has(entry.recipeId) || checked >= 5) continue;
      seen.add(entry.recipeId);
      checked += 1;
      const r = poolById.get(entry.recipeId);
      const hit = r.ingredientNames.filter((n) => forbidden.some((k) => n.includes(k)));
      const status = hit.length ? "VIOLATION" : "clean";
      if (hit.length) violations += 1;
      console.log(`  [${status}] ${entry.title} — ingredients: ${r.ingredientNames.join(", ")}`);
      if (hit.length) console.log(`    matched forbidden keywords: ${hit.join(", ")}`);
    }
  }
  console.log(`\nChecked ${checked} recipes, ${violations} violation(s).`);
  if (violations > 0) process.exitCode = 1;

  // --- Sanity across the three plan lengths ---
  console.log("\n=== Length sanity (1 / 7 / 30 days) ===");
  for (const lengthDays of [1, 7, 30]) {
    const plan = await generateMealPlan(env, { ...baseInput, lengthDays });
    console.log(
      `  lengthDays=${lengthDays}: totalMeals=${plan.summary.totalMeals} totalCost=£${plan.summary.totalCost} budgetGBP=£${plan.summary.budgetGBP} avgCaloriesPerDay=${plan.summary.avgCaloriesPerDay}`,
    );
  }

  fs.unlinkSync(outfile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
