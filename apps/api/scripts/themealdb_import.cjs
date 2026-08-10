// Part B: build Recipe + recipe_cost docs from the TheMealDB raw snapshot,
// reusing the exact same canonical-resolution / unit-conversion / cost engine
// as the existing 197 recipes (no second conversion system).
//
// Default: dry run (prints a coverage report, writes nothing to DB).
// Pass --write to insert the built drafts (isPublic:false) into `recipes` +
// `recipe_cost`. Never touches the existing 197 recipes (insert-only).
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { parseMeasure } = require("./themealdb_measure_parser.cjs");
const { normalizeName } = require("../../../../assets/name_normalizer.js");
const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { normalizeQty, costRecipe } = require("../../../../assets/recipe_cost.service.js");
// packages/shared builds ESM-only (type:module) — this script is CJS, so pull
// ingredientTextGuard in via dynamic import() inside main() instead of require().
const SHARED_DIST_URL = "file:///" + path.resolve(__dirname, "../../../packages/shared/dist/index.js").replace(/\\/g, "/");

const WRITE = process.argv.includes("--write");
const RAW_PATH = path.resolve(__dirname, "../../../../assets/themealdb_raw/meals_raw.json");
const REPORT_PATH = path.resolve(__dirname, "../../../../assets/themealdb_raw/import_coverage_report.json");

const CATEGORY_TAGS = {
  Beef: ["main course"],
  Chicken: ["main course"],
  Dessert: ["dessert"],
  Goat: ["main course"],
  Lamb: ["main course"],
  Miscellaneous: [],
  Pasta: ["main course"],
  Pork: ["main course"],
  Seafood: ["main course"],
  Side: ["side dish"],
  Starter: ["starter"],
  Vegan: ["vegan", "main course"],
  Vegetarian: ["vegetarian", "main course"],
  Breakfast: ["breakfast"],
};

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

function buildTags(meal) {
  const tags = new Set();
  for (const t of CATEGORY_TAGS[meal.strCategory] || []) tags.add(t);
  if (meal.strTags) {
    for (const t of meal.strTags.split(",")) {
      const clean = t.trim().toLowerCase();
      if (clean) tags.add(clean);
    }
  }
  return [...tags];
}

function extractIngredients(meal) {
  const lines = [];
  for (let i = 1; i <= 20; i++) {
    const name = (meal[`strIngredient${i}`] || "").trim();
    const measure = (meal[`strMeasure${i}`] || "").trim();
    if (!name) continue;
    const { quantity, unit } = parseMeasure(measure);
    lines.push({ name: name.toLowerCase(), quantity, unit });
  }
  return lines;
}

