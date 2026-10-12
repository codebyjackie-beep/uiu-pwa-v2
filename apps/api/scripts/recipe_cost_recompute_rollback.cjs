// Roll back a recipe_cost_recompute.cjs batch.   node scripts/recipe_cost_recompute_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Restores recipe_cost documents from costFixPrev (the doc is removed when there was none).
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/recipe_cost_recompute_rollback.cjs <batch> [--write]");
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
    const costCol = client.db(env.MONGODB_DB).collection("recipe_cost");
    const docs = await costCol.find({ costFixBatch: batch }).toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${docs.length} recipe_cost docs carry the marker`);
    for (const d of docs.slice(0, 30)) console.log(`  ${d.recipeId}: perServing ${d.perServing} -> ${d.costFixPrev ? d.costFixPrev.perServing : "(remove doc)"}`);
    if (docs.length > 30) console.log(`  … ${docs.length - 30} more`);
    if (!docs.length) return;
    if (!WRITE) { console.log("re-run with --write to apply"); return; }
    let n = 0;
    for (const d of docs) {
      if (!d.costFixPrev) {
        n += (await costCol.deleteOne({ _id: d._id, costFixBatch: batch })).deletedCount;
        continue;
      }
      const { _id, ...current } = d;
      const unsetKeys = Object.keys(current).filter((k) => !(k in d.costFixPrev) && k !== "recipeId");
      const $unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
      // costFixPrev is the full previous doc: if it carried an earlier batch marker (e.g. pdfix-*) that marker is restored with it
      const $set = { ...d.costFixPrev };
      n += (await costCol.updateOne({ _id: d._id, costFixBatch: batch }, Object.keys($unset).length ? { $set, $unset } : { $set })).modifiedCount;
    }
    console.log(`rolled back: recipe_cost ${n}/${docs.length}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
