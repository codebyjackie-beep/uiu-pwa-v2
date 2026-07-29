// One-off audit for HANDOFF_ai-meal-plan-generator.md follow-up: scan every
// public recipe's ingredients[].name and flag lines that don't look like
// English, so ALLERGEN_KEYWORDS (mealPlanGenerator.ts) can be extended with
// verified real-world spellings instead of guessed ones. Read-only — no DB
// writes. Prints a summary and writes the full raw list to the path given as
// argv[2] (JSON).
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

// Common French cooking/ingredient-label words that carry no accent, so the
// non-ASCII check alone would miss them (e.g. "oignon", "sel", "sucre").
// Deliberately conservative — short/ambiguous English words (e.g. "en", "de")
// are excluded to avoid false positives on legitimate English ingredient text.
// NOTE: deliberately excludes words that are also common English/international
// culinary terms (e.g. "sesame", "creme" as in creme fraiche, "cafe") — those
// caused false positives on the first pass of this audit (2026-07-29) when a
// diacritic-only check was also in play. Word-list membership is now the only
// signal; each entry here is unambiguous French (no legitimate English
// ingredient-label use).
const FRENCH_FOOD_WORDS = new Set([
  "oignon", "oignons", "sel", "sucre", "poudre", "huile", "farine", "epices",
  "aromatique", "naturel", "naturelle", "regulateur", "acidite", "epaississant",
  "colorant", "exhausteur", "gout", "extrait", "levure", "humectant", "contient",
  "antioxydant", "colza", "tournesol", "vegetale", "vegetales", "variable",
  "proportion", "iode", "iodee", "epaissi", "conservateur", "amidon", "gomme",
  "lait", "beurre", "fromage", "oeuf", "oeufs", "poisson", "arachide",
  "soja", "ble", "amande", "amandes", "noisette", "noisettes",
  "moutarde", "celeri", "sulfites", "mollusques", "crustaces", "lupin",
]);

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function classify(name) {
  const lower = name.toLowerCase();
  const words = stripDiacritics(lower)
    .replace(/[(),.]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const frenchWordHits = words.filter((w) => FRENCH_FOOD_WORDS.has(w));
  const looksForeign = frenchWordHits.length > 0;
  return { looksForeign, hasNonAscii: /[^\x00-\x7F]/.test(name), frenchWordHits, guessedLanguage: looksForeign ? "french" : null };
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("Usage: node audit_ingredient_language.cjs <output.json>");
    process.exit(1);
  }

  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const recipes = await db.collection("recipes").find({ isPublic: true }).toArray();
    console.log(`Scanned ${recipes.length} public recipes.`);

    const flaggedRecipes = [];
    let totalIngredientLines = 0;
    let flaggedIngredientLines = 0;

    for (const r of recipes) {
      const ingredients = Array.isArray(r.ingredients) ? r.ingredients : [];
      const flaggedLines = [];
      for (const ing of ingredients) {
        totalIngredientLines += 1;
        const name = String(ing?.name ?? "");
        if (!name) continue;
        const result = classify(name);
        if (result.looksForeign) {
          flaggedIngredientLines += 1;
          flaggedLines.push({ name, hasNonAscii: result.hasNonAscii, frenchWordHits: result.frenchWordHits });
        }
      }
      if (flaggedLines.length > 0) {
        flaggedRecipes.push({
          _id: r._id.toString(),
          title: r.title,
          source: r.source ?? null,
          sourcePlatform: r.sourcePlatform ?? null,
          sourceUrl: r.sourceUrl ?? null,
          totalIngredientLines: ingredients.length,
          flaggedIngredientLines: flaggedLines,
        });
      }
    }

    const sourceCounts = {};
    for (const fr of flaggedRecipes) {
      const key = `${fr.source ?? "null"} / ${fr.sourcePlatform ?? "null"}`;
      sourceCounts[key] = (sourceCounts[key] || 0) + 1;
    }

    const report = {
      scannedAt: new Date().toISOString(),
      totalPublicRecipes: recipes.length,
      totalIngredientLines,
      flaggedIngredientLines,
      flaggedRecipeCount: flaggedRecipes.length,
      flaggedRecipesBySource: sourceCounts,
      flaggedRecipes,
    };

    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log(`\nFlagged ${flaggedRecipes.length}/${recipes.length} recipes with ${flaggedIngredientLines}/${totalIngredientLines} non-English-looking ingredient lines.`);
    console.log("By source:", JSON.stringify(sourceCounts, null, 2));
    console.log(`\nFull raw report written to ${outPath}`);
    for (const fr of flaggedRecipes) {
      console.log(`\n  [${fr._id}] ${fr.title}  (source=${fr.source}, sourcePlatform=${fr.sourcePlatform})`);
      for (const line of fr.flaggedIngredientLines) {
        console.log(`    - "${line.name}"  nonAscii=${line.hasNonAscii}  frenchWords=[${line.frenchWordHits.join(", ")}]`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
