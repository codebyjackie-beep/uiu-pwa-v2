// cc_prompt_canonical_quarantine_instruction_fragment_cleanup.md (2026-09-10)
// Step 1+2: find the actual quarantine:true canonical_ingredients entries that
// ingredientNameLooksLikeFragment() flags (instruction-sentence pattern), then
// check recipes/recipe_drafts for any live reference to each one's _id or
// canonical_name. Read-only, writes evidence JSON, no mutation.
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

  const quarantined = await db.collection("canonical_ingredients").find({ quarantine: true }).toArray();
  console.log(`Total quarantine:true canonical_ingredients: ${quarantined.length}`);

  const flagged = quarantined.filter((d) => typeof d.canonical_name === "string" && ingredientNameLooksLikeFragment(d.canonical_name));
  console.log(`Flagged by ingredientNameLooksLikeFragment(): ${flagged.length}`);
  for (const f of flagged) {
    console.log(`  _id=${f._id} canonical_name=${JSON.stringify(f.canonical_name)}`);
  }

  const results = [];
  for (const entry of flagged) {
    const idStr = entry._id.toString();
    const nameLower = String(entry.canonical_name).toLowerCase().trim();

    const refs = { recipes: [], recipe_drafts: [] };
    for (const collName of ["recipes", "recipe_drafts"]) {
      const docs = await db.collection(collName)
        .find(
          {
            $or: [
              { "ingredients.canonicalId": idStr },
              { "ingredients.canonical_id": idStr },
              { "ingredients.name": entry.canonical_name },
            ],
          },
          { projection: { title: 1, ingredients: 1, isPublic: 1, status: 1 } }
        )
        .toArray();
      for (const doc of docs) {
        const matchingIngredients = (Array.isArray(doc.ingredients) ? doc.ingredients : []).filter((ing) => {
          if (!ing) return false;
          const byId = ing.canonicalId === idStr || ing.canonical_id === idStr;
          const byName = typeof ing.name === "string" && ing.name.toLowerCase().trim() === nameLower;
          return byId || byName;
        });
        refs[collName].push({
          _id: doc._id.toString(),
          title: doc.title,
          isPublic: doc.isPublic,
          status: doc.status,
          matchingIngredients,
        });
      }
    }

    // referenceCount field on the canonical entry itself, if present
    results.push({
      _id: idStr,
      canonical_name: entry.canonical_name,
      quarantine: entry.quarantine,
      referenceCountField: entry.referenceCount,
      recipesRefCount: refs.recipes.length,
      recipeDraftsRefCount: refs.recipe_drafts.length,
      recipes: refs.recipes,
      recipe_drafts: refs.recipe_drafts,
    });
  }

  console.log("\n=== Reference check results ===");
  console.log(JSON.stringify(results, null, 2));

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-10_quarantine-instruction-fragment-scan.json"),
    JSON.stringify({ scannedAt: new Date().toISOString(), totalQuarantined: quarantined.length, flaggedCount: flagged.length, results }, null, 2)
  );

  await client.close();
})();
