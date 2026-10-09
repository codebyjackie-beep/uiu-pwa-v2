// HANDOFF_recipe-nutrition-spoonacular-data-loss-fix.md — one-time fix for the
// 152 spoonacular recipes whose `nutrition` was overwritten by
// recompute_recipes_nutrition.cjs with an internally-computed whole-recipe
// total (methodologically wrong for spoonacular: those recipes' original
// nutrition was authoritative per-serving data from Spoonacular's own API).
//
// Part 1 — 121 recipes recoverable from uiu-migration/uiu_export/recipes.FULL_BACKUP.json
//   (2026-07-22 mongoexport, NDJSON, MongoDB Extended JSON). Restore their
//   original `nutrition` (incl. `fiber`) verbatim from the backup.
//
// Part 2 — 31 recipes NOT in the backup (added after 2026-07-22, so no
//   authoritative source exists). Approximate per-serving by dividing the
//   current (wrong) whole-recipe-total by `servings`. Cannot recover `fiber`
//   (left absent, not fabricated). Flagged with `nutritionApproximate: true`
//   so it's clear this is a stand-in, not authoritative data.
//
// Default dry-run; pass --write to actually commit.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/fix_spoonacular_nutrition.cjs            # dry run
//   node scripts/fix_spoonacular_nutrition.cjs --write    # real write
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

// Unwrap MongoDB Extended JSON scalar wrappers.
function unwrap(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(unwrap);
  if (typeof v === "object") {
    if ("$oid" in v) return v.$oid;
    if ("$numberInt" in v) return parseInt(v.$numberInt, 10);
    if ("$numberDouble" in v) return parseFloat(v.$numberDouble);
    if ("$numberLong" in v) return parseInt(v.$numberLong, 10);
    if ("$date" in v) return unwrap(v.$date);
    const out = {};
    for (const k of Object.keys(v)) out[k] = unwrap(v[k]);
    return out;
  }
  return v;
}

function loadBackupById() {
  const p = path.resolve(__dirname, "../../../../uiu-migration/uiu_export/recipes.FULL_BACKUP.json");
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const id = doc._id && doc._id.$oid;
    if (id) byId.set(id, unwrap(doc));
  }
  return byId;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const recipesCol = db.collection("recipes");
    const backupById = loadBackupById();

    const spoonacular = await recipesCol.find({ source: "spoonacular" }).toArray();
    console.log(`Total spoonacular recipes: ${spoonacular.length}`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    const affected = spoonacular.filter((r) => !(r.nutrition && typeof r.nutrition.fiber === "number"));
    console.log(`Affected (missing fiber, i.e. overwritten by recompute): ${affected.length}`);

    const restoreList = [];
    const approxList = [];
    const approxSkipped = [];

    for (const r of affected) {
      const b = backupById.get(String(r._id));
      if (b && b.nutrition && typeof b.nutrition.fiber === "number") {
        restoreList.push({
          id: r._id,
          title: r.title,
          current: r.nutrition,
          restored: b.nutrition,
        });
      } else {
        const servings = r.servings;
        if (!servings || typeof servings !== "number" || servings <= 0) {
          approxSkipped.push({ id: r._id, title: r.title, servings, reason: "servings missing/zero/invalid" });
          continue;
        }
        const cur = r.nutrition || {};
        const approx = {
          calories: Math.round((cur.calories || 0) / servings),
          protein: round1((cur.protein || 0) / servings),
          carbs: round1((cur.carbs || 0) / servings),
          fat: round1((cur.fat || 0) / servings),
          nutritionApproximate: true,
        };
        approxList.push({ id: r._id, title: r.title, servings, current: cur, approx });
      }
    }

    console.log(`\n=== Part 1: restore from backup (${restoreList.length}) ===`);
    for (const e of restoreList) {
      console.log(`  "${e.title}" (${e.id})`);
      console.log(`    current (wrong): ${JSON.stringify(e.current)}`);
      console.log(`    restored (backup): ${JSON.stringify(e.restored)}`);
    }

    console.log(`\n=== Part 2: total÷servings approximation (${approxList.length}) ===`);
    for (const e of approxList) {
      console.log(`  "${e.title}" (${e.id}) servings=${e.servings}`);
      console.log(`    current total: ${JSON.stringify(e.current)}`);
      console.log(`    approx per-serving: ${JSON.stringify(e.approx)}`);
    }

    if (approxSkipped.length > 0) {
      console.log(`\n=== Part 2 skipped (invalid servings, left untouched) (${approxSkipped.length}) ===`);
      for (const e of approxSkipped) {
        console.log(`  "${e.title}" (${e.id}) servings=${JSON.stringify(e.servings)} — ${e.reason}`);
      }
    }

    console.log(`\nSummary: restore=${restoreList.length}, approximate=${approxList.length}, skipped=${approxSkipped.length}, total affected=${affected.length}`);

    if (WRITE) {
      let restored = 0;
      for (const e of restoreList) {
        await recipesCol.updateOne({ _id: new ObjectId(e.id) }, { $set: { nutrition: e.restored } });
        restored += 1;
      }
      let approximated = 0;
      for (const e of approxList) {
        await recipesCol.updateOne({ _id: new ObjectId(e.id) }, { $set: { nutrition: e.approx } });
        approximated += 1;
      }
      console.log(`\nWritten: restored=${restored}/${restoreList.length}, approximated=${approximated}/${approxList.length}`);
    } else {
      console.log(`\n(dry run — nothing written; pass --write to commit)`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
