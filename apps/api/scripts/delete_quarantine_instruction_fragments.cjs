// cc_prompt_canonical_quarantine_instruction_fragment_cleanup.md (2026-09-10)
// Deletes the 4 quarantine:true canonical_ingredients entries identified in the
// 2026-09-09 fragment-guard-v2 scan as instruction-sentence leaks with ZERO live
// references (confirmed via scan_quarantine_instruction_fragments.cjs against
// recipes, recipe_drafts, AND recipe_cost). Dead quarantined seed-import junk.
// Backs up the full docs to summaries/ before deleting. Default = dry-run;
// pass --write to actually delete.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, idx)] = value;
  }
  return env;
}

const TARGET_IDS = [
  "6a5d33b7f92108b016edebb1", // "add rice and water. mix well. cover and simmer in heat"
  "6a5d33b7f92108b016edebb4", // "stir in a amount of green onions. add salt and pepper if necessary"
  "6a5d33b7f92108b016edebaf", // "add chicken and stir-fry until both sides turn brown"
  "6a5d33b7f92108b016edebb0", // "add fish sauce and simmer"
];

const WRITE = process.argv.includes("--write");

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const col = db.collection("canonical_ingredients");

  const docs = await col.find({ _id: { $in: TARGET_IDS.map((id) => new ObjectId(id)) } }).toArray();
  console.log(`Found ${docs.length} of ${TARGET_IDS.length} target docs.`);
  for (const d of docs) {
    console.log(`  _id=${d._id} canonical_name=${JSON.stringify(d.canonical_name)} quarantine=${d.quarantine} quarantined_reason=${d.quarantined_reason}`);
  }
  if (docs.length !== TARGET_IDS.length) {
    console.error("MISMATCH: not all target ids found. Aborting without deleting.");
    await client.close();
    process.exit(1);
  }

  const backupPath = path.resolve(__dirname, "..", "..", "..", "..", "summaries", `2026-09-10_quarantine-instruction-fragment-delete-backup${WRITE ? "" : "-dryrun"}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ backedUpAt: new Date().toISOString(), mode: WRITE ? "write" : "dry-run", docs }, null, 2));
  console.log(`Backup written to ${backupPath}`);

  if (!WRITE) {
    console.log("\nDRY RUN — no deletion performed. Re-run with --write to delete these 4 docs.");
    await client.close();
    return;
  }

  const result = await col.deleteMany({ _id: { $in: TARGET_IDS.map((id) => new ObjectId(id)) } });
  console.log(`\nDeleted ${result.deletedCount} docs.`);

  await client.close();
})();
