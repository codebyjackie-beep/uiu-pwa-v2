// Re-decide a finished Worker run from its STORED listings (0 Serper credits) with the CURRENT code.
//   node scripts/price_refresh_redecide.cjs <runId>        -> summaries/price_refresh_redecide_<runId>.json
// Bundles src/jobs/priceRefresh.ts (buildDecisionRows / applySet = the Worker's own code) + recipeCostGate. READ-ONLY on Mongo.
// Docs are decided against the price/canonical docs as they are now; abort thresholds and the recipe_cost projection are recomputed.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const runId = process.argv[2];
if (!runId) { console.error("usage: node scripts/price_refresh_redecide.cjs <runId>"); process.exit(2); }
const OUT = path.join(SUMMARIES, `price_refresh_redecide_${runId}.json`);

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
const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});

(async () => {
  const env = loadDevVars();
  const P = await bundle("src/jobs/priceRefresh.ts", "pr");
  const Gate = await bundle("src/jobs/recipeCostGate.ts", "gate");
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const run = await db.collection("price_refresh_runs").findOne({ runId });
  if (!run) { console.error("run not found"); process.exit(1); }
  const names = run.results.map((r) => r.name);
  const priceMap = new Map((await db.collection("canonical_price_cache").find({ canonical_name: { $in: names } }).toArray()).map((d) => [d.canonical_name, d]));
  const canonMap = new Map((await db.collection("canonical_ingredients").find({ canonical_name: { $in: names } }).toArray()).map((d) => [d.canonical_name, d]));

  // the run doc already holds decided rows (listings + calls kept); error rows keep their `reason` as the fetch error
  const fetched = run.results.map((r) => ({ name: r.name, listings: r.listings || [], calls: r.calls || [], ...(r.action === "fetch_error" ? { error: r.reason } : {}) }));
  const rows = P.buildDecisionRows(fetched, priceMap, canonMap);

  const actions = count(rows, (r) => r.action);
  const updates = actions.update || 0;
  const docsTotal = run.docsTotal;
  const updatePct = updates / docsTotal;
  const overlay = new Map();
  for (const r of rows) if (r.action === "update" && r.set) overlay.set(r.name, P.applySet(priceMap.get(r.name), r.set));
  const rc = await Gate.recomputeRecipeCostsGated(db, { write: false, priceOverlay: overlay });
  await client.close();

  const old = new Map(run.results.map((r) => [r.name, r]));
  const transitions = count(rows.filter((r) => old.get(r.name).action !== r.action), (r) => `${old.get(r.name).action} -> ${r.action}`);
  const holdDrop = rows.filter((r) => r.action === "hold_drop").map((r) => ({
    canonical_name: r.name,
    refreshBatch: priceMap.get(r.name).refreshBatch,
    ratios: r.ratios,
    liveMetric: r.cur.metric && r.cur.metric.value,
    liveCount: r.cur.count && r.cur.count.value,
    newMetric: r.newMetric,
    newCount: r.newCount,
    previousDecision: `${old.get(r.name).action} (${old.get(r.name).reason})`,
  }));
  // sensitivity: how many of the old updates fall under 0.77 (the rounded figure in the cloud note) rather than 1/1.3
  const under077 = rows.filter((r) => { const o = old.get(r.name); return o.action === "update" && priceMap.get(r.name).refreshBatch && r.ratios && Object.values(r.ratios).some((x) => x < 0.77); }).length;
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    note: "re-decided from stored listings with current code (hold_drop on), 0 credits, nothing written",
    docsTotal,
    originalActions: count(run.results, (r) => r.action),
    actions,
    updatePct: Math.round(updatePct * 1000) / 1000,
    transitions,
    holdDropCount: holdDrop.length,
    holdDrop,
    sensitivity: { oldUpdatesWithRatioUnder_0_77: under077, floor: 1 / 1.3 },
    docsWithRefreshBatch: [...priceMap.values()].filter((d) => d.refreshBatch).length,
    recipeCost: { anomalies: rc.anomalies, publicRecipes: rc.publicRecipes, publicChanged: rc.publicChanged, before: rc.before, after: rc.after, lineWeightedAdjustedPct: rc.lineWeightedAdjustedPct },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ out: OUT, docsTotal, originalActions: report.originalActions, actions, updatePct: report.updatePct, holdDropCount: holdDrop.length, transitions, sensitivity: report.sensitivity, docsWithRefreshBatch: report.docsWithRefreshBatch, recipeCost: { anomalies: rc.anomalies.length, publicChanged: rc.publicChanged, tiersBefore: rc.before.tiers, tiersAfter: rc.after.tiers, perServingBefore: rc.before.perServing, perServingAfter: rc.after.perServing, plan6Before: rc.before.weeklyPlan6, plan6After: rc.after.weeklyPlan6 } }, null, 1));
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
