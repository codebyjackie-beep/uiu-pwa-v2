// Parity test for src/services/priceRefreshGuard.ts (monthly-cron Part 1).   node scripts/price_refresh_parity.cjs
// Offline: raw listings come from summaries/price_refresh_full_dryrun_2026-10-13.json, the "current" snapshot (state before the
// refresh-20261016 write) from summaries/price_refresh_final_dryrun_2026-10-16.json. The TS module is bundled with esbuild (same
// approach as price_refresh.cjs) and every doc's action/reason/fields/proposed set must equal the reviewed final dry-run.
// Cloud overrides are NOT in the module: for an overridden doc the module result is compared with override.originalAction/Reason.
// Reads canonical_ingredients (aliases / reference_pack) and canonical_price_cache (protection rule) from Mongo, READ-ONLY.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const FULL = path.join(SUMMARIES, "price_refresh_full_dryrun_2026-10-13.json");
const FINAL = path.join(SUMMARIES, "price_refresh_final_dryrun_2026-10-16.json");
const OUT = path.join(SUMMARIES, "price_refresh_parity_2026-10-16.json");

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
async function loadGuard() {
  const { build } = require("esbuild");
  const outFile = path.join(API_ROOT, "scripts", "_parity_bundle.mjs");
  try {
    await build({ entryPoints: [path.join(API_ROOT, "src/services/priceRefreshGuard.ts")], bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent" });
    return await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}
const j = (x) => JSON.stringify(x);

(async () => {
  const G = await loadGuard();
  const env = loadDevVars();
  const full = JSON.parse(fs.readFileSync(FULL, "utf8"));
  const fin = JSON.parse(fs.readFileSync(FINAL, "utf8"));
  const fullByName = new Map(full.docs.map((d) => [d.canonical_name, d]));
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const canonByName = new Map((await db.collection("canonical_ingredients").find({}).toArray()).map((d) => [d.canonical_name, d]));
  const liveByName = new Map((await db.collection("canonical_price_cache").find({}).toArray()).map((d) => [d.canonical_name, d]));
  await client.close();

  const mismatches = [];
  const tally = { normal: 0, normalOk: 0, normalOverride: 0, stock: 0, stockOk: 0, protected: 0, protectedOk: 0, other: 0 };
  const byAction = {};
  const bad = (name, what, a, b) => mismatches.push({ canonical_name: name, what, module: a, expected: b });

  // ---- normal docs --------------------------------------------------------------------------------
  for (const f of fin.docs) {
    byAction[f.action] = (byAction[f.action] || 0) + 1;
    if (f.family !== "normal") continue;
    tally.normal += 1;
    const src = fullByName.get(f.canonical_name);
    if (!src || !Array.isArray(src.listings)) { bad(f.canonical_name, "no listings in 10-13 full dry-run", null, null); continue; }
    const raw = src.listings.map((l) => ({ store: l.store, title: l.title, price: l.price }));
    const canon = canonByName.get(f.canonical_name);
    const referencePack = canon?.reference_pack || null;
    const ctx = { matcher: G.makeTitleMatcher(canon, { canonical_name: f.canonical_name }), referencePack };
    const { g, decision, ambiguityFallback } = G.evaluateListings(raw, f.current, ctx);
    const baseline = G.computeBaseline(raw, referencePack);
    const ov = f.override && !f.override.skipped ? f.override : null;
    if (ov) tally.normalOverride += 1;
    const expAction = ov ? ov.originalAction : f.action;
    const expReason = ov ? ov.originalReason : f.reason;
    let ok = true;
    const chk = (what, a, b) => { if (j(a) !== j(b)) { ok = false; bad(f.canonical_name, what, a, b); } };
    chk("action", decision.action, expAction);
    chk("reason", decision.reason, expReason);
    chk("guarded.per_unit_metric", g.per_unit_metric, f.guarded.per_unit_metric);
    chk("guarded.per_unit_count", g.per_unit_count, f.guarded.per_unit_count);
    chk("guarded.cheapest", g.cheapest, f.guarded.cheapest);
    chk("guarded.confidence", g.confidence, f.guarded.confidence);
    chk("guarded.n_supermarkets", g.n_supermarkets, f.guarded.n_supermarkets);
    chk("baseline.per_unit_metric", baseline.per_unit_metric, f.baseline.per_unit_metric);
    chk("baseline.per_unit_count", baseline.per_unit_count, f.baseline.per_unit_count);
    chk("listing status/reason", g.rows.map((r) => [r.status, r.reason]), f.listings.map((r) => [r.status, r.reason]));
    chk("ambiguityFallback.chosen", ambiguityFallback ? ambiguityFallback.chosen : null, f.ambiguityFallback ? f.ambiguityFallback.chosen : null);
    if (!ov) {
      chk("fieldsToWrite", decision.fields, f.fieldsToWrite);
      if (decision.action === "update") chk("proposed.set", G.buildUpdateSet(f.canonical_name, g, decision, raw.length, f.fetch.calls ? f.fetch.calls.length : null), f.proposed ? f.proposed.set : null);
    }
    if (ok) tally.normalOk += 1;
  }

  // ---- stock family (type groups re-pooled from the listings the reviewed run recorded) ---------------
  const groupCalc = {};
  for (const t of G.CORE_TYPES) {
    const sg = fin.stockGroups[t];
    if (!sg || !sg.listingsUsed) continue;
    const pooled = [...sg.listingsUsed, ...(sg.listingsDropped || [])].map((l) => ({ store: l.store, title: l.title, price: l.price }));
    const grp = G.buildStockGroup(t, [["pooled", pooled]]);
    groupCalc[t] = grp;
    const chk = (what, a, b) => { if (j(a) !== j(b)) bad(`stockGroup:${t}`, what, a, b); };
    chk("nUsed", grp.nUsed, sg.nUsed);
    chk("medianPerL", grp.medianPerL, sg.medianPerL);
    chk("medianPerMl", grp.medianPerMl, sg.medianPerMl);
    chk("result", grp.result, sg.result);
    chk("nearest", grp.nearest, sg.nearest);
    chk("droppedReasonCounts", grp.droppedReasonCounts, sg.droppedReasonCounts);
  }
  for (const f of fin.docs) {
    if (f.family !== "stock") continue;
    tally.stock += 1;
    const { type } = G.docStockType(f.canonical_name);
    const grp = groupCalc[type];
    let ok = !!grp;
    if (grp) {
      const prop = G.stockProposal(type, grp);
      const act = !grp.nUsed ? "hold_stock" : grp.result === "stock_out_of_range" ? "hold_stock" : "nominal_stock";
      if (act !== f.action) { ok = false; bad(f.canonical_name, "stock action", act, f.action); }
      if (prop && f.proposed && j(prop.set) !== j(f.proposed.set)) { ok = false; bad(f.canonical_name, "stock proposed.set", prop.set, f.proposed.set); }
    } else bad(f.canonical_name, "no stock group", null, null);
    if (ok) tally.stockOk += 1;
  }

  // ---- protected_skip: rule reproduced from the live docs --------------------------------------------
  const protectedNotes = [];
  for (const f of fin.docs) {
    if (f.action !== "protected_skip") { if (f.family !== "normal" && f.family !== "stock") tally.other += 1; continue; }
    tally.protected += 1;
    const d = liveByName.get(f.canonical_name);
    const reasons = d ? G.liveProtectReasons(d) : [];
    if (reasons.length) { tally.protectedOk += 1; if (reasons.join(" | ") !== f.reason) protectedNotes.push({ canonical_name: f.canonical_name, nowReasons: reasons.join(" | "), reviewedReason: f.reason }); }
    else protectedNotes.push({ canonical_name: f.canonical_name, nowReasons: "(not protected by rule now)", reviewedReason: f.reason });
  }
  // docs that are protected now but were not in the reviewed protected list (expected: the 12 nominal_stock docs, written 10-16)
  const finProtected = new Set(fin.docs.filter((x) => x.action === "protected_skip").map((x) => x.canonical_name));
  const newlyProtected = fin.docs.filter((x) => !finProtected.has(x.canonical_name) && liveByName.get(x.canonical_name) && G.liveProtectReasons(liveByName.get(x.canonical_name)).length).map((x) => `${x.canonical_name}[${x.action}]`);

  const total = fin.docs.length;
  const identical = tally.normalOk + tally.stockOk + tally.protectedOk;
  const report = { generatedAt: new Date().toISOString(), total, actionCountsExpected: byAction, tally, identical, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 60), protectedNotes, newlyProtectedSinceReview: newlyProtected };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ total, ...tally, identical, mismatchCount: mismatches.length, protectedNotes: protectedNotes.length, newlyProtectedSinceReview: newlyProtected.length }, null, 1));
  if (mismatches.length) { console.log(JSON.stringify(mismatches.slice(0, 15), null, 1)); process.exit(3); }
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
