// HANDOFF_health-weekly-meal-records.md verification helper.
// Inserts 3 temporary meal_logs docs across 3 different days (today, -2d, -4d),
// so the "This week" grouping/7-day-total can be checked against real
// production data, then deletes them again. Not part of the app itself.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
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

const mode = process.argv[2];

async function main() {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const col = db.collection("meal_logs");

  if (mode === "insert") {
    const now = new Date();
    const docs = [
      { offsetDays: 0, description: "TEST verify-weekly A (today)", calories: 400, protein: 20, carbs: 40, fat: 10 },
      { offsetDays: 2, description: "TEST verify-weekly B (-2d)", calories: 500, protein: 25, carbs: 50, fat: 15 },
      { offsetDays: 4, description: "TEST verify-weekly C (-4d)", calories: 300, protein: 15, carbs: 30, fat: 8 },
    ].map((d) => {
      const t = new Date(now);
      t.setUTCDate(t.getUTCDate() - d.offsetDays);
      return {
        photoUrl: null,
        calories: d.calories,
        protein: d.protein,
        carbs: d.carbs,
        fat: d.fat,
        description: d.description,
        loggedAt: t.toISOString(),
        source: "manual",
      };
    });
    const result = await col.insertMany(docs);
    console.log(JSON.stringify({ insertedIds: Object.values(result.insertedIds).map(String), docs }, null, 2));
  } else if (mode === "cleanup") {
    const result = await col.deleteMany({ description: { $regex: /^TEST verify-weekly / } });
    console.log(JSON.stringify({ deletedCount: result.deletedCount }));
  } else {
    console.log("usage: node verify_health_weekly.cjs insert|cleanup");
  }

  await client.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
