// One-off migration: remove bad ingredient lines inherited from v1 Spoonacular
// import. Root cause + scope documented in
// summaries/2026-08-04_recipe-ingredients-unit-bug-investigation.md; execution
// scope locked down in HANDOFF_recipe-ingredients-cleanup.md. Jackie signed off
// on removing both batches (2026-08-04).
//
// Batch 1: ingredient.unit in ["servings","serving"] AND
//          ingredient.quantity === recipe.servings (146 lines / 81 recipes) —
//          Spoonacular's ambiguous-quantity fallback dumped the recipe's own
//          servings count into a single ingredient's quantity+unit.
// Batch 2: 15 specific lines (hardcoded below, exact recipeId+name match) where
//          a cooking-step SENTENCE was mis-parsed as an ingredient list item.
//          3 of these 15 have quantity !== recipe.servings so they are NOT
//          caught by batch 1's rule; the other 12 overlap batch 1. This script
//          reports the two batches separately (per HANDOFF) but only removes
//          each physical ingredient line once.
//
// This script does NOT delete any recipe, even if removal leaves it with 0
// ingredients — those cases are flagged in the report for Jackie to decide.
//
// Default dry-run; pass --write to actually commit (same opt-in convention as
// write_conversion_curation.cjs / fix_meal_plan_servings.cjs).
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/cleanup_bad_ingredient_lines.cjs            # dry run
//   node scripts/cleanup_bad_ingredient_lines.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");

