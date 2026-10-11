// cc_prompt_recipe_data_cleanup.md Part 8 — READ-ONLY dry run. Writes nothing to the DB.
// Lists (a) public recipes whose stored per-serving calories < 50 or > 1500, with per-line
// nutrition match detail, (b) lowercase-initial titles, (c) recipes with junk `mealType` values.
// Output: console + summaries/part8_dryrun_<date>.json for review before any --write script exists.
//
// Usage (from uiu-pwa-v2/apps/api): node scripts/part8_low_kcal_dryrun.cjs
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
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

// Mirrors RecipeMealClass in @uiu/shared (+ legacy values the classifier already understands).
const VALID_MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack", "dessert", "appetizer", "brunch", "main", "side", "starter", "drink"]);

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

    const flagged = [];
    for (const r of recipes) {
      const kcal = r.nutrition && typeof r.nutrition.calories === "number" ? r.nutrition.calories : null;
      // The API (routes/recipes.ts) serves nutrition.calories as-is and the UI shows it per serving,
      // so the stored value IS the per-serving figure — no division by servings.
      const candidate = kcal !== null && (kcal < 50 || kcal > 1500);
      if (!candidate) continue;
      let cost = null;
      try { cost = costRecipe(r, resolveFn, ingMap, priceMap, quarantined); } catch (e) { cost = null; }
      const lines = (cost?.lines || []).map((l) => {
        const doc = l.canonical_name ? ingMap.get(l.canonical_name) : null;
        const hasNut = !!doc?.nutrition_per_100g;
        return {
          raw: l.rawName || l.raw || null,
          canonical: l.canonical_name || null,
          normValue: l.normValue ?? null,
          normUnit: l.normUnit ?? null,
          hasNutrition: hasNut,
          kcalContribution: hasNut && l.normUnit === "g" && l.normValue ? Math.round(doc.nutrition_per_100g.kcal * l.normValue / 100) : null,
        };
      });
      const contributing = lines.filter((l) => l.hasNutrition && l.kcalContribution !== null).length;
      const total = (r.ingredients || []).length;
      const lineCoverage = total ? Math.round((contributing / total) * 100) / 100 : 0;
      // Proposal only (nothing is written): a stored value that sums < 70% of the ingredient lines is
      // an under-computed partial sum, not a real figure -> candidate for nutritionUnavailable:true.
      let proposal;
      if (r.nutritionUnavailable === true) proposal = "already-flagged";
      else if (kcal > 1500) proposal = "review-servings-or-flag";
      else if (lineCoverage < 0.7) proposal = "flag-nutritionUnavailable";
      else proposal = "keep-review";
      flagged.push({
        lineCoverage, proposal,
        id: String(r._id), title: r.title, servings: r.servings ?? null,
        storedCalories: kcal,
        nutritionUnavailable: r.nutritionUnavailable === true,
        autoApprovedBatchId: r.autoApprovedBatchId ?? null,
        ingredientLines: (r.ingredients || []).length,
        gramLinesWithNutrition: lines.filter((l) => l.hasNutrition && l.kcalContribution !== null).length,
        gramLinesTotal: lines.filter((l) => l.normUnit === "g").length,
        unmatchedLines: lines.filter((l) => !l.hasNutrition).map((l) => l.raw || l.canonical),
        lines,
      });
    }

    const lowercaseTitles = recipes.filter((r) => typeof r.title === "string" && /^[a-z]/.test(r.title.trim())).map((r) => ({ id: String(r._id), title: r.title }));
    const junkMealType = [];
    for (const r of recipes) {
      const mt = Array.isArray(r.mealType) ? r.mealType : r.mealType != null ? [r.mealType] : [];
      const bad = mt.filter((v) => !VALID_MEAL_TYPES.has(String(v).toLowerCase()));
      if (bad.length) junkMealType.push({ id: String(r._id), title: r.title, mealType: r.mealType, bad });
    }
    const junkValueCounts = {};
    for (const j of junkMealType) for (const b of j.bad) junkValueCounts[b] = (junkValueCounts[b] || 0) + 1;

    console.log(`flagged by kcal: ${flagged.length}`);
    for (const f of flagged) {
      console.log(`- [${f.proposal} cov=${f.lineCoverage}] ${f.title} [${f.id}] stored=${f.storedCalories} servings=${f.servings} unavailable=${f.nutritionUnavailable} gramLines ${f.gramLinesWithNutrition}/${f.gramLinesTotal} of ${f.ingredientLines} lines`);
      if (f.unmatchedLines.length) console.log(`    no nutrition: ${f.unmatchedLines.join("; ")}`);
    }
    const byProposal = {};
    for (const f of flagged) byProposal[f.proposal] = (byProposal[f.proposal] || 0) + 1;
    console.log("proposal counts", byProposal);
    console.log(`lowercase titles: ${lowercaseTitles.length}`, lowercaseTitles);
    console.log(`junk mealType recipes: ${junkMealType.length}`, junkValueCounts);

    const out = { generatedAt: new Date().toISOString(), publicRecipes: recipes.length, flagged, lowercaseTitles, junkMealType, junkValueCounts };
    const dir = path.resolve(__dirname, "../../../summaries");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `part8_dryrun_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`report: ${file}`);
  } finally {
    await client.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
