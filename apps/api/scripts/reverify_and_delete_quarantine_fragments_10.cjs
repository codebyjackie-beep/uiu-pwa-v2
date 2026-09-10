// cc_prompt_canonical_quarantine_instruction_fragment_cleanup_round2 (2026-09-10)
// Re-confirms the 10 target quarantine:true canonical_ingredients entries (from the
// 09-10 round-1 scan) are STILL quarantine:true with ZERO live references, this time
// querying recipes, recipe_drafts, AND recipe_cost (closing the gap flagged from
// round 1, where recipe_cost was claimed-checked but never actually queried by script).
// Explicitly EXCLUDES "i gem lettuce" (6a5d33c5f92108b016eded8d) — known live reference,
// skip per Jackie's standing decision.
// Default = dry-run (verify + backup only). Pass --write to actually delete.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

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

const TARGET_IDS = [
  "6a5d33b7f92108b016edebae", // add chicken and stir until it melts
  "6a5d33b8f92108b016edebc7", // a onion
  "6a5d33bbf92108b016edec40", // to 5 garlic cloves
  "6a5d33c2f92108b016eded26", // to 3 chilli padis
  "6a5d33bef92108b016edec9f", // t cream
  "6a5d33b7f92108b016edebab", // pcs lemon
  "6a5d33c1f92108b016edecf8", // p of pepper
  "6a5d33c2f92108b016eded23", // to 4 japanese cucumbers
  "6a5d33ccf92108b016edee6f", // you can use regular basil
  "6a5d33c6f92108b016ededa7", // a apple
];

const EXCLUDED_ID = "6a5d33c5f92108b016eded8d"; // i gem lettuce — must never be touched

