// Roll back a price_density_fix.cjs batch.   node scripts/price_density_fix_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Restores:
//   canonical_price_cache   listings / per_unit_metric / n_supermarkets from priceFixPrev
//   canonical_ingredients   density_cup from densityFixPrev (unset when it did not exist)
//   recipe_cost             previous document fields from costFixPrev (the doc is removed when there was none)
// and removes the batch markers.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/price_density_fix_rollback.cjs <batch> [--write]");
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
    const priceCol = db.collection("canonical_price_cache");
    const canonCol = db.collection("canonical_ingredients");
    const costCol = db.collection("recipe_cost");
    const pDocs = await priceCol.find({ priceFixBatch: batch }).toArray();
    const cDocs = await canonCol.find({ priceDensityFixBatch: batch }).toArray();
    const rDocs = await costCol.find({ costFixBatch: batch }).toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${pDocs.length} price docs, ${cDocs.length} canonical docs, ${rDocs.length} recipe_cost docs carry the marker`);
    for (const d of pDocs) console.log(`  price ${d.canonical_name}: n ${d.per_unit_metric ? d.per_unit_metric.n : null} -> ${d.priceFixPrev.per_unit_metric ? d.priceFixPrev.per_unit_metric.n : null}, metric ${d.per_unit_metric ? d.per_unit_metric.value : null} -> ${d.priceFixPrev.per_unit_metric ? d.priceFixPrev.per_unit_metric.value : null}, listings ${(d.listings || []).length} -> ${(d.priceFixPrev.listings || []).length}`);
    for (const d of cDocs) console.log(`  canon ${d.canonical_name}: density_cup ${d.density_cup} -> ${d.densityFixPrev.absent ? "(absent)" : d.densityFixPrev.density_cup}`);
    for (const d of rDocs) console.log(`  recipe_cost ${d.recipeId}: basket ${d.basket} -> ${d.costFixPrev ? d.costFixPrev.basket : "(remove doc)"}`);
    if (!pDocs.length && !cDocs.length && !rDocs.length) return;
    if (!WRITE) { console.log("re-run with --write to apply"); return; }

    let p = 0;
    for (const d of pDocs) {
      const prev = d.priceFixPrev;
      const $set = { listings: prev.listings, n_supermarkets: prev.n_supermarkets };
      const $unset = { priceFixPrev: "", priceFixBatch: "", priceFixAt: "" };
      if (prev.per_unit_metric === null || prev.per_unit_metric === undefined) $unset.per_unit_metric = "";
      else $set.per_unit_metric = prev.per_unit_metric;
      p += (await priceCol.updateOne({ _id: d._id, priceFixBatch: batch }, { $set, $unset })).modifiedCount;
    }
    let c = 0;
    for (const d of cDocs) {
      const prev = d.densityFixPrev;
      const markers = { densityFixPrev: "", priceDensityFixBatch: "", priceDensityFixAt: "" };
      const update = prev.absent
        ? { $unset: { density_cup: "", ...markers } }
        : { $set: { density_cup: prev.density_cup }, $unset: markers };
      c += (await canonCol.updateOne({ _id: d._id, priceDensityFixBatch: batch }, update)).modifiedCount;
    }
    let r = 0;
    for (const d of rDocs) {
      if (!d.costFixPrev) {
        r += (await costCol.deleteOne({ _id: d._id, costFixBatch: batch })).deletedCount;
        continue;
      }
      const { _id, ...current } = d;
      const unsetKeys = Object.keys(current).filter((k) => !(k in d.costFixPrev) && !["recipeId"].includes(k));
      const $unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
      const $set = { ...d.costFixPrev };
      delete $set.costFixPrev;
      delete $set.costFixBatch;
      r += (await costCol.updateOne({ _id: d._id, costFixBatch: batch }, Object.keys($unset).length ? { $set, $unset } : { $set })).modifiedCount;
    }
    console.log(`rolled back: price ${p}/${pDocs.length}, canonical ${c}/${cDocs.length}, recipe_cost ${r}/${rDocs.length}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
