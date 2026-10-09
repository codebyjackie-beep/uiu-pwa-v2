// Reverses migrate_m2_backfill_userid.cjs --write for one batch: $unset userId + m2BackfillBatch on
// docs tagged with that batch, and delete the per-user meal_plan_sequence doc it created.
// Indexes are left in place (harmless) unless --drop-indexes is passed.
//
//   node scripts/rollback_m2_backfill_userid.cjs --batch m2_YYYY-MM-DD_xxxxxxxx [--write] [--drop-indexes]
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");
const DROP = process.argv.includes("--drop-indexes");
const bi = process.argv.indexOf("--batch");
const BATCH = bi !== -1 ? process.argv[bi + 1] : null;
if (!BATCH || !/^m2_/.test(BATCH)) {
  console.error("Usage: --batch m2_... [--write] [--drop-indexes]");
  process.exit(1);
}

const NAMES = [
  "fridge_stock",
  "meal_plan_sets",
  "meal_plans",
  "user_health_profiles",
  "weight_logs",
  "meal_logs",
  "nutrition_coach_history",
  "favourite_recipes",
  "shopping_list_items",
  "recipe_browse_state",
];
const IDX = { meal_plans: "userId_1_planId_1", favourite_recipes: "userId_1_recipeId_1" };

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

(async () => {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN"}  batch=${BATCH}`);
    for (const n of NAMES) {
      const col = db.collection(n);
      const count = await col.countDocuments({ m2BackfillBatch: BATCH });
      console.log(`${n}: ${count} doc(s) tagged`);
      if (WRITE && count) await col.updateMany({ m2BackfillBatch: BATCH }, { $unset: { userId: "", m2BackfillBatch: "" } });
      if (WRITE && DROP) await col.dropIndex(IDX[n] ?? "userId_1").catch((e) => console.log(`  (index drop skipped: ${e.message})`));
    }
    const seq = db.collection("meal_plan_sequence");
    const sc = await seq.countDocuments({ m2BackfillBatch: BATCH });
    console.log(`meal_plan_sequence: ${sc} doc(s) tagged`);
    if (WRITE && sc) await seq.deleteMany({ m2BackfillBatch: BATCH });
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
