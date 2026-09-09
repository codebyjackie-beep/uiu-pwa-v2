// cc_prompt_live_recipes_fragment_names.md (2026-09-09) — step 1: re-query actual current
// state of the 11 live recipes flagged in that pending item, do not assume the list is
// still accurate. Also checks whether the stored recipe_cost doc for each recipe still
// carries the fragment name as a CostLine.rawName, and whether that line is currently
// priceable (to gauge cost-coverage impact of the fragment).
//
// Usage: node scripts/scan_live_recipes_fragment_names.cjs
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
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

// The 11 ids from cc_prompt_live_recipes_fragment_names.md — re-verified below, not trusted blindly.
const CANDIDATE_IDS = [
  "69b1db92974afef25b93a44d",
  "69b277e5f9069a06b5536b58",
  "69c31de2b17f27d65b4f4ec9",
  "69b4aeaee736bc836fd51337",
  "69b277e5f9069a06b5536b5b",
  "69b9587c7d3db8c999c7df7a",
  "69c473017393a7f0235b89b5",
  "69c473017393a7f0235b89b6",
  "69c7275f754babcc25875c8d",
  "69c7275f754babcc25875c87",
  "69fa56304476f68485ccfcf7",
];

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);

  // Full independent re-scan of ALL live recipes (not just the candidate list) — the
  // whole point of "don't assume the list is still right."
  const allRecipes = await db.collection("recipes").find({}).toArray();
  const freshHits = [];
  for (const r of allRecipes) {
    const ingredients = Array.isArray(r.ingredients) ? r.ingredients : [];
    const fragmentNames = ingredients.map((i) => i && i.name).filter((n) => typeof n === "string" && ingredientNameLooksLikeFragment(n));
    if (fragmentNames.length > 0) freshHits.push({ _id: r._id.toString(), title: r.title, isPublic: r.isPublic, fragmentNames, ingredients });
  }
  console.log(`Fresh full-collection scan: ${allRecipes.length} total recipes, ${freshHits.length} with fragment-like name(s)`);

  const freshIds = new Set(freshHits.map((h) => h._id));
  const candidateSet = new Set(CANDIDATE_IDS);
  const stillPresent = CANDIDATE_IDS.filter((id) => freshIds.has(id));
  const noLongerHits = CANDIDATE_IDS.filter((id) => !freshIds.has(id));
  const newlyFound = freshHits.filter((h) => !candidateSet.has(h._id));
  console.log(`Candidate list still valid: ${stillPresent.length}/${CANDIDATE_IDS.length}`);
  if (noLongerHits.length) console.log(`No longer a hit (list stale for these): ${JSON.stringify(noLongerHits)}`);
  if (newlyFound.length) console.log(`NEW hits not in the original 11: ${JSON.stringify(newlyFound.map((h) => h._id))}`);

  const details = [];
  for (const hit of freshHits) {
    const costDoc = await db.collection("recipe_cost").findOne({ recipeId: new ObjectId(hit._id) });
    const fragmentLines = costDoc
      ? (costDoc.lines || []).filter((l) => hit.fragmentNames.includes(l.rawName))
      : null;
    details.push({
      _id: hit._id,
      title: hit.title,
      isPublic: hit.isPublic,
      fragmentNames: hit.fragmentNames,
      ingredients: hit.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      hasRecipeCostDoc: !!costDoc,
      recipeCostComputedAt: costDoc ? costDoc.computedAt : null,
      recipeCostAdjustedCoveragePct: costDoc ? costDoc.adjustedCoveragePct : null,
      fragmentCostLines: fragmentLines,
    });
    console.log(`\n${hit._id} "${hit.title}" isPublic=${hit.isPublic}`);
    console.log(`  fragment names: ${JSON.stringify(hit.fragmentNames)}`);
    console.log(`  full ingredients: ${JSON.stringify(hit.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })))}`);
    console.log(`  recipe_cost doc: ${costDoc ? `computedAt=${costDoc.computedAt}, adjustedCoveragePct=${costDoc.adjustedCoveragePct}` : "NONE"}`);
    console.log(`  fragment-name cost line(s): ${JSON.stringify(fragmentLines)}`);
  }

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-09_live-recipes-fragment-scan-raw.json"),
    JSON.stringify({ scannedAt: new Date().toISOString(), totalRecipes: allRecipes.length, hitCount: freshHits.length, stillPresent, noLongerHits, newlyFound: newlyFound.map((h) => h._id), details }, null, 2)
  );

  await client.close();
})();
