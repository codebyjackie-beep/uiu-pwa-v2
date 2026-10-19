// Rollback for unpriced_fix.cjs.
//   node scripts/unpriced_fix_rollback.cjs --price-batch unpriced-<yyyymmdd> --canon-batch canonfix-<yyyymmdd>            # DRY RUN: lists what would be restored
//   node scripts/unpriced_fix_rollback.cjs --price-batch ... --canon-batch ... --write
// price docs  : restore the fields saved in `priceFixPrev` (a field that was absent / null before goes back to its old value), unset priceFixPrev/Batch/At,
//               and delete the `price_refresh_overrides` rows this batch inserted (note = "manual_curated by <batch>").
// canonical   : restore each field in `unpricedFixPrev` (absent -> $unset), unset unpricedFixPrev/Source/Batch/At.
// recipe_cost : not touched here - roll that back FIRST with `recipe_cost_recompute_rollback.cjs <rcr-batch> --write`, then run this.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const priceBatch = argAfter("--price-batch");
const canonBatch = argAfter("--canon-batch");
if (!priceBatch && !canonBatch) { console.error("usage: --price-batch <b> and/or --canon-batch <b> [--write]"); process.exit(1); }

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.join(API_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
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
  const db = client.db(env.MONGODB_DB);
  try {
    const priceCol = db.collection("canonical_price_cache");
    const canonCol = db.collection("canonical_ingredients");
    const ovCol = db.collection("price_refresh_overrides");
    const report = { mode: WRITE ? "WRITE" : "DRY RUN", price: [], canon: [], overrides: 0 };

    if (priceBatch) {
      for (const d of await priceCol.find({ priceFixBatch: priceBatch }).toArray()) {
        const prev = d.priceFixPrev;
        if (!prev) { report.price.push({ name: d.canonical_name, skipped: "no priceFixPrev" }); continue; }
        const set = {}, unset = { priceFixPrev: "", priceFixBatch: "", priceFixAt: "" };
        for (const k of ["per_unit_metric", "per_unit_count", "cheapest", "n_supermarkets", "listings", "confidence", "needs_review"]) set[k] = prev[k] === undefined ? null : prev[k];
        if (prev.curation_note == null) unset.curation_note = ""; else set.curation_note = prev.curation_note;
        report.price.push({ name: d.canonical_name, nowMetric: d.per_unit_metric, restoredMetric: prev.per_unit_metric, restoredConfidence: prev.confidence });
        if (WRITE) await priceCol.updateOne({ _id: d._id, priceFixBatch: priceBatch }, { $set: set, $unset: unset });
      }
      const ov = await ovCol.find({ note: `manual_curated by ${priceBatch}` }).toArray();
      report.overrides = ov.length;
      if (WRITE && ov.length) await ovCol.deleteMany({ note: `manual_curated by ${priceBatch}` });
    }
    if (canonBatch) {
      for (const d of await canonCol.find({ unpricedFixBatch: canonBatch }).toArray()) {
        const prev = d.unpricedFixPrev || {};
        const set = {}, unset = { unpricedFixPrev: "", unpricedFixSource: "", unpricedFixBatch: "", unpricedFixAt: "" };
        for (const [f, p] of Object.entries(prev)) { if (p.absent) unset[f] = ""; else set[f] = p.value; }
        report.canon.push({ name: d.canonical_name, restore: prev });
        if (WRITE) await canonCol.updateOne({ _id: d._id, unpricedFixBatch: canonBatch }, { ...(Object.keys(set).length ? { $set: set } : {}), $unset: unset });
      }
    }
    console.log(JSON.stringify(report, null, 1));
    if (!WRITE) console.log("(dry run - nothing changed; add --write to apply)");
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
