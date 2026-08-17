// HANDOFF_canonical-ingredients-curation-round4-export.md — pure export, no
// research, no writes. §1 unpriceable ingredients (all public recipes) by
// reference count, §2 garlic vs garlic clove, §3 sake/hake follow-up.
// §4 (fuzzy-match audit rerun) is handled by run_round4_fuzzy_audit.cjs,
// which reuses audit_resolver_fuzzy_match.cjs verbatim.
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

const REQUIRED_TERMS = [
  "spaghetti", "water chestnuts", "hardboiled quail eggs", "sugar substitute",
  "ground ginger", "vanilla", "cayenne", "daikon radish", "enoki mushrooms",
  "chia seeds", "tamari sauce", "snow peas", "garlic clove",
];

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

    // ---- §1: unpriceable raw ingredient text, grouped, sorted by reference count ----
    const byRawText = new Map(); // rawName (lowercased, trimmed) -> { rawName, canonical_name, recipeTitles:Set, count }
    for (const r of publicRecipes) {
      const cost = costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      const ingredientLines = r.ingredients || [];
      for (let i = 0; i < ingredientLines.length; i += 1) {
        const line = cost.lines[i];
        if (!line || line.priceable) continue; // only unpriceable
        const rawName = ingredientLines[i].name;
        const key = String(rawName || "").toLowerCase().trim();
        if (!key) continue;
        let entry = byRawText.get(key);
        if (!entry) {
          entry = {
            rawText: rawName,
            resolvedCanonicalName: line.canonical_name || "UNRESOLVED",
            reason: line.reason || null,
            referenceCount: 0,
            recipeTitles: new Set(),
          };
          byRawText.set(key, entry);
        }
        entry.referenceCount += 1;
        entry.recipeTitles.add(r.title);
      }
    }

    const unpriceableIngredients = [...byRawText.values()]
      .sort((a, b) => b.referenceCount - a.referenceCount)
      .map((entry) => {
        const canonicalDoc = entry.resolvedCanonicalName !== "UNRESOLVED"
          ? ingredientsMap.get(entry.resolvedCanonicalName) || null
          : null;
        const priceDoc = entry.resolvedCanonicalName !== "UNRESOLVED"
          ? priceMap.get(entry.resolvedCanonicalName) || null
          : null;
        return {
          rawText: entry.rawText,
          resolvedCanonicalName: entry.resolvedCanonicalName,
          reason: entry.reason,
          referenceCount: entry.referenceCount,
          sampleRecipeTitles: [...entry.recipeTitles].slice(0, 10),
          canonical_ingredients_doc: canonicalDoc,
          canonical_price_cache_doc: priceDoc,
        };
      });

    const foundTerms = new Set(unpriceableIngredients.map((e) => e.rawText.toLowerCase().trim()));
    const missingRequiredTerms = REQUIRED_TERMS.filter((term) => {
      // required terms may appear as a substring within a longer raw ingredient line
      return ![...foundTerms].some((raw) => raw.includes(term));
    });

    // ---- §2: garlic vs garlic clove ----
    const garlicDoc = await ciCol.findOne({ canonical_name: "garlic" });
    const garlicCloveDoc = await ciCol.findOne({ canonical_name: "garlic clove" });
    const garlicCloveResolve = resolveFn("garlic clove");

    function recipesUsingRawText(needle) {
      const titles = [];
      for (const r of publicRecipes) {
        const ingredientLines = r.ingredients || [];
        if (ingredientLines.some((ing) => String(ing.name || "").toLowerCase().trim() === needle)) {
          titles.push(r.title);
        }
      }
      return titles;
    }

    const garlicSection = {
      garlic_canonical_doc: garlicDoc || null,
      garlic_clove_canonical_doc: garlicCloveDoc || null,
      garlic_clove_live_resolve: garlicCloveResolve,
      recipesUsingRawText_garlic: recipesUsingRawText("garlic"),
      recipesUsingRawText_garlicClove: recipesUsingRawText("garlic clove"),
    };

    // ---- §3: sake/hake ----
    const sakeDoc = await ciCol.findOne({ canonical_name: "sake" });
    const hakeDoc = await ciCol.findOne({ canonical_name: "hake" });
    const sakePriceDoc = await priceCol.findOne({ canonical_name: "sake" });
    const hakePriceDoc = await priceCol.findOne({ canonical_name: "hake" });
    const sakeResolve = resolveFn("sake");
    const hakeResolve = resolveFn("hake");

    const sakeHakeSection = {
      sake_canonical_doc: sakeDoc || null,
      hake_canonical_doc: hakeDoc || null,
      sake_price_cache_doc: sakePriceDoc || null,
      hake_price_cache_doc: hakePriceDoc || null,
      sake_live_resolve: sakeResolve,
      hake_live_resolve: hakeResolve,
      recipesUsingRawText_sake: recipesUsingRawText("sake"),
      recipesUsingRawText_hake: recipesUsingRawText("hake"),
    };

    const output = {
      generatedAt: new Date().toISOString(),
      productionSnapshot: {
        canonical_ingredients_count: allIngredientDocs.length,
        recipes_public: publicRecipes.length,
      },
      section1_unpriceableIngredients: {
        totalCount: unpriceableIngredients.length,
        missingRequiredTerms,
        items: unpriceableIngredients,
      },
      section2_garlicVsGarlicClove: garlicSection,
      section3_sakeHake: sakeHakeSection,
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(__dirname, "..", "..", "..", "..", "summaries");
    const jsonPath = path.join(outDir, `${dateStr}_curation_round4_export.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

    console.log("public recipes scanned:", publicRecipes.length);
    console.log("unpriceable raw ingredient texts:", unpriceableIngredients.length);
    console.log("missing required terms (should be empty):", missingRequiredTerms);
    console.log("garlic doc exists:", !!garlicDoc, "| garlic clove doc exists:", !!garlicCloveDoc);
    console.log("garlic clove live resolve:", JSON.stringify(garlicCloveResolve));
    console.log("sake doc exists:", !!sakeDoc, "| hake doc exists:", !!hakeDoc);
    console.log("sake live resolve:", JSON.stringify(sakeResolve));
    console.log("hake live resolve:", JSON.stringify(hakeResolve));
    console.log("wrote:", jsonPath);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("export failed:", err.message);
  process.exit(1);
});
