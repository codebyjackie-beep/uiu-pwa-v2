// HANDOFF_canonical-ingredients-curation-round3-write.md — dry-run by default, --write to commit.
// Source data: assets/curation_round3_updates.json (Jackie sign-off already given on the 12 values
// per the handoff; this script re-prints a final before/after per house convention before writing).
//
// Follows the write_conversion_curation.cjs convention of separating "fill" (existing field was
// null) from "correction" (existing field already had a different value) updates, since corrections
// carry higher risk and need explicit call-out.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_curation_round3.cjs            # dry run
//   node scripts/write_curation_round3.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

const WRITE = process.argv.includes("--write");
const UPDATES_PATH = path.resolve(__dirname, "../../../../assets/curation_round3_updates.json");

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
  const { updates } = JSON.parse(fs.readFileSync(UPDATES_PATH, "utf8"));
  console.log(`Loaded ${updates.length} canonical_name updates from ${UPDATES_PATH}`);
  console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const ciCol = db.collection("canonical_ingredients");

    console.log("\n=== BEFORE / AFTER per doc ===");
    const fillLog = [];
    const correctionLog = [];
    const notFound = [];

    for (const u of updates) {
      const before = await ciCol.findOne({ canonical_name: u.canonical_name });
      if (!before) {
        notFound.push(u.canonical_name);
        console.log(`  SKIP ${u.canonical_name}: not found in DB`);
        continue;
      }
      const beforeFields = {};
      const afterFields = {};
      for (const k of Object.keys(u.set)) {
        beforeFields[k] = before[k] ?? null;
        afterFields[k] = u.set[k];
      }
      console.log(`  ${u.canonical_name} [${u.kind}]: before=${JSON.stringify(beforeFields)} -> after=${JSON.stringify(afterFields)}${u.note ? ` — ${u.note}` : ""}`);
      if (u.kind === "correction" || u.kind === "mixed") correctionLog.push(u);
      else fillLog.push(u);

      if (WRITE) {
        await ciCol.updateOne({ canonical_name: u.canonical_name }, { $set: u.set });
      }
    }

    console.log(`\n  NULL-FILL updates: ${fillLog.length} (${fillLog.map((u) => u.canonical_name).join(", ")})`);
    console.log(`  CORRECTION updates (pre-existing non-null values changed): ${correctionLog.length} (${correctionLog.map((u) => u.canonical_name).join(", ")})`);
    if (notFound.length > 0) console.log(`  NOT FOUND: ${notFound.join(", ")}`);

    // --- costRecipe() simulation: before vs after, using in-memory doc overrides ---
    console.log("\n=== costRecipe() simulation (no DB writes from this step) ===");
    const recipesCol = db.collection("recipes");
    const priceCol = db.collection("canonical_price_cache");
    const allRecipes = await recipesCol.find({}).toArray();
    const allIngredientDocs = await ciCol.find({}).toArray();
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));

    async function simulate(label, ingredientDocsOverride) {
      const ingredientsMap = new Map(ingredientDocsOverride.map((d) => [d.canonical_name, d]));
      const nonQuarantined = ingredientDocsOverride.filter((d) => d.quarantine !== true);
      const fakeCol = { find: () => ({ project: () => ({ toArray: async () => nonQuarantined }) }) };
      const index = await buildAliasIndex(fakeCol);
      const resolveFn = (raw) => resolve(raw, index);
      let priceableLines = 0;
      let totalLines = 0;
      const perLine = new Map();
      for (const r of allRecipes) {
        const result = costRecipe(r, resolveFn, ingredientsMap, priceMap, new Set());
        totalLines += result.totalLines;
        priceableLines += result.priceableCount;
        result.lines.forEach((l, i) => {
          perLine.set(`${r._id}:${i}`, { priceable: l.priceable, canonical_name: l.canonical_name, rawName: l.rawName, reason: l.reason });
        });
      }
      console.log(`  ${label}: totalLines=${totalLines}, priceableCount=${priceableLines}, coverage=${((priceableLines / totalLines) * 100).toFixed(2)}%`);
      return { totalLines, priceableLines, perLine };
    }

    const before = await simulate("BEFORE (current live DB)", allIngredientDocs);

    const afterDocs = allIngredientDocs.map((d) => ({ ...d }));
    for (const u of updates) {
      const d = afterDocs.find((x) => x.canonical_name === u.canonical_name);
      if (d) Object.assign(d, u.set);
    }
    const after = await simulate("AFTER (simulated with updates applied)", afterDocs);

    console.log(`\n  Delta: priceableCount ${before.priceableLines} -> ${after.priceableLines} (${after.priceableLines - before.priceableLines >= 0 ? "+" : ""}${after.priceableLines - before.priceableLines})`);

    console.log("\n  Per-line changes (reason changed, i.e. missing_density_cup/missing_per_item_g -> priceable):");
    for (const [key, b] of before.perLine) {
      const a = after.perLine.get(key);
      if (!a) continue;
      if (a.priceable !== b.priceable) {
        console.log(`    ${key} raw="${b.rawName}" canonical=${b.canonical_name}: priceable ${b.priceable}->${a.priceable} (reason: ${b.reason}->${a.reason})`);
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
