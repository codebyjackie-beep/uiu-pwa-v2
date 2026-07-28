// One-off: flip isPublic:false -> true for the first AI-drafted recipe
// (HANDOFF_ai-recipe-drafting-tool.md Part B), _id 6a69323fb048d5e7f4ddfb31,
// "One-Tray Honey Mustard Chicken Thighs with New Potatoes" — Jackie reviewed
// and approved. _id-scoped update only; needs_review stays true (review-once
// doesn't mean never-review-again, kept as a standing record).
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const RECIPE_ID = "6a69323fb048d5e7f4ddfb31";

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
  const db = client.db(MONGODB_DB);

  try {
    const col = db.collection("recipes");
    const _id = ObjectId.createFromHexString(RECIPE_ID);

    const before = await col.findOne({ _id }, { projection: { isPublic: 1, needs_review: 1, title: 1 } });
    console.log("before:", JSON.stringify(before));

    const result = await col.updateOne({ _id }, { $set: { isPublic: true } });
    console.log(`matched: ${result.matchedCount}  modified: ${result.modifiedCount}`);

    const after = await col.findOne({ _id }, { projection: { isPublic: 1, needs_review: 1, title: 1 } });
    console.log("after:", JSON.stringify(after));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
