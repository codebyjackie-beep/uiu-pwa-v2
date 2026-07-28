// HANDOFF_ai-recipe-drafting-tool.md Part B: manual insert of ONE AI-drafted
// recipe (idea sourced via tools/recipe_ideas/spoonacular_browse.cjs, dish name
// only — ingredients/steps written from scratch, no Spoonacular content copied).
//
// Reuses the exact same canonical-resolution / unit-conversion / cost engine as
// the existing 197 recipes + the TheMealDB batch (no second conversion system).
//
// Default: dry run (prints canonical-match + nutrition + cost report, writes
// nothing to DB). Pass --write to insert the recipe + recipe_cost doc.
// isPublic stays false — this script never sets isPublic:true.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { normalizeQty, costRecipe } = require("../../../../assets/recipe_cost.service.js");

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

const INGREDIENT_LINES = [
  { name: "chicken thighs", quantity: 700, unit: "g" },
  { name: "new potatoes", quantity: 500, unit: "g" },
  { name: "red onion", quantity: 1, unit: "pc" },
  { name: "garlic clove", quantity: 15, unit: "g" },
  { name: "olive oil", quantity: 30, unit: "ml" },
  { name: "honey", quantity: 40, unit: "g" },
  { name: "dijon mustard", quantity: 20, unit: "g" },
  { name: "thyme", quantity: 4, unit: "g" },
  { name: "salt", quantity: 3, unit: "g" },
  { name: "black pepper", quantity: 2, unit: "g" },
  { name: "chicken stock", quantity: 100, unit: "ml" },
  { name: "broccoli florets", quantity: 300, unit: "g" },
];

const STEPS = [
  "Preheat the oven to 200°C (180°C fan).",
  "Halve the new potatoes and slice the red onion; toss both on a large roasting tray with half the olive oil, a pinch of salt and pepper.",
  "Whisk together the honey, dijon mustard, remaining olive oil, minced garlic and thyme to make the glaze.",
  "Pat the chicken thighs dry and coat them well in the honey-mustard glaze.",
  "Nestle the chicken thighs among the potatoes and onion on the tray, skin-side up.",
  "Pour the chicken stock into the base of the tray and roast for 35-40 minutes, until the chicken is golden and cooked through and the potatoes are tender.",
  "About 10 minutes before the tray comes out, steam the broccoli florets until just tender.",
  "Rest the chicken for a few minutes, then serve straight from the tray with the steamed broccoli on the side.",
];

