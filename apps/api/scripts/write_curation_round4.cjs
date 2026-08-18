// HANDOFF_canonical-ingredients-curation-round4-write.md — dry-run by default, --write to commit.
//
// §1 (19+ high-confidence density_cup/per_item_g/price+pack fixes) + §3 (judgment-call
// substitutes for kosher salt/jicama/dale's seasoning/etc, all pre-approved by Jackie per the
// handoff intro) + §4 (new standalone `hake` canonical_ingredients + canonical_price_cache
// entry, to break the fuzzy hake->sake collision).
//
// Follows write_curation_round3.cjs convention: before/after printed per doc, dry-run by
// default, costRecipe() before/after simulation using the SAME frozen recipe.ingredients[]
// (this only previews the coverage delta — the real recipe_cost recompute happens via
// POST /api/admin/recompute-costs?write=true after this script's --write run, per the
// handoff's explicit "trigger precomputeRecipeCosts only after all DB writes are done").
//
// IMPORTANT — schema note learned while building this script: costRecipe() does NOT read
// canonical_price_cache.cheapest.price directly. The actual per-line cost driver is
// per_unit_metric.value (price per gram/ml) or per_unit_count.value (price per each) — see
// assets/recipe_cost.service.js normalizeQty()/priceLine(). `cheapest` is display-only
// metadata (store/title shown on a priced line). So every price+pack correction below sets
// BOTH `cheapest` (for display) AND the matching per_unit_metric/per_unit_count (for the
// actual cost math) — computed as new_price / pack_size using the exact SKU pack size from
// the handoff where given, or a documented reasonable assumption (flagged via `curation_note`)
// where the handoff only gave a per-item/no-pack price (jicama, romaine lettuce twin-pack,
// lemon rind's whole-lemon proxy).
//
// A few items also get one field beyond the literal §1/§3 table entry, always because without
// it the price fix cannot actually take effect for how the ingredient is really used in
// recipes (checked via a live `recipes.ingredients.name`/`.unit` query before writing this
// script) — each such addition is called out in its `note` below:
//   - lemon rind: recipes use it exclusively as "1 teaspoon" (volume) but the CI doc has no
//     density_cup, so even a correct price would still hit `missing_density_cup`. Added a
//     conservative density_cup=48 (zest is very light, ~1g/tsp).
//   - persian cucumber / garlic clove: added the missing per_unit_count/per_item_g the
//     handoff explicitly asked for (§3), which the live schema confirms was genuinely absent.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_curation_round4.cjs            # dry run
//   node scripts/write_curation_round4.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

const WRITE = process.argv.includes("--write");

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

