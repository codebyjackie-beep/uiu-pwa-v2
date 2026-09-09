// cc_prompt_recipe_drafts_fragment_retroactive_cleanup.md (2026-09-09) — retroactive cleanup
// of production recipe_drafts with fragment-like ingredient names, per fresh scan via
// scan_drafts_fragment_names.cjs (see summaries/2026-09-09_drafts-fragment-scan-raw.json).
//
// Fresh scan found 23 pending drafts (all daily-agent origin, importMethod=undefined),
// all with exactly one of two fragment strings, both already quarantined in
// canonical_ingredients as of the earlier parser-fragment fix (commit 45ed583):
//   "to 5 garlic cloves" (17 drafts)
//   "a onion"            (7 drafts, one draft has both -> 23 total draft hits)
// Confidence: HIGH for all 23 — in every hit, quantity/unit are already separate, sane
// numeric/string fields (the fragment text is confined to `name`), so this is a pure
// name substitution, no quantity/unit surgery needed. No draft in this batch needed reject.
//
// Usage: node scripts/fix_drafts_fragment_names.cjs [--write]
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, idx)] = value;
  }
  return env;
}

const RENAME_MAP = {
  "to 5 garlic cloves": "garlic cloves",
  "a onion": "onion",
};

(async () => {
  const env = loadDevVars();
  console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

  const scanPath = path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-09_drafts-fragment-scan-raw.json");
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
  console.log(`Loaded scan: ${scan.hitCount} hits from ${scan.scannedAt}`);

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const col = db.collection("recipe_drafts");

  const results = [];
  for (const hit of scan.hits) {
    const unmapped = hit.fragmentNames.filter((n) => !(n in RENAME_MAP));
    if (unmapped.length > 0) {
      console.log(`REJECT-CANDIDATE ${hit._id}: no confident mapping for ${JSON.stringify(unmapped)} — skipping (needs manual review, not in this batch's confident-fix map)`);
      results.push({ _id: hit._id, action: "skip-no-mapping", unmapped });
      continue;
    }

    const before = await col.findOne({ _id: new ObjectId(hit._id) });
    if (!before) {
      console.log(`SKIP ${hit._id}: not found in DB (already handled?)`);
      continue;
    }
    if (before.status !== "pending") {
      console.log(`SKIP ${hit._id}: status is now "${before.status}", not "pending" — skipping (already decided)`);
      continue;
    }

    const newIngredients = (before.ingredients || []).map((ing) => {
      if (ing && typeof ing.name === "string" && ing.name in RENAME_MAP) {
        return { ...ing, name: RENAME_MAP[ing.name] };
      }
      return ing;
    });

    const beforeNames = (before.ingredients || []).map((i) => i.name);
    const afterNames = newIngredients.map((i) => i.name);
    console.log(`\nFIX ${hit._id} "${before.title}"`);
    console.log(`  before: ${JSON.stringify(beforeNames)}`);
    console.log(`  after:  ${JSON.stringify(afterNames)}`);

    results.push({ _id: hit._id, action: "fix", title: before.title, beforeNames, afterNames });

    if (WRITE) {
      await col.updateOne({ _id: new ObjectId(hit._id), status: "pending" }, { $set: { ingredients: newIngredients } });
    }
  }

  console.log(`\n=== Summary: ${results.filter((r) => r.action === "fix").length} fixed, ${results.filter((r) => r.action === "skip-no-mapping").length} skipped (no mapping) ===`);

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", `2026-09-09_drafts-fragment-fix-${WRITE ? "write" : "dryrun"}.json`),
    JSON.stringify({ mode: WRITE ? "write" : "dryrun", ranAt: new Date().toISOString(), results }, null, 2)
  );

  await client.close();
})();
