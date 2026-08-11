// HANDOFF_canonical-ingredients-curation-round3-export.md — pure export,
// no research, no writes. Pulls fresh production data for cloud to
// USDA/CoFID-verify. Includes the 2026-08-11 "組3" gram-conversion spot check.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

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

// Round 1 notResearchedThisRound list + garlic (順帶), per handoff verbatim.
const CANDIDATES = [
  "frozen dumplings",
  "juice of lime",
  "cloves",
  "star anise",
  "coconut milk",
  "beef bouillon cube",
  "bok choy",
  "shrimp",
  "sriracha",
  "agave",
  "ground coriander",
  "cola",
  "sweetener",
  "bisquick",
  "garlic",
];

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ciCol = db.collection("canonical_ingredients");
    const recipesCol = db.collection("recipes");
    const costCol = db.collection("recipe_cost");

    const ciCount = await ciCol.countDocuments({});
    const recipesTotal = await recipesCol.countDocuments({});
    const recipesPublic = await recipesCol.countDocuments({ isPublic: true });

    const allRecipes = await recipesCol.find({}).project({ title: 1, ingredients: 1 }).toArray();
    const recipeById = new Map(allRecipes.map((r) => [String(r._id), r]));
    const allCostDocs = await costCol.find({}).toArray();
    const costByRecipeId = new Map(allCostDocs.map((c) => [String(c.recipeId), c]));

    const round3Candidates = [];
    for (const name of CANDIDATES) {
      const doc = await ciCol.findOne({ canonical_name: name });

      const recipeTitles = [];
      const currentLineStatus = [];
      let lineCount = 0;

      for (const [recipeId, recipe] of recipeById) {
        const ingredientLines = recipe.ingredients || [];
        const costDoc = costByRecipeId.get(recipeId);
        for (let i = 0; i < ingredientLines.length; i += 1) {
          const line = costDoc && costDoc.lines ? costDoc.lines[i] : null;
          if (line && line.canonical_name === name) {
            lineCount += 1;
            if (!recipeTitles.includes(recipe.title)) recipeTitles.push(recipe.title);
            currentLineStatus.push({
              recipe_id: recipeId,
              recipe_title: recipe.title || null,
              lineCost: line.priceable ? line.lineCost : null,
              priceable: !!line.priceable,
              reason: line.reason || null,
              raw_ingredient_text: ingredientLines[i] ? ingredientLines[i].name : null,
            });
          }
        }
      }

      round3Candidates.push({
        canonical_name: name,
        exists: !!doc,
        full_doc: doc || null,
        referenceCounts: { lineCount, recipeTitles },
        currentLineStatus,
      });
    }

    // ---- 組3: gram-conversion spot check ----
    // NOTE: 呢條 recipe 只喺 `recipe_drafts`（status:"pending"，未 publish），唔喺 `recipes`/
    // `recipe_cost`（precomputed cache 只覆蓋已 publish 嘅 recipes）。冇 line-level cost 存低，
    // 得返 draft 自己嘅 aggregate `costPreview`。所以呢度用返 assets/recipe_cost.service.js
    // 嘅 costRecipe() 現場計，用 live resolver index + 現時 canonical_ingredients/price_cache——
    // 純讀，冇寫任何嘢落 draft 或者其他 collection。
    const targetTitle = "Coconut Tamarind-Style Assam Fish Curry";
    let targetRecipe = allRecipes.find((r) => r.title === targetTitle);
    let targetSource = "recipes";
    let targetDraftMeta = null;
    if (!targetRecipe) {
      const draftsCol = db.collection("recipe_drafts");
      const draft = await draftsCol.findOne({ title: targetTitle });
      if (draft) {
        targetRecipe = draft;
        targetSource = "recipe_drafts";
        targetDraftMeta = { status: draft.status || null, costPreview: draft.costPreview || null };
      }
    }
    let targetRecipeLines = null;
    if (targetRecipe) {
      const existingCostDoc = costByRecipeId.get(String(targetRecipe._id));
      const ingredientLines = targetRecipe.ingredients || [];
      if (existingCostDoc && existingCostDoc.lines) {
        targetRecipeLines = ingredientLines.map((ing, i) => {
          const line = existingCostDoc.lines[i];
          return {
            rawName: line ? line.rawName : ing.name,
            quantity: line ? line.quantity : ing.quantity,
            rawUnit: line ? line.rawUnit : ing.unit,
            canonical_name: line ? line.canonical_name || null : null,
            normValue: line ? line.normValue ?? null : null,
            normUnit: line ? line.normUnit ?? null : null,
            bucket: line ? line.bucket ?? null : null,
            lineCost: line && line.priceable ? line.lineCost : null,
            priceable: line ? !!line.priceable : false,
            reason: line ? line.reason || null : null,
          };
        });
      } else {
        // Self-compute (draft path, or a published recipe missing a cache row).
        const liveIndex = await buildAliasIndex(ciCol);
        const allIngredientDocs = await ciCol.find({}).toArray();
        const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
        const priceDocs = await db.collection("canonical_price_cache").find({}).toArray();
        const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
        const resolveFn = (raw) => resolve(raw, liveIndex);
        const computed = costRecipe(targetRecipe, resolveFn, ingredientsMap, priceMap, new Set());
        targetRecipeLines = ingredientLines.map((ing, i) => {
          const line = computed.lines[i];
          return {
            rawName: line ? line.rawName : ing.name,
            quantity: line ? line.quantity : ing.quantity,
            rawUnit: line ? line.rawUnit : ing.unit,
            canonical_name: line ? line.canonical_name || null : null,
            normValue: line ? line.normValue ?? null : null,
            normUnit: line ? line.normUnit ?? null : null,
            bucket: line ? line.bucket ?? null : null,
            lineCost: line && line.priceable ? line.lineCost : null,
            priceable: line ? !!line.priceable : false,
            reason: line ? line.reason || null : null,
          };
        });
      }
    }

    const saltDoc = await ciCol.findOne({ canonical_name: "salt" });

    // Extra 2-3 recipes with tsp/tbsp/cup lines, to check normValue is generally populated
    const volumeUnits = new Set(["tsp", "tbsp", "cup", "teaspoon", "tablespoon"]);
    const extraSampleRecipes = [];
    for (const r of allRecipes) {
      if (r.title === targetTitle) continue;
      const ingredientLines = r.ingredients || [];
      const hasVolumeLine = ingredientLines.some((ing) => volumeUnits.has(String(ing.unit || "").toLowerCase()));
      if (!hasVolumeLine) continue;
      const costDoc = costByRecipeId.get(String(r._id));
      if (!costDoc) continue;
      const lines = ingredientLines
        .map((ing, i) => {
          const unit = String(ing.unit || "").toLowerCase();
          if (!volumeUnits.has(unit)) return null;
          const line = costDoc.lines ? costDoc.lines[i] : null;
          return {
            rawName: line ? line.rawName : ing.name,
            rawUnit: line ? line.rawUnit : ing.unit,
            canonical_name: line ? line.canonical_name || null : null,
            normValue: line ? line.normValue ?? null : null,
            normUnit: line ? line.normUnit ?? null : null,
            priceable: line ? !!line.priceable : false,
            reason: line ? line.reason || null : null,
          };
        })
        .filter(Boolean);
      if (lines.length > 0) {
        extraSampleRecipes.push({ recipe_id: String(r._id), recipe_title: r.title, volumeLines: lines });
      }
      if (extraSampleRecipes.length >= 3) break;
    }

    const gramConversionSpotCheck = {
      targetRecipe: {
        title: targetTitle,
        found: !!targetRecipe,
        source: targetRecipe ? targetSource : null,
        draftMeta: targetDraftMeta,
        recipe_id: targetRecipe ? String(targetRecipe._id) : null,
        lines: targetRecipeLines,
      },
      saltCanonicalDoc: saltDoc || { exists: false, note: "canonical_name 'salt' 唔存在" },
      extraSampleRecipes,
    };

    const output = {
      generatedAt: new Date().toISOString(),
      productionSnapshot: {
        canonical_ingredients_count: ciCount,
        recipes_public: recipesPublic,
        recipes_total: recipesTotal,
      },
      round3Candidates,
      gramConversionSpotCheck,
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(__dirname, "..", "..", "..", "..", "summaries");
    const jsonPath = path.join(outDir, `${dateStr}_curation_round3_export.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

    console.log("candidates exported:", round3Candidates.length);
    console.log("candidates exist:", round3Candidates.filter((c) => c.exists).length);
    console.log("candidates missing (merged/renamed away?):", round3Candidates.filter((c) => !c.exists).map((c) => c.canonical_name));
    console.log("target recipe found:", !!targetRecipe);
    console.log("salt canonical doc found:", !!saltDoc, saltDoc ? "density_cup=" + saltDoc.density_cup : "");
    console.log("extra sample recipes:", extraSampleRecipes.length);
    console.log("wrote:", jsonPath);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("export failed:", err.message);
  process.exit(1);
});