function buildSteps(meal) {
  return String(meal.strInstructions || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildDescription(meal) {
  const firstLine = buildSteps(meal)[0] || "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] || firstLine;
  return sentence.slice(0, 200);
}

async function main() {
  const { ingredientTextGuard } = await import(SHARED_DIST_URL);
  const meals = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
  console.log(`Loaded ${meals.length} raw TheMealDB meals from ${RAW_PATH}`);

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

    const recipes = [];
    const costs = [];
    const stats = {
      totalMeals: meals.length,
      coverageBuckets: { ge80: 0, ge50: 0, lt50: 0 },
      nutritionFullyResolved: 0,
      nutritionPartial: 0,
      nutritionNone: 0,
    };

    for (const meal of meals) {
      const ingredientLines = extractIngredients(meal);
      const now = new Date().toISOString();

      const recipe = {
        title: meal.strMeal,
        description: buildDescription(meal),
        isPublic: false,
        userId: null,
        ingredients: ingredientLines,
        steps: buildSteps(meal),
        tags: buildTags(meal),
        servings: 4,
        prepTimeMinutes: 15,
        cookTimeMinutes: 30,
        imageUrl: meal.strMealThumb || null,
        source: "themealdb",
        sourcePlatform: null,
        sourceUrl: meal.strSource || null,
        cuisineType: meal.strArea || undefined,
        collectionIds: [],
        isFavorite: false,
        viewCount: 0,
        favoriteCount: 0,
        needs_review: true,
        themealdb_id: meal.idMeal,
        createdAt: now,
        updatedAt: now,
      };

      // HANDOFF_recipe-import-french-label-bug-execute.md decision 2: every write path
      // that can touch recipes.isPublic must pass ingredients through the shared guard.
      // themealdb_import already hardcodes isPublic:false + needs_review:true for every
      // doc, so a trip here changes no behaviour — it's wired for the audit trail and so
      // the guard fires consistently if this script's isPublic default is ever loosened.
      const guardResult = ingredientTextGuard(ingredientLines);
      if (guardResult.suspicious) stats.guardTripped = (stats.guardTripped || 0) + 1;

      // Nutrition: reuse the same unit-conversion table as recipe_cost, with
      // priceDoc=null so count-unit lines fall through to per_item_g grams
      // (nutrition doesn't care about price-cache count pricing).
      let kcal = 0, protein = 0, carbs = 0, fat = 0;
      let resolvedCount = 0;
      for (const line of ingredientLines) {
        const resolvedName = resolveFn(line.name);
        if (resolvedName.unresolved) continue;
        const canonicalDoc = ingredientsMap.get(resolvedName.canonical_name);
        if (!canonicalDoc || !canonicalDoc.nutrition_per_100g) continue;
        const norm = normalizeQty(line.quantity, line.unit, canonicalDoc, null);
        if (norm.unpriceable) continue;
        let grams = null;
        if (norm.normUnit === "g") grams = norm.normValue;
        else if (norm.normUnit === "ml") grams = norm.normValue; // density ~1 fallback not attempted; ml treated as g equivalent only when no better data
        if (grams == null) continue;
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
      if (resolvedCount === 0) stats.nutritionNone += 1;
      else if (resolvedCount === ingredientLines.length) stats.nutritionFullyResolved += 1;
      else stats.nutritionPartial += 1;

      recipes.push(recipe);

      // Cost: reuse costRecipe() exactly as-is for the existing 197.
      const costInput = { ...recipe, ingredients: ingredientLines };
      let cost;
      try {
        cost = costRecipe(costInput, resolveFn, ingredientsMap, priceMap, new Set());
      } catch (err) {
        cost = { error: String(err), adjustedCoveragePct: 0 };
      }
      costs.push({ themealdb_id: meal.idMeal, title: meal.strMeal, cost });

      const pct = cost.adjustedCoveragePct || 0;
      if (pct >= 80) stats.coverageBuckets.ge80 += 1;
      else if (pct >= 50) stats.coverageBuckets.ge50 += 1;
      else stats.coverageBuckets.lt50 += 1;
    }

    console.log(`Built ${recipes.length} recipe drafts, ${costs.length} cost records`);
    console.log(`ingredientTextGuard tripped on ${stats.guardTripped || 0}/${recipes.length} meals`);
    console.log("Coverage buckets:", JSON.stringify(stats.coverageBuckets));
    console.log(
      `Nutrition: fully resolved ${stats.nutritionFullyResolved}, partial ${stats.nutritionPartial}, none ${stats.nutritionNone}`,
    );

    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify({ stats, sampleRecipe: recipes[0], sampleCost: costs[0] }, null, 2),
    );
    console.log(`Coverage report written to ${REPORT_PATH}`);

    if (WRITE) {
      const recipesCol = db.collection("recipes");
      const recipeCostCol = db.collection("recipe_cost");
      const insertResult = await recipesCol.insertMany(recipes);
      console.log(`Inserted ${insertResult.insertedCount} recipes`);

      const insertedIds = Object.values(insertResult.insertedIds);
      const costDocs = costs.map((c, i) => ({
        recipeId: insertedIds[i],
        themealdb_id: c.themealdb_id,
        ...c.cost,
      }));
      const costInsertResult = await recipeCostCol.insertMany(costDocs);
      console.log(`Inserted ${costInsertResult.insertedCount} recipe_cost docs`);
    } else {
      console.log("DRY RUN — no DB writes performed. Pass --write to commit.");
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
