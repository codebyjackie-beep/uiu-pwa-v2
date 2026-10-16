// Weekly precompute dry-run: runs the Worker's own recomputeRecipeCostsGated(write:false) against prod data.
//   node scripts/recipe_cost_gate_dryrun.cjs   -> summaries/recipe_cost_gate_dryrun_<date>.json
// READ-ONLY on Mongo (write:false never calls createIndex/bulkWrite). Also cross-checks the web's stock-cube name list.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const OUT = path.join(SUMMARIES, `recipe_cost_gate_dryrun_${new Date().toISOString().slice(0, 10)}.json`);

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.join(API_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
async function bundle(entry, name) {
  const { build } = require("esbuild");
  const outFile = path.join(API_ROOT, "scripts", `_${name}_bundle.mjs`);
  try {
    await build({ entryPoints: [path.join(API_ROOT, entry)], bundle: true, platform: "node", format: "esm", outfile: outFile, packages: "external", logLevel: "silent" });
    return await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

(async () => {
  const env = loadDevVars();
  const Gate = await bundle("src/jobs/recipeCostGate.ts", "gate");
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const r = await Gate.recomputeRecipeCostsGated(db, { write: false });
  // The gate only looks at PUBLIC recipes; a real write would also upsert every non-public doc. Show how those would move (read-only).
  const Res = await bundle("src/services/ingredientResolver.ts", "res");
  const Cost = await bundle("src/services/recipeCost.ts", "cost");
  const ing = await db.collection("canonical_ingredients").find({}).toArray();
  const ingMap = new Map(ing.map((d) => [d.canonical_name, d]));
  const priceMap = new Map((await db.collection("canonical_price_cache").find({}).toArray()).map((d) => [d.canonical_name, d]));
  const index = await Res.buildAliasIndex(db.collection("canonical_ingredients"));
  const quarantined = new Set(ing.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
  const recipes = await db.collection("recipes").find({}).toArray();
  const stored = new Map((await db.collection("recipe_cost").find({}).toArray()).map((d) => [String(d.recipeId), d]));
  const nonPublic = { total: 0, changed: 0, noStored: 0, changedSamples: [] };
  const publicStampCounts = {};
  for (const rec of recipes) {
    const st = stored.get(String(rec._id));
    if (rec.isPublic === true) { const k = String(st && st.priceCacheStamp); publicStampCounts[k] = (publicStampCounts[k] || 0) + 1; continue; }
    nonPublic.total++;
    const fr = Cost.costRecipe(rec, (n) => Res.resolve(n, index), ingMap, priceMap, quarantined);
    if (!st) { nonPublic.noStored++; continue; }
    if (Math.abs((fr.perServing || 0) - (st.perServing || 0)) > 0.0001 || Math.abs((fr.adjustedCoveragePct || 0) - (st.adjustedCoveragePct || 0)) > 0.01) {
      nonPublic.changed++;
      if (nonPublic.changedSamples.length < 10) nonPublic.changedSamples.push({ title: rec.title, before: st.perServing, after: fr.perServing });
    }
  }
  const stockDocs = (await db.collection("canonical_price_cache").find({ price_basis: "stock_cube_made_up" }, { projection: { canonical_name: 1 } }).toArray()).map((d) => d.canonical_name).sort();
  await client.close();
  const report = { generatedAt: new Date().toISOString(), note: "recomputeRecipeCostsGated(write:false) on prod; nothing written", result: r, stockCubeMadeUpInDb: stockDocs, nonPublic, publicStoredStampCounts: publicStampCounts };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ out: OUT, write: r.write, wrote: r.wrote, recipes: r.recipes, publicRecipes: r.publicRecipes, publicChanged: r.publicChanged, anomalyCount: r.anomalies.length, anomalies: r.anomalies, before: r.before, after: r.after, withBasket: r.withBasket, lineWeightedAdjustedPct: r.lineWeightedAdjustedPct, priceCacheStamp: r.priceCacheStamp, stockCubeMadeUpInDb: stockDocs.length, nonPublic, publicStoredStampCounts: publicStampCounts }, null, 1));
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
