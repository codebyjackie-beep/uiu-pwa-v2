// Clerk dev -> production instance cutover: rewrite every old Clerk user id to its new one
// (cc_prompt_clerk_production_cutover.md Part 1).
//
//   - 10 per-user collections: `userId` field.
//   - meal_plan_sequence: `_id` = Clerk id (immutable -> copy under the new _id, then delete the old doc).
//   - users: `clerkUserId` field. After the new instance is live, /users/sync has already created a fresh
//     users doc for each new id; that duplicate is stored on the old doc (`clerkRemapDeletedDup`) and removed,
//     so the old doc (createdAt / subscriptionStatus) survives.
// Every touched doc gets `clerkRemapPrev` (old id) + `clerkRemapBatch`. Reverse with clerk_user_remap_rollback.cjs.
//
// Default is a dry run (per-collection counts, blockers, nothing written). --write commits, then re-queries:
// old id must be 0 everywhere and new id must equal the dry-run expectation.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/clerk_user_remap.cjs --map user_OLD=user_NEW [--map ...] [--write] [--out report.json] [--db name]
//   node scripts/clerk_user_remap.cjs --by-email codeby.jackie@gmail.com=user_NEW [--by-email ...]
//     (--by-email looks the OLD id up from the existing users doc with that email; it never calls the Clerk API,
//      the new id always comes from you.)
// The seed row `test_clerk_id_*` is never remapped (it is simply not in the map) and is reported as unmapped.

const fs = require("fs");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION, UNIQUE_USER_COLLECTIONS, ID_RE, loadDevVars, argValues, argValue } = require("./clerk_user_remap_lib.cjs");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const OUT = argValue(argv, "--out");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function resolveMap(db) {
  const pairs = []; // [old, new, how]
  for (const m of argValues(argv, "--map")) {
    const [o, n, ...rest] = m.split("=");
    if (!o || !n || rest.length) die(`--map expects old_id=new_id, got "${m}"`);
    pairs.push([o, n, "map"]);
  }
  for (const m of argValues(argv, "--by-email")) {
    const eq = m.lastIndexOf("=");
    const email = m.slice(0, eq);
    const n = m.slice(eq + 1);
    if (eq < 1 || !n) die(`--by-email expects email=new_id, got "${m}"`);
    // After sign-up on the new instance /users/sync has already created a doc for the same email under the NEW id — skip that one.
    const docs = await db.collection(USERS_COLLECTION).find({ email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, clerkUserId: { $ne: n } }).toArray();
    if (docs.length !== 1) die(`--by-email ${email}: expected exactly 1 old users doc (excluding ${n}), found ${docs.length}`);
    pairs.push([docs[0].clerkUserId, n, `email:${email}`]);
  }
  if (!pairs.length) die("Usage: --map old=new (repeatable) and/or --by-email email=new_id [--write] [--out file] [--db name]");
  const olds = new Set(), news = new Set();
  for (const [o, n] of pairs) {
    if (!ID_RE.test(o) || !ID_RE.test(n)) die(`ids must match ${ID_RE}: ${o} / ${n}`);
    if (!n.startsWith("user_")) die(`new id must start with user_: ${n}`);
    if (o === n) die(`old and new id are identical: ${o}`);
    if (olds.has(o)) die(`old id mapped twice: ${o}`);
    if (news.has(n)) die(`new id used twice: ${n}`);
    olds.add(o);
    news.add(n);
  }
  for (const n of news) if (olds.has(n)) die(`new id ${n} is also an old id (chain/swap) — refusing`);
  return pairs;
}