function buildRecipe() {
  const now = new Date().toISOString();
  return {
    title: "One-Tray Honey Mustard Chicken Thighs with New Potatoes",
    description:
      "A simple, budget-friendly all-in-one traybake — bone-in chicken thighs and new potatoes roasted in a sticky honey-mustard glaze, finished with steamed broccoli on the side.",
    isPublic: false,
    userId: null,
    ingredients: INGREDIENT_LINES,
    steps: STEPS,
    tags: ["chicken", "traybake", "budget", "one-pan", "gluten-free"],
    servings: 4,
    prepTimeMinutes: 15,
    cookTimeMinutes: 40,
    mealType: "dinner",
    imageUrl: "",
    source: "AI-drafted",
    sourcePlatform: null,
    collectionIds: [],
    isFavorite: false,
    viewCount: 0,
    favoriteCount: 0,
    needs_review: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ingredientsCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");

    const aliasIndex = await buildAliasIndex(ingredientsCol);
    const ingredientDocs = await ingredientsCol.find({ quarantine: { $ne: true } }).toArray();
    const ingredientsMap = new Map(ingredientDocs.map((d) => [d.canonical_name, d]));
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));

    const resolveFn = (rawName) => resolve(rawName, aliasIndex);

    const recipe = buildRecipe();

    // --- canonical match report (name resolution only, exact/fuzzy/unresolved) ---
    const matchReport = INGREDIENT_LINES.map((line) => {
      const r = resolveFn(line.name);
      if (r.unresolved) return { rawName: line.name, match: "unresolved" };
      return { rawName: line.name, match: r.method, canonical_name: r.canonical_name };
    });

    console.log("=== Canonical match report (12 ingredients) ===");
    for (const m of matchReport) {
      console.log(
        `  ${m.match.padEnd(10)} ${m.rawName}${m.canonical_name ? ` -> ${m.canonical_name}` : ""}`,
      );
    }
    const counts = matchReport.reduce((acc, m) => {
      acc[m.match] = (acc[m.match] || 0) + 1;
      return acc;
    }, {});
    console.log(`Summary: ${JSON.stringify(counts)}`);

    // --- nutrition (same method as themealdb_import.cjs) ---
    let kcal = 0, protein = 0, carbs = 0, fat = 0;
    let resolvedCount = 0;
    const nutritionGaps = [];
    for (const line of INGREDIENT_LINES) {
      const resolvedName = resolveFn(line.name);
      if (resolvedName.unresolved) { nutritionGaps.push({ name: line.name, reason: "unresolved" }); continue; }
      const canonicalDoc = ingredientsMap.get(resolvedName.canonical_name);
      if (!canonicalDoc || !canonicalDoc.nutrition_per_100g) { nutritionGaps.push({ name: line.name, reason: "no_nutrition_per_100g" }); continue; }
      const norm = normalizeQty(line.quantity, line.unit, canonicalDoc, null);
      if (norm.unpriceable) { nutritionGaps.push({ name: line.name, reason: norm.reason }); continue; }
      let grams = null;
      if (norm.normUnit === "g") grams = norm.normValue;
      else if (norm.normUnit === "ml") grams = norm.normValue;
      if (grams == null) { nutritionGaps.push({ name: line.name, reason: "no_gram_value" }); continue; }
      const n = canonicalDoc.nutrition_per_100g;
      const factor = grams / 100;
      if (n.kcal != null) kcal += n.kcal * factor;
      if (n.protein != null) protein += n.protein * factor;
      if (n.carbs != null) carbs += n.carbs * factor;
      if (n.fat != null) fat += n.fat * factor;
      resolvedCount += 1;
    }
    recipe.nutrition = {
      calories: Math.round(kcal),
      protein: Math.round(protein * 10) / 10,
      carbs: Math.round(carbs * 10) / 10,
      fat: Math.round(fat * 10) / 10,
    };

    console.log("\n=== Nutrition ===");
    console.log(`  Resolved ${resolvedCount}/${INGREDIENT_LINES.length} lines`);
    console.log(`  ${JSON.stringify(recipe.nutrition)}`);
    if (nutritionGaps.length) {
      console.log("  Gaps:", JSON.stringify(nutritionGaps));
    }

    // --- cost (costRecipe(), same engine as the 197 baseline) ---
    const cost = costRecipe(recipe, resolveFn, ingredientsMap, priceMap, new Set());

    console.log("\n=== Cost (recipe_cost.service.js) ===");
    console.log(`  adjustedCoveragePct: ${cost.adjustedCoveragePct.toFixed(2)}%`);
    console.log(`  coveragePct (raw): ${cost.coveragePct.toFixed(2)}%`);
    console.log(`  basket: £${cost.basket.toFixed(2)}  perServing: £${cost.perServing.toFixed(2)}`);
    console.log(`  adjustedTotal: ${cost.adjustedTotal}  adjustedPriceable: ${cost.adjustedPriceable}`);
    console.log(`  unpriceableReasons: ${JSON.stringify(cost.unpriceableReasons)}`);
    for (const line of cost.lines) {
      if (!line.priceable) {
        console.log(`  UNPRICEABLE: ${line.rawName} (${line.quantity} ${line.rawUnit}) -> reason=${line.reason}`);
      }
    }

    if (WRITE) {
      const recipesCol = db.collection("recipes");
      const recipeCostCol = db.collection("recipe_cost");
      const insertResult = await recipesCol.insertOne(recipe);
      console.log(`\nInserted recipe _id=${insertResult.insertedId}`);

      const costDoc = { recipeId: insertResult.insertedId, ...cost, computedAt: new Date().toISOString() };
      const costInsertResult = await recipeCostCol.insertOne(costDoc);
      console.log(`Inserted recipe_cost _id=${costInsertResult.insertedId}`);
    } else {
      console.log("\nDRY RUN — no DB writes performed. Pass --write to commit.");
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
