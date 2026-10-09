// One-off migration: Jackie-approved dry-run
// (summaries/2026-08-03_conversion_curation_dry_run.json), reviewed and
// signed off 2026-08-03. Writes density_cup/per_item_g onto 21
// canonical_ingredients docs (23 field-sets). All are null-fills EXCEPT
// cherry tomato's per_item_g, which is an explicit CORRECTION of an
// existing wrong value (110g -> 17g, USDA-sourced) — logged separately
// per Jackie's instruction not to conflate "fill null" with "fix existing".
//
// Default dry-run; pass --write to actually commit (same opt-in
// convention as write_nutrition_per_100g.cjs / recipe_cost's ?write=true).
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_conversion_curation.cjs            # dry run
//   node scripts/write_conversion_curation.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");
const UPDATES_PATH = path.resolve(__dirname, "../../../../assets/conversion_curation_updates.json");

function loadDevVars() {
  const p = path.resolve(__dirname, "../.dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const updates = JSON.parse(fs.readFileSync(UPDATES_PATH, "utf8"));
  console.log(`Loaded ${updates.length} canonical_name updates from ${UPDATES_PATH}`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection("canonical_ingredients");

    const totalCount = await col.countDocuments({});
    const beforeDensity = await col.countDocuments({ density_cup: { $ne: null, $exists: true } });
    const beforePerItem = await col.countDocuments({ per_item_g: { $ne: null, $exists: true } });
    const cherryBefore = await col.findOne({ canonical_name: "cherry tomato" }, { projection: { density_cup: 1, per_item_g: 1 } });

    console.log(`\n=== BEFORE ===`);
    console.log(`density_cup non-null: ${beforeDensity}/${totalCount}`);
    console.log(`per_item_g non-null:  ${beforePerItem}/${totalCount}`);
    console.log(`cherry tomato: density_cup=${cherryBefore ? cherryBefore.density_cup : "N/A"}, per_item_g=${cherryBefore ? cherryBefore.per_item_g : "N/A"}`);
    console.log(`\nMode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    let matched = 0;
    let notFound = [];
    const fillLog = [];
    const correctionLog = [];

    for (const u of updates) {
      if (WRITE) {
        const result = await col.updateOne(
          { canonical_name: u.canonical_name },
          { $set: u.set },
        );
        if (result.matchedCount === 0) { notFound.push(u.canonical_name); continue; }
        matched += 1;
      } else {
        const exists = await col.countDocuments({ canonical_name: u.canonical_name });
        if (exists === 0) { notFound.push(u.canonical_name); continue; }
        matched += 1;
      }
      if (u.kind === "mixed") correctionLog.push(u);
      else fillLog.push(u);
    }

    const afterDensity = WRITE ? await col.countDocuments({ density_cup: { $ne: null, $exists: true } }) : beforeDensity;
    const afterPerItem = WRITE ? await col.countDocuments({ per_item_g: { $ne: null, $exists: true } }) : beforePerItem;
    const cherryAfter = WRITE
      ? await col.findOne({ canonical_name: "cherry tomato" }, { projection: { density_cup: 1, per_item_g: 1 } })
      : cherryBefore;

    console.log(`\n${WRITE ? "Written" : "Would write"}: ${matched}/${updates.length} canonical_names`);
    if (notFound.length > 0) {
      console.log(`canonical_name not found in DB (${notFound.length}): ${notFound.join(", ")}`);
    }

    console.log(`\n--- NULL-FILL updates (${fillLog.length}) ---`);
    for (const u of fillLog) console.log(`  ${u.canonical_name}: ${JSON.stringify(u.set)}`);

    console.log(`\n--- CORRECTION updates (${correctionLog.length}) — pre-existing WRONG values fixed, NOT null-fills ---`);
    for (const u of correctionLog) console.log(`  ${u.canonical_name}: ${JSON.stringify(u.set)} — ${u.note}`);

    console.log(`\n=== AFTER ===`);
    console.log(`density_cup non-null: ${afterDensity}/${totalCount}`);
    console.log(`per_item_g non-null:  ${afterPerItem}/${totalCount}`);
    console.log(`cherry tomato: density_cup=${cherryAfter ? cherryAfter.density_cup : "N/A"}, per_item_g=${cherryAfter ? cherryAfter.per_item_g : "N/A"}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
