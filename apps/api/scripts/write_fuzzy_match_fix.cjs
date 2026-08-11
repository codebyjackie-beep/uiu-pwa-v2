// HANDOFF_resolver-fuzzy-match-fix.md — dry-run by default, --write to commit.
// Source data: assets/fuzzy_match_fix_updates.json (Jackie-reviewed before write).
//
// Three independent changes against canonical_ingredients:
//   1. 4 new known_gap stub docs (beef/custard/rapeseed oil/sake) — currently
//      have NO canonical entry at all, so raw text for them falls through to
//      fuzzy match and lands on an unrelated real ingredient (beer/mustard/
//      grapeseed oil/sage). Adding the stub gives resolver an exact match that
//      correctly reports "known_gap" (honest no-price) instead of a wrong price.
//   2. Rename "blacks olives" -> "black olives" (existing canonical_name was
//      simply mistyped, which is why raw "black olives" text fell through to
//      fuzzy match in the first place). Old spelling kept as an alias.
//   3. 17 alias additions on existing canonical docs, for raw-text spelling
//      variants that are unambiguously the same ingredient (already fuzzy-
//      matching correctly today) — this only changes match METHOD
//      (fuzzy -> exact), not the resolved canonical_name, so it cannot change
//      any recipe's cost.
//
// NOTE: raw "black olives" text (one of the audit's 22 fuzzy pairs) is
// deliberately NOT in aliasAdditions — once step 2 renames the canonical_name
// itself to "black olives", that raw text resolves via exact match on the
// canonical_name automatically (buildAliasIndex indexes canonical_name as a
// key too), so a redundant alias would add nothing.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_fuzzy_match_fix.cjs            # dry run
//   node scripts/write_fuzzy_match_fix.cjs --write     # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

