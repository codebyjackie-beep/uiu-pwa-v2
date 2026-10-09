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

  const total = await recipes.countDocuments({});
  console.log(`Total recipes: ${total}`);

  // unit literally "servings" or "serving"
  const unitServings = await recipes.find({ "ingredients.unit": { $in: ["servings", "serving"] } })
    .project({ title: 1, source: 1, isPublic: 1, servings: 1, ingredients: 1 }).toArray();
  console.log(`\nRecipes with an ingredient unit == "servings"/"serving": ${unitServings.length}`);
  for (const r of unitServings) {
    const bad = r.ingredients.filter(i => i.unit === "servings" || i.unit === "serving");
    console.log(`- ${r._id} | ${r.title} | source=${r.source} | isPublic=${r.isPublic} | recipe.servings=${r.servings}`);
    for (const b of bad) {
      console.log(`    ingredient: name="${b.name}" quantity=${b.quantity} unit="${b.unit}"`);
    }
  }

  // Broader: units that look suspicious (contain "serving", "portion", or match recipe.servings numerically with weird unit)
  const suspiciousUnitWords = ["servings", "serving", "portions", "portion", "yield"];
  const suspiciousDocs = await recipes.find({ "ingredients.unit": { $in: suspiciousUnitWords } }).count();
  console.log(`\nCount (suspicious unit words): ${suspiciousDocs}`);

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