const WRITE = process.argv.includes("--write");

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const canonicalCol = db.collection("canonical_ingredients");
  const recipesCol = db.collection("recipes");
  const draftsCol = db.collection("recipe_drafts");
  const costCol = db.collection("recipe_cost");

  // Safety: confirm excluded id is not accidentally in target list
  if (TARGET_IDS.includes(EXCLUDED_ID)) {
    console.error("FATAL: excluded id 'i gem lettuce' is present in TARGET_IDS. Aborting.");
    await client.close();
    process.exit(1);
  }

  const objIds = TARGET_IDS.map((id) => new ObjectId(id));
  const docs = await canonicalCol.find({ _id: { $in: objIds } }).toArray();
  console.log(`Found ${docs.length} of ${TARGET_IDS.length} target docs in canonical_ingredients.`);
  if (docs.length !== TARGET_IDS.length) {
    console.error("MISMATCH: not all target ids found (may have been deleted/changed already). Aborting without deleting.");
    console.error("Missing:", TARGET_IDS.filter((id) => !docs.some((d) => d._id.toString() === id)));
    await client.close();
    process.exit(1);
  }

  const results = [];
  for (const entry of docs) {
    const idStr = entry._id.toString();
    const nameLower = String(entry.canonical_name).toLowerCase().trim();

    if (entry.quarantine !== true) {
      console.warn(`  WARNING: _id=${idStr} canonical_name=${JSON.stringify(entry.canonical_name)} quarantine=${entry.quarantine} (NOT true anymore!)`);
    }

    const recipesMatches = await recipesCol
      .find(
        {
          $or: [
            { "ingredients.canonicalId": idStr },
            { "ingredients.canonical_id": idStr },
            { "ingredients.name": entry.canonical_name },
          ],
        },
        { projection: { title: 1, ingredients: 1, isPublic: 1, status: 1 } }
      )
      .toArray();

    const draftsMatches = await draftsCol
      .find(
        {
          $or: [
            { "ingredients.canonicalId": idStr },
            { "ingredients.canonical_id": idStr },
            { "ingredients.name": entry.canonical_name },
          ],
        },
        { projection: { title: 1, ingredients: 1, status: 1 } }
      )
      .toArray();

    const costMatches = await costCol
      .find(
        {
          $or: [
            { "lines.canonical_name": entry.canonical_name },
            { "lines.canonicalId": idStr },
            { "lines.canonical_id": idStr },
            { "lines.rawName": entry.canonical_name },
          ],
        },
        { projection: { recipeId: 1, lines: 1 } }
      )
      .toArray();

    const recipesRefs = recipesMatches.map((doc) => ({
      _id: doc._id.toString(),
      title: doc.title,
      isPublic: doc.isPublic,
      status: doc.status,
      matchingIngredients: (Array.isArray(doc.ingredients) ? doc.ingredients : []).filter(
        (ing) => ing && (ing.canonicalId === idStr || ing.canonical_id === idStr || (typeof ing.name === "string" && ing.name.toLowerCase().trim() === nameLower))
      ),
    }));
    const draftsRefs = draftsMatches.map((doc) => ({
      _id: doc._id.toString(),
      title: doc.title,
      status: doc.status,
      matchingIngredients: (Array.isArray(doc.ingredients) ? doc.ingredients : []).filter(
        (ing) => ing && (ing.canonicalId === idStr || ing.canonical_id === idStr || (typeof ing.name === "string" && ing.name.toLowerCase().trim() === nameLower))
      ),
    }));
    const costRefs = costMatches.map((doc) => ({
      recipeId: doc.recipeId,
      matchingLines: (Array.isArray(doc.lines) ? doc.lines : []).filter(
        (l) =>
          l &&
          (l.canonicalId === idStr ||
            l.canonical_id === idStr ||
            (typeof l.canonical_name === "string" && l.canonical_name.toLowerCase().trim() === nameLower) ||
            (typeof l.rawName === "string" && l.rawName.toLowerCase().trim() === nameLower))
      ),
    }));

    const totalRefs = recipesRefs.length + draftsRefs.length + costRefs.length;
    console.log(
      `  _id=${idStr} name=${JSON.stringify(entry.canonical_name)} quarantine=${entry.quarantine} | recipes=${recipesRefs.length} drafts=${draftsRefs.length} recipe_cost=${costRefs.length}`
    );

    results.push({
      _id: idStr,
      canonical_name: entry.canonical_name,
      quarantine: entry.quarantine,
      recipesRefCount: recipesRefs.length,
      recipeDraftsRefCount: draftsRefs.length,
      recipeCostRefCount: costRefs.length,
      totalRefs,
      recipes: recipesRefs,
      recipe_drafts: draftsRefs,
      recipe_cost: costRefs,
      fullDoc: entry,
    });
  }

  const allZero = results.every((r) => r.totalRefs === 0 && r.quarantine === true);
  const nonZero = results.filter((r) => r.totalRefs !== 0 || r.quarantine !== true);

  console.log(`\nAll 10 still quarantine:true with zero refs across all 3 collections? ${allZero}`);
  if (!allZero) {
    console.log("Entries that changed / now have references:");
    for (const r of nonZero) {
      console.log(`  ${r.canonical_name}: quarantine=${r.quarantine} totalRefs=${r.totalRefs}`);
    }
  }

  const evidencePath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "summaries",
    `2026-09-10_quarantine-fragment-round2-reverify${WRITE ? "" : "-dryrun"}.json`
  );
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({ scannedAt: new Date().toISOString(), mode: WRITE ? "write" : "dry-run", allZero, results }, null, 2)
  );
  console.log(`Evidence written to ${evidencePath}`);

  if (!allZero) {
    console.log("\nABORTING — not all 10 are still zero-reference quarantined. No deletion performed. See evidence file for details.");
    await client.close();
    return;
  }

  if (!WRITE) {
    console.log("\nDRY RUN — verification passed (all 10 zero-ref, quarantine:true). No deletion performed. Re-run with --write to delete.");
    await client.close();
    return;
  }

  // Final safety check before deleting: exclude id must not be in the delete set
  const deleteIds = results.map((r) => r._id);
  if (deleteIds.includes(EXCLUDED_ID)) {
    console.error("FATAL: excluded id about to be deleted. Aborting.");
    await client.close();
    process.exit(1);
  }

  const result = await canonicalCol.deleteMany({ _id: { $in: objIds } });
  console.log(`\nDeleted ${result.deletedCount} docs.`);

  await client.close();
})();
