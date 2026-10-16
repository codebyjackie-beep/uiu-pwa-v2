// READ-ONLY: which canonicals account for the most "Price unavailable" lines across PUBLIC recipes.
//   node scripts/public_unpriced_lines.cjs  -> summaries/public_unpriced_lines_<date>.json
// A line shows "Price unavailable" on recipe detail when it has no price (priceable=false). Uses the stored recipe_cost docs
// (identical to a fresh recompute for public recipes — see recipe_cost_gate_dryrun). Nothing is written.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(API_ROOT, "../../summaries", `public_unpriced_lines_${new Date().toISOString().slice(0, 10)}.json`);
function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.join(API_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const recipes = await db.collection("recipes").find({ isPublic: true }, { projection: { title: 1 } }).toArray();
  const ids = recipes.map((r) => r._id);
  const costs = await db.collection("recipe_cost").find({ recipeId: { $in: ids } }).toArray();
  const price = new Map((await db.collection("canonical_price_cache").find({}).toArray()).map((d) => [d.canonical_name, d]));
  const canon = new Map((await db.collection("canonical_ingredients").find({}).toArray()).map((d) => [d.canonical_name, d]));

  const groups = new Map();
  let totalLines = 0;
  let unpricedLines = 0;
  const reasonTotals = {};
  for (const c of costs) {
    for (const l of c.lines || []) {
      totalLines++;
      if (l.priceable) continue;
      unpricedLines++;
      const key = l.canonical_name || `(unresolved) ${String(l.rawName || "").toLowerCase()}`;
      let g = groups.get(key);
      if (!g) { g = { key, canonical: l.canonical_name || null, lines: 0, recipes: new Set(), reasons: {}, isPantry: 0, rawNames: {}, units: {} }; groups.set(key, g); }
      g.lines++;
      g.recipes.add(String(c.recipeId));
      inc(g.reasons, l.reason || "(none)");
      inc(reasonTotals, l.reason || "(none)");
      if (l.isPantry) g.isPantry++;
      inc(g.rawNames, String(l.rawName || ""));
      inc(g.units, String(l.rawUnit || ""));
    }
  }
  const rows = [...groups.values()].map((g) => {
    const p = g.canonical ? price.get(g.canonical) : undefined;
    const ci = g.canonical ? canon.get(g.canonical) : undefined;
    return {
      canonical: g.key,
      recipes: g.recipes.size,
      lines: g.lines,
      reasons: g.reasons,
      isPantryLines: g.isPantry,
      hasPriceDoc: !!p,
      priceDoc: p ? { metric: p.metric_price ?? p.metric ?? null, count: p.count_price ?? p.count ?? null, price_basis: p.price_basis || null, confidence: p.confidence || null, hasCheapest: !!p.cheapest, keys: Object.keys(p).filter((k) => !["_id", "metadata", "listings"].includes(k)).slice(0, 25) } : null,
      canonicalDoc: ci ? { quarantine: ci.quarantine === true, hasDensity: ci.density_g_per_ml != null || ci.density != null, keys: Object.keys(ci).filter((k) => k !== "_id").slice(0, 20) } : (g.canonical ? "missing" : null),
      topRawNames: Object.entries(g.rawNames).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} x${v}`),
      topUnits: Object.entries(g.units).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k || "(none)"} x${v}`),
    };
  }).sort((a, b) => b.recipes - a.recipes || b.lines - a.lines);

  const report = { generatedAt: new Date().toISOString(), publicRecipes: recipes.length, costDocs: costs.length, totalLines, unpricedLines, unpricedPct: Math.round((unpricedLines / totalLines) * 1000) / 10, distinctUnpriced: rows.length, reasonTotals, top20: rows.slice(0, 20), all: rows };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  await client.close();
  console.log(JSON.stringify({ out: OUT, publicRecipes: report.publicRecipes, costDocs: report.costDocs, totalLines, unpricedLines, unpricedPct: report.unpricedPct, distinctUnpriced: rows.length, reasonTotals }, null, 1));
  for (const r of rows.slice(0, 20)) console.log(`${String(r.recipes).padStart(3)} rec ${String(r.lines).padStart(3)} ln | ${r.canonical} | priceDoc=${r.hasPriceDoc}${r.priceDoc ? ` basis=${r.priceDoc.price_basis} conf=${r.priceDoc.confidence} metric=${JSON.stringify(r.priceDoc.metric)} count=${JSON.stringify(r.priceDoc.count)}` : ""} | ${JSON.stringify(r.reasons)} | pantry=${r.isPantryLines} | ${r.topUnits.join(", ")} | ${r.topRawNames[0]}${r.canonicalDoc === "missing" ? " | CANONICAL DOC MISSING" : r.canonicalDoc && r.canonicalDoc.quarantine ? " | QUARANTINED" : ""}`);
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
