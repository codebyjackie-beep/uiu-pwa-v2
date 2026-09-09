// cc_prompt_canonical_skip_list_cleanup.md — 28-entry canonical_ingredients data cleanup
// (8 from round1 + 20 from round2 nutrition_per_100g work, deferred as an independent
// data-quality task per those handoffs).
//
// Per-entry classification (see summaries/2026-09-09_canonical-skip-list-cleanup.md for the
// full rationale table):
//   - QUARANTINE:    not food, too vague, brand-specific, or a merge of two foods whose real
//                     canonical entries already exist separately (so nothing is lost — the
//                     merged/garbage entry just stops being a live resolution target).
//   - RENAME+QUARANTINE: typo fixed for findability, but the corrected name is still too
//                     generic to price/nutrition confidently, so it stays quarantined too.
//   - SPLIT:          merge of two foods where at least one target canonical entry doesn't
//                     exist yet — create it (real nutrition_per_100g, density_cup/per_item_g),
//                     then quarantine the merged entry.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_skip_list_28_cleanup.cjs            # dry run
//   node scripts/write_skip_list_28_cleanup.cjs --write    # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

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

// -------------------- QUARANTINE-ONLY (existing doc, just set quarantine:true) --------------------
const QUARANTINE_ONLY = [
  { name: "skewers", reason: "not food (BBQ skewer sticks)" },
  { name: "sugar substitute", reason: "too vague, no specific product to price" },
  { name: "seasoning", reason: "too vague" },
  { name: "seafood seasoning", reason: "too vague" },
  { name: "honey or maple syrup", reason: "merge of 2 foods; 'honey' and 'maple syrup' already exist as separate priced/nutrition entries" },
  { name: "grape seed", reason: "too vague — likely meant 'grapeseed oil' (which already exists separately) but not confident enough to alias" },
  { name: "to 5 garlic cloves", reason: "recipe-parser fragment (likely 'X to 5 garlic cloves'), not a real ingredient name", flagParser: true },
  { name: "wooden skewers", reason: "not food" },
  { name: "i gem lettuce", reason: "garbled text, likely 'little gem lettuce' but not confident enough to rename; no existing canonical target anyway", flagParser: true },
  { name: "dale's seasoning", reason: "branded seasoning blend, no public standard nutrition/price value" },
  { name: "pcs lemon", reason: "recipe-parser fragment ('pcs' = pieces), not a real ingredient name", flagParser: true },
  { name: "you can use regular basil", reason: "recipe instruction text parsed as an ingredient name", flagParser: true },
  { name: "black bean burgers (store-bought or homemade)", reason: "brand/homemade variance too large for a single standard value" },
  { name: "water or vegetable broth", reason: "merge of 2 foods; 'water' and 'vegetable broth' already exist as separate priced/nutrition entries" },
  { name: "yoghurt sauce", reason: "too vague, unknown sauce base" },
  { name: "milk or chicken broth", reason: "merge of 2 foods; 'milk' and 'chicken broth' already exist as separate priced/nutrition entries" },
  { name: "maple syrup or honey", reason: "merge of 2 foods (same pair, reversed order, as 'honey or maple syrup'); both already exist separately" },
  { name: "white wine vinegar or lemon juice", reason: "merge of 2 foods; both already exist as separate priced/nutrition entries" },
  { name: "salt and black pepper", reason: "merge of 2 foods; both already exist as separate priced/nutrition entries" },
  { name: "grain tortillas", reason: "too vague ('grain' is not a standard tortilla category — not clearly corn or flour)" },
  { name: "cream of mushroom or chicken soup (condensed)", reason: "merge of 2 foods (same pair, reversed order, as 'cream of chicken or mushroom soup (condensed)'); split targets created by this same cleanup" },
];

// -------------------- RENAME + QUARANTINE (typo fix, but still too generic to price) ------------
const RENAME_QUARANTINE = [
  {
    name: "sweetner",
    newName: "sweetener",
    reason: "typo fix ('sweetner' -> 'sweetener') for findability, but 'sweetener' itself is still too generic to price/nutrition confidently (could mean sugar, stevia, aspartame — wildly different kcal) so it stays quarantined",
  },
];