// ---- §1 + §3 canonical_ingredients ($set) updates ----
const CI_UPDATES = [
  { canonical_name: "juice of lemon", set: { density_cup: 244 }, note: "§1 USDA FDC 173944" },
  { canonical_name: "vanilla", set: { density_cup: 208 }, note: "§1 USDA FDC 173461" },
  { canonical_name: "cola (regular)", set: { density_cup: 246 }, note: "§1 USDA FDC 174852" },
  { canonical_name: "raspberries", set: { density_cup: 123 }, note: "§1 USDA FDC 167755" },
  { canonical_name: "basil leaves", set: { per_item_g: 0.5 }, note: "§1 USDA FDC 172232" },
  { canonical_name: "sesame oil", set: { density_cup: 218 }, note: "§1 USDA FDC 171016" },
  {
    canonical_name: "flour and 3 tbsp",
    set: { needs_reparse: true },
    note: "§3 parsing-artifact name — flag only, no density_cup/price applied (§3 supersedes the §1 table row for this entry; unpriceable-by-design until re-parsed)",
  },
  {
    canonical_name: "lemon rind",
    set: { density_cup: 48, curation_note: "zest is very light (~1g/tsp assumed); added beyond the §1 table because recipes use lemon rind exclusively in teaspoons — without density_cup the price fix can't take effect" },
    note: "§1 price+pack fix + supplementary density_cup (see script header)",
  },
  {
    canonical_name: "jicama",
    set: { is_specialty_import: true, curation_note: "specialty import item, no mainstream UK SKU" },
    note: "§3 judgment call",
  },
  { canonical_name: "unpasteurized shiro miso", set: { reference_pack: { qty: 200, unit: "g" } }, note: "§1 Ocado Miso Tasty actual pack size" },
  {
    canonical_name: "hardboiled quail eggs",
    set: { type: "C", display_unit: "pc", reference_pack: { qty: 12, unit: "each" } },
    note: "§1 was mis-typed as a weight pack; actually a 12-count pack",
  },
  { canonical_name: "cardamom seeds", set: { reference_pack: { qty: 30, unit: "g" } }, note: "§1 Tesco Whole Cardamom 30g" },
  { canonical_name: "water chestnuts", set: { reference_pack: { qty: 225, unit: "g" } }, note: "§1 Kingfisher Sliced Water Chestnuts actual pack" },
  { canonical_name: "fried garlic", set: { reference_pack: { qty: 140, unit: "g" } }, note: "§1 Sous Chef Crispy Fried Garlic actual pack" },
  { canonical_name: "saffron threads", set: { reference_pack: { qty: 0.4, unit: "g" } }, note: "§1 Waitrose Cooks' Ingredients Saffron actual pack" },
  { canonical_name: "garlic clove", set: { per_item_g: 4 }, note: "§3 judgment call" },
  {
    canonical_name: "dale's seasoning",
    set: { type: "L", display_unit: "ml", reference_pack: { qty: 290, unit: "ml" } },
    note: "§3 judgment call — Lea & Perrins Worcestershire Sauce substitute, liquid not solid",
  },
  { canonical_name: "liquid egg substitute", set: { reference_pack: { qty: 490, unit: "ml" } }, note: "§3 judgment call — Two Chicks Liquid Egg pack size" },
  { canonical_name: "sugar substitute", set: { density_cup: 110, source: "estimated_no_exact_fda_match" }, note: "§3 judgment call" },
  { canonical_name: "sweetner", set: { density_cup: 110, source: "estimated_no_exact_fda_match" }, note: "§3 judgment call" },
  { canonical_name: "garam masala", set: { density_cup: 120, source: "estimated_no_exact_fda_match" }, note: "§3 judgment call" },
  { canonical_name: "chilli flakes", set: { density_cup: 70, source: "estimated_no_exact_fda_match" }, note: "§3 judgment call" },
  { canonical_name: "dry white wine (e.g., pinot grigio)", set: { reference_pack: { qty: 750, unit: "ml" } }, note: "§3 judgment call — 75cl bottle" },
  { canonical_name: "herbs", set: { curation_note: "ambiguous_generic_term" }, note: "§3 judgment call" },
  {
    canonical_name: "safflower",
    set: { type: "L", display_unit: "ml", curation_note: "resolved_as_safflower_oil_no_spice_context" },
    note: "§3 judgment call",
  },
];

