// HANDOFF_canonical-ingredients-nutrition-per-100g-export.md — pure export,
// no research, no writes. Lists canonical_ingredients missing
// nutrition_per_100g, sorted by how often each is referenced across public
// recipes' ingredient lines (via the resolver), same pattern as round4's
// referenceCount aggregation.
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

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ciCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const recipesCol = db.collection("recipes");

    const index = await buildAliasIndex(ciCol);
    const allIngredientDocs = await ciCol.find({}).toArray();
    const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(
      allIngredientDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()),
    );
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const resolveFn = (raw) => resolve(raw, index);

    const publicRecipes = await recipesCol.find({ isPublic: true }).toArray();

    const refCount = new Map();
    for (const r of publicRecipes) {
      const cost = costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      for (const line of cost.lines) {
        if (!line.priceable || !line.canonical_name) continue;
        let entry = refCount.get(line.canonical_name);
        if (!entry) {
          entry = { count: 0, recipeTitles: new Set() };
          refCount.set(line.canonical_name, entry);
        }
        entry.count += 1;
        entry.recipeTitles.add(r.title);
      }
    }

    const missing = allIngredientDocs.filter((d) => !d.nutrition_per_100g);
    const present = allIngredientDocs.filter((d) => !!d.nutrition_per_100g);

    const missingSorted = missing
      .map((d) => {
        const ref = refCount.get(d.canonical_name);
        return {
          canonical_name: d.canonical_name,
          category: d.category || null,
          aliases: d.aliases || [],
          referenceCount: ref ? ref.count : 0,
          sampleRecipeTitles: ref ? [...ref.recipeTitles].slice(0, 10) : [],
          canonical_ingredients_doc: d,
        };
      })
      .sort((a, b) => b.referenceCount - a.referenceCount);

    const output = {
      generatedAt: new Date().toISOString(),
      productionSnapshot: {
        canonical_ingredients_count: allIngredientDocs.length,
        with_nutrition_per_100g: present.length,
        missing_nutrition_per_100g: missing.length,
        recipes_public: publicRecipes.length,
      },
      missingNutritionPer100g: {
        totalCount: missingSorted.length,
        referencedByAtLeastOneRecipe: missingSorted.filter((e) => e.referenceCount > 0).length,
        neverReferenced: missingSorted.filter((e) => e.referenceCount === 0).length,
        items: missingSorted,
      },
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(__dirname, "..", "..", "..", "..", "summaries");
    const jsonPath = path.join(outDir, `${dateStr}_nutrition_per_100g_export.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

    console.log("public recipes scanned:", publicRecipes.length);
    console.log("canonical_ingredients total:", allIngredientDocs.length);
    console.log("with nutrition_per_100g:", present.length);
    console.log("missing nutrition_per_100g:", missing.length);
    console.log("missing but referenced by >=1 recipe:", output.missingNutritionPer100g.referencedByAtLeastOneRecipe);
    console.log("missing and never referenced:", output.missingNutritionPer100g.neverReferenced);
    console.log("top 15 by referenceCount:");
    for (const item of missingSorted.slice(0, 15)) {
      console.log(`  ${item.referenceCount}\t${item.canonical_name}`);
    }
    console.log("wrote:", jsonPath);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("export failed:", err.message);
  process.exit(1);
});
