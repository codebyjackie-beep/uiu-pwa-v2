// One-off migration for HANDOFF_meal-planner-multi-plan-library.md §0.
//
// meal_plans used to store a real calendar `date` per entry with no grouping concept.
// The new model groups entries under a `meal_plan_sets` "Plan card" doc (max 4 cards,
// at most one isActive:true), and each meal_plans entry gets `planId` (FK) + `dayIndex`
// (1=Mon...7=Sun, position within that card's own 7-day grid — not a real date).
//
// This script:
//   1. Creates one new meal_plan_sets doc { name: "Weekly Plan", isActive: true }.
//   2. For every existing meal_plans entry whose `date` falls in the CURRENT week
//      (Mon-Sun containing today, same window Prev/Next week nav showed before this
//      migration), sets planId = the new doc's _id and dayIndex = that date's weekday.
//   3. Discards (deletes) every other meal_plans entry — Jackie 2026-08-08 (5) signed
//      off on this: the new model has no "other weeks" concept, so historical/future
//      week entries don't map onto anything and are dropped rather than becoming
//      orphan cards.
//
// Default dry-run (no writes) — prints counts and a full breakdown, and always writes
// a JSON report to summaries/ regardless of mode, so the dry-run report can be reviewed
// before anyone passes --write. Same opt-in convention as fix_meal_plan_servings.cjs.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/migrate_meal_plan_sets.cjs            # dry run
//   node scripts/migrate_meal_plan_sets.cjs --write     # real write

const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");

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

// Same Monday-start-of-week logic as apps/web/app/lib/dates.ts's mondayOf()/weekDates(),
// duplicated here (no import across the web/api boundary) so "current week" means the
// exact same Mon-Sun range Prev/Next week nav was showing before this migration.
function toDateKey(d) {
  return d.toISOString().slice(0, 10);
}
function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function mondayOfToday() {
  const base = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const dow = base.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(base.getTime() + diff * 86400000);
}
function weekDatesFrom(mondayKey) {
  const monday = parseDateKey(mondayKey);
  return Array.from({ length: 7 }, (_, i) => toDateKey(new Date(monday.getTime() + i * 86400000)));
}
// Mon=1...Sun=7, matching apps/api/src/routes/mealPlan.ts's isoWeekdayOf().
function isoWeekdayOf(dateKey) {
  const dow = parseDateKey(dateKey).getUTCDay();
  return dow === 0 ? 7 : dow;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const mealPlanSets = db.collection("meal_plan_sets");
    const mealPlans = db.collection("meal_plans");

    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    const existingSets = await mealPlanSets.countDocuments({});
    if (existingSets > 0) {
      console.log(`\nmeal_plan_sets already has ${existingSets} doc(s) — this migration is meant to run once against a`);
      console.log(`pre-migration DB. Refusing to continue to avoid creating a duplicate "current week" card.`);
      if (WRITE) process.exit(1);
      console.log(`(dry-run continues below anyway, so the report still shows what a fresh run would have done.)`);
    }

    const mondayKey = toDateKey(mondayOfToday());
    const currentWeekDates = weekDatesFrom(mondayKey);
    const sundayKey = currentWeekDates[currentWeekDates.length - 1];
    console.log(`\nCurrent week window: ${mondayKey} .. ${sundayKey}`);

    const allEntries = await mealPlans.find({}).sort({ date: 1, mealSlot: 1 }).toArray();
    console.log(`Total existing meal_plans entries: ${allEntries.length}`);

    const currentWeekEntries = [];
    const discardEntries = [];
    for (const e of allEntries) {
      if (typeof e.date === "string" && currentWeekDates.includes(e.date)) {
        currentWeekEntries.push(e);
      } else {
        discardEntries.push(e);
      }
    }

    const newSetId = new ObjectId();
    const migratedRows = currentWeekEntries.map((e) => ({
      _id: e._id.toString(),
      date: e.date,
      mealSlot: e.mealSlot,
      recipeId: e.recipeId.toString(),
      dayIndex: isoWeekdayOf(e.date),
    }));
    const discardRows = discardEntries.map((e) => ({
      _id: e._id.toString(),
      date: e.date,
      mealSlot: e.mealSlot,
      recipeId: e.recipeId ? e.recipeId.toString() : null,
    }));

    const dayIndexCounts = {};
    for (const row of migratedRows) dayIndexCounts[row.dayIndex] = (dayIndexCounts[row.dayIndex] ?? 0) + 1;

    console.log(`\n=== SUMMARY ===`);
    console.log(`New meal_plan_sets card to create: 1 ({ name: "Weekly Plan", isActive: true, _id: ${newSetId.toString()} })`);
    console.log(`meal_plans entries to convert (planId + dayIndex added): ${migratedRows.length}`);
    console.log(`  by dayIndex (1=Mon...7=Sun): ${JSON.stringify(dayIndexCounts)}`);
    console.log(`meal_plans entries to DISCARD (outside current week, deleted): ${discardRows.length}`);
    console.log(`  discarded dates: ${JSON.stringify([...new Set(discardRows.map((r) => r.date))].sort())}`);

    if (WRITE) {
      await mealPlanSets.insertOne({ _id: newSetId, name: "Weekly Plan", isActive: true, createdAt: new Date().toISOString() });
      for (const e of currentWeekEntries) {
        await mealPlans.updateOne(
          { _id: e._id },
          { $set: { planId: newSetId, dayIndex: isoWeekdayOf(e.date) } },
        );
      }
      const discardIds = discardEntries.map((e) => e._id);
      if (discardIds.length > 0) {
        await mealPlans.deleteMany({ _id: { $in: discardIds } });
      }
      console.log(`\nWrite complete: 1 plan card created, ${migratedRows.length} entries migrated, ${discardRows.length} entries discarded.`);
    } else {
      console.log(`\nDry run only — no writes performed. Re-run with --write to apply.`);
    }

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      currentWeek: { mondayKey, sundayKey, dates: currentWeekDates },
      newPlanCard: { _id: newSetId.toString(), name: "Weekly Plan", isActive: true },
      totalEntries: allEntries.length,
      migratedCount: migratedRows.length,
      migratedByDayIndex: dayIndexCounts,
      migratedEntries: migratedRows,
      discardedCount: discardRows.length,
      discardedDates: [...new Set(discardRows.map((r) => r.date))].sort(),
      discardedEntries: discardRows,
    };
    const outPath = path.resolve(
      __dirname,
      `../../../../summaries/2026-08-08_meal-plan-sets-migration-${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${outPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
