// cc_prompt 2026-10-12 Part E — READ-ONLY. Lists public recipes with adjustedCoveragePct < 50 so Jackie
// can search a short title and confirm the "Price unavailable" card state.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const pub = await db.collection("recipes").find({ isPublic: true }, { projection: { title: 1 } }).toArray();
    const titles = new Map(pub.map((r) => [String(r._id), r.title]));
    const costs = await db.collection("recipe_cost").find({}).toArray();
    const rows = costs
      .filter((c) => titles.has(String(c.recipeId)))
      .map((c) => ({ id: String(c.recipeId), title: titles.get(String(c.recipeId)), cov: c.adjustedCoveragePct, perServing: c.perServing }))
      .filter((r) => r.cov == null || r.cov < 50)
      .sort((a, b) => a.title.length - b.title.length);
    console.log(`public recipes with coverage < 50 (or null): ${rows.length}`);
    for (const r of rows) console.log(`${String(r.title.length).padStart(3)} ch | cov ${r.cov == null ? "null" : Math.round(r.cov * 10) / 10}% | perServing ${r.perServing} | ${r.title} [${r.id}]`);
    const have = new Set(costs.map((c) => String(c.recipeId)));
    console.log(`public recipes with no recipe_cost doc: ${pub.filter((r) => !have.has(String(r._id))).length}`);
  } finally { await client.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
