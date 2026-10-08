/**
 * One-off data fix (2026-10-08) — recipeDraftApproval.ts briefly stored
 * recipe_cost.recipeId as a string (insertResult.insertedId.toString())
 * instead of the raw ObjectId every other code path uses (recipes.ts,
 * mealPlan.ts, mealPlanGenerator.ts, precomputeRecipeCosts.ts,
 * recipeImport.ts, fridgeRecipeGen.ts). This finds every recipe_cost doc
 * where recipeId is a string and converts it back to ObjectId in place.
 *
 * Default is --dry-run (reports counts only). Pass --write to commit.
 *
 * Usage:
 *   node scripts/fix_recipe_cost_recipeid_type.cjs            # dry run
 *   node scripts/fix_recipe_cost_recipeid_type.cjs --write    # real fix
 */
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

function loadDevVars() {
  const p = path.resolve(API_ROOT, ".dev.vars");
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

(async () => {
  console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN (pass --write to commit)"}`);

  const devVars = loadDevVars();
  const client = new MongoClient(devVars.MONGODB_URI);
  await client.connect();
  const db = client.db(devVars.MONGODB_DB);

  try {
    const col = db.collection("recipe_cost");
    const stringDocs = await col.find({ recipeId: { $type: "string" } }).toArray();
    const objectIdDocs = await col.countDocuments({ recipeId: { $type: "objectId" } });
    const total = await col.countDocuments({});

    console.log(`recipe_cost total: ${total}. recipeId as ObjectId (correct): ${objectIdDocs}. recipeId as string (bug): ${stringDocs.length}.`);

    const invalid = stringDocs.filter((d) => !ObjectId.isValid(d.recipeId));
    if (invalid.length > 0) {
      console.error(`[ABORT] ${invalid.length} string recipeId value(s) are not valid ObjectId hex — investigate before writing:`, invalid.map((d) => ({ _id: d._id, recipeId: d.recipeId })));
      process.exit(1);
    }

    if (!WRITE) {
      console.log("Dry run only — pass --write to convert the above string recipeId docs to ObjectId.");
      console.log("Affected recipe_cost _ids:", stringDocs.map((d) => d._id.toString()));
      return;
    }

    if (stringDocs.length === 0) {
      console.log("Nothing to fix.");
      return;
    }

    const ops = stringDocs.map((d) => ({
      updateOne: {
        filter: { _id: d._id },
        update: { $set: { recipeId: new ObjectId(d.recipeId) } },
      },
    }));
    const result = await col.bulkWrite(ops);
    console.log(`Converted ${result.modifiedCount} recipe_cost docs' recipeId from string to ObjectId.`);

    const remainingString = await col.countDocuments({ recipeId: { $type: "string" } });
    console.log(`Post-fix check: ${remainingString} recipe_cost docs still have string recipeId (expect 0).`);
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
