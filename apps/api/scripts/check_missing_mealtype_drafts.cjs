// Read-only diagnostic: how many `pending` recipe_drafts have already been
// backfilled (tags.length >= 9, the classify-only pass's typical output size)
// but ended up with an empty/missing mealType — the LLM-omitted-mealType
// fallback bug flagged 2026-08-21. Touches nothing — find() only, no writes.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/check_missing_mealtype_drafts.cjs
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

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
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const col = db.collection("recipe_drafts");

    const totalPending = await col.countDocuments({ status: "pending" });

    const backfilledButMissingMealType = await col
      .find({
        status: "pending",
        $expr: { $gte: [{ $size: { $ifNull: ["$tags", []] } }, 9] },
        $or: [{ mealType: { $exists: false } }, { mealType: null }, { mealType: "" }],
      })
      .project({ title: 1, tags: 1, mealType: 1 })
      .toArray();

    console.log("total pending drafts:", totalPending);
    console.log("backfilled (tags>=9) but mealType missing/empty:", backfilledButMissingMealType.length);
    console.log(JSON.stringify(backfilledButMissingMealType, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
