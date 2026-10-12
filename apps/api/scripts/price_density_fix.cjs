// Mung bean sprouts price/density fix + affected recipe_cost recompute (cloud 2nd review 2026-10-12, point 3).
//
//   node scripts/price_density_fix.cjs                                   # DRY RUN (read-only) -> summaries/price_density_fix_dryrun_<date>.json
//   node scripts/price_density_fix.cjs --write --from ../../summaries/price_density_fix_dryrun_2026-10-12.json [--batch pdfix-...]
//   node scripts/price_density_fix_rollback.cjs <batch> [--write]       # undo
//
// Workflow (cloud rule): dry-run -> commit the JSON -> STOP for cloud review -> only then --write with the committed file.
// --write re-computes live and ABORTS (nothing written) when anything differs from the reviewed file.
//
// What it changes (all old values kept, nothing deleted from the DB history):
//   1. canonical_price_cache["mung bean sprouts"]: the wrong-product listing "A.Vogel Mung Bean Seeds 40g" (Tesco, £0.0533/g,
//      a seed packet) is removed from `listings`; per_unit_metric / n_supermarkets are re-derived from the remaining listings
//      with the same rule the existing documents follow (verified in `sanity`). Previous values -> `priceFixPrev`, `priceFixBatch`.
//   2. canonical_ingredients["mung bean sprouts"].density_cup 180 -> 104 (USDA FDC 'Mung beans, mature seeds, sprouted, raw':
//      1 cup = 104 g). Previous value -> `densityFixPrev`, `priceDensityFixBatch`.
//   3. recipe_cost: ONLY recipes whose recomputed cost changes are rewritten, using the production costRecipe() with the same
//      inputs as jobs/precomputeRecipeCosts.ts. Previous doc fields -> `costFixPrev`, `costFixBatch`.
// Report-only: spread scan — canonicals whose listings differ by > 5x in £/unit.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const WRITE = process.argv.includes("--write");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const FROM = argAfter("--from");
const TODAY = "2026-10-12";
const OUT_DRYRUN = path.join(SUMMARIES, `price_density_fix_dryrun_${TODAY}.json`);

const TARGET = "mung bean sprouts";
const BAD_LISTING_RE = /mung bean seeds/i; // "A.Vogel Mung Bean Seeds 40g" — a seed packet, not sprouts
const NEW_DENSITY_CUP = 104;
const DENSITY_SOURCE = "USDA FDC 'Mung beans, mature seeds, sprouted, raw': 1 cup = 104 g (was 180) — cloud-specified";
const SPREAD_RATIO = 5;

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

