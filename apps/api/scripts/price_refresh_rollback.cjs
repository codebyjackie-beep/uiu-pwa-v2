// Roll back a price_refresh.cjs batch (refresh-YYYYMMDD) or a Worker auto-refresh batch (refresh-auto-YYYYMMDD[-n]).
//   node scripts/price_refresh_rollback.cjs <batch> [--verify <dry-run JSON> | --verify-run <runId>] [--write]
// --verify-run reads results[].cur from the `price_refresh_runs` doc (the Worker stores the pre-write snapshot there); the marker
// fields (refreshBatch / refreshPrev / refreshAt) are identical for both producers, so the restore logic is shared.
// Dry run by default: computes, per doc, what the restore would produce from `refreshPrev` and (with --verify)
// proves it equals the `current` snapshot recorded in the reviewed dry-run JSON. Nothing is written without --write.
// Restores on canonical_price_cache: per_unit_metric / per_unit_count / cheapest / n_supermarkets / listings /
// confidence / needs_review / price_basis / curation_note / metadata from refreshPrev, then removes
// refreshPrev / refreshBatch / refreshAt. Fields that were null in the snapshot: metric / count / cheapest are
// restored as explicit null (that is how untouched docs store them); needs_review / price_basis / curation_note /
// n_supermarkets / listings are $unset (absent before the refresh).
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const argv = process.argv.slice(2);
const batch = argv[0];
const WRITE = argv.includes("--write");
const vi = argv.indexOf("--verify");
const verifyPath = vi >= 0 ? argv[vi + 1] : null;
const vri = argv.indexOf("--verify-run");
const verifyRunId = vri >= 0 ? argv[vri + 1] : null;
if (!batch || batch.startsWith("--")) {
  console.error("usage: node scripts/price_refresh_rollback.cjs <batch> [--verify <dry-run JSON>] [--write]");
  process.exit(1);
}

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

const EXPLICIT_NULL = ["per_unit_metric", "per_unit_count", "cheapest"];
const UNSET_WHEN_NULL = ["n_supermarkets", "listings", "confidence", "needs_review", "price_basis", "curation_note"];
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9);

function restorePlan(d) {
  const prev = d.refreshPrev;
  const $set = {};
  const $unset = { refreshPrev: "", refreshBatch: "", refreshAt: "" };
  for (const k of EXPLICIT_NULL) $set[k] = prev[k] ?? null;
  for (const k of UNSET_WHEN_NULL) {
    if (prev[k] === null || prev[k] === undefined) $unset[k] = "";
    else $set[k] = prev[k];
  }
  if (prev.metadata) $set.metadata = prev.metadata; // restores fetched_at and every other metadata key as it was
  return { $set, $unset };
}
function snapshotAfter(d, plan) {
  const v = (k) => (k in plan.$set ? plan.$set[k] : (k in plan.$unset ? null : d[k] ?? null));
  const md = plan.$set.metadata || d.metadata;
  return {
    metric: v("per_unit_metric") ? v("per_unit_metric").value : null,
    count: v("per_unit_count") ? v("per_unit_count").value : null,
    cheapestPrice: v("cheapest") ? v("cheapest").price : null,
    n_supermarkets: v("n_supermarkets"),
    confidence: v("confidence"),
    fetched_at: md && md.fetched_at ? new Date(md.fetched_at).toISOString() : null,
  };
}

(async () => {
  const env = loadDevVars();
  let verify = verifyPath ? new Map(JSON.parse(fs.readFileSync(path.resolve(verifyPath), "utf8")).docs.map((x) => [x.canonical_name, x.current])) : null;
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    if (verifyRunId) {
      const run = await client.db(env.MONGODB_DB).collection("price_refresh_runs").findOne({ runId: verifyRunId });
      if (!run) throw new Error(`ABORT: run ${verifyRunId} not found in price_refresh_runs`);
      if (run.batch !== batch) throw new Error(`ABORT: run ${verifyRunId} wrote batch ${run.batch}, not ${batch}`);
      verify = new Map(run.results.filter((x) => x.written === true && x.cur).map((x) => [x.name, x.cur]));
    }
    const col = client.db(env.MONGODB_DB).collection("canonical_price_cache");
    const docs = await col.find({ refreshBatch: batch }).toArray();
    console.log(`batch ${batch} (${WRITE ? "WRITE" : "dry run"}): ${docs.length} docs carry the marker`);
    if (!docs.length) return;
    const noPrev = docs.filter((d) => !d.refreshPrev);
    if (noPrev.length) throw new Error(`ABORT: ${noPrev.length} doc(s) have refreshBatch but no refreshPrev (${noPrev.slice(0, 5).map((d) => d.canonical_name).join(", ")})`);
    let ok = 0;
    const bad = [];
    const plans = docs.map((d) => ({ d, plan: restorePlan(d) }));
    if (verify) {
      for (const { d, plan } of plans) {
        const cur = verify.get(d.canonical_name);
        if (!cur) { bad.push({ canonical_name: d.canonical_name, why: "not in --verify JSON" }); continue; }
        const s = snapshotAfter(d, plan);
        const eq = same(s.metric, cur.metric ? cur.metric.value : null) && same(s.count, cur.count ? cur.count.value : null) &&
          same(s.cheapestPrice, cur.cheapest ? cur.cheapest.price : null) && s.n_supermarkets === cur.n_supermarkets &&
          s.confidence === cur.confidence && s.fetched_at === cur.fetched_at;
        if (eq) ok++; else bad.push({ canonical_name: d.canonical_name, restored: s, dryRunCurrent: cur });
      }
      console.log(JSON.stringify({ verifiedAgainst: verifyPath || (verifyRunId ? "run:" + verifyRunId : null), docs: docs.length, restoredEqualsPreRefresh: ok, mismatches: bad.length }, null, 1));
      if (bad.length) console.log(JSON.stringify(bad.slice(0, 10), null, 1));
    }
    const changed = plans.filter(({ d }) => d.refreshBatch === batch).length;
    console.log(`would restore ${changed} docs; sample:`);
    for (const { d, plan } of plans.slice(0, 5)) {
      const s = snapshotAfter(d, plan);
      console.log(`  ${d.canonical_name}: metric ${d.per_unit_metric ? d.per_unit_metric.value : null} -> ${s.metric}, count ${d.per_unit_count ? d.per_unit_count.value : null} -> ${s.count}, fetched_at ${d.metadata && d.metadata.fetched_at ? new Date(d.metadata.fetched_at).toISOString() : null} -> ${s.fetched_at}`);
    }
    if (bad.length) throw new Error(`ABORT: ${bad.length} doc(s) would not restore to the pre-refresh snapshot`);
    if (!WRITE) { console.log("dry run only; re-run with --write to apply"); return; }
    let n = 0;
    for (const { d, plan } of plans) {
      n += (await col.updateOne({ _id: d._id, refreshBatch: batch }, { $set: plan.$set, $unset: plan.$unset })).modifiedCount;
    }
    console.log(`rolled back ${n}/${docs.length}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
