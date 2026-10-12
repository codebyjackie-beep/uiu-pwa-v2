// cc_prompt 2026-10-12 Part D — READ-ONLY audit of how recipe.nutrition.calories is derived.
// Writes nothing to the DB. Lists per-line kcal for two example recipes and public recipes with
// stored per-serving kcal < 150 (excluding nutritionUnavailable:true).
//
// Usage (from uiu-pwa-v2/apps/api): node scripts/partD_nutrition_audit.cjs
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const EXAMPLES = ["Kale With Red Onion", "Sweet Potato & Avocado Hash with Poached Eggs"];

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const ciCol = db.collection("canonical_ingredients");
    const index = await buildAliasIndex(ciCol);
    const ingDocs = await ciCol.find({}).toArray();
    const ingMap = new Map(ingDocs.map((d) => [d.canonical_name, d]));
    const quarantined = new Set(ingDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()));
    const priceMap = new Map((await db.collection("canonical_price_cache").find({}).toArray()).map((d) => [d.canonical_name, d]));
    const resolveFn = (raw) => resolve(raw, index);

    const recipes = await db.collection("recipes").find({ isPublic: true }).toArray();
    console.log(`public recipes: ${recipes.length}`);

    function lineDetail(r) {
      const cost = costRecipe(r, resolveFn, ingMap, priceMap, quarantined);
      let counted = 0, missedMl = 0;
      const rows = (cost.lines || []).map((l, i) => {
        const ing = (r.ingredients || [])[i] || {};
        const doc = l.canonical_name ? ingMap.get(l.canonical_name) : null;
        const n = doc?.nutrition_per_100g;
        const counts = !!(l.priceable && l.normUnit === "g" && l.canonical_name && l.normValue && n);
        const kcal = counts ? l.normValue * n.kcal / 100 : 0;
        counted += kcal;
        // informational only: what an ml line WOULD add if counted at 1 g/ml (not in the stored figure)
        const wouldBe = !counts && l.normUnit === "ml" && n && l.normValue ? l.normValue * n.kcal / 100 : null;
        if (wouldBe) missedMl += wouldBe;
        return {
          raw: `${ing.quantity ?? ""} ${ing.unit ?? ""} ${ing.name ?? ""}`.replace(/\s+/g, " ").trim(),
          canonical: l.canonical_name || null,
          normValue: l.normValue != null ? Math.round(l.normValue * 10) / 10 : null,
          normUnit: l.normUnit || null,
          priceable: !!l.priceable,
          kcalPer100g: n ? n.kcal : null,
          countedKcal: Math.round(kcal),
          countedInStored: counts,
          mlWouldAddKcal: wouldBe ? Math.round(wouldBe) : null,
        };
      });
      return { rows, totalCounted: Math.round(counted), missedMl: Math.round(missedMl), servings: r.servings };
    }

    const examples = [];
    for (const title of EXAMPLES) {
      const r = recipes.find((x) => x.title === title) || recipes.find((x) => x.title.startsWith(title));
      if (!r) { console.log(`NOT FOUND: ${title}`); continue; }
      const d = lineDetail(r);
      const ex = { id: String(r._id), title: r.title, isPublic: r.isPublic, storedCalories: r.nutrition?.calories ?? null, servings: r.servings ?? null, nutritionUnavailable: r.nutritionUnavailable === true, approx: r.nutritionApproximate === true, ...d };
      examples.push(ex);
      console.log(`\n${ex.title} [${ex.id}] stored=${ex.storedCalories} kcal/serving, servings=${ex.servings}, recomputed whole-recipe=${d.totalCounted} -> /serving ${Math.round(d.totalCounted / (r.servings || 1))}, ml lines would add ${d.missedMl}`);
      for (const row of d.rows) console.log(`  ${String(row.countedKcal).padStart(5)} kcal | ${row.normUnit ?? "-"} ${row.normValue ?? ""} | ${row.raw} -> ${row.canonical ?? "UNRESOLVED"}${row.kcalPer100g == null ? " (no nutrition)" : ""}${row.mlWouldAddKcal ? ` (ml line: +${row.mlWouldAddKcal} if counted)` : ""}`);
    }

    const low = [];
    let excluded = 0;
    for (const r of recipes) {
      const kcal = r.nutrition && typeof r.nutrition.calories === "number" ? r.nutrition.calories : null;
      if (r.nutritionUnavailable === true) { excluded += 1; continue; }
      if (kcal === null || kcal >= 150) continue;
      const d = lineDetail(r);
      const lineCount = d.rows.length;
      low.push({
        id: String(r._id), title: r.title, kcal, servings: r.servings ?? null,
        lines: lineCount,
        mlLines: d.rows.filter((x) => x.normUnit === "ml").length,
        pcLines: d.rows.filter((x) => x.normUnit === "pc").length,
        noNutritionLines: d.rows.filter((x) => x.kcalPer100g == null).length,
        mlWouldAddKcalWhole: d.missedMl,
        source: r.source ?? null,
      });
    }
    low.sort((a, b) => a.kcal - b.kcal);
    console.log(`\nexcluded (nutritionUnavailable): ${excluded}`);
    console.log(`public per-serving kcal < 150 (not flagged): ${low.length}`);
    for (const l of low) console.log(`  ${String(l.kcal).padStart(4)} kcal | servings ${l.servings} | lines ${l.lines} (ml ${l.mlLines}, pc ${l.pcLines}, no-nutrition ${l.noNutritionLines}) | ${l.title}`);

    const out = { generatedAt: new Date().toISOString(), publicRecipes: recipes.length, excludedFlagged: excluded, examples, lowKcal: low };
    const dir = path.resolve(__dirname, "../../../summaries");
    const file = path.join(dir, "partD_nutrition_audit_2026-10-12.json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`report: ${file}`);
  } finally {
    await client.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
