// Roll back a partC_apply.cjs batch.   node scripts/partC_rollback.cjs <batch> [--write]
// Dry run by default (counts only). Restores tags from tagsOriginal and unsets the batch markers.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const batch = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/partC_rollback.cjs <batch> [--write]");
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
    const col = client.db(env.MONGODB_DB).collection("recipes");
    const docs = await col.find({ partCBatch: batch }).toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${docs.length} recipes carry the marker`);
    for (const d of docs) console.log(`  ${d._id}  ${JSON.stringify(d.tags)} -> ${JSON.stringify(d.tagsOriginal)}  ${d.title}`);
    if (!docs.length) return;
    if (!WRITE) { console.log("re-run with --write to apply"); return; }
    let restored = 0;
    for (const d of docs) {
      if (!Array.isArray(d.tagsOriginal)) { console.warn(`skip ${d._id}: no tagsOriginal`); continue; }
      const res = await col.updateOne(
        { _id: d._id, partCBatch: batch },
        { $set: { tags: d.tagsOriginal }, $unset: { tagsOriginal: "", partCBatch: "", partCAt: "" } },
      );
      restored += res.modifiedCount;
    }
    console.log(`rolled back: ${restored}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