async function loadServices() {
  const { build } = require("esbuild");
  const entryFile = path.join(API_ROOT, "scripts", "_price_density_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_price_density_bundle.mjs");
  fs.writeFileSync(
    entryFile,
    [
      `export { buildAliasIndex, resolve } from "../src/services/ingredientResolver.ts";`,
      `export { costRecipe } from "../src/services/recipeCost.ts";`,
    ].join("\n"),
  );
  try {
    await build({ entryPoints: [entryFile], bundle: true, platform: "node", format: "esm", outfile: outFile, external: ["mongodb"], logLevel: "silent" });
    return await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
  } finally {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const metricValues = (listings) =>
  (listings || []).filter((l) => typeof l.per_unit === "number" && l.pack && l.pack.unit === "g_or_ml").map((l) => l.per_unit);

(async () => {
  const env = loadDevVars();
  const { buildAliasIndex, resolve, costRecipe } = await loadServices();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  try {
    const canonCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const recipesCol = db.collection("recipes");
    const costCol = db.collection("recipe_cost");

    const canonDocs = await canonCol.find({}).toArray();
    const priceDocs = await priceCol.find({}).toArray();
    const recipes = await recipesCol.find({}).toArray();
    const storedCosts = await costCol.find({}).toArray();
    const storedByRecipe = new Map(storedCosts.map((d) => [String(d.recipeId), d]));

    // ---- sanity: which formula do existing price docs follow? -------------------------------------
    const sanity = { docsWithMetric: 0, meanMatches: 0, medianMatches: 0, nMatchesCount: 0, nSupermarketsEqListings: 0, nSupermarketsEqDistinctStores: 0 };
    for (const d of priceDocs) {
      const vals = metricValues(d.listings);
      if (d.per_unit_metric && vals.length) {
        sanity.docsWithMetric += 1;
        if (Math.abs(mean(vals) - d.per_unit_metric.value) <= 1e-4 + 1e-3 * d.per_unit_metric.value) sanity.meanMatches += 1;
        if (Math.abs(median(vals) - d.per_unit_metric.value) <= 1e-4 + 1e-3 * d.per_unit_metric.value) sanity.medianMatches += 1;
        if (d.per_unit_metric.n === vals.length) sanity.nMatchesCount += 1;
      }
      const L = Array.isArray(d.listings) ? d.listings : [];
      if (d.n_supermarkets === L.length) sanity.nSupermarketsEqListings += 1;
      if (d.n_supermarkets === new Set(L.map((l) => l.store)).size) sanity.nSupermarketsEqDistinctStores += 1;
    }

    // ---- the simulated change -------------------------------------------------------------------
    const target = priceDocs.find((d) => d.canonical_name === TARGET);
    const targetCanon = canonDocs.find((d) => d.canonical_name === TARGET);
    if (!target || !targetCanon) throw new Error(`target missing: price doc ${!!target}, canonical ${!!targetCanon}`);
    const problems = [];
    const badListings = (target.listings || []).filter((l) => BAD_LISTING_RE.test(String(l.title)));
    if (badListings.length !== 1) problems.push(`expected exactly 1 bad listing in ${TARGET}, found ${badListings.length}`);
    const keptListings = (target.listings || []).filter((l) => !BAD_LISTING_RE.test(String(l.title)));
    const keptVals = metricValues(keptListings);
    const useMean = sanity.meanMatches >= sanity.medianMatches;
    const newMetric = keptVals.length
      ? { value: r5(useMean ? mean(keptVals) : median(keptVals)), unit: target.per_unit_metric ? target.per_unit_metric.unit : "g_or_ml", n: keptVals.length }
      : null;
    const cheapestRemoved = badListings.some((l) => target.cheapest && l.title === target.cheapest.title && l.store === target.cheapest.store);
    if (cheapestRemoved) problems.push("the removed listing was the `cheapest` — cheapest would need re-deriving (not handled)");
    const newPriceFields = { listings: keptListings, per_unit_metric: newMetric, n_supermarkets: keptListings.length };
    const oldPriceFields = { listings: target.listings, per_unit_metric: target.per_unit_metric ?? null, n_supermarkets: target.n_supermarkets ?? null };

    // the same bad listing under OTHER canonicals (reported, not changed)
    const otherDocsWithBadListing = priceDocs
      .filter((d) => d.canonical_name !== TARGET && (d.listings || []).some((l) => BAD_LISTING_RE.test(String(l.title))))
      .map((d) => ({ canonical_name: d.canonical_name, titles: (d.listings || []).filter((l) => BAD_LISTING_RE.test(String(l.title))).map((l) => l.title) }));

    // ---- cost recompute: current data vs simulated change ----------------------------------------
    const quarantinedNames = new Set(canonDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
    const shimCol = (docs) => ({ find: () => ({ project: () => ({ toArray: async () => docs.filter((d) => d.quarantine !== true) }) }) });
    const index = await buildAliasIndex(shimCol(canonDocs)); // aliases are not touched by this change
    const resolveFn = (raw) => resolve(raw, index);
    const mapBefore = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    const mapAfter = new Map(canonDocs.map((d) => [d.canonical_name, d.canonical_name === TARGET ? { ...d, density_cup: NEW_DENSITY_CUP } : d]));
    const priceBefore = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const priceAfter = new Map(priceDocs.map((d) => [d.canonical_name, d.canonical_name === TARGET ? { ...d, ...newPriceFields } : d]));

    const affected = [];
    let driftVsStored = 0;
    for (const r of recipes) {
      const cb = costRecipe(r, resolveFn, mapBefore, priceBefore, quarantinedNames);
      const ca = costRecipe(r, resolveFn, mapAfter, priceAfter, quarantinedNames);
      const st = storedByRecipe.get(String(r._id));
      if (st && Math.abs((st.basket ?? 0) - cb.basket) > 1e-6) driftVsStored += 1;
      const lineDiffs = [];
      cb.lines.forEach((lb, i) => {
        const la = ca.lines[i];
        if (Math.abs((lb.lineCost || 0) - (la.lineCost || 0)) > 1e-9 || lb.priceable !== la.priceable) {
          lineDiffs.push({
            raw: lb.rawName, canonical: lb.canonical_name ?? null, qty: lb.quantity ?? null, unit: lb.unit ?? null,
            normValue: lb.normValue ?? null, normUnit: lb.normUnit ?? null, perUnit: lb.perUnit ?? null,
            normValueAfter: la.normValue ?? null, perUnitAfter: la.perUnit ?? null,
            costBefore: r4(lb.lineCost || 0), costAfter: r4(la.lineCost || 0),
          });
        }
      });
      if (!lineDiffs.length && Math.abs(cb.basket - ca.basket) < 1e-9) continue;
      affected.push({
        id: String(r._id), title: r.title, isPublic: r.isPublic === true, servings: r.servings ?? null,
        stored: st ? { basket: r4(st.basket ?? 0), perServing: r4(st.perServing ?? 0), adjustedCoveragePct: st.adjustedCoveragePct ?? null } : null,
        before: { basket: r4(cb.basket), perServing: r4(cb.perServing), adjustedCoveragePct: r4(cb.adjustedCoveragePct) },
        after: { basket: r4(ca.basket), perServing: r4(ca.perServing), adjustedCoveragePct: r4(ca.adjustedCoveragePct) },
        lineDiffs,
        afterFull: { // what --write stores (same shape as jobs/precomputeRecipeCosts.ts)
          ...ca,
        },
      });
    }

    // ---- meal-plan impact -----------------------------------------------------------------------
    const planSets = await db.collection("meal_plan_sets").find({}).toArray();
    const affectedById = new Map(affected.map((a) => [a.id, a]));
    const plans = [];
    for (const s of planSets) {
      const entries = await db.collection("meal_plans").find({ planId: s._id }).toArray();
      const hit = entries.filter((e) => affectedById.has(String(e.recipeId)));
      if (!hit.length) continue;
      const sum = (key) => hit.reduce((t, e) => t + affectedById.get(String(e.recipeId))[key].perServing * (e.servings ?? 1), 0);
      plans.push({
        name: s.name, id: String(s._id), isActive: s.isActive === true, entriesAffected: hit.length,
        entries: hit.map((e) => ({ dayIndex: e.dayIndex, mealSlot: e.mealSlot, recipe: affectedById.get(String(e.recipeId)).title, servings: e.servings ?? null,
          perServingBefore: affectedById.get(String(e.recipeId)).before.perServing, perServingAfter: affectedById.get(String(e.recipeId)).after.perServing })),
        affectedEntriesCostBefore: r4(sum("before")), affectedEntriesCostAfter: r4(sum("after")),
      });
    }

    // ---- spread scan (report only) -----------------------------------------------------------------
    const recipeCountByName = new Map(canonDocs.map((d) => [d.canonical_name, d.recipe_count ?? null]));
    const spread = [];
    for (const d of priceDocs) {
      const byUnit = new Map();
      for (const l of d.listings || []) {
        if (typeof l.per_unit !== "number" || !(l.per_unit > 0) || !l.pack) continue;
        const arr = byUnit.get(l.pack.unit) || [];
        arr.push(l);
        byUnit.set(l.pack.unit, arr);
      }
      for (const [unit, ls] of byUnit) {
        if (ls.length < 2) continue;
        const lo = ls.reduce((a, b) => (b.per_unit < a.per_unit ? b : a));
        const hi = ls.reduce((a, b) => (b.per_unit > a.per_unit ? b : a));
        const ratio = hi.per_unit / lo.per_unit;
        if (ratio > SPREAD_RATIO) {
          spread.push({
            canonical_name: d.canonical_name, unit, listings: ls.length, ratio: Math.round(ratio * 10) / 10,
            metricValue: d.per_unit_metric ? d.per_unit_metric.value : null, recipe_count: recipeCountByName.get(d.canonical_name) ?? null,
            low: { store: lo.store, title: lo.title, price: lo.price, per_unit: lo.per_unit },
            high: { store: hi.store, title: hi.title, price: hi.price, per_unit: hi.per_unit },
          });
        }
      }
    }
    spread.sort((a, b) => b.ratio - a.ratio);

    const report = {
      generatedAt: new Date().toISOString(),
      change: {
        priceDoc: { canonical_name: TARGET, removedListings: badListings.map((l) => ({ store: l.store, title: l.title, price: l.price, per_unit: l.per_unit })), before: oldPriceFields, after: newPriceFields, formula: useMean ? "mean" : "median" },
        density: { canonical_name: TARGET, before: targetCanon.density_cup ?? null, after: NEW_DENSITY_CUP, source: DENSITY_SOURCE },
        otherDocsWithBadListing,
      },
      sanity: { ...sanity, priceDocs: priceDocs.length, freshVsStoredBasketDriftRecipes: driftVsStored, recipes: recipes.length },
      problems,
      affectedCount: affected.length,
      affected: affected.map(({ afterFull, ...rest }) => rest),
      affectedAfterFull: affected.map((a) => ({ id: a.id, cost: JSON.parse(JSON.stringify(a.afterFull)) })),
      plans,
      spreadScan: { threshold: SPREAD_RATIO, count: spread.length, items: spread },
    };

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify(report, null, 1));
      console.log(`DRY RUN -> ${OUT_DRYRUN}`);
      console.log(JSON.stringify({
        problems, affectedCount: affected.length, sanity: report.sanity,
        priceMetric: { before: oldPriceFields.per_unit_metric, after: newMetric }, density: report.change.density,
        otherDocsWithBadListing, spreadCount: spread.length,
        affected: report.affected.map((a) => ({ title: a.title, servings: a.servings, stored: a.stored && a.stored.basket, before: a.before.basket, after: a.after.basket, perServing: [a.before.perServing, a.after.perServing] })),
        plans: plans.map((p) => ({ name: p.name, active: p.isActive, entries: p.entriesAffected, before: p.affectedEntriesCostBefore, after: p.affectedEntriesCostAfter })),
      }, null, 1));
      return;
    }

    // ---------------- WRITE (guarded) ----------------
    if (!FROM) throw new Error("--write needs --from <reviewed dry-run json>");
    const reviewed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), FROM), "utf8"));
    const bad = [...problems];
    if (JSON.stringify(reviewed.change.priceDoc.after) !== JSON.stringify(newPriceFields)) bad.push("price doc after-state differs from reviewed file");
    if (reviewed.change.density.after !== NEW_DENSITY_CUP || (reviewed.change.density.before ?? null) !== (targetCanon.density_cup ?? null)) bad.push("density before/after differs from reviewed file");
    const revById = new Map(reviewed.affected.map((a) => [a.id, a]));
    if (revById.size !== affected.length) bad.push(`affected recipe count ${affected.length} != reviewed ${revById.size}`);
    for (const a of affected) {
      const rv = revById.get(a.id);
      if (!rv) { bad.push(`${a.id} ${a.title}: not in reviewed file`); continue; }
      if (rv.after.basket !== a.after.basket || rv.before.basket !== a.before.basket) bad.push(`${a.id} ${a.title}: cost differs from reviewed (${a.before.basket}->${a.after.basket} vs ${rv.before.basket}->${rv.after.basket})`);
    }
    if (bad.length) {
      console.error(["ABORT - guard failures (nothing written):", ...bad.slice(0, 30)].join("\n  "));
      process.exit(1);
    }
    const batch = argAfter("--batch") || `pdfix-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const at = new Date();
    const pr = await priceCol.updateOne(
      { _id: target._id, priceFixBatch: { $exists: false } },
      { $set: { ...newPriceFields, priceFixPrev: oldPriceFields, priceFixBatch: batch, priceFixAt: at } },
    );
    const dr = await canonCol.updateOne(
      { _id: targetCanon._id, priceDensityFixBatch: { $exists: false } },
      { $set: { density_cup: NEW_DENSITY_CUP, densityFixPrev: { density_cup: targetCanon.density_cup ?? null, absent: targetCanon.density_cup === undefined }, priceDensityFixBatch: batch, priceDensityFixAt: at } },
    );
    let costsModified = 0;
    for (const a of affected) {
      const cost = JSON.parse(JSON.stringify(a.afterFull));
      const st = storedByRecipe.get(a.id);
      const prev = st ? (({ _id, ...rest }) => rest)(JSON.parse(JSON.stringify(st))) : null;
      const res = await costCol.updateOne(
        { recipeId: new ObjectId(a.id) },
        { $set: { recipeId: new ObjectId(a.id), ...cost, computedAt: at.toISOString(), priceCacheStamp: st ? st.priceCacheStamp : 0, costFixPrev: prev, costFixBatch: batch } },
        { upsert: true },
      );
      costsModified += (res.modifiedCount || 0) + (res.upsertedCount || 0);
    }
    console.log(`WRITE batch ${batch}: price doc ${pr.modifiedCount}/1, density ${dr.modifiedCount}/1, recipe_cost ${costsModified}/${affected.length}`);
    if (pr.modifiedCount !== 1 || dr.modifiedCount !== 1 || costsModified !== affected.length) process.exitCode = 1;
    const evidence = {
      batch, appliedAt: at.toISOString(), source: path.basename(path.resolve(process.cwd(), FROM)),
      priceDocModified: pr.modifiedCount, densityModified: dr.modifiedCount, recipeCostModified: costsModified,
      requery: {
        price: await priceCol.findOne({ canonical_name: TARGET }, { projection: { listings: 1, per_unit_metric: 1, n_supermarkets: 1 } }),
        density: (await canonCol.findOne({ canonical_name: TARGET }, { projection: { density_cup: 1 } })).density_cup,
        recipeCost: (await costCol.find({ costFixBatch: batch }).project({ recipeId: 1, basket: 1, perServing: 1 }).toArray()).map((d) => ({ recipeId: String(d.recipeId), basket: r4(d.basket), perServing: r4(d.perServing) })),
      },
    };
    const outApplied = path.join(SUMMARIES, `price_density_fix_${batch}_applied.json`);
    fs.writeFileSync(outApplied, JSON.stringify(evidence, null, 1));
    console.log(`evidence -> ${outApplied}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
