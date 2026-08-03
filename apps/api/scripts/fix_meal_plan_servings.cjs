// One-off migration: fix meal_plans entries written before the servings-multiplier
// bug fix (2026-08-04). Root cause: POST /api/meal-plan defaulted `servings` to
// recipe.servings (the recipe's own yield count, e.g. "makes 8") instead of 1, and
// the display layer multiplied per-serving cost/calories by that value — inflating
// both by the recipe's servings count. See summaries/2026-08-04_saved-meal-plan-display-bugs.md.
//
// This script does NOT change cost/calories fields on meal_plans docs (the collection
// never stored cost/calories — those are joined live from recipes/recipe_cost at read
// time). The only stored field that was wrong is `servings`. This migration resets
// every meal_plans.servings to 1, so the (now-fixed) read-time join stops multiplying.
//
// Default dry-run; pass --write to actually commit (same opt-in convention as
// write_conversion_curation.cjs / write_nutrition_per_100g.cjs).
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/fix_meal_plan_servings.cjs            # dry run
//   node scripts/fix_meal_plan_servings.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");

function loadDevVars() {
  const p = path.resolve(__dirname, "../.dev.vars");
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

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const mealPlans = db.collection("meal_plans");
    const recipes = db.collection("recipes");
    const recipeCost = db.collection("recipe_cost");

    const allEntries = await mealPlans.find({}).sort({ date: 1, mealSlot: 1 }).toArray();
    console.log(`Loaded ${allEntries.length} meal_plans entries`);
    console.log(`\nMode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    const recipeIds = [...new Set(allEntries.map((e) => e.recipeId.toString()))].map((id) => new ObjectId(id));
    const [recipeDocs, costDocs] = await Promise.all([
      recipeIds.length ? recipes.find({ _id: { $in: recipeIds } }).toArray() : [],
      recipeIds.length ? recipeCost.find({ recipeId: { $in: recipeIds } }).toArray() : [],
    ]);
    const recipeById = new Map(recipeDocs.map((d) => [d._id.toString(), d]));
    const costByRecipeId = new Map(costDocs.map((d) => [d.recipeId.toString(), d]));

    const affected = [];
    const alreadyOk = [];

    for (const e of allEntries) {
      const recipeIdStr = e.recipeId.toString();
      const recipe = recipeById.get(recipeIdStr);
      const costDoc = costByRecipeId.get(recipeIdStr);
      const perServingCost = costDoc && typeof costDoc.perServing === "number" ? costDoc.perServing : null;
      const perServingCalories = recipe && recipe.nutrition && typeof recipe.nutrition.calories === "number"
        ? recipe.nutrition.calories
        : null;

      const oldServings = e.servings;
      const displayedCostBefore = perServingCost != null ? perServingCost * oldServings : null;
      const displayedCaloriesBefore = perServingCalories != null ? perServingCalories * oldServings : null;
      const displayedCostAfter = perServingCost; // servings will become 1
      const displayedCaloriesAfter = perServingCalories;

      const row = {
        _id: e._id.toString(),
        date: e.date,
        mealSlot: e.mealSlot,
        recipeId: recipeIdStr,
        recipeTitle: recipe ? recipe.title : "(recipe not found)",
        servingsBefore: oldServings,
        servingsAfter: 1,
        perServingCost,
        perServingCalories,
        displayedCostBefore: displayedCostBefore != null ? Number(displayedCostBefore.toFixed(4)) : null,
        displayedCostAfter: displayedCostAfter != null ? Number(displayedCostAfter.toFixed(4)) : null,
        displayedCaloriesBefore: displayedCaloriesBefore != null ? Math.round(displayedCaloriesBefore) : null,
        displayedCaloriesAfter: displayedCaloriesAfter != null ? Math.round(displayedCaloriesAfter) : null,
      };

      if (oldServings === 1) {
        alreadyOk.push(row);
        continue;
      }
      affected.push(row);

      if (WRITE) {
        await mealPlans.updateOne({ _id: e._id }, { $set: { servings: 1 } });
      }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total entries: ${allEntries.length}`);
    console.log(`Already servings=1 (untouched): ${alreadyOk.length}`);
    console.log(`Affected (servings != 1, ${WRITE ? "written to 1" : "would be written to 1"}): ${affected.length}`);

    // Per-day before/after totals, matching GET /api/meal-plan's grouping logic.
    const byDate = new Map();
    for (const row of [...affected, ...alreadyOk]) {
      const list = byDate.get(row.date) ?? [];
      list.push(row);
      byDate.set(row.date, list);
    }
    const dayTotals = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => ({
        date,
        totalCostBefore: Number(rows.reduce((s, r) => s + (r.displayedCostBefore ?? 0), 0).toFixed(2)),
        totalCostAfter: Number(rows.reduce((s, r) => s + (r.displayedCostAfter ?? 0), 0).toFixed(2)),
        totalCaloriesBefore: Math.round(rows.reduce((s, r) => s + (r.displayedCaloriesBefore ?? 0), 0)),
        totalCaloriesAfter: Math.round(rows.reduce((s, r) => s + (r.displayedCaloriesAfter ?? 0), 0)),
      }));

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      totalEntries: allEntries.length,
      alreadyOkCount: alreadyOk.length,
      affectedCount: affected.length,
      affectedEntries: affected,
      dayTotals,
    };

    const outPath = path.resolve(
      __dirname,
      `../../../../summaries/2026-08-04_meal-plan-servings-migration-${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${outPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
