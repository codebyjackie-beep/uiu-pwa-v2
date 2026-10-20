// Reverses clerk_user_remap.cjs --write for one batch, using the per-doc `clerkRemapPrev`.
//   - per-user collections: userId <- clerkRemapPrev; unset clerkRemapPrev / clerkRemapBatch
//   - meal_plan_sequence: re-insert clerkRemapPrevDoc (old _id), delete the new-id doc
//   - users: clerkUserId <- clerkRemapPrev, re-insert the folded duplicate (clerkRemapDeletedDup) if any
// Docs created under the new id AFTER the remap (no clerkRemapBatch) are left alone and only reported.
//
//   node scripts/clerk_user_remap_rollback.cjs <batch> [--write] [--out report.json] [--db name]
const fs = require("fs");
const { MongoClient } = require("mongodb");
const { USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION, loadDevVars, argValue } = require("./clerk_user_remap_lib.cjs");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const BATCH = argv.find((a) => /^clerkremap_/.test(a));
if (!BATCH) {
  console.error("Usage: clerk_user_remap_rollback.cjs clerkremap_YYYYMMDD_xxxxxx [--write] [--out file] [--db name]");
  process.exit(1);
}

(async () => {
  const env = loadDevVars();
  const dbName = argValue(argv, "--db") ?? env.MONGODB_DB;
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(dbName);
    console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN"}  batch=${BATCH}  db=${dbName}`);
    const rows = [];

    for (const name of USERID_COLLECTIONS) {
      const col = db.collection(name);
      const tagged = await col.countDocuments({ clerkRemapBatch: BATCH });
      rows.push({ collection: name, tagged });
      if (WRITE && tagged) {
        await col.updateMany({ clerkRemapBatch: BATCH }, [{ $set: { userId: "$clerkRemapPrev" } }, { $unset: ["clerkRemapPrev", "clerkRemapBatch"] }]);
      }
    }

    const seq = db.collection(SEQUENCE_COLLECTION);
    const seqDocs = await seq.find({ clerkRemapBatch: BATCH }).toArray();
    rows.push({ collection: SEQUENCE_COLLECTION, tagged: seqDocs.length });
    if (WRITE) {
      for (const d of seqDocs) {
        if (await seq.countDocuments({ _id: d.clerkRemapPrev })) throw new Error(`meal_plan_sequence ${d.clerkRemapPrev} already exists — resolve by hand`);
        await seq.insertOne(d.clerkRemapPrevDoc);
        await seq.deleteOne({ _id: d._id });
      }
    }

    const users = db.collection(USERS_COLLECTION);
    const userDocs = await users.find({ clerkRemapBatch: BATCH }).toArray();
    rows.push({ collection: USERS_COLLECTION, tagged: userDocs.length });
    if (WRITE) {
      for (const d of userDocs) {
        await users.updateOne({ _id: d._id }, { $set: { clerkUserId: d.clerkRemapPrev }, $unset: { clerkRemapPrev: "", clerkRemapBatch: "", clerkRemapDeletedDup: "" } });
        if (d.clerkRemapDeletedDup) await users.insertOne(d.clerkRemapDeletedDup);
      }
    }

    console.table(rows);
    console.log(`Total docs ${WRITE ? "restored" : "that would be restored"}: ${rows.reduce((a, r) => a + r.tagged, 0)}`);
    if (WRITE) {
      let left = 0;
      for (const n of [...USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION]) left += await db.collection(n).countDocuments({ clerkRemapBatch: BATCH });
      console.log(`Tagged docs left after rollback: ${left}`);
      if (left) process.exitCode = 2;
    }
    if (argValue(argv, "--out")) fs.writeFileSync(argValue(argv, "--out"), JSON.stringify({ mode: WRITE ? "write" : "dry-run", db: dbName, batch: BATCH, rows }, null, 2));
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
