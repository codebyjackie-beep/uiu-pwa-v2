// One-off migration: additive-only write of `nutrition_per_100g` onto
// existing `canonical_ingredients` docs, sourced from the Jackie-approved
// dry-run file `assets/cofid/nutrition_per_100g_updates.json`.
//
// Only ever $set's the single field `nutrition_per_100g` — no other field on
// any canonical_ingredients doc is read or touched. Default dry-run; pass
// --write to actually commit (same opt-in convention as recipe_cost's
// ?write=true admin route in apps/api/src/index.ts).
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_nutrition_per_100g.cjs            # dry run
//   node scripts/write_nutrition_per_100g.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");
const UPDATES_PATH = path.resolve(__dirname, "../../../../assets/cofid/nutrition_per_100g_updates.json");

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
  console.log(`Loaded ${updates.length} updates from ${UPDATES_PATH}`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection("canonical_ingredients");

    const beforeCount = await col.countDocuments({ nutrition_per_100g: { $exists: true } });
    const totalCount = await col.countDocuments({});

    console.log(`\nBefore write: ${beforeCount}/${totalCount} canonical_ingredients have nutrition_per_100g`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    let matched = 0;
    let notFound = [];
    for (const u of updates) {
      if (WRITE) {
        const result = await col.updateOne(
          { canonical_name: u.canonical_name },
          { $set: { nutrition_per_100g: u.nutrition_per_100g } },
        );
        if (result.matchedCount === 0) notFound.push(u.canonical_name);
        else matched += 1;
      } else {
        const exists = await col.countDocuments({ canonical_name: u.canonical_name });
        if (exists === 0) notFound.push(u.canonical_name);
        else matched += 1;
      }
    }

    const afterCount = WRITE
      ? await col.countDocuments({ nutrition_per_100g: { $exists: true } })
      : beforeCount;

    console.log(`\n${WRITE ? "Written" : "Would write"}: ${matched}/${updates.length}`);
    if (notFound.length > 0) {
      console.log(`canonical_name not found in DB (${notFound.length}): ${notFound.join(", ")}`);
    }
    console.log(`After write: ${afterCount}/${totalCount} canonical_ingredients have nutrition_per_100g`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
