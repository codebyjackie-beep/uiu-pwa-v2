/**
 * Rollback for shopping_list_canonical_backfill.cjs:  node scripts/shopping_list_canonical_backfill_rollback.cjs <batch> [--write]
 * Dry-run by default. Restores canonicalNamePrev (or removes canonicalName when the field was absent before) and clears the batch fields.
 */
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: shopping_list_canonical_backfill_rollback.cjs <batch> [--write]");
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(path.join(API_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}

(async () => {
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const col = client.db(env.MONGODB_DB || "useitup").collection("shopping_list_items");
  try {
    const docs = await col.find({ canonicalNameBatch: batch }).toArray();
    console.log(`${docs.length} doc(s) in batch ${batch}${WRITE ? "" : " (dry-run)"}`);
    if (!WRITE) return;
    let n = 0;
    for (const d of docs) {
      const update = d.canonicalNamePrevAbsent
        ? { $unset: { canonicalName: "", canonicalNamePrev: "", canonicalNamePrevAbsent: "", canonicalNameBatch: "", canonicalNameAt: "" } }
        : { $set: { canonicalName: d.canonicalNamePrev }, $unset: { canonicalNamePrev: "", canonicalNamePrevAbsent: "", canonicalNameBatch: "", canonicalNameAt: "" } };
      n += (await col.updateOne({ _id: d._id, canonicalNameBatch: batch }, update)).modifiedCount;
    }
    console.log(`rolled back ${n}; remaining in batch: ${await col.countDocuments({ canonicalNameBatch: batch })}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