async function main() {
  const env = loadDevVars();
  const dbName = argValue(argv, "--db") ?? env.MONGODB_DB;
  const client = new MongoClient(env.MONGODB_URI);
  const batch = `clerkremap_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${crypto.randomBytes(3).toString("hex")}`;
  try {
    await client.connect();
    const db = client.db(dbName);
    const pairs = await resolveMap(db);
    console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN (pass --write to commit)"}  db=${dbName}`);
    if (WRITE) console.log(`Batch id: ${batch}`);
    for (const [o, n, how] of pairs) console.log(`  ${o}  ->  ${n}   (${how})`);

    const oldIds = pairs.map((p) => p[0]);
    const rows = []; // one per collection x pair
    const blockers = [];
    const unmapped = [];

    // ---------- pre-flight (read-only) ----------
    for (const name of USERID_COLLECTIONS) {
      const col = db.collection(name);
      for (const [o, n] of pairs) {
        const oldDocs = await col.countDocuments({ userId: o });
        const newBefore = await col.countDocuments({ userId: n });
        const alreadyTagged = await col.countDocuments({ userId: o, clerkRemapBatch: { $exists: true } });
        if (alreadyTagged) blockers.push(`${name}: ${alreadyTagged} doc(s) under ${o} already carry clerkRemapBatch (would lose the rollback chain)`);
        if (UNIQUE_USER_COLLECTIONS.includes(name) && oldDocs && newBefore) blockers.push(`${name}: ${o} and ${n} both already have a doc (unique userId)`);
        if (name === "favourite_recipes" && oldDocs && newBefore) {
          const oldR = new Set((await col.find({ userId: o }, { projection: { recipeId: 1 } }).toArray()).map((d) => String(d.recipeId)));
          const clash = (await col.find({ userId: n }, { projection: { recipeId: 1 } }).toArray()).filter((d) => oldR.has(String(d.recipeId))).length;
          if (clash) blockers.push(`favourite_recipes: ${clash} recipeId(s) favourited under both ${o} and ${n} (unique {userId,recipeId})`);
        }
        rows.push({ collection: name, oldId: o, newId: n, oldDocs, newBefore, expectedNew: newBefore + oldDocs });
      }
      const others = await col.aggregate([{ $match: { userId: { $nin: [...oldIds, ...pairs.map((p) => p[1])] } } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray();
      for (const g of others) unmapped.push({ collection: name, field: "userId", value: g._id, docs: g.n });
    }

    const seq = db.collection(SEQUENCE_COLLECTION);
    for (const [o, n] of pairs) {
      const oldDocs = await seq.countDocuments({ _id: o });
      const newBefore = await seq.countDocuments({ _id: n });
      if (oldDocs && newBefore) blockers.push(`${SEQUENCE_COLLECTION}: _id ${n} already exists (would overwrite its nextPlanNumber)`);
      if (oldDocs && (await seq.countDocuments({ _id: o, clerkRemapBatch: { $exists: true } }))) blockers.push(`${SEQUENCE_COLLECTION}: ${o} already remapped`);
      rows.push({ collection: SEQUENCE_COLLECTION, oldId: o, newId: n, oldDocs, newBefore, expectedNew: oldDocs ? 1 : newBefore });
    }
    for (const g of await seq.find({ _id: { $nin: [...oldIds, ...pairs.map((p) => p[1])] } }).toArray()) unmapped.push({ collection: SEQUENCE_COLLECTION, field: "_id", value: g._id, docs: 1 });

    const users = db.collection(USERS_COLLECTION);
    for (const [o, n] of pairs) {
      const oldDocs = await users.countDocuments({ clerkUserId: o });
      const newBefore = await users.countDocuments({ clerkUserId: n });
      if (oldDocs > 1) blockers.push(`users: ${oldDocs} docs for ${o}`);
      if (newBefore > 1) blockers.push(`users: ${newBefore} docs for ${n}`);
      if (oldDocs && (await users.countDocuments({ clerkUserId: o, clerkRemapBatch: { $exists: true } }))) blockers.push(`users: ${o} already remapped`);
      rows.push({ collection: USERS_COLLECTION, oldId: o, newId: n, oldDocs, newBefore, expectedNew: oldDocs ? 1 : newBefore, note: oldDocs && newBefore ? "fresh /sync duplicate under new id will be folded into the old doc" : "" });
    }
    for (const g of await users.aggregate([{ $match: { clerkUserId: { $nin: [...oldIds, ...pairs.map((p) => p[1])] } } }, { $project: { clerkUserId: 1, email: 1 } }]).toArray()) {
      unmapped.push({ collection: USERS_COLLECTION, field: "clerkUserId", value: g.clerkUserId, docs: 1, email: g.email });
    }

    for (const [o] of pairs) {
      if (!rows.some((r) => r.oldId === o && r.oldDocs)) console.log(`WARNING: ${o} has no docs anywhere`);
    }

    // per-collection summary
    const summary = [...USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION].map((name) => {
      const rs = rows.filter((r) => r.collection === name);
      return { collection: name, willRemap: rs.reduce((a, r) => a + r.oldDocs, 0), newIdAlreadyThere: rs.reduce((a, r) => a + r.newBefore, 0) };
    });
    console.table(summary);
    console.log(`Total docs to remap: ${summary.reduce((a, s) => a + s.willRemap, 0)}`);
    if (unmapped.length) {
      console.log("Unmapped ids found (left untouched):");
      console.table(unmapped);
    }
    if (blockers.length) {
      console.log("\nBLOCKERS:");
      for (const b of blockers) console.log(`  - ${b}`);
    }

    const report = { mode: WRITE ? "write" : "dry-run", db: dbName, batch: WRITE ? batch : null, map: pairs.map(([o, n]) => ({ old: o, new: n })), summary, rows, unmapped, blockers };

    if (blockers.length && WRITE) {
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      die("Blockers present — nothing written.");
    }
    if (!WRITE) {
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      console.log("\nDry run only — nothing written.");
      return;
    }

    // ---------- write ----------
    for (const name of USERID_COLLECTIONS) {
      for (const [o, n] of pairs) {
        const r = await db.collection(name).updateMany({ userId: o }, [{ $set: { clerkRemapPrev: "$userId", userId: { $literal: n }, clerkRemapBatch: { $literal: batch } } }]);
        if (r.modifiedCount) console.log(`  ${name}: ${o} -> ${n}: ${r.modifiedCount}`);
      }
    }
    for (const [o, n] of pairs) {
      const doc = await seq.findOne({ _id: o });
      if (doc) {
        await seq.insertOne({ ...doc, _id: n, clerkRemapPrev: o, clerkRemapBatch: batch, clerkRemapPrevDoc: doc });
        await seq.deleteOne({ _id: o });
        console.log(`  ${SEQUENCE_COLLECTION}: ${o} -> ${n}: 1`);
      }
    }
    for (const [o, n] of pairs) {
      const oldDoc = await users.findOne({ clerkUserId: o });
      if (!oldDoc) continue;
      const dup = await users.findOne({ clerkUserId: n });
      // 1) park the duplicate on the old doc, 2) delete it (unique clerkUserId), 3) switch the old doc to the new id.
      await users.updateOne({ _id: oldDoc._id }, { $set: { clerkRemapPrev: o, clerkRemapBatch: batch, ...(dup ? { clerkRemapDeletedDup: dup } : {}) } });
      if (dup) await users.deleteOne({ _id: dup._id });
      await users.updateOne({ _id: oldDoc._id }, { $set: { clerkUserId: n } });
      console.log(`  ${USERS_COLLECTION}: ${o} -> ${n}: 1${dup ? " (duplicate folded)" : ""}`);
    }

    // ---------- re-query ----------
    const check = [];
    for (const r of rows) {
      let oldAfter, newAfter;
      if (r.collection === SEQUENCE_COLLECTION) {
        oldAfter = await seq.countDocuments({ _id: r.oldId });
        newAfter = await seq.countDocuments({ _id: r.newId });
      } else if (r.collection === USERS_COLLECTION) {
        oldAfter = await users.countDocuments({ clerkUserId: r.oldId });
        newAfter = await users.countDocuments({ clerkUserId: r.newId });
      } else {
        oldAfter = await db.collection(r.collection).countDocuments({ userId: r.oldId });
        newAfter = await db.collection(r.collection).countDocuments({ userId: r.newId });
      }
      check.push({ collection: r.collection, oldId: r.oldId, newId: r.newId, oldAfter, newAfter, expectedNew: r.expectedNew, ok: oldAfter === 0 && newAfter === r.expectedNew });
    }
    const bad = check.filter((c) => !c.ok);
    console.table(check.filter((c) => c.expectedNew || c.oldAfter));
    report.requery = check;
    report.requeryAllOk = bad.length === 0;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    if (bad.length) {
      console.log(`RE-QUERY MISMATCH in ${bad.length} row(s):`);
      console.table(bad);
      process.exitCode = 2;
    } else {
      console.log("Re-query OK: old ids = 0 everywhere, new ids = expected.");
    }
    console.log(`Rollback: node scripts/clerk_user_remap_rollback.cjs ${batch} --write`);
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
