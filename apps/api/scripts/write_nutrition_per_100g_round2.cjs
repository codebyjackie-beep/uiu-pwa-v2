// HANDOFF_canonical-ingredients-nutrition-per-100g-round2-write.md — Round 2
// write of nutrition_per_100g for the 110 canonical_ingredients with
// referenceCount===1 (130 candidates minus 20 explicitly skipped — see
// handoff for the skip list and reasons). Only ever $set's
// nutrition_per_100g, and only on docs where it does not already exist.
//
// Field name is `kcal` (not `calories`) — round1 caught this bug mid-run,
// round2 starts correct.
//
// Default dry-run; pass --write to actually commit.
//
// Usage (from uiu-pwa-v2/apps/api):
//   node scripts/write_nutrition_per_100g_round2.cjs            # dry run
//   node scripts/write_nutrition_per_100g_round2.cjs --write    # real write
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
  ["brown rice flour", 363, 7.2, 76, 2.8],
  ["hardboiled eggs", 155, 13, 1.1, 11],
  ["baby potatoes", 77, 2, 17.5, 0.1],
  ["coconut & sesame oil", 884, 0, 0, 100],
  ["basa fillets", 90, 15, 0, 3],
  ["ginger piece", 80, 1.8, 18, 0.8],
  ["snow peas", 42, 2.8, 7.6, 0.2],
  ["thai garlic chili pepper sauce", 130, 1.5, 28, 1],
  ["chicken thighs and legs", 209, 17, 0, 15],
  ["cardamom powder", 311, 10.8, 68, 6.7],
  ["pasta shells", 371, 13, 75, 1.5],
  ["eyed peas", 116, 7.7, 20.8, 0.5],
  ["skirt steaks", 194, 19, 0, 13],
  ["quinoa and brown rice mix", 363, 10, 70, 4],
  ["ready-cut tomatoes", 18, 0.9, 4, 0.1],
  ["vegetable burger crumbles", 150, 15, 10, 6],
  ["sticky rice", 370, 7.3, 81, 0.6],
  ["sharp cheddar cheese", 403, 25, 1.3, 33],
  ["garlic paste", 145, 6, 32, 0.5],
  ["bisquick", 430, 7, 63, 15],
  ["celery finelly", 16, 0.7, 3, 0.2],
  ["ground turkey", 143, 17.4, 0, 8],
  ["thinly cut chicken breast", 120, 22.5, 0, 2.6],
  ["stevia", 0, 0, 0, 0],
  ["broccoli flowerets", 34, 2.8, 6.6, 0.4],
  ["vine tomato", 18, 0.9, 3.9, 0.2],
  ["ground sausage", 296, 12.5, 3, 26],
  ["apple cider", 47, 0.1, 11.3, 0.1],
  ["ground chicken thigh", 180, 16, 0, 12],
  ["lump crab meat", 83, 18, 0, 1],
  ["rigatoni", 371, 13, 75, 1.5],
  ["powdered ginger", 335, 9, 71, 4.2],
  ["sirloin beef tips", 183, 21, 0, 10],
  ["slow cook brown rice", 362, 7.5, 76, 2.7],
  ["cracked pepper", 251, 10.4, 64, 3.3],
  ["ground veal", 172, 20, 0, 10],
  ["long beans", 47, 2.8, 8, 0.4],
  ["button mushrooms", 22, 3.1, 3.3, 0.3],
  ["ground mustard powder", 508, 26, 28, 36],
  ["chipotle sauce", 50, 1.5, 10, 1],
  ["parsley leaves", 36, 3, 6.3, 0.8],
  ["beef short ribs", 303, 17, 0, 26],
  ["gorgonzola", 353, 21, 2, 29],
  ["sriracha sauce", 93, 2, 19, 0.9],
  ["fuji apple", 52, 0.3, 14, 0.2],
  ["basil in ribbons", 23, 3.2, 2.7, 0.6],
  ["vanilla pod", 288, 0.1, 13, 0.1],
  ["lebanese cucumber", 15, 0.7, 3.6, 0.1],
  ["cornflour", 381, 0.3, 91, 0.1],
  ["beef broth", 7, 1, 0.5, 0.2],
  ["stew meat", 194, 19, 0, 13],
  ["venison stew meat", 120, 22, 0, 2.5],
  ["celery salt", 260, 3, 50, 1],
  ["canola oil", 884, 0, 0, 100],
  ["cinnamon stick", 247, 4, 81, 1.2],
  ["chavrie goat cheese", 290, 19, 3, 23],
  ["satsuma orange", 47, 0.9, 12, 0.2],
  ["rice bran oil", 884, 0, 0, 100],
  ["flat leaf parsley leaves", 36, 3, 6.3, 0.8],
  ["ground sumac", 245, 4, 73, 4.5],
  ["pita breads", 275, 9, 56, 1.2],
  ["paprika powder", 282, 14.1, 54, 13],
  ["greens onion", 32, 1.8, 7.3, 0.2],
  ["garbanzo beans", 164, 8.9, 27.4, 2.6],
  ["rounds pita bread", 275, 9, 56, 1.2],
  ["boston lettuce", 15, 1.2, 2.2, 0.2],
  ["olive tapenade", 260, 2, 7, 25],
  ["cotija cheese", 380, 23, 2, 31],
  ["white fish fillets (cod, tilapia)", 85, 18, 0, 1],
  ["hoisin sauce (optional)", 220, 2.6, 44, 1.1],
  ["cooking sherry", 130, 0.1, 4, 0],
  ["roquette lettuce", 25, 2.6, 3.7, 0.7],
  ["ground chile powder", 282, 12, 50, 14],
  ["arrowroot powder", 357, 0.3, 88, 0.1],
  ["butter lettuce", 13, 1.4, 2.2, 0.2],
  ["allspice powder", 263, 6, 72, 8.7],
  ["mirin", 245, 0.2, 60, 0],
  ["asparagus spears, trimmed", 20, 2.2, 3.9, 0.1],
  ["linguine pasta", 371, 13, 75, 1.5],
  ["pickled cucumber", 11, 0.3, 2.3, 0.2],
  ["leave lettuce", 15, 1.4, 2.9, 0.2],
  ["quality extra virgin olive oil", 884, 0, 0, 100],
  ["large eggs", 143, 13, 1.1, 9.5],
  ["mixed salad greens", 15, 1.4, 2.9, 0.2],
  ["large shrimp, peeled & deveined", 99, 24, 0.2, 0.3],
  ["green curry paste", 90, 3, 10, 4.5],
  ["chorizo sausage, sliced", 455, 24, 1.9, 38],
  ["ginger root", 80, 1.8, 18, 0.8],
  ["fresh basil leaves", 23, 3.2, 2.7, 0.6],
  ["vegetable or fish broth, hot", 6, 1, 0.6, 0.1],
  ["black olives", 115, 0.8, 6, 11],
  ["lrgs garlic clove", 149, 6.4, 33, 0.5],
  ["iceberg lettuce", 14, 0.9, 3, 0.1],
  ["flat parsley", 36, 3, 6.3, 0.8],
  ["saffron threads", 310, 11.4, 65, 5.9],
  ["red chilli, deseeded and sliced (optional)", 40, 2, 9, 0.4],
  ["jasmine rice", 365, 7, 80, 0.7],
  ["fresh dill or parsley, chopped", 40, 3.3, 6.5, 1.1],
  ["chile pepper", 40, 2, 9, 0.4],
  ["cooked white or brown rice", 121, 2.5, 26, 0.5],
  ["red pepper flakes (optional)", 282, 12, 50, 14],
  ["campbell's chicken gravy", 41, 1.5, 6, 1.2],
  ["all-purpose flour", 364, 10, 76, 1],
  ["salad lettuce", 15, 1.4, 2.9, 0.2],
  ["top sirloin steak", 183, 21, 0, 10],
  ["almond extract", 288, 0.5, 13, 0.1],
  ["hothouse cucumber", 15, 0.7, 3.6, 0.1],
  ["lime or lemon", 30, 0.7, 10, 0.2],
  ["red cabbage, shredded", 31, 1.4, 7.4, 0.2],
  ["paella rice (e.g., bomba or arborio)", 365, 7, 79, 0.6],
].map(([canonical_name, kcal, protein, carbs, fat]) => ({
  canonical_name,
  nutrition_per_100g: { kcal, protein, carbs, fat },
}));

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  console.log(`Loaded ${UPDATES.length} round2 updates (referenceCount===1, minus 20 skipped)`);

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
