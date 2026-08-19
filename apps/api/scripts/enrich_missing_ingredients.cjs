// One-off backfill for `recipes` docs that have `ingredients: []` — happens when a
// Spoonacular import (source:"spoonacular") landed with an empty extendedIngredients
// response. Re-fetches the recipe from RapidAPI's Spoonacular mirror using the
// Spoonacular id recovered from sourceUrl, and writes ingredients+steps back.
//
// Sets `enrichmentAttempted: true` on every doc it touches, whether or not the
// re-fetch actually found ingredients — this lets the frontend (costPendingLabel(),
// HANDOFF_recipe-missing-ingredients-enrichment.md §3) distinguish "still calculating"
// from "we tried and there's genuinely nothing" without a second field.
//
// Default: dry run (prints what would change, writes nothing). Pass --write to persist.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/enrich_missing_ingredients.cjs           # dry run
//   node scripts/enrich_missing_ingredients.cjs --write   # writes ingredients/steps + enrichmentAttempted
//
// Run history: 2026-08-19, --write against production — 41 docs matched
// (ingredients:{$size:0}, source:"spoonacular"), all 41 enriched successfully
// (0 fetch-failed/empty-response). Re-verified 2026-08-20: 0 recipes remain with
// ingredients:{$size:0} out of 1003 total; 41 docs carry enrichmentAttempted:true.
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

const WRITE = process.argv.includes("--write");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractSpoonacularId(sourceUrl) {
  const m = String(sourceUrl || "").match(/-(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

async function fetchInfo(id, RAPIDAPI_KEY, RAPIDAPI_HOST) {
  const url = `https://${RAPIDAPI_HOST}/recipes/${id}/information?includeNutrition=false`;
  let res = await fetch(url, { headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": RAPIDAPI_HOST } });
  if (res.status === 429) {
    await sleep(1500);
    res = await fetch(url, { headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": RAPIDAPI_HOST } });
  }
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  return { ok: true, json };
}

function toIngredients(json) {
  const list = Array.isArray(json.extendedIngredients) ? json.extendedIngredients : [];
  return list
    .map((ing) => ({
      name: String(ing.nameClean || ing.name || ing.originalName || "").trim(),
      quantity: typeof ing.amount === "number" ? ing.amount : 0,
      unit: String(ing.unit || "").trim(),
    }))
    .filter((i) => i.name);
}

function toSteps(json) {
  const instr = Array.isArray(json.analyzedInstructions) ? json.analyzedInstructions : [];
  const steps = [];
  for (const block of instr) {
    for (const s of block.steps || []) {
      if (s.step && s.step.trim()) steps.push(s.step.trim());
    }
  }
  return steps;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB, RAPIDAPI_KEY, RAPIDAPI_HOST } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const col = db.collection("recipes");

    const targets = await col
      .find({ ingredients: { $size: 0 }, source: "spoonacular" })
      .project({ title: 1, sourceUrl: 1 })
      .toArray();

    console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN (no writes)"}`);
    console.log(`Targets: ${targets.length}`);

    const results = [];
    for (const doc of targets) {
      const id = extractSpoonacularId(doc.sourceUrl);
      if (!id) {
        results.push({ _id: doc._id, title: doc.title, status: "no-id-in-url" });
        continue;
      }
      const info = await fetchInfo(id, RAPIDAPI_KEY, RAPIDAPI_HOST);
      if (!info.ok) {
        results.push({ _id: doc._id, title: doc.title, status: `fetch-failed-${info.status}` });
        if (WRITE) await col.updateOne({ _id: doc._id }, { $set: { enrichmentAttempted: true } });
        await sleep(400);
        continue;
      }
      const ingredients = toIngredients(info.json);
      const steps = toSteps(info.json);
      const ok = ingredients.length > 0;
      results.push({
        _id: doc._id,
        title: doc.title,
        status: ok ? "enriched" : "empty-response",
        ingredientCount: ingredients.length,
        stepCount: steps.length,
      });
      if (WRITE) {
        const setFields = { enrichmentAttempted: true };
        if (ok) {
          setFields.ingredients = ingredients;
          setFields.steps = steps;
        }
        await col.updateOne({ _id: doc._id }, { $set: setFields });
      }
      await sleep(400);
    }

    console.log(JSON.stringify(results, null, 2));
    const enrichedCount = results.filter((r) => r.status === "enriched").length;
    console.log(`\nEnriched: ${enrichedCount}/${targets.length}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("error:", err.message);
  process.exit(1);
});
