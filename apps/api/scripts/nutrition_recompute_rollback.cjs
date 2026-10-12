// Roll back a nutrition_recompute.cjs batch.   node scripts/nutrition_recompute_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Restores:
//   recipes.nutrition            from nutritionPrev (unsets nutrition when there was none)
//   canonical fixed fields       from canonFixPrev (fields listed in canonFixPrevAbsent are unset — they did not exist)
//   nutritionUnavailable flags   unset on recipes carrying nutritionFlagBatch == <batch>
// and removes the batch markers.
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
    const fDocs = await recipes.find({ nutritionFlagBatch: batch }).project({ title: 1, nutritionFlagReason: 1 }).toArray();
    const cDocs = await canon
      .find({ nutritionFixBatch: batch })
      .project({ canonical_name: 1, canonFixPrev: 1, canonFixPrevAbsent: 1, nutrition_per_100g: 1 })
      .toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${rDocs.length} recipes, ${fDocs.length} flagged recipes, ${cDocs.length} canonical docs carry the marker`);
    for (const d of cDocs) {
      const prev = d.canonFixPrev || {};
      console.log(`  canon ${d.canonical_name}: fields ${Object.keys(prev).join(", ")} (absent before: ${(d.canonFixPrevAbsent || []).join(", ") || "-"}); kcal ${d.nutrition_per_100g?.kcal} -> ${prev.nutrition_per_100g?.kcal ?? "(unchanged)"}`);
    }
    for (const d of rDocs.slice(0, 30)) console.log(`  recipe ${d._id}: ${d.nutrition?.calories} -> ${d.nutritionPrev?.calories ?? "(none)"}  ${d.title}`);
    if (rDocs.length > 30) console.log(`  … ${rDocs.length - 30} more`);
    for (const d of fDocs.slice(0, 20)) console.log(`  flag ${d._id}: ${d.nutritionFlagReason}  ${d.title}`);
    if (!rDocs.length && !cDocs.length && !fDocs.length) return;
    if (!WRITE) { console.log("re-run with --write to apply"); return; }

    let r = 0;
    for (const d of rDocs) {
      const update = d.nutritionPrev
        ? { $set: { nutrition: d.nutritionPrev }, $unset: { nutritionPrev: "", nutritionRecomputeBatch: "", nutritionRecomputeAt: "" } }
        : { $unset: { nutrition: "", nutritionPrev: "", nutritionRecomputeBatch: "", nutritionRecomputeAt: "" } };
      r += (await recipes.updateOne({ _id: d._id, nutritionRecomputeBatch: batch }, update)).modifiedCount;
    }
    const f = (
      await recipes.updateMany(
        { nutritionFlagBatch: batch },
        { $unset: { nutritionUnavailable: "", nutritionFlagBatch: "", nutritionFlagAt: "", nutritionFlagReason: "" } },
      )
    ).modifiedCount;
    let c = 0;
    for (const d of cDocs) {
      const prev = d.canonFixPrev || {};
      const absent = new Set(d.canonFixPrevAbsent || []);
      const $set = {};
      const $unset = { canonFixPrev: "", canonFixPrevAbsent: "", nutritionFixBatch: "", nutritionFixCofid: "", nutritionFixAt: "" };
      for (const [field, value] of Object.entries(prev)) {
        if (absent.has(field)) $unset[field] = "";
        else $set[field] = value;
      }
      const update = Object.keys($set).length ? { $set, $unset } : { $unset };
      c += (await canon.updateOne({ _id: d._id, nutritionFixBatch: batch }, update)).modifiedCount;
    }
    console.log(`rolled back: recipes ${r}/${rDocs.length}, flags ${f}/${fDocs.length}, canonical ${c}/${cDocs.length}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
