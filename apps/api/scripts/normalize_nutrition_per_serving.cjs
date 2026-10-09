// HANDOFF_recipe-nutrition-and-price-per-serving-normalize.md §1 — backfill
// `recipe.nutrition` for internally-generated recipes (source !== "spoonacular")
// from whole-recipe-total to per-serving, so the field means the same thing
// across the whole `recipes` collection (spoonacular recipes are already
// per-serving and are excluded entirely).
//
// Filter: source !== "spoonacular" AND nutrition exists AND servings is a
// valid positive number. Recipes missing/invalid `servings` are skipped and
// logged, never touched.
//
// Only ever $set's `nutrition` (same field, divides calories/protein/carbs/fat
// and fiber if present) — no other field touched.
//
// Default dry-run; pass --write to actually commit.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/normalize_nutrition_per_serving.cjs            # dry run
//   node scripts/normalize_nutrition_per_serving.cjs --write    # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

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
    const recipesCol = db.collection("recipes");

    const candidates = await recipesCol
      .find({ source: { $ne: "spoonacular" }, nutrition: { $exists: true } })
      .toArray();

    console.log(`Candidates (source!=="spoonacular" AND nutrition exists): ${candidates.length}`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    const eligible = [];
    const skipped = [];

    for (const r of candidates) {
      const servings = r.servings;
      if (typeof servings !== "number" || !Number.isFinite(servings) || servings <= 0) {
        skipped.push({ id: r._id, title: r.title, servings });
        continue;
      }
      const cur = r.nutrition || {};
      const next = {
        calories: Math.round((cur.calories || 0) / servings),
        protein: round1((cur.protein || 0) / servings),
        carbs: round1((cur.carbs || 0) / servings),
        fat: round1((cur.fat || 0) / servings),
      };
      if (typeof cur.fiber === "number") {
        next.fiber = round1(cur.fiber / servings);
      }
      eligible.push({ id: r._id, title: r.title, servings, oldTotal: cur, newPerServing: next });
    }

    console.log(`\nEligible for update: ${eligible.length}`);
    console.log(`Skipped (missing/invalid servings, left untouched): ${skipped.length}`);

    console.log(`\n=== Full update list (title / servings / old total / new per-serving) ===`);
    for (const e of eligible) {
      console.log(`  "${e.title}" (${e.id}) servings=${e.servings}`);
      console.log(`    old total: ${JSON.stringify(e.oldTotal)}`);
      console.log(`    new per-serving: ${JSON.stringify(e.newPerServing)}`);
    }

    if (skipped.length > 0) {
      console.log(`\n=== Skip list (missing/invalid servings) ===`);
      for (const e of skipped) {
        console.log(`  "${e.title}" (${e.id}) servings=${JSON.stringify(e.servings)}`);
      }
    }

    if (WRITE) {
      let written = 0;
      for (const e of eligible) {
        await recipesCol.updateOne({ _id: e.id }, { $set: { nutrition: e.newPerServing } });
        written += 1;
      }
      console.log(`\nWritten: ${written}/${eligible.length}`);
    } else {
      console.log(`\n(dry run — nothing written; pass --write to commit)`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
