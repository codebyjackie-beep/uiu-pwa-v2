// Milestone 2 (cc_prompt_milestone2_user_scoping.md §3): backfill `userId` onto every pre-existing
// per-user document, so the user-scoped routes keep showing the old (test) data to its owner.
//
// Default dry-run — prints per-collection counts and the indexes it would create; no writes.
// --write: $set { userId, m2BackfillBatch } on docs that have NO userId, create indexes, and copy the
// global meal_plan_sequence counter to a per-user doc (_id = userId). Reversible with
// rollback_m2_backfill_userid.cjs --batch <id>.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/migrate_m2_backfill_userid.cjs --user <clerkUserId>            # dry run
//   node scripts/migrate_m2_backfill_userid.cjs --user <clerkUserId> --write
//
// Run with --write BEFORE deploying the filtered API code (otherwise the owner briefly sees nothing).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");
const userIdx = process.argv.indexOf("--user");
const USER_ID = userIdx !== -1 ? process.argv[userIdx + 1] : null;
if (!USER_ID || !/^user_[A-Za-z0-9]+$/.test(USER_ID)) {
  console.error("Usage: --user <clerkUserId> (must look like user_xxx) [--write]");
  process.exit(1);
}

// Plain per-user collections.
const COLLECTIONS = [
  { name: "fridge_stock", indexes: [{ key: { userId: 1 } }] },
  { name: "meal_plan_sets", indexes: [{ key: { userId: 1 } }] },
  { name: "meal_plans", indexes: [{ key: { userId: 1, planId: 1 } }] },
  { name: "user_health_profiles", indexes: [{ key: { userId: 1 }, unique: true }] },
  { name: "weight_logs", indexes: [{ key: { userId: 1 } }] },
  { name: "meal_logs", indexes: [{ key: { userId: 1 } }] },
  { name: "nutrition_coach_history", indexes: [{ key: { userId: 1 } }] },
  { name: "favourite_recipes", indexes: [{ key: { userId: 1, recipeId: 1 }, unique: true }] },
  { name: "shopping_list_items", indexes: [{ key: { userId: 1 } }] },
  { name: "recipe_browse_state", indexes: [{ key: { userId: 1 }, unique: true }] },
];

function loadDevVars() {
  const content = fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[t.slice(0, eq).trim()] = val;
  }
  return env;
}

const keyName = (key) => Object.entries(key).map(([k, v]) => `${k}_${v}`).join("_");

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  const batch = `m2_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(4).toString("hex")}`;
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN (pass --write to commit)"}`);
    console.log(`Owner of existing data: ${USER_ID}`);
    if (WRITE) console.log(`Batch id: ${batch}`);

    const rows = [];
    const problems = [];

    // Pre-flight (read-only) for every collection first, so a blocker stops --write before anything is touched.
    const plan = [];
    for (const c of COLLECTIONS) {
      const col = db.collection(c.name);
      const total = await col.countDocuments({});
      const noUser = await col.countDocuments({ userId: { $exists: false } });
      const otherUser = await col.countDocuments({ userId: { $exists: true, $ne: USER_ID } });
      const existingIdx = (await col.indexes().catch(() => [])).map((i) => i.name);
      const toCreate = c.indexes.filter((i) => !existingIdx.includes(keyName(i.key)));

      // Everything goes to ONE user, so any duplicate would break the unique indexes.
      if (c.name === "user_health_profiles" && total > 1) problems.push(`user_health_profiles has ${total} docs; unique {userId} allows 1`);
      if (c.name === "recipe_browse_state" && total > 1) problems.push(`recipe_browse_state has ${total} docs; unique {userId} allows 1`);
      if (c.name === "favourite_recipes") {
        const dups = await col.aggregate([{ $group: { _id: "$recipeId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
        if (dups.length) problems.push(`favourite_recipes has ${dups.length} duplicated recipeId(s); unique {userId,recipeId} would fail`);
      }

      rows.push({
        collection: c.name,
        total,
        withoutUserId: noUser,
        willBackfill: noUser,
        alreadyOtherUser: otherUser,
        indexesToCreate: toCreate.map((i) => `${keyName(i.key)}${i.unique ? " (unique)" : ""}`).join(", ") || "-",
      });
      plan.push({ c, col, noUser, toCreate });
    }

    // meal_plan_sequence: global { _id: "meal_plan_set" } -> per-user { _id: userId } (old doc left in place).
    const seq = db.collection("meal_plan_sequence");
    const seqAll = await seq.find({}).toArray();
    const oldSeq = seqAll.find((d) => d._id === "meal_plan_set");
    const alreadyMigrated = seqAll.find((d) => d._id === USER_ID);
    rows.push({
      collection: "meal_plan_sequence",
      total: seqAll.length,
      withoutUserId: oldSeq ? 1 : 0,
      willBackfill: oldSeq && !alreadyMigrated ? 1 : 0,
      alreadyOtherUser: seqAll.filter((d) => d._id !== "meal_plan_set" && d._id !== USER_ID).length,
      indexesToCreate: "- (new doc _id=userId)",
    });

    console.table(rows);
    if (oldSeq) console.log(`meal_plan_sequence old doc: ${JSON.stringify(oldSeq)}`);

    if (problems.length) {
      console.log("\nBLOCKERS (nothing written):");
      for (const p of problems) console.log(`  - ${p}`);
      if (WRITE) process.exit(1);
    }

    if (!WRITE) {
      console.log("\nDry run only — nothing written.");
      return;
    }

    for (const { c, col, noUser, toCreate } of plan) {
      if (noUser > 0) {
        const r = await col.updateMany({ userId: { $exists: false } }, { $set: { userId: USER_ID, m2BackfillBatch: batch } });
        console.log(`  ${c.name}: backfilled ${r.modifiedCount}`);
      }
      for (const i of toCreate) await col.createIndex(i.key, { unique: !!i.unique, name: keyName(i.key) });
    }
    if (oldSeq && !alreadyMigrated) {
      await seq.insertOne({ _id: USER_ID, nextPlanNumber: oldSeq.nextPlanNumber, m2BackfillBatch: batch });
      console.log(`  meal_plan_sequence: created _id=${USER_ID} nextPlanNumber=${oldSeq.nextPlanNumber}`);
    }
    console.log(`Done. Rollback: node scripts/rollback_m2_backfill_userid.cjs --batch ${batch} --write`);
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
