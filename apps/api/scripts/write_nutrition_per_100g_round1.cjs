// HANDOFF_canonical-ingredients-nutrition-per-100g-round1-write.md — Round 1
// write of nutrition_per_100g for the 91 canonical_ingredients with
// referenceCount>=2 (99 candidates minus 8 explicitly skipped — see handoff
// for the skip list and reasons). Only ever $set's nutrition_per_100g, and
// only on docs where it does not already exist (protects against clobbering
// data written by another session in the meantime).
//
// Default dry-run; pass --write to actually commit (same opt-in convention
// as write_nutrition_per_100g.cjs / recipe_cost's ?write=true admin route).
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_nutrition_per_100g_round1.cjs            # dry run
//   node scripts/write_nutrition_per_100g_round1.cjs --write    # real write
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");

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

// [canonical_name, kcal, protein, carbs, fat] per 100g
const UPDATES = [
  ["bell pepper", 20, 0.9, 4.6, 0.2],
  ["garlic clove", 149, 6.4, 33, 0.5],
  ["green onion", 32, 1.8, 7.3, 0.2],
  ["scallion", 32, 1.8, 7.3, 0.2],
  ["king prawns, peeled and deveined", 99, 24, 0.2, 0.3],
  ["kosher salt", 0, 0, 0, 0],
  ["rice vinegar", 21, 0, 0.4, 0],
  ["red onion", 40, 1.1, 9.3, 0.1],
  ["extra virgin olive oil", 884, 0, 0, 100],
  ["cilantro", 23, 2.1, 3.7, 0.5],
  ["balsamic vinegar", 88, 0.5, 17, 0],
  ["ground cumin", 375, 17.8, 44.2, 22.3],
  ["jalapeno pepper", 29, 0.9, 6.5, 0.4],
  ["vegetable broth", 5, 0.2, 0.9, 0.1],
  ["ripe avocado", 160, 2, 8.5, 14.7],
  ["celery stalk", 16, 0.7, 3, 0.2],
  ["fish sauce", 43, 6, 3.8, 0],
  ["chicken broth", 7, 1, 0.5, 0.2],
  ["rice wine vinegar", 21, 0, 0.4, 0],
  ["flat leaf parsley", 36, 3, 6.3, 0.8],
  ["dijon mustard", 66, 4.4, 5.3, 3.3],
  ["sea salt", 0, 0, 0, 0],
  ["basil leaves", 23, 3.2, 2.7, 0.6],
  ["broccoli florets", 34, 2.8, 6.6, 0.4],
  ["cilantro leaves", 23, 2.1, 3.7, 0.5],
  ["heavy cream", 340, 2.1, 2.8, 36],
  ["fresh parsley, chopped", 36, 3, 6.3, 0.8],
  ["cherry tomato", 18, 0.9, 3.9, 0.2],
  ["smoked paprika", 282, 14.1, 54, 13],
  ["tomato paste", 82, 4.3, 18.9, 0.5],
  ["roma tomato", 18, 0.9, 3.9, 0.2],
  ["maple syrup", 260, 0, 67, 0.2],
  ["orange pepper", 27, 1, 6.3, 0.2],
  ["persian cucumber", 15, 0.7, 3.6, 0.1],
  ["red bell pepper, sliced", 31, 1, 6, 0.3],
  ["lemon rind", 47, 1.5, 16, 0.3],
  ["chilli flakes", 282, 12, 50, 14],
  ["zucchini", 17, 1.2, 3.1, 0.3],
  ["soy milk", 33, 2.9, 1.8, 1.8],
  ["cornstarch", 381, 0.3, 91, 0.1],
  ["bread crumbs", 395, 13, 72, 5.3],
  ["red wine vinegar", 19, 0, 0.3, 0],
  ["oyster sauce", 51, 1.4, 11, 0.3],
  ["russet potato", 79, 2, 18, 0.1],
  ["pepper flakes", 282, 12, 50, 14],
  ["white onion", 40, 1.1, 9.3, 0.1],
  ["apple cider vinegar", 21, 0, 0.9, 0],
  ["bok choy", 13, 1.5, 2.2, 0.2],
  ["chickpeas", 164, 8.9, 27.4, 2.6],
  ["jicama", 38, 0.7, 8.8, 0.1],
  ["mint leaves", 70, 3.8, 14.9, 0.9],
  ["rice wine", 130, 0.2, 5, 0],
  ["baby bok choy", 13, 1.5, 2.2, 0.2],
  ["roasted coarse peanuts", 585, 24, 21, 50],
  ["flank steak", 172, 21.4, 0, 9],
  ["unpasteurized shiro miso", 199, 12, 26, 6],
  ["savoy cabbage", 27, 2, 6.1, 0.1],
  ["yellow onion", 40, 1.1, 9.3, 0.1],
  ["sriracha", 93, 2, 19, 0.9],
  ["fresh cilantro", 23, 2.1, 3.7, 0.5],
  ["rice stick noodles", 364, 6, 80, 0.6],
  ["hardboiled quail eggs", 158, 13, 0.4, 11],
  ["kernal corn", 86, 3.3, 19, 1.4],
  ["five spice", 350, 10, 60, 10],
  ["turmeric powder", 312, 9.7, 67, 3.3],
  ["star anise", 337, 17.6, 50, 15.9],
  ["tabasco sauce", 12, 0.9, 0.8, 0.5],
  ["thumb sized ginger", 80, 1.8, 18, 0.8],
  ["white wine vinegar", 19, 0, 0.3, 0],
  ["ground coriander", 298, 12, 55, 17.8],
  ["romaine lettuce", 17, 1.2, 3.3, 0.3],
  ["ground beef", 254, 17, 0, 20],
  ["mung bean sprouts", 30, 3, 5.9, 0.2],
  ["grape tomatoes", 18, 0.9, 3.9, 0.2],
  ["hot sauce", 11, 0.5, 2, 0.4],
  ["chili pepper flakes", 282, 12, 50, 14],
  ["peppercorns", 251, 10.4, 64, 3.3],
  ["cajun seasoning", 280, 10, 55, 6],
  ["broccoli slaw", 30, 1.7, 6.6, 0.2],
  ["ground chicken", 143, 17.4, 0, 8],
  ["pancetta", 380, 27, 0, 30],
  ["ginger paste", 80, 1.8, 18, 0.8],
  ["non-fat milk", 34, 3.4, 5, 0.1],
  ["white vinegar", 18, 0, 0.04, 0],
  ["flat-leaf parsley", 36, 3, 6.3, 0.8],
  ["canned chopped tomatoes", 18, 0.9, 4, 0.1],
  ["chile paste", 60, 2, 12, 0.5],
  ["white miso paste", 199, 12, 26, 6],
  ["lettuce leaves", 17, 1.2, 3.3, 0.3],
  ["fresh basil, torn", 23, 3.2, 2.7, 0.6],
  ["chicken or fish broth", 7, 1, 0.5, 0.2],
].map(([canonical_name, kcal, protein, carbs, fat]) => ({
  canonical_name,
  // field name must be `kcal` (not `calories`) — matches the existing 248
  // docs' schema and what apps/api/src/routes/fridgeRecipeGen.ts etc. read.
  nutrition_per_100g: { kcal, protein, carbs, fat },
}));

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  console.log(`Loaded ${UPDATES.length} round1 updates (referenceCount>=2, minus 8 skipped)`);

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection("canonical_ingredients");

    const beforeCount = await col.countDocuments({ nutrition_per_100g: { $exists: true } });
    const totalCount = await col.countDocuments({});

    console.log(`\nBefore write: ${beforeCount}/${totalCount} canonical_ingredients have nutrition_per_100g`);
    console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);

    let matched = 0;
    const notFound = [];
    const alreadyHasField = [];
    for (const u of UPDATES) {
      const filter = { canonical_name: u.canonical_name, nutrition_per_100g: { $exists: false } };
      if (WRITE) {
        const result = await col.updateOne(filter, { $set: { nutrition_per_100g: u.nutrition_per_100g } });
        if (result.matchedCount === 0) {
          const existsAtAll = await col.countDocuments({ canonical_name: u.canonical_name });
          if (existsAtAll === 0) notFound.push(u.canonical_name);
          else alreadyHasField.push(u.canonical_name);
        } else {
          matched += 1;
        }
      } else {
        const matchesFilter = await col.countDocuments(filter);
        if (matchesFilter > 0) {
          matched += 1;
        } else {
          const existsAtAll = await col.countDocuments({ canonical_name: u.canonical_name });
          if (existsAtAll === 0) notFound.push(u.canonical_name);
          else alreadyHasField.push(u.canonical_name);
        }
      }
    }

    const afterCount = WRITE
      ? await col.countDocuments({ nutrition_per_100g: { $exists: true } })
      : beforeCount;

    console.log(`\n${WRITE ? "Written" : "Would write"}: ${matched}/${UPDATES.length}`);
    if (notFound.length > 0) {
      console.log(`canonical_name not found in DB at all (${notFound.length}): ${notFound.join(", ")}`);
    }
    if (alreadyHasField.length > 0) {
      console.log(`canonical_name already has nutrition_per_100g, skipped (${alreadyHasField.length}): ${alreadyHasField.join(", ")}`);
    }
    console.log(`After write: ${afterCount}/${totalCount} canonical_ingredients have nutrition_per_100g`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
