// Proves clerk_user_remap.cjs + rollback on a SCRATCH database: copies the 12 Clerk-id-bearing collections from
// prod into `uiu_remap_scratch_<ts>` (docs + indexes), simulates the "fresh /users/sync duplicate under the new id"
// case, then runs remap dry-run -> write -> rollback dry-run -> rollback write against it with FAKE new ids and
// compares a canonical snapshot before vs after. Prod is only read. The scratch DB is always dropped at the end.
//
//   node scripts/clerk_user_remap_scratch_verify.cjs [--out ../../summaries/clerk_remap_scratch_verify_YYYY-MM-DD.json]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { MongoClient } = require("mongodb");
const { ALL_COLLECTIONS, loadDevVars, argValue } = require("./clerk_user_remap_lib.cjs");

const argv = process.argv.slice(2);
const OUT = argValue(argv, "--out");
const FAKE_JACKIE = "user_TEST_NEW_JACKIE";
const FAKE_TESTER = "user_TEST_NEW_TESTER";

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && !(v instanceof Date) && typeof v.toHexString !== "function") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
};
async function snapshot(db) {
  const snap = {};
  for (const n of ALL_COLLECTIONS) {
    const docs = await db.collection(n).find({}).toArray();
    snap[n] = docs.map((d) => JSON.stringify(canon(d))).sort();
  }
  return snap;
}
function run(script, args, scratch) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args, "--db", scratch], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  return { script, args, exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

(async () => {
  const env = loadDevVars();
  const scratch = `uiu_remap_scratch_${Date.now()}`;
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const prod = client.db(env.MONGODB_DB);
  const db = client.db(scratch);
  const result = { scratchDb: scratch, steps: [] };
  try {
    // copy
    for (const n of ALL_COLLECTIONS) {
      const docs = await prod.collection(n).find({}).toArray();
      if (docs.length) await db.collection(n).insertMany(docs);
      const idx = (await prod.collection(n).indexes()).filter((i) => i.name !== "_id_");
      for (const i of idx) {
        const { key, name, unique } = i;
        await db.collection(n).createIndex(key, { name, unique: !!unique });
      }
      console.log(`copied ${n}: ${docs.length} docs, ${idx.length} extra index(es)`);
    }
    const jackie = await db.collection("users").findOne({ email: "codeby.jackie@gmail.com" });
    const tester = await db.collection("users").findOne({ email: "useitup.uk+tester@gmail.com" });
    if (!jackie || !tester) throw new Error("Jackie/Tester users docs not found");
    // simulate /users/sync having already created the new-id docs on the production instance
    await db.collection("users").insertMany([
      { clerkUserId: FAKE_JACKIE, email: jackie.email, createdAt: "2026-10-20T00:00:00.000Z", subscriptionStatus: "free" },
      { clerkUserId: FAKE_TESTER, email: tester.email, createdAt: "2026-10-20T00:00:00.000Z", subscriptionStatus: "free" },
    ]);

    const before = await snapshot(db);
    const mapArgs = ["--by-email", `${jackie.email}=${FAKE_JACKIE}`, "--map", `${tester.clerkUserId}=${FAKE_TESTER}`];

    const dry = run("clerk_user_remap.cjs", mapArgs, scratch);
    result.steps.push(dry);
    const afterDry = await snapshot(db);
    result.dryRunWroteNothing = JSON.stringify(before) === JSON.stringify(afterDry);

    const w = run("clerk_user_remap.cjs", [...mapArgs, "--write", "--out", path.join(__dirname, "_scratch_write_report.json")], scratch);
    result.steps.push(w);
    if (w.exit !== 0) console.log(dry.stdout, dry.stderr, w.stdout, w.stderr);
    const batch = (/Batch id: (\S+)/.exec(w.stdout) || [])[1];
    result.batch = batch;
    const writeReport = JSON.parse(fs.readFileSync(path.join(__dirname, "_scratch_write_report.json"), "utf8"));
    fs.unlinkSync(path.join(__dirname, "_scratch_write_report.json"));
    result.writeReport = { summary: writeReport.summary, requeryAllOk: writeReport.requeryAllOk, unmapped: writeReport.unmapped, perIdCounts: writeReport.rows.filter((r) => r.oldDocs).map((r) => ({ collection: r.collection, oldId: r.oldId, docs: r.oldDocs })) };
    const mid = await snapshot(db);
    result.writeChangedSomething = JSON.stringify(before) !== JSON.stringify(mid);

    const rbDry = run("clerk_user_remap_rollback.cjs", [batch], scratch);
    result.steps.push(rbDry);
    const afterRbDry = await snapshot(db);
    result.rollbackDryRunWroteNothing = JSON.stringify(mid) === JSON.stringify(afterRbDry);

    const rb = run("clerk_user_remap_rollback.cjs", [batch, "--write"], scratch);
    result.steps.push(rb);
    const after = await snapshot(db);
    const diffs = {};
    for (const n of ALL_COLLECTIONS) {
      const a = new Set(before[n]), b = new Set(after[n]);
      const onlyBefore = before[n].filter((x) => !b.has(x)).length;
      const onlyAfter = after[n].filter((x) => !a.has(x)).length;
      diffs[n] = { before: before[n].length, after: after[n].length, onlyBefore, onlyAfter };
    }
    result.diffAfterRollback = diffs;
    result.zeroDiff = Object.values(diffs).every((d) => d.before === d.after && d.onlyBefore === 0 && d.onlyAfter === 0);
    console.log(`dryRunWroteNothing=${result.dryRunWroteNothing} writeChangedSomething=${result.writeChangedSomething} rollbackDryRunWroteNothing=${result.rollbackDryRunWroteNothing} zeroDiffAfterRollback=${result.zeroDiff}`);
    console.table(diffs);
  } finally {
    await client.db(scratch).dropDatabase();
    const left = (await client.db().admin().listDatabases()).databases.filter((d) => d.name === scratch).length;
    result.scratchDropped = left === 0;
    console.log(`scratch db ${scratch} dropped: ${result.scratchDropped}`);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    await client.close();
  }
  if (!result.zeroDiff || !result.dryRunWroteNothing || !result.rollbackDryRunWroteNothing) process.exitCode = 2;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