const WRITE = process.argv.includes("--write");
const UPDATES_PATH = path.resolve(__dirname, "../../../../assets/fuzzy_match_fix_updates.json");

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
  const updates = JSON.parse(fs.readFileSync(UPDATES_PATH, "utf8"));
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const ciCol = db.collection("canonical_ingredients");
    const priceCacheCol = db.collection("canonical_price_cache");

    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);
    const now = new Date().toISOString();

    // --- 1. New known_gap stubs ---
    console.log("\n=== 1. New known_gap stub docs ===");
    for (const s of updates.newStubs) {
      const existing = await ciCol.findOne({ canonical_name: s.canonical_name });
      if (existing) {
        console.log(`  SKIP ${s.canonical_name}: already exists (unexpected — not creating stub)`);
        continue;
      }
      const doc = {
        canonical_name: s.canonical_name,
        aliases: [],
        density_cup: null,
        display_unit: null,
        is_combo: false,
        is_priceable: true,
        pantry_staple: false,
        per_item_g: null,
        recipe_count: s.recipe_count,
        reference_pack: null,
        source: "seed",
        type: s.type,
        updated_at: now,
        known_gap: true,
        known_gap_reason: "pending_curation",
      };
      console.log(`  ${WRITE ? "INSERT" : "WOULD INSERT"} ${s.canonical_name}:`, JSON.stringify(doc));
      if (WRITE) await ciCol.insertOne(doc);
    }

    // --- 2. Rename blacks olives -> black olives ---
    console.log("\n=== 2. Rename typo ===");
    const { from, to, addAlias } = updates.rename;
    const beforeDoc = await ciCol.findOne({ canonical_name: from });
    console.log(`  BEFORE ${from}:`, JSON.stringify(beforeDoc));
    if (WRITE && beforeDoc) {
      await ciCol.updateOne({ canonical_name: from }, { $set: { canonical_name: to }, $addToSet: { aliases: addAlias } });
    }
    const afterDoc = WRITE ? await ciCol.findOne({ canonical_name: to }) : null;
    console.log(`  ${WRITE ? "AFTER" : "WOULD RESULT IN"} ${to}:`, WRITE ? JSON.stringify(afterDoc) : JSON.stringify({ ...beforeDoc, canonical_name: to, aliases: Array.from(new Set([...(beforeDoc?.aliases || []), addAlias])) }));

    if (updates.rename.renamePriceCacheToo) {
      console.log(`\n  ADDED FINDING: canonical_price_cache is keyed by canonical_name text too.`);
      const priceBefore = await priceCacheCol.findOne({ canonical_name: from });
      const priceCollision = await priceCacheCol.findOne({ canonical_name: to });
      console.log(`  canonical_price_cache doc for "${from}" exists: ${!!priceBefore} (cheapest: ${priceBefore ? JSON.stringify(priceBefore.cheapest) : "n/a"})`);
      console.log(`  canonical_price_cache doc for "${to}" already exists (would collide): ${!!priceCollision}`);
      console.log(`  ${WRITE ? "RENAMING" : "WOULD RENAME"} canonical_price_cache doc "${from}" -> "${to}" too, to keep the price join intact.`);
      if (WRITE && priceBefore && !priceCollision) {
        await priceCacheCol.updateOne({ canonical_name: from }, { $set: { canonical_name: to } });
      }
    }

    // --- 3. Alias additions ---
    console.log("\n=== 3. Alias additions (17) ===");
    for (const a of updates.aliasAdditions) {
      const doc = await ciCol.findOne({ canonical_name: a.canonical_name });
      if (!doc) {
        console.log(`  SKIP ${a.canonical_name}: doc not found`);
        continue;
      }
      const already = (doc.aliases || []).includes(a.addAlias);
      console.log(`  ${a.canonical_name}: aliases before=${JSON.stringify(doc.aliases)} ${already ? "(already has it, no-op)" : `-> add "${a.addAlias}"`}`);
      if (WRITE && !already) {
        await ciCol.updateOne({ canonical_name: a.canonical_name }, { $addToSet: { aliases: a.addAlias } });
      }
    }

    // --- costRecipe() simulation against live recipes, using the index AS IF updates applied ---
    console.log("\n=== costRecipe() simulation (no DB writes from this step) ===");
    const recipesCol = db.collection("recipes");
    const priceCol = db.collection("canonical_price_cache");
    const allRecipes = await recipesCol.find({}).toArray();
    const allIngredientDocs = await ciCol.find({}).toArray();
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));

    // "after" priceMap also reflects the price-cache rename (see step 2 finding above).
    const priceMapAfter = new Map(priceMap);
    if (updates.rename.renamePriceCacheToo) {
      const oldEntry = priceMapAfter.get(updates.rename.from);
      if (oldEntry) {
        priceMapAfter.delete(updates.rename.from);
        priceMapAfter.set(updates.rename.to, { ...oldEntry, canonical_name: updates.rename.to });
      }
    }

    async function simulate(label, ingredientDocsOverride, priceMapOverride) {
      const ingredientsMap = new Map(ingredientDocsOverride.map((d) => [d.canonical_name, d]));
      const nonQuarantined = ingredientDocsOverride.filter((d) => d.quarantine !== true);
      const fakeCol = { find: () => ({ project: () => ({ toArray: async () => nonQuarantined }) }) };
      const index = await buildAliasIndex(fakeCol);
      const resolveFn = (raw) => resolve(raw, index);
      const pm = priceMapOverride || priceMap;
      let priceableLines = 0;
      let totalLines = 0;
      const perLine = new Map(); // "recipeId:index" -> {priceable, canonical_name}
      for (const r of allRecipes) {
        const result = costRecipe(r, resolveFn, ingredientsMap, pm, new Set());
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

    // Build an in-memory "after" doc set reflecting all 3 changes, without writing.
    const afterDocs = allIngredientDocs.map((d) => ({ ...d }));
    for (const s of updates.newStubs) {
      if (!afterDocs.some((d) => d.canonical_name === s.canonical_name)) {
        afterDocs.push({
          canonical_name: s.canonical_name,
          aliases: [],
          density_cup: null,
          per_item_g: null,
          recipe_count: s.recipe_count,
          known_gap: true,
        });
      }
    }
    const renamed = afterDocs.find((d) => d.canonical_name === updates.rename.from);
    if (renamed) {
      renamed.canonical_name = updates.rename.to;
      renamed.aliases = Array.from(new Set([...(renamed.aliases || []), updates.rename.addAlias]));
    }
    for (const a of updates.aliasAdditions) {
      const d = afterDocs.find((x) => x.canonical_name === a.canonical_name);
      if (d) d.aliases = Array.from(new Set([...(d.aliases || []), a.addAlias]));
    }
    const after = await simulate("AFTER (simulated with updates applied, INCLUDING price-cache rename)", afterDocs, priceMapAfter);
    const afterNoPriceCacheFix = await simulate("AFTER but WITHOUT price-cache rename (shows the regression if step 2's addendum is skipped)", afterDocs, priceMap);

    console.log(`\n  Delta: priceableCount ${before.priceableLines} -> ${after.priceableLines} (${after.priceableLines - before.priceableLines >= 0 ? "+" : ""}${after.priceableLines - before.priceableLines})`);

    console.log("\n  Per-line changes (priceable flipped, or canonical_name changed):");
    const newCollisions = [];
    for (const [key, b] of before.perLine) {
      const a = after.perLine.get(key);
      if (!a) continue;
      if (a.priceable !== b.priceable || a.canonical_name !== b.canonical_name) {
        console.log(`    ${key} raw="${b.rawName}": canonical ${b.canonical_name}->${a.canonical_name}, priceable ${b.priceable}->${a.priceable} (reason: ${b.reason}->${a.reason})`);
        const isStubName = updates.newStubs.some((s) => s.canonical_name === a.canonical_name);
        if (isStubName && b.canonical_name !== a.canonical_name && a.reason === "known_gap" && b.reason === "unresolved") {
          newCollisions.push({ rawName: b.rawName, newCanonical: a.canonical_name });
        }
      }
    }
    if (newCollisions.length > 0) {
      console.log("\n  ADDED FINDING: new stub canonical_names introduce NEW fuzzy-match collisions that");
      console.log("  didn't exist before (raw text that was previously 'unresolved' now fuzzy-matches");
      console.log("  the new stub). Currently zero-cost (stub is known_gap, unpriceable), but if that");
      console.log("  stub ever gets a real price later without also fixing the underlying collision,");
      console.log("  this raw text would silently start using the wrong price — same failure class this");
      console.log("  whole handoff exists to fix. Flagging for awareness, NOT fixing (out of scope —");
      console.log("  resolver algorithm itself is explicitly untouched per handoff):");
      for (const c of newCollisions) console.log(`    "${c.rawName}" now fuzzy-matches new stub "${c.newCanonical}"`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
