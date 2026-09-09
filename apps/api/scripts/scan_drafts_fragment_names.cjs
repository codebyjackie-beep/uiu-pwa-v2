// cc_prompt_recipe_drafts_fragment_retroactive_cleanup.md (2026-09-09) — step 1: re-query
// actual current state of production recipe_drafts using the just-shipped
// ingredientNameLooksLikeFragment() (packages/shared), do not assume the old "24 drafts"
// count still holds now that the parser fix + quarantine (commit 45ed583) is live.
//
// Scans status:"pending" (and any other non-final status, e.g. needs_review, if present)
// drafts. Prints per-draft: _id, status, importMethod, createdAt, and which ingredient
// names trip the guard.
//
// Usage: node scripts/scan_drafts_fragment_names.cjs
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
  const col = db.collection("recipe_drafts");

  const statusCounts = await col.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
  console.log("=== status breakdown (all recipe_drafts) ===");
  console.log(statusCounts);

  const allDrafts = await col.find({}).toArray();
  console.log(`\nTotal recipe_drafts docs: ${allDrafts.length}`);

  const hits = [];
  for (const d of allDrafts) {
    const ingredients = Array.isArray(d.ingredients) ? d.ingredients : [];
    const fragmentNames = ingredients
      .map((ing) => ing && ing.name)
      .filter((n) => typeof n === "string" && ingredientNameLooksLikeFragment(n));
    if (fragmentNames.length > 0) {
      hits.push({
        _id: d._id.toString(),
        status: d.status,
        importMethod: d.importMethod,
        createdAt: d.createdAt,
        title: d.title,
        fragmentNames,
        allIngredients: ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      });
    }
  }

  console.log(`\n=== ${hits.length} drafts with >=1 fragment-like ingredient name ===`);
  for (const h of hits) {
    console.log(`\n${h._id} | status=${h.status} | importMethod=${h.importMethod} | createdAt=${h.createdAt} | title="${h.title}"`);
    console.log(`  fragment names: ${JSON.stringify(h.fragmentNames)}`);
    console.log(`  full ingredients: ${JSON.stringify(h.allIngredients)}`);
  }

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-09_drafts-fragment-scan-raw.json"),
    JSON.stringify({ scannedAt: new Date().toISOString(), totalDrafts: allDrafts.length, statusCounts, hitCount: hits.length, hits }, null, 2)
  );

  await client.close();
})();
