// Roll back a nutrition_recompute.cjs batch.   node scripts/nutrition_recompute_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Restores recipes.nutrition from nutritionPrev (unsets nutrition when
// there was none), restores canonical nutrition_per_100g from nutritionPer100gPrev, and removes the batch markers.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/nutrition_recompute_rollback.cjs <batch> [--write]");
  process.exit(1);
}

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const recipes = db.collection("recipes");
    const canon = db.collection("canonical_ingredients");
    const rDocs = await recipes.find({ nutritionRecomputeBatch: batch }).project({ title: 1, nutrition: 1, nutritionPrev: 1 }).toArray();
    const cDocs = await canon.find({ nutritionFixBatch: batch }).project({ canonical_name: 1, nutrition_per_100g: 1, nutritionPer100gPrev: 1 }).toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${rDocs.length} recipes, ${cDocs.length} canonical docs carry the marker`);
    for (const d of cDocs) console.log(`  canon ${d.canonical_name}: ${d.nutrition_per_100g?.kcal} -> ${d.nutritionPer100gPrev?.kcal} kcal/100g`);
    for (const d of rDocs.slice(0, 30)) console.log(`  recipe ${d._id}: ${d.nutrition?.calories} -> ${d.nutritionPrev?.calories ?? "(none)"}  ${d.title}`);
    if (rDocs.length > 30) console.log(`  … ${rDocs.length - 30} more`);
    if (!rDocs.length && !cDocs.length) return;
    if (!WRITE) { console.log("re-run with --write to apply"); return; }

    let r = 0;
    for (const d of rDocs) {
      const update = d.nutritionPrev
        ? { $set: { nutrition: d.nutritionPrev }, $unset: { nutritionPrev: "", nutritionRecomputeBatch: "", nutritionRecomputeAt: "" } }
        : { $unset: { nutrition: "", nutritionPrev: "", nutritionRecomputeBatch: "", nutritionRecomputeAt: "" } };
      r += (await recipes.updateOne({ _id: d._id, nutritionRecomputeBatch: batch }, update)).modifiedCount;
    }
    let c = 0;
    for (const d of cDocs) {
      const update = d.nutritionPer100gPrev
        ? { $set: { nutrition_per_100g: d.nutritionPer100gPrev }, $unset: { nutritionPer100gPrev: "", nutritionFixBatch: "", nutritionFixCofid: "", nutritionFixAt: "" } }
        : { $unset: { nutrition_per_100g: "", nutritionPer100gPrev: "", nutritionFixBatch: "", nutritionFixCofid: "", nutritionFixAt: "" } };
      c += (await canon.updateOne({ _id: d._id, nutritionFixBatch: batch }, update)).modifiedCount;
    }
    console.log(`rolled back: recipes ${r}/${rDocs.length}, canonical ${c}/${cDocs.length}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
