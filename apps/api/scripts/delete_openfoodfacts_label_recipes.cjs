// HANDOFF_recipe-import-french-label-bug-execute.md decision 1 — Jackie has confirmed the
// dry-run report (summaries/2026-08-10_recipe-import-french-label-bug-dry-run.json): delete
// all 8 open_food_facts product-label "recipes" (not unpublish — real delete), and their
// corresponding recipe_cost docs.
//
// Default: dry run (prints before-counts + what would be deleted, writes nothing).
// Pass --write to actually delete. Prints before/after raw counts either way.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");

const RECIPE_IDS = [
  "69b4a8c564f3ba3a3aebef07",
  "69b4a8c564f3ba3a3aebef08",
  "69b4a8c564f3ba3a3aebef09",
  "69b4a8c564f3ba3a3aebef0b",
  "69b4a8c564f3ba3a3aebef0c",
  "69b4a8c564f3ba3a3aebef0d",
  "69b4a8c564f3ba3a3aebef0f",
  "69b4a8c564f3ba3a3aebef10",
];

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
    const recipesCol = db.collection("recipes");
    const costCol = db.collection("recipe_cost");
    const objectIds = RECIPE_IDS.map((id) => new ObjectId(id));

    const before = {
      recipesTotal: await recipesCol.countDocuments({}),
      recipesPublic: await recipesCol.countDocuments({ isPublic: true }),
      recipeCostTotal: await costCol.countDocuments({}),
    };

    const targetRecipes = await recipesCol
      .find({ _id: { $in: objectIds } }, { projection: { title: 1, source: 1, isPublic: 1 } })
      .toArray();
    const targetCosts = await costCol
      .find({ recipeId: { $in: objectIds } }, { projection: { recipeId: 1 } })
      .toArray();

    console.log(`Found ${targetRecipes.length}/8 target recipes in production:`);
    for (const r of targetRecipes) {
      console.log(`  ${r._id}  source=${r.source}  isPublic=${r.isPublic}  "${r.title}"`);
    }
    console.log(`Found ${targetCosts.length}/8 matching recipe_cost docs.`);

    if (targetRecipes.length !== 8) {
      console.error(`ERROR: expected exactly 8 matching recipes, found ${targetRecipes.length}. Aborting without writing.`);
      process.exit(1);
    }

    let deletedRecipes = 0;
    let deletedCosts = 0;
    if (WRITE) {
      const recipesResult = await recipesCol.deleteMany({ _id: { $in: objectIds } });
      deletedRecipes = recipesResult.deletedCount;
      const costsResult = await costCol.deleteMany({ recipeId: { $in: objectIds } });
      deletedCosts = costsResult.deletedCount;
      console.log(`Deleted ${deletedRecipes} recipes, ${deletedCosts} recipe_cost docs.`);
    } else {
      console.log("DRY RUN — no DB writes performed. Pass --write to commit.");
    }

    const after = {
      recipesTotal: await recipesCol.countDocuments({}),
      recipesPublic: await recipesCol.countDocuments({ isPublic: true }),
      recipeCostTotal: await costCol.countDocuments({}),
    };

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      targetRecipeIds: RECIPE_IDS,
      foundRecipes: targetRecipes.length,
      foundCosts: targetCosts.length,
      deletedRecipes,
      deletedCosts,
      before,
      after,
    };
    const reportPath = path.resolve(
      __dirname,
      "../../../../summaries",
      `2026-08-10_recipe-import-french-label-bug-delete-${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${reportPath}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