// -------------------- SPLIT: new canonical entries to create, then quarantine the merge ----------
// nutrition_per_100g values are well-established USDA/standard reference figures for these foods
// (kcal, protein, carbs, fat).
const NEW_ENTRIES = [
  {
    canonical_name: "plain greek yogurt",
    nutrition_per_100g: { kcal: 59, protein: 10.2, carbs: 3.6, fat: 0.4 },
    density_cup: 245,
  },
  {
    canonical_name: "sour cream",
    nutrition_per_100g: { kcal: 198, protein: 2.4, carbs: 4.6, fat: 19.4 },
    density_cup: 230,
  },
  {
    canonical_name: "corn tortillas",
    nutrition_per_100g: { kcal: 218, protein: 5.7, carbs: 44.6, fat: 2.9 },
    per_item_g: 26,
  },
  {
    canonical_name: "flour tortillas",
    nutrition_per_100g: { kcal: 312, protein: 8.2, carbs: 50.6, fat: 8.0 },
    per_item_g: 45,
  },
  {
    canonical_name: "red pepper flakes",
    nutrition_per_100g: { kcal: 318, protein: 12.0, carbs: 56.6, fat: 17.3 },
    density_cup: 90,
  },
  {
    canonical_name: "cream of chicken soup (condensed)",
    nutrition_per_100g: { kcal: 111, protein: 2.9, carbs: 8.9, fat: 7.2 },
    per_item_g: 295,
  },
  {
    canonical_name: "cream of mushroom soup (condensed)",
    nutrition_per_100g: { kcal: 106, protein: 1.7, carbs: 8.8, fat: 7.6 },
    per_item_g: 295,
  },
  {
    canonical_name: "fresh dill",
    nutrition_per_100g: { kcal: 43, protein: 3.5, carbs: 7.0, fat: 1.1 },
    density_cup: 25,
  },
  {
    canonical_name: "single cream",
    nutrition_per_100g: { kcal: 198, protein: 2.7, carbs: 4.1, fat: 19.1 },
    density_cup: 240,
  },
  {
    canonical_name: "double cream",
    nutrition_per_100g: { kcal: 449, protein: 1.7, carbs: 2.7, fat: 48.0 },
    density_cup: 240,
  },
];

const SPLIT_MERGES = [
  { name: "plain greek yogurt or sour cream", targets: ["plain greek yogurt", "sour cream"] },
  { name: "corn or flour tortillas", targets: ["corn tortillas", "flour tortillas"] },
  { name: "sriracha or red pepper flakes", targets: ["sriracha", "red pepper flakes"] }, // sriracha already existed
  { name: "cream of chicken or mushroom soup (condensed)", targets: ["cream of chicken soup (condensed)", "cream of mushroom soup (condensed)"] },
  { name: "fresh parsley or dill", targets: ["fresh parsley, chopped", "fresh dill"] }, // "fresh parsley, chopped" already existed
  { name: "single or double cream", targets: ["single cream", "double cream"] },
];

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection("canonical_ingredients");

    console.log("\n=== 1. QUARANTINE-ONLY (21 entries) ===");
    for (const { name, reason, flagParser } of QUARANTINE_ONLY) {
      const before = await col.findOne({ canonical_name: name });
      if (!before) {
        console.log(`  SKIP "${name}": not found in DB`);
        continue;
      }
      console.log(`  "${name}" quarantine ${before.quarantine ?? false} -> true — ${reason}${flagParser ? " [FLAG: recipeImport.ts parser produced this]" : ""}`);
      if (WRITE) await col.updateOne({ canonical_name: name }, { $set: { quarantine: true } });
    }

    console.log("\n=== 2. RENAME + QUARANTINE (1 entry) ===");
    for (const { name, newName, reason } of RENAME_QUARANTINE) {
      const before = await col.findOne({ canonical_name: name });
      if (!before) {
        console.log(`  SKIP "${name}": not found in DB`);
        continue;
      }
      const aliases = Array.from(new Set([...(before.aliases ?? []), before.canonical_name, name]));
      console.log(`  "${name}" -> canonical_name="${newName}", quarantine true, aliases=${JSON.stringify(aliases)} — ${reason}`);
      if (WRITE) {
        await col.updateOne({ canonical_name: name }, { $set: { canonical_name: newName, quarantine: true, aliases } });
      }
    }

    console.log("\n=== 3. CREATE new split-target canonical entries (10 entries) ===");
    for (const entry of NEW_ENTRIES) {
      const existing = await col.findOne({ canonical_name: entry.canonical_name });
      if (existing) {
        console.log(`  SKIP CREATE "${entry.canonical_name}": already exists (unexpected — check manually)`);
        continue;
      }
      const doc = {
        canonical_name: entry.canonical_name,
        aliases: [entry.canonical_name],
        quarantine: false,
        nutrition_per_100g: entry.nutrition_per_100g,
        density_cup: entry.density_cup ?? null,
        per_item_g: entry.per_item_g ?? null,
      };
      console.log(`  CREATE "${entry.canonical_name}": ${JSON.stringify(doc)}`);
      if (WRITE) await col.insertOne(doc);
    }

    console.log("\n=== 4. QUARANTINE merged entries whose split targets now exist (6 entries) ===");
    for (const { name, targets } of SPLIT_MERGES) {
      const before = await col.findOne({ canonical_name: name });
      if (!before) {
        console.log(`  SKIP "${name}": not found in DB`);
        continue;
      }
      console.log(`  "${name}" quarantine ${before.quarantine ?? false} -> true — split into ${JSON.stringify(targets)}`);
      if (WRITE) await col.updateOne({ canonical_name: name }, { $set: { quarantine: true } });
    }

    const totalQuarantined = QUARANTINE_ONLY.length + RENAME_QUARANTINE.length + SPLIT_MERGES.length;
    console.log(`\n=== Summary ===`);
    console.log(`  Entries quarantined: ${totalQuarantined} (should be 28: 21 quarantine-only + 1 rename+quarantine + 6 split-merge)`);
    console.log(`  New canonical entries created: ${NEW_ENTRIES.length}`);

    const totalDocs = await col.countDocuments({});
    const totalQuarantinedNow = await col.countDocuments({ quarantine: true });
    console.log(`  canonical_ingredients total: ${totalDocs}, quarantined total: ${totalQuarantinedNow}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
