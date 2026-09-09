// cc_prompt_fragment_guard_instruction_text_gap.md (2026-09-09) -- verifies the broadened
// ingredientNameLooksLikeFragment() (packages/shared/dist/index.js, built from src/index.ts)
// against the real corpus: full canonical_ingredients + all recipes/recipe_drafts ingredient
// names. Confirms 0 false positives and lists every hit (old + new patterns combined).
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { ingredientNameLooksLikeFragment } = require("../../../packages/shared/dist/index.js");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, idx)] = value;
  }
  return env;
}

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);

  const canonicalNames = (await db.collection("canonical_ingredients").find({}, { projection: { canonical_name: 1 } }).toArray())
    .map((d) => d.canonical_name)
    .filter((n) => typeof n === "string");

  const rawEntries = []; // {name, source, recipeId, title}
  for (const collName of ["recipes", "recipe_drafts"]) {
    const docs = await db.collection(collName).find({}, { projection: { ingredients: 1, title: 1, isPublic: 1 } }).toArray();
    for (const doc of docs) {
      const ingredients = Array.isArray(doc.ingredients) ? doc.ingredients : [];
      for (const ing of ingredients) {
        if (ing && typeof ing.name === "string" && ing.name.trim()) {
          rawEntries.push({ name: ing.name, source: collName, recipeId: doc._id.toString(), title: doc.title, isPublic: doc.isPublic });
        }
      }
    }
  }

  const canonHits = canonicalNames.filter(ingredientNameLooksLikeFragment);
  const rawHits = rawEntries.filter((e) => ingredientNameLooksLikeFragment(e.name));

  console.log(`canonical_ingredients: ${canonicalNames.length} names, ${canonHits.length} flagged`);
  console.log(JSON.stringify(canonHits, null, 2));
  console.log(`\nrecipes+recipe_drafts: ${rawEntries.length} ingredient lines, ${rawHits.length} flagged`);
  console.log(JSON.stringify(rawHits, null, 2));

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-09_fragment-guard-v2-verify-raw.json"),
    JSON.stringify({ verifiedAt: new Date().toISOString(), canonicalTotal: canonicalNames.length, canonHits, rawTotal: rawEntries.length, rawHits }, null, 2)
  );

  await client.close();
})();
