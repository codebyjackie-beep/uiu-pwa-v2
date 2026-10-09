const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const recipes = db.collection("recipes");

  const docs = await recipes.find({ "ingredients.unit": { $in: ["servings", "serving"] } })
    .project({ title: 1, source: 1, isPublic: 1, servings: 1, createdAt: 1, sourceUrl: 1, ingredients: 1 }).toArray();

  let matchCount = 0, mismatchCount = 0, totalBadLines = 0;
  const mismatches = [];
  const sources = new Set();
  const createdAtDates = new Set();
  const nonIngredientLike = [];

  for (const r of docs) {
    sources.add(r.source);
    if (r.createdAt) createdAtDates.add(String(r.createdAt).slice(0,10));
    const bad = r.ingredients.filter(i => i.unit === "servings" || i.unit === "serving");
    for (const b of bad) {
      totalBadLines++;
      if (b.quantity === r.servings) matchCount++;
      else { mismatchCount++; mismatches.push({ id: r._id.toString(), title: r.title, servings: r.servings, ing: b }); }
      // heuristic: looks like a cooking instruction, not an ingredient (long text, verb-like start)
      const words = b.name.split(/\s+/);
      if (words.length >= 5 || /^(add|put|stir|mix|place|preheat|cover|simmer|sprinkle|if)\b/i.test(b.name)) {
        nonIngredientLike.push({ id: r._id.toString(), title: r.title, name: b.name });
      }
    }
  }

  console.log(`Docs affected: ${docs.length}`);
  console.log(`Total bad ingredient lines (unit=servings/serving): ${totalBadLines}`);
  console.log(`quantity === recipe.servings: ${matchCount}`);
  console.log(`quantity !== recipe.servings (mismatch): ${mismatchCount}`);
  console.log(`Distinct source values: ${[...sources].join(", ")}`);
  console.log(`Distinct createdAt dates (YYYY-MM-DD): ${[...createdAtDates].sort().join(", ")}`);
  console.log(`\nMismatches:`);
  for (const m of mismatches) console.log(JSON.stringify(m));
  console.log(`\nLikely mis-parsed recipe STEPS masquerading as ingredients (${nonIngredientLike.length}):`);
  for (const n of nonIngredientLike) console.log(`  [${n.id}] ${n.title} :: "${n.name}"`);

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
