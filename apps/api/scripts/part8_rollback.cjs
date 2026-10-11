// Roll back a part8_apply.cjs batch.   node scripts/part8_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Everything is keyed on the `part8Batch` marker written by the apply script.
//   flags       -> unset nutritionUnavailable + nutritionFlagBatch/At/Reason
//   apple       -> servings / nutrition restored from part8Prev*; recipe_cost doc restored from <batch>_applied.json
//   withdrawals -> isPublic:true, unset withdrawnAt/withdrawnBatch/withdrawnReason
//   title       -> title restored from titleOriginal
//   mealType    -> mealType restored from mealTypeOriginal
// Finally the part8Batch / part8Prev* markers are unset.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/part8_rollback.cjs <batch> [--write]");
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

async function main() {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const col = db.collection("recipes");
    const touched = await col.countDocuments({ part8Batch: batch });
    const counts = {
      touched,
      flags: await col.countDocuments({ nutritionFlagBatch: batch }),
      apple: await col.countDocuments({ part8Batch: batch, part8PrevServings: { $exists: true } }),
      withdrawals: await col.countDocuments({ withdrawnBatch: batch }),
      title: await col.countDocuments({ part8Batch: batch, titleOriginal: { $exists: true } }),
      mealType: await col.countDocuments({ part8Batch: batch, mealTypeOriginal: { $exists: true } }),
    };
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}):`, JSON.stringify(counts));
    if (!touched) { console.log("nothing carries this batch marker - nothing to roll back"); return; }
    if (!WRITE) { console.log("re-run with --write to apply"); return; }

    const res = {};
    res.flags = (await col.updateMany(
      { nutritionFlagBatch: batch },
      { $unset: { nutritionUnavailable: "", nutritionFlagBatch: "", nutritionFlagAt: "", nutritionFlagReason: "" } },
    )).modifiedCount;

    // apple: restore servings + nutrition + recipe_cost
    const appliedFile = path.resolve(__dirname, "../../../summaries", `${batch}_applied.json`);
    let appliedDoc = null;
    try { appliedDoc = JSON.parse(fs.readFileSync(appliedFile, "utf8")); } catch { /* file missing -> recipe_cost left as is */ }
    res.apple = 0;
    for (const d of await col.find({ part8Batch: batch, part8PrevServings: { $exists: true } }).toArray()) {
      await col.updateOne({ _id: d._id }, { $set: { servings: d.part8PrevServings, nutrition: d.part8PrevNutrition } });
      res.apple += 1;
      const before = appliedDoc?.apple?.recipeCostDocBefore;
      const rc = db.collection("recipe_cost");
      if (before) {
        const { _id, ...fields } = before;
        const { part8Batch, ...clean } = fields;
        await rc.replaceOne({ recipeId: d._id }, { recipeId: d._id, ...clean });
        res.recipeCostRestored = true;
      } else if (appliedDoc) {
        await rc.deleteOne({ recipeId: d._id, part8Batch: batch });
        res.recipeCostRemoved = true;
      } else {
        console.warn(`WARNING: ${appliedFile} not found - recipe_cost for ${d._id} NOT restored (re-run precompute)`);
      }
    }

    res.withdrawals = (await col.updateMany(
      { withdrawnBatch: batch },
      { $set: { isPublic: true }, $unset: { withdrawnAt: "", withdrawnBatch: "", withdrawnReason: "" } },
    )).modifiedCount;

    res.title = 0;
    for (const d of await col.find({ part8Batch: batch, titleOriginal: { $exists: true } }).toArray()) {
      await col.updateOne({ _id: d._id }, { $set: { title: d.titleOriginal }, $unset: { titleOriginal: "" } });
      res.title += 1;
    }

    res.mealType = 0;
    for (const d of await col.find({ part8Batch: batch, mealTypeOriginal: { $exists: true } }).toArray()) {
      await col.updateOne({ _id: d._id }, { $set: { mealType: d.mealTypeOriginal }, $unset: { mealTypeOriginal: "" } });
      res.mealType += 1;
    }

    await col.updateMany({ part8Batch: batch }, { $unset: { part8Batch: "", part8PrevServings: "", part8PrevNutrition: "" } });
    console.log("rolled back:", JSON.stringify(res));
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
