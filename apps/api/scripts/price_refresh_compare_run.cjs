// Compare a Worker price_refresh_runs doc with the cloud-reviewed final dry-run.   node scripts/price_refresh_compare_run.cjs <runId>
// Read-only (Mongo find only). Writes summaries/price_refresh_auto_dryrun_compare_<date>.json.
// Per doc: previous effective action (override applied) vs the Worker's action, previous proposed value vs the Worker's, ratio.
// NOTE the reviewed run used the pre-refresh-20261016 prices as "current"; the Worker run compares against what is live now
// (= the values refresh-20261016 wrote), so `ratios` differ by design. The like-for-like numbers are the proposed values.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const FINAL = path.join(SUMMARIES, "price_refresh_final_dryrun_2026-10-16.json");
const runId = process.argv[2];
if (!runId) { console.error("usage: node scripts/price_refresh_compare_run.cjs <runId>"); process.exit(2); }
const OUT = path.join(SUMMARIES, `price_refresh_auto_dryrun_compare_${new Date().toISOString().slice(0, 10)}.json`);

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
const r4 = (v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);
const ratio = (a, b) => (typeof a === "number" && typeof b === "number" && b !== 0 ? Math.round((a / b) * 1000) / 1000 : null);
const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});

(async () => {
  const env = loadDevVars();
  const fin = JSON.parse(fs.readFileSync(FINAL, "utf8"));
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const run = await db.collection("price_refresh_runs").findOne({ runId });
  const overrides = new Set((await db.collection("price_refresh_overrides").find({ canonical_name: { $exists: true } }).toArray()).map((o) => o.canonical_name));
  await client.close();
  if (!run) { console.error("run not found"); process.exit(1); }

  const byName = new Map(fin.docs.map((d) => [d.canonical_name, d]));
  const workerBy = new Map(run.results.map((r) => [r.name, r]));
  const rows = [];
  for (const f of fin.docs) {
    const ov = f.override && !f.override.skipped ? f.override : null;
    const prevAction = ov ? ov.decision : f.action; // keep_old / skip = cloud override; otherwise the guard action
    const prevMetric = f.action === "update" && f.proposed && f.proposed.set && f.proposed.set.per_unit_metric ? f.proposed.set.per_unit_metric.value : (f.guarded && f.guarded.per_unit_metric ? f.guarded.per_unit_metric.value : null);
    const prevCount = f.action === "update" && f.proposed && f.proposed.set && f.proposed.set.per_unit_count ? f.proposed.set.per_unit_count.value : (f.guarded && f.guarded.per_unit_count ? f.guarded.per_unit_count.value : null);
    const w = workerBy.get(f.canonical_name);
    const row = {
      canonical_name: f.canonical_name,
      family: f.family,
      prevAction,
      prevReason: ov ? `${ov.decision}: ${ov.note || ""}` : f.reason,
      workerAction: w ? w.action : overrides.has(f.canonical_name) ? "(skipped: override)" : "(not in run)",
      workerReason: w ? w.reason ?? null : null,
      prevProposedMetric: r4(prevMetric),
      workerMetric: w ? r4(w.newMetric ?? null) : null,
      metricVsPrevProposed: w ? ratio(w.newMetric, prevMetric) : null,
      prevProposedCount: r4(prevCount),
      workerCount: w ? r4(w.newCount ?? null) : null,
      countVsPrevProposed: w ? ratio(w.newCount, prevCount) : null,
      workerRatiosVsLive: w && w.ratios ? w.ratios : null,
      liveMetricNow: w && w.cur && w.cur.metric ? r4(w.cur.metric.value) : null,
      liveCountNow: w && w.cur && w.cur.count ? r4(w.cur.count.value) : null,
      whitelisted: w ? w.whitelisted : null,
      fetchError: w && w.reason && w.action === "fetch_error" ? w.reason : null,
    };
    row.sameAction = row.prevAction === row.workerAction;
    rows.push(row);
  }
  const workerOnly = run.results.filter((r) => !byName.has(r.name)).map((r) => ({ canonical_name: r.name, workerAction: r.action, workerReason: r.reason }));
  const diff = rows.filter((r) => !r.sameAction);
  const transitions = count(diff, (r) => `${r.prevAction} -> ${r.workerAction}`);

  // like-for-like value drift for docs both runs would update
  const bothUpdate = rows.filter((r) => r.prevAction === "update" && r.workerAction === "update");
  const drift = (key) => { const v = bothUpdate.map((r) => r[key]).filter((x) => typeof x === "number").sort((a, b) => a - b); return v.length ? { n: v.length, min: v[0], p10: v[Math.floor(v.length * 0.1)], median: v[Math.floor(v.length / 2)], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1] } : null; };
  const outsideBand = bothUpdate.filter((r) => (r.metricVsPrevProposed != null && (r.metricVsPrevProposed < 0.8 || r.metricVsPrevProposed > 1.25)) || (r.countVsPrevProposed != null && (r.countVsPrevProposed < 0.8 || r.countVsPrevProposed > 1.25)));

  const slim = { ...run, queue: undefined, results: undefined };
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    reference: "price_refresh_final_dryrun_2026-10-16.json (cloud-reviewed; 'current' there = pre-refresh-20261016 prices)",
    run: slim,
    counts: {
      referenceDocs: fin.docs.length,
      workerFetched: run.results.length,
      referenceByAction: count(rows, (r) => r.prevAction),
      workerByAction: count(run.results, (r) => r.action),
      sameAction: rows.filter((r) => r.sameAction).length,
      differentAction: diff.length,
    },
    transitions,
    bothUpdateValueDrift: { metricVsPrevProposed: drift("metricVsPrevProposed"), countVsPrevProposed: drift("countVsPrevProposed"), outsideBand_0_8_to_1_25: outsideBand.map((r) => ({ canonical_name: r.canonical_name, metric: r.metricVsPrevProposed, count: r.countVsPrevProposed })) },
    workerOnly,
    differentActionDocs: diff.map((r) => ({ canonical_name: r.canonical_name, prev: `${r.prevAction} (${r.prevReason})`, worker: `${r.workerAction}${r.workerReason ? ` (${r.workerReason})` : ""}`, prevProposedMetric: r.prevProposedMetric, workerMetric: r.workerMetric, prevProposedCount: r.prevProposedCount, workerCount: r.workerCount })),
    docs: rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ out: OUT, counts: report.counts, transitions, bothUpdateValueDrift: { ...report.bothUpdateValueDrift, outsideBand_0_8_to_1_25: outsideBand.length }, workerOnly: workerOnly.length }, null, 1));
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
