// HANDOFF_recompute-existing-recipes-nutrition.md — recompute every recipe's
// stored `nutrition` snapshot using canonical_ingredients.nutrition_per_100g
// as it stands after round1+round2 (449/746 covered). Recipe `nutrition` is
// computed once at generation/import time and never live-recalculated
// (apps/api/src/routes/recipes.ts:70 just reads doc.nutrition), so this
// backfills the improved coverage onto pre-existing recipe docs.
//
// Safety rules (both required by the handoff):
//   - matchedLines === 0 (not a single ingredient line resolved to
//     nutrition data) -> recipe is NEVER updated, its existing `nutrition`
//     stays untouched. Counted and reported separately.
//   - matchedLines > 0 -> eligible for update; dry-run lists old vs new
//     nutrition + matchedLines/totalGramLines for review before --write.
//
// Only ever $set's `nutrition` on eligible recipes — no other field is read
// or touched.
//
// Default dry-run; pass --write to actually commit.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/recompute_recipes_nutrition.cjs            # dry run
//   node scripts/recompute_recipes_nutrition.cjs --write    # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ciCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const recipesCol = db.collection("recipes");

    const index = await buildAliasIndex(ciCol);
    const allIngredientDocs = await ciCol.find({}).toArray();
    const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(
      allIngredientDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()),
    );
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const resolveFn = (raw) => resolve(raw, index);

    const allRecipes = await recipesCol.find({}).toArray();
    console.log(`Total recipes: ${allRecipes.length}`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    const eligible = [];
    const skippedZeroMatch = [];

    for (const r of allRecipes) {
      let calories = 0, protein = 0, carbs = 0, fat = 0, matchedLines = 0, totalGramLines = 0;
      let cost;
      try {
        cost = costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      } catch (err) {
        skippedZeroMatch.push({ id: r._id, title: r.title, reason: `costRecipe threw: ${err.message}` });
        continue;
      }
      for (const line of cost.lines) {
        if (!line.priceable || line.normUnit !== "g" || !line.canonical_name || !line.normValue) continue;
        totalGramLines += 1;
        const doc = ingredientsMap.get(line.canonical_name);
        const n = doc?.nutrition_per_100g;
        if (!n) continue;
        matchedLines += 1;
        const factor = line.normValue / 100;
        calories += n.kcal * factor;
        protein += n.protein * factor;
        carbs += n.carbs * factor;
        fat += n.fat * factor;
      }

      if (matchedLines === 0) {
        skippedZeroMatch.push({ id: r._id, title: r.title, reason: "matchedLines===0" });
        continue;
      }

      const oldNutrition = r.nutrition || null;
      const newNutrition = {
        calories: Math.round(calories),
        protein: round1(protein),
        carbs: round1(carbs),
        fat: round1(fat),
      };
      const oldCalories = oldNutrition && typeof oldNutrition.calories === "number" ? oldNutrition.calories : null;
      const pctChange =
        oldCalories !== null && oldCalories !== 0
          ? Math.abs((newNutrition.calories - oldCalories) / oldCalories) * 100
          : oldCalories === 0 && newNutrition.calories !== 0
            ? Infinity
            : 0;

      eligible.push({
        id: r._id,
        title: r.title,
        matchedLines,
        totalGramLines,
        oldNutrition,
        newNutrition,
        pctChange,
      });
    }

    console.log(`\nEligible for update (matchedLines>0): ${eligible.length}`);
    console.log(`Skipped (matchedLines===0, nutrition left untouched): ${skippedZeroMatch.length}`);

    const changedOver20pct = eligible.filter((e) => e.pctChange > 20).length;
    console.log(`Of eligible, recipes whose calories changed by >20%: ${changedOver20pct}`);

    const topByMatched = [...eligible].sort((a, b) => b.matchedLines - a.matchedLines).slice(0, 5);
    console.log(`\nTop 5 by matchedLines (dry-run preview):`);
    for (const e of topByMatched) {
      console.log(`  "${e.title}" (${e.id}) matchedLines=${e.matchedLines}/${e.totalGramLines}`);
      console.log(`    old: ${JSON.stringify(e.oldNutrition)}`);
      console.log(`    new: ${JSON.stringify(e.newNutrition)}`);
    }

    if (WRITE) {
      let written = 0;
      for (const e of eligible) {
        await recipesCol.updateOne({ _id: e.id }, { $set: { nutrition: e.newNutrition } });
        written += 1;
      }
      console.log(`\nWritten: ${written}/${eligible.length}`);
    } else {
      console.log(`\n(dry run — nothing written; pass --write to commit)`);
    }

    console.log(`\nmatchedLines===0 recipe count (for Jackie's UI handoff): ${skippedZeroMatch.length}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
