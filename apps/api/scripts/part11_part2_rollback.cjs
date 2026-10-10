// Undo a batch written by part11_part2_write.cjs. Dry-run by default; --write to apply.
//   node scripts/part11_part2_rollback.cjs <batchId> [--write]
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
async function main() {
  const batch = process.argv[2]; const write = process.argv.includes("--write");
  if (!batch) throw new Error("usage: <batchId> [--write]");
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const col = client.db(MONGODB_DB).collection("recipes");
    if (batch.startsWith("part11")) {
      const n = await col.countDocuments({ withdrawnBatch: batch });
      console.log({ batch, rows: n, write });
      if (write) { const r = await col.updateMany({ withdrawnBatch: batch }, { $set: { isPublic: true }, $unset: { withdrawnAt: "", withdrawnBatch: "", withdrawnReason: "" } }); console.log("restored", r.modifiedCount, "publicNow", await col.countDocuments({ isPublic: true })); }
    } else {
      const n = await col.countDocuments({ imageBatch: batch });
      console.log({ batch, rows: n, write });
      if (write) {
        let m = 0;
        for (const d of await col.find({ imageBatch: batch }).project({ imageUrlPrev: 1 }).toArray()) {
          m += (await col.updateOne({ _id: d._id }, { $set: { imageUrl: d.imageUrlPrev }, $unset: { imageUrlPrev: "", imageBatch: "", imageChangedAt: "", imagePexelsId: "" } })).modifiedCount;
        }
        console.log("restored", m);
      }
    }
  } finally { await client.close(); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