// Exact (recipeId, ingredient.name) pairs identified in the investigation
// report as cooking-step sentences mis-parsed as ingredients. Chili-Garlic
// Stir Fry has two distinct ingredient entries both named "stir fry" — both
// are bad and both must go, so name-match removes both, which is correct here.
const BATCH2_STEPS = [
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "in a soup pot over heat" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "add ginger and onion" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "add chicken and stir-fry until both sides turn brown" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "add fish sauce and simmer" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "add rice and water. mix well. cover and simmer in heat" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "put-in the hardboiled eggs" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "add the safflower" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "stir in a amount of green onions. add salt and pepper if necessary" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "if rice soup becomes too" },
  { id: "69b277e5f9069a06b5536b58", title: "Chicken Arrozcaldo", name: "sprinkle a little lemon juice on the soup" },
  { id: "69c31df4b17f27d65b4f4ed3", title: "The Best Quinoa Minestrone", name: "baguette smothered in my pistachio pesto" },
  { id: "69c4766a7393a7f0235b89c9", title: "Butternut Squash Souffle Side Dish", name: "butter to grease the ramekins" },
  { id: "69d04b0f26a6c4c3877dfcc8", title: "Butternut Squash, Red Onion and Chickpea Salad", name: "optional - some feta cheese" },
  { id: "69d5710287d5d72710ae8eb1", title: "Chili-Garlic Stir Fry", name: "stir fry" },
  { id: "69d5710287d5d72710ae8eb1", title: "Chili-Garlic Stir Fry", name: "stir fry" },
];

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
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
    const recipes = db.collection("recipes");

    const docs = await recipes
      .find({ "ingredients.unit": { $in: ["servings", "serving"] } })
      .project({ title: 1, servings: 1, ingredients: 1 })
      .toArray();

    console.log(`Recipes with an ingredient unit == "servings"/"serving": ${docs.length}`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    // Remaining batch2 entries not yet consumed, so the duplicate "stir fry"
    // pair each consume one hardcoded slot instead of both matching the first.
    const batch2Remaining = BATCH2_STEPS.map((s) => ({ ...s, used: false }));

    let batch1LineCount = 0;
    let batch2LineCount = 0;
    let unexplainedLineCount = 0;
    const recipeReports = [];

    for (const r of docs) {
      const idStr = r._id.toString();
      const keptIngredients = [];
      const removedLines = [];

      for (const ing of r.ingredients) {
        const isTargetUnit = ing.unit === "servings" || ing.unit === "serving";
        if (!isTargetUnit) {
          keptIngredients.push(ing);
          continue;
        }

        const isBatch1 = ing.quantity === r.servings;
        const batch2Slot = batch2Remaining.find((s) => !s.used && s.id === idStr && s.name === ing.name);
        const isBatch2 = !!batch2Slot;

        if (isBatch1 || isBatch2) {
          if (batch2Slot) batch2Slot.used = true;
          if (isBatch1) batch1LineCount++;
          if (isBatch2) batch2LineCount++;
          removedLines.push({
            name: ing.name,
            quantity: ing.quantity,
            unit: ing.unit,
            reason: isBatch1 && isBatch2 ? "batch1+batch2" : isBatch1 ? "batch1" : "batch2",
          });
        } else {
          unexplainedLineCount++;
          keptIngredients.push(ing); // safety: don't remove anything outside the two defined batches
          console.log(`  WARNING: unexplained servings-unit line kept, review manually: [${idStr}] ${r.title} :: "${ing.name}" qty=${ing.quantity}`);
        }
      }

      if (removedLines.length === 0) continue;

      recipeReports.push({
        id: idStr,
        title: r.title,
        servings: r.servings,
        removedLines,
        ingredientCountBefore: r.ingredients.length,
        ingredientCountAfter: keptIngredients.length,
        emptyAfterCleanup: keptIngredients.length === 0,
      });

      if (WRITE) {
        await recipes.updateOne({ _id: r._id }, { $set: { ingredients: keptIngredients } });
      }
    }

    const unusedBatch2 = batch2Remaining.filter((s) => !s.used);
    if (unusedBatch2.length > 0) {
      console.log(`\nWARNING: ${unusedBatch2.length} hardcoded batch-2 entries were NOT found in DB (title/name may have changed):`);
      for (const s of unusedBatch2) console.log(`  [${s.id}] ${s.title} :: "${s.name}"`);
    }

    const emptyAfterCleanup = recipeReports.filter((r) => r.emptyAfterCleanup);

    console.log(`\n=== SUMMARY ===`);
    console.log(`Recipes touched: ${recipeReports.length}`);
    console.log(`Batch 1 lines removed (unit=servings/serving, quantity===recipe.servings): ${batch1LineCount}`);
    console.log(`Batch 2 lines removed (step-sentence mis-parsed as ingredient): ${batch2LineCount}`);
    console.log(`Unexplained servings-unit lines (kept, NOT removed): ${unexplainedLineCount}`);
    console.log(`Recipes left with 0 ingredients after cleanup: ${emptyAfterCleanup.length}`);
    if (emptyAfterCleanup.length > 0) {
      console.log(`  >>> FLAGGED FOR REVIEW (not auto-handled): ${emptyAfterCleanup.map((r) => `${r.title} [${r.id}]`).join(", ")}`);
    }

    console.log(`\n=== PER-RECIPE DETAIL ===`);
    for (const r of recipeReports) {
      console.log(`\n[${r.id}] ${r.title} (recipe.servings=${r.servings})  ingredients: ${r.ingredientCountBefore} -> ${r.ingredientCountAfter}${r.emptyAfterCleanup ? "  *** EMPTY AFTER CLEANUP ***" : ""}`);
      for (const line of r.removedLines) {
        console.log(`    [${line.reason}] name="${line.name}" quantity=${line.quantity} unit="${line.unit}"`);
      }
    }

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      recipesTouched: recipeReports.length,
      batch1LineCount,
      batch2LineCount,
      unexplainedLineCount,
      emptyAfterCleanupCount: emptyAfterCleanup.length,
      emptyAfterCleanup: emptyAfterCleanup.map((r) => ({ id: r.id, title: r.title })),
      recipes: recipeReports,
    };
    const outPath = path.resolve(
      __dirname,
      `../../../../summaries/2026-08-04_recipe-ingredients-cleanup-${WRITE ? "write" : "dry-run"}.json`,
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
