// Read-only diagnostic: prints `tags` + derived-slot-relevant fields for the
// 4 soup recipes flagged in 2026-08-04 meal-plan verification (all landed in
// snack slot, never lunch, across 4 full-week generate runs). Touches
// nothing — find() only, no writes.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/check_soup_tags.cjs
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

const TITLES = [
  "Azteca Soup",
  "Asparagus and Pea Soup",
  "Red Quinoa Cranberry Arugula Soup",
  "Vegan Colcannon Soup",
];
const TITLE_REGEX = /asparagus.*pea|quinoa.*cranberry.*arugula|azteca|colcannon/i;

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const docs = await db
      .collection("recipes")
      .find({ $or: [{ title: { $in: TITLES } }, { title: { $regex: TITLE_REGEX } }] })
      .project({ title: 1, tags: 1, mealType: 1, isPublic: 1 })
      .toArray();
    console.log(JSON.stringify(docs, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
