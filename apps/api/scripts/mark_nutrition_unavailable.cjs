// HANDOFF: UI「0 cal / 0g」改做「Nutrition not available」
//
// 2026-08-22's recompute_recipes_nutrition.cjs identified 71 recipes with matchedLines===0 (not
// a single ingredient line resolved to nutrition data) and deliberately left their `nutrition`
// field untouched (see that script's header) — but it never wrote any flag back to the DB, it
// only printed the count/ids for this handoff. Checked: no recipe doc has any existing
// nutritionUnavailable/nutritionNotAvailable-style field.
//
// This script re-derives the exact same matchedLines===0 set (same costRecipe() call, same
// canonical_ingredients/canonical_price_cache snapshot logic as the recompute script — read-only,
// doesn't touch costRecipe() itself) and $set's `nutritionUnavailable: true` on those recipe docs
// only. This is the reliable signal the handoff asked for, instead of a fragile "all 4 macros are
// 0" heuristic — it directly reflects "the cost engine could not resolve a single ingredient",
// not "the stored numbers happen to be zero".
//
// Never touches `nutrition` itself, never touches ingredient/cost data. Recipes NOT in the
// matchedLines===0 set are left completely alone (no field added, no field removed).
//
// Default dry-run; pass --write to actually commit.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/mark_nutrition_unavailable.cjs            # dry run
//   node scripts/mark_nutrition_unavailable.cjs --write    # real write
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

    const zeroMatch = [];
    const alreadyFlagged = [];
    const flaggedButShouldnt = [];

    for (const r of allRecipes) {
      let matchedLines = 0;
      let cost;
      try {
        cost = costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      } catch (err) {
        // costRecipe threw -> treat same as zero-match (no reliable nutrition data either way)
        zeroMatch.push({ id: r._id, title: r.title });
        if (r.nutritionUnavailable === true) alreadyFlagged.push(r._id);
        continue;
      }
      for (const line of cost.lines) {
        if (!line.priceable || line.normUnit !== "g" || !line.canonical_name || !line.normValue) continue;
        const doc = ingredientsMap.get(line.canonical_name);
        if (doc?.nutrition_per_100g) matchedLines += 1;
      }

      if (matchedLines === 0) {
        zeroMatch.push({ id: r._id, title: r.title });
        if (r.nutritionUnavailable === true) alreadyFlagged.push(r._id);
      } else if (r.nutritionUnavailable === true) {
        // Shouldn't happen (nothing has ever set this field before), but check anyway.
        flaggedButShouldnt.push(r._id);
      }
    }

    console.log(`\nmatchedLines===0 recipes found: ${zeroMatch.length}`);
    console.log(`Of those, already flagged nutritionUnavailable:true: ${alreadyFlagged.length}`);
    console.log(`Recipes flagged nutritionUnavailable:true but matchedLines>0 (would need unflagging): ${flaggedButShouldnt.length}`);
    console.log(`\nSample (first 5):`);
    for (const r of zeroMatch.slice(0, 5)) {
      console.log(`  ${r.id}  "${r.title}"`);
    }

    let flagged = 0;
    let unflagged = 0;
    if (WRITE) {
      const idsToFlag = zeroMatch.map((r) => r.id);
      if (idsToFlag.length > 0) {
        const res = await recipesCol.updateMany({ _id: { $in: idsToFlag } }, { $set: { nutritionUnavailable: true } });
        flagged = res.modifiedCount;
      }
      if (flaggedButShouldnt.length > 0) {
        const res = await recipesCol.updateMany({ _id: { $in: flaggedButShouldnt } }, { $unset: { nutritionUnavailable: "" } });
        unflagged = res.modifiedCount;
      }
      console.log(`\nSet nutritionUnavailable:true on ${flagged} recipe(s). Unset on ${unflagged} recipe(s).`);
    } else {
      console.log("\nDRY RUN — no DB writes performed. Pass --write to commit.");
    }

    const after = {
      recipesTotal: await recipesCol.countDocuments({}),
      nutritionUnavailableCount: await recipesCol.countDocuments({ nutritionUnavailable: true }),
    };

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      zeroMatchCount: zeroMatch.length,
      zeroMatchIds: zeroMatch.map((r) => String(r.id)),
      alreadyFlaggedBefore: alreadyFlagged.length,
      flaggedButShouldnt: flaggedButShouldnt.length,
      flagged,
      unflagged,
      after,
    };
    const reportPath = path.resolve(
      __dirname,
      "../../../../summaries",
      `2026-09-08_nutrition-unavailable-flag-${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${reportPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