// ---- §1 + §3 canonical_price_cache ($set) updates ----
// Every entry sets `cheapest` (display) AND per_unit_metric or per_unit_count (actual cost
// driver — see script header). `confidence: "manual_curated"` marks these as hand-verified
// (distinct from the "high"/"low"/"price_only"/"none" values the Serper scraper writes), so a
// future scraper refresh doesn't silently look identical to a live-verified value.
const PC_UPDATES = [
  {
    canonical_name: "juice of lemon",
    set: {
      cheapest: { store: "Sainsbury's / Tesco", price: 0.87, title: "Jif Lemon 100% Lemon Juice 100ml", pack: { qty: 100, unit: "ml" } },
      per_unit_metric: { value: 0.0087, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "parmesan",
    set: {
      cheapest: { store: "Tesco", price: 2.8, title: "Tesco Parmigiano Reggiano 100G", pack: { qty: 100, unit: "g" } },
      per_unit_metric: { value: 0.028, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "lemon rind",
    set: {
      cheapest: { store: "Tesco (whole-lemon proxy)", price: 0.4, title: "Whole lemon (zest proxy, per lemon)", pack: { qty: 58, unit: "g" } },
      per_unit_metric: { value: 0.0069, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
      curation_note: "whole-lemon proxy per handoff §1 (same approach as lime zest); 58g = existing `lemon` canonical per_item_g",
    },
  },
  {
    canonical_name: "jicama",
    set: {
      cheapest: { store: "Specialty grocer (e.g. Sous Chef)", price: 3.5, title: "Jicama, whole (specialty import)", pack: { qty: 500, unit: "g" } },
      per_unit_metric: { value: 0.007, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
      curation_note: "handoff gave price per whole root only (£3-4/個); ~500g typical whole-jicama weight assumed to convert to per-gram price since recipes reference jicama in cup/g, not count — Jackie/cloud should sanity-check this weight assumption",
    },
  },
  {
    canonical_name: "romaine lettuce",
    set: {
      cheapest: { store: "Tesco / Sainsbury's", price: 1.25, title: "Romaine Lettuce Hearts Twin Pack", pack: { qty: 550, unit: "g" } },
      per_unit_metric: { value: 0.00227, unit: "g_or_ml", n: 1 },
      per_unit_count: { value: 0.625, unit: "each", n: 1 },
      confidence: "manual_curated",
      curation_note: "twin-pack total weight (~550g) assumed — handoff gave price range only, no pack weight; per_unit_count derived from same £1.25/2 hearts",
    },
  },
  {
    canonical_name: "thumb sized ginger",
    set: {
      cheapest: { store: "Tesco / Sainsbury's", price: 1.12, title: "Fresh root ginger (loose)", pack: { qty: 100, unit: "g" } },
      per_unit_metric: { value: 0.0112, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "unpasteurized shiro miso",
    set: {
      cheapest: { store: "Ocado", price: 4.15, title: "Miso Tasty Unpasteurised Shiro Miso 200g", pack: { qty: 200, unit: "g" } },
      per_unit_metric: { value: 0.02075, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "hardboiled quail eggs",
    set: {
      cheapest: { store: "Waitrose & Partners", price: 5, title: "Clarence Court Ready to Eat Quail Eggs, 12 pack", pack: { qty: 12, unit: "each" } },
      per_unit_count: { value: 0.4167, unit: "each", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "curry paste",
    set: {
      cheapest: { store: "sainsburys.co.uk", price: 3.35, title: "Patak's Mild Curry Spice Paste 283g", pack: { qty: 284, unit: "g" } },
      per_unit_metric: { value: 0.0118, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "saffron threads",
    set: {
      cheapest: { store: "Waitrose & Partners", price: 4.1, title: "Waitrose Cooks' Ingredients Saffron 0.4g", pack: { qty: 0.4, unit: "g" } },
      per_unit_metric: { value: 10.25, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "cardamom seeds",
    set: {
      cheapest: { store: "Tesco", price: 1.1, title: "Tesco Whole Cardamom 30G", pack: { qty: 30, unit: "g" } },
      per_unit_metric: { value: 0.0367, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "water chestnuts",
    set: {
      cheapest: { store: "Tesco", price: 1.15, title: "Kingfisher Sliced Water Chestnuts 225G", pack: { qty: 225, unit: "g" } },
      per_unit_metric: { value: 0.0051, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "baby carrots",
    set: {
      cheapest: { store: "Tesco", price: 1.5, title: "Tesco Mini Carrots 320G", pack: { qty: 320, unit: "g" } },
      per_unit_metric: { value: 0.0047, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "grain bread",
    set: {
      cheapest: { store: "Tesco", price: 1.8, title: "Tesco Finest Wholemeal Seeds & Grains 800G", pack: { qty: 800, unit: "g" } },
      per_unit_metric: { value: 0.00225, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "fried garlic",
    set: {
      cheapest: { store: "Sous Chef", price: 3.5, title: "Sous Chef Crispy Fried Garlic 140g", pack: { qty: 140, unit: "g" } },
      per_unit_metric: { value: 0.025, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "new potatoes",
    set: {
      cheapest: { store: "Sainsbury's", price: 2, title: "Sainsbury's Taste the Difference New Potatoes 450g", pack: { qty: 450, unit: "g" } },
      per_unit_metric: { value: 0.0044, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
      curation_note: "exact SKU/price NOT live-confirmed by CC (handoff flagged this explicitly) — Jackie/cloud should verify before treating as final",
    },
  },
  {
    canonical_name: "kosher salt",
    set: {
      cheapest: { store: "Tesco / Ocado", price: 2.35, title: "Maldon Sea Salt Flakes 250g", pack: { qty: 250, unit: "g" } },
      per_unit_metric: { value: 0.0094, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "persian cucumber",
    set: {
      cheapest: { store: "Waitrose / M&S", price: 0.45, title: "Mini Cucumbers Multipack (per cucumber)", pack: { qty: 1, unit: "each" } },
      per_unit_metric: { value: 0.0041, unit: "g_or_ml", n: 1 },
      per_unit_count: { value: 0.45, unit: "each", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "salt and pepper",
    set: {
      cheapest: { store: "nominal — pantry staple, not live-matched", price: 0.99, title: "Salt & pepper (nominal estimate; previously matched a £26.80 cutlery set)", pack: { qty: 50, unit: "g" } },
      per_unit_metric: { value: 0.02, unit: "g_or_ml", n: 1 },
      confidence: "manual_nominal",
      curation_note: "combo entry unsuited to live price matching — fixed nominal per-gram rate per handoff §3",
    },
  },
  {
    canonical_name: "salt and black pepper",
    set: {
      cheapest: { store: "nominal — pantry staple, not live-matched", price: 0.99, title: "Salt and black pepper (nominal estimate)", pack: { qty: 50, unit: "g" } },
      per_unit_metric: { value: 0.02, unit: "g_or_ml", n: 1 },
      confidence: "manual_nominal",
      curation_note: "same nominal-cost treatment as `salt and pepper` per handoff §3",
    },
  },
  {
    canonical_name: "monterrey jack and cheddar cheese",
    set: {
      cheapest: { store: "Ocado / Tesco", price: 2.75, title: "Cathedral City Grated Mature Cheddar 320g", pack: { qty: 320, unit: "g" } },
      per_unit_metric: { value: 0.0086, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "dale's seasoning",
    set: {
      cheapest: { store: "Tesco / Sainsbury's", price: 2, title: "Lea & Perrins Worcestershire Sauce 290ml", pack: { qty: 290, unit: "ml" } },
      per_unit_metric: { value: 0.0069, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "liquid egg substitute",
    set: {
      cheapest: { store: "Sainsbury's / Ocado", price: 3, title: "Two Chicks Free Range Liquid Egg 490ml", pack: { qty: 490, unit: "ml" } },
      per_unit_metric: { value: 0.0061, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "dry white wine (e.g., pinot grigio)",
    set: {
      cheapest: { store: "Tesco / Morrisons / Sainsbury's", price: 8.25, title: "Most Wanted Pinot Grigio 75cl", pack: { qty: 750, unit: "ml" } },
      per_unit_metric: { value: 0.011, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
  {
    canonical_name: "herbs",
    set: {
      cheapest: { store: "Tesco / Sainsbury's", price: 0.75, title: "Mixed Herbs 26g", pack: { qty: 26, unit: "g" } },
      per_unit_metric: { value: 0.0288, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
      curation_note: "replaced single-herb (thyme) mismatch with mixed-herbs proxy per handoff §3",
    },
  },
  {
    canonical_name: "safflower",
    set: {
      cheapest: { store: "Clearspring (specialty)", price: 11.28, title: "Clearspring Organic Safflower Oil 500ml", pack: { qty: 500, unit: "ml" } },
      per_unit_metric: { value: 0.02256, unit: "g_or_ml", n: 1 },
      confidence: "manual_curated",
    },
  },
];

// ---- §4: new standalone `hake` entry (does not exist yet — insert, not update) ----
const HAKE_CI_DOC = {
  canonical_name: "hake",
  aliases: ["hake"],
  type: "S",
  display_unit: "g",
  density_cup: null,
  per_item_g: null,
  is_combo: false,
  is_priceable: true,
  pantry_staple: false,
  recipe_count: 1,
  reference_pack: { qty: 300, unit: "g" },
  source: "manual_curation_round4",
  nutrition_per_100g: { kcal: 84, protein: 18.6, carbs: 0, fat: 0.9 },
  updated_at: new Date().toISOString(),
};
const HAKE_PC_DOC = {
  canonical_name: "hake",
  cheapest: { store: "Fishmonger / market average (manual estimate)", price: 2.7, title: "Hake Fillets, fresh (per 300g)", pack: { qty: 300, unit: "g" } },
  per_unit_metric: { value: 0.009, unit: "g_or_ml", n: 1 },
  per_unit_count: null,
  confidence: "manual_curated",
  curation_note: "§4 — new standalone entry to break the fuzzy hake->sake collision (sake itself is still unpriced); ~£8-10/kg market estimate",
};

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);
  console.log(`CI updates: ${CI_UPDATES.length}, PC updates: ${PC_UPDATES.length}, new hake entry: 1`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const ciCol = db.collection("canonical_ingredients");
    const pcCol = db.collection("canonical_price_cache");

    console.log("\n=== canonical_ingredients: BEFORE / AFTER ===");
    const ciNotFound = [];
    for (const u of CI_UPDATES) {
      const before = await ciCol.findOne({ canonical_name: u.canonical_name });
      if (!before) {
        ciNotFound.push(u.canonical_name);
        console.log(`  SKIP ${u.canonical_name}: not found in canonical_ingredients`);
        continue;
      }
      const beforeFields = {};
      for (const k of Object.keys(u.set)) beforeFields[k] = before[k] ?? null;
      console.log(`  ${u.canonical_name}: before=${JSON.stringify(beforeFields)} -> after=${JSON.stringify(u.set)} — ${u.note}`);
      if (WRITE) await ciCol.updateOne({ canonical_name: u.canonical_name }, { $set: u.set });
    }

    console.log("\n=== canonical_price_cache: BEFORE / AFTER ===");
    const pcNotFound = [];
    for (const u of PC_UPDATES) {
      const before = await pcCol.findOne({ canonical_name: u.canonical_name });
      if (!before) {
        pcNotFound.push(u.canonical_name);
        console.log(`  SKIP ${u.canonical_name}: not found in canonical_price_cache`);
        continue;
      }
      console.log(`  ${u.canonical_name}:`);
      console.log(`    before.cheapest=${JSON.stringify(before.cheapest)} before.per_unit_metric=${JSON.stringify(before.per_unit_metric)} before.per_unit_count=${JSON.stringify(before.per_unit_count)}`);
      console.log(`    after.cheapest=${JSON.stringify(u.set.cheapest)} after.per_unit_metric=${JSON.stringify(u.set.per_unit_metric)} after.per_unit_count=${JSON.stringify(u.set.per_unit_count || null)}`);
      if (WRITE) await pcCol.updateOne({ canonical_name: u.canonical_name }, { $set: u.set });
    }

    console.log("\n=== §4 new `hake` entry ===");
    const existingHakeCI = await ciCol.findOne({ canonical_name: "hake" });
    const existingHakePC = await pcCol.findOne({ canonical_name: "hake" });
    console.log(`  canonical_ingredients: ${existingHakeCI ? "ALREADY EXISTS — will skip insert" : "does not exist — will insert"}`);
    console.log(`  new doc: ${JSON.stringify(HAKE_CI_DOC, null, 2)}`);
    console.log(`  canonical_price_cache: ${existingHakePC ? "ALREADY EXISTS — will skip insert" : "does not exist — will insert"}`);
    console.log(`  new doc: ${JSON.stringify(HAKE_PC_DOC, null, 2)}`);
    if (WRITE) {
      if (!existingHakeCI) await ciCol.insertOne(HAKE_CI_DOC);
      if (!existingHakePC) await pcCol.insertOne(HAKE_PC_DOC);
    }

    if (ciNotFound.length > 0) console.log(`\n  CI NOT FOUND (skipped): ${ciNotFound.join(", ")}`);
    if (pcNotFound.length > 0) console.log(`  PC NOT FOUND (skipped): ${pcNotFound.join(", ")}`);

    // --- costRecipe() before/after simulation, same frozen recipe.ingredients[] snapshot ---
    console.log("\n=== costRecipe() simulation (no DB writes from this step) ===");
    const recipesCol = db.collection("recipes");
    const allRecipes = await recipesCol.find({}).toArray();
    const allIngredientDocs = await ciCol.find({}).toArray();
    const priceDocs = await pcCol.find({}).toArray();

    async function simulate(label, ingredientDocsOverride, priceDocsOverride) {
      const ingredientsMap = new Map(ingredientDocsOverride.map((d) => [d.canonical_name, d]));
      const priceMap = new Map(priceDocsOverride.map((d) => [d.canonical_name, d]));
      const nonQuarantined = ingredientDocsOverride.filter((d) => d.quarantine !== true);
      const fakeCol = { find: () => ({ project: () => ({ toArray: async () => nonQuarantined }) }) };
      const index = await buildAliasIndex(fakeCol);
      const resolveFn = (raw) => resolve(raw, index);
      let priceableLines = 0;
      let totalLines = 0;
      for (const r of allRecipes) {
        const result = costRecipe(r, resolveFn, ingredientsMap, priceMap, new Set());
        totalLines += result.totalLines;
        priceableLines += result.priceableCount;
      }
      console.log(`  ${label}: totalLines=${totalLines}, priceableCount=${priceableLines}, coverage=${((priceableLines / totalLines) * 100).toFixed(2)}%`);
      return { totalLines, priceableLines };
    }

    const before = await simulate("BEFORE (current live DB)", allIngredientDocs, priceDocs);

    const afterCI = allIngredientDocs.map((d) => ({ ...d }));
    for (const u of CI_UPDATES) {
      const d = afterCI.find((x) => x.canonical_name === u.canonical_name);
      if (d) Object.assign(d, u.set);
    }
    if (!existingHakeCI) afterCI.push({ ...HAKE_CI_DOC });

    const afterPC = priceDocs.map((d) => ({ ...d }));
    for (const u of PC_UPDATES) {
      const d = afterPC.find((x) => x.canonical_name === u.canonical_name);
      if (d) Object.assign(d, u.set);
    }
    if (!existingHakePC) afterPC.push({ ...HAKE_PC_DOC });

    const after = await simulate("AFTER (simulated with updates applied)", afterCI, afterPC);
    console.log(`\n  Delta: priceableCount ${before.priceableLines} -> ${after.priceableLines} (${after.priceableLines - before.priceableLines >= 0 ? "+" : ""}${after.priceableLines - before.priceableLines})`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
