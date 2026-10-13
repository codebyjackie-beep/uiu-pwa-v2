// Guarded price refresh — Part 0: READ-ONLY inventory (no Serper, no DB write).
//
//   node scripts/price_refresh_inventory.cjs   -> summaries/price_refresh_inventory_2026-10-13.json
//
// Answers: what is in canonical_price_cache, which docs are hand-touched (protected), what the old refresh did,
// which canonicals matter most to public recipe prices, and the baseline per-serving price distribution.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const OUT = path.join(SUMMARIES, "price_refresh_inventory_2026-10-13.json");
const OLD_REPO = "C:/Project/UseItUp/useitup_backend/src";

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
  const entryFile = path.join(API_ROOT, "scripts", "_pri_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_pri_bundle.mjs");
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

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const trimOutliers = (a) => (a.length < 5 ? a : [...a].sort((x, y) => x - y).slice(1, -1)); // old rule: drop 1 high + 1 low when n>=5
const valuesOf = (listings, unit) =>
  (listings || []).filter((l) => typeof l.per_unit === "number" && l.pack && l.pack.unit === unit).map((l) => l.per_unit);
const close = (a, b) => Math.abs(a - b) <= 1e-4 + 1e-3 * Math.abs(b);
const count = (arr, f) => { const m = {}; for (const x of arr) { const k = String(f(x)); m[k] = (m[k] || 0) + 1; } return m; };

const STANDARD_KEYS = new Set(["_id", "canonical_name", "per_unit_metric", "per_unit_count", "cheapest", "n_supermarkets", "listings", "confidence", "needs_review", "metadata"]);

// Names written by write_curation_round4.cjs PC_UPDATES (parsed from the file, not hand-typed).
function parseRound4PriceUpdates() {
  const src = fs.readFileSync(path.join(__dirname, "write_curation_round4.cjs"), "utf8");
  const start = src.indexOf("const PC_UPDATES");
  if (start === -1) return { names: [], note: "PC_UPDATES not found" };
  const end = src.indexOf("\n];", start);
  const block = src.slice(start, end);
  const names = [...block.matchAll(/canonical_name:\s*"([^"]+)"/g)].map((m) => m[1]);
  const startLine = src.slice(0, start).split("\n").length;
  return { names, file: "apps/api/scripts/write_curation_round4.cjs", fromLine: startLine, note: "§1+§3 canonical_price_cache $set updates, confidence=manual_curated" };
}

(async () => {
  const env = loadDevVars();
  const { buildAliasIndex, resolve, costRecipe } = await loadServices();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  try {
    const canonDocs = await db.collection("canonical_ingredients").find({}).toArray();
    const priceDocs = await db.collection("canonical_price_cache").find({}).toArray();
    const recipes = await db.collection("recipes").find({}).toArray();
    const storedCosts = await db.collection("recipe_cost").find({}).toArray();
    const storedByRecipe = new Map(storedCosts.map((d) => [String(d.recipeId), d]));
    const canonByName = new Map(canonDocs.map((d) => [d.canonical_name, d]));

    // ---- 1. composition ------------------------------------------------------------------------
    const composition = {
      total: priceDocs.length,
      bySource: count(priceDocs, (d) => d.metadata?.source ?? "(no metadata)"),
      byConfidence: count(priceDocs, (d) => d.confidence ?? "(none)"),
      fetchedAt: count(priceDocs, (d) => (d.metadata?.fetched_at ? new Date(d.metadata.fetched_at).toISOString().slice(0, 10) : "(none)")),
      perUnitMetricNull: priceDocs.filter((d) => !d.per_unit_metric).length,
      perUnitCountNull: priceDocs.filter((d) => !d.per_unit_count).length,
      bothNull: priceDocs.filter((d) => !d.per_unit_metric && !d.per_unit_count).length,
      needsReview: priceDocs.filter((d) => d.needs_review === true).length,
      zeroListings: priceDocs.filter((d) => !(d.listings || []).length).length,
      queryUsedDiffersFromCanonical: priceDocs.filter((d) => d.metadata?.query_used && d.metadata.query_used !== d.canonical_name).length,
      topLevelKeyCensus: count(priceDocs.flatMap((d) => Object.keys(d)), (k) => k),
      metadataKeyCensus: count(priceDocs.flatMap((d) => Object.keys(d.metadata || {})), (k) => k),
      canonicalsWithoutPriceDoc: canonDocs.filter((c) => c.quarantine !== true && !priceDocs.some((p) => p.canonical_name === c.canonical_name)).length,
      priceDocsWithoutCanonical: priceDocs.filter((p) => !canonByName.has(p.canonical_name)).map((p) => p.canonical_name),
      priceDocsForQuarantinedCanonical: priceDocs.filter((p) => canonByName.get(p.canonical_name)?.quarantine === true).length,
    };

    // which aggregate formula do the stored docs follow? (Part 1 must reproduce it)
    const formula = { docsWithMetric: 0, plainMean: 0, plainMedian: 0, trimmedMedian: 0, nEqualsRawCount: 0, nEqualsTrimmedCount: 0, noneMatch: [] };
    for (const d of priceDocs) {
      if (!d.per_unit_metric) continue;
      const vals = valuesOf(d.listings, "g_or_ml");
      if (!vals.length) { formula.noneMatch.push({ canonical_name: d.canonical_name, why: "no g_or_ml listing values", stored: d.per_unit_metric.value }); continue; }
      formula.docsWithMetric += 1;
      const v = d.per_unit_metric.value;
      const m1 = close(mean(vals), v), m2 = close(median(vals), v), m3 = close(median(trimOutliers(vals)), v);
      if (m1) formula.plainMean += 1;
      if (m2) formula.plainMedian += 1;
      if (m3) formula.trimmedMedian += 1;
      if (d.per_unit_metric.n === vals.length) formula.nEqualsRawCount += 1;
      if (!m1 && !m2 && !m3) formula.noneMatch.push({ canonical_name: d.canonical_name, stored: v, mean: r5(mean(vals)), median: r5(median(vals)), trimmedMedian: r5(median(trimOutliers(vals))) });
    }
    formula.noneMatchCount = formula.noneMatch.length;
    formula.noneMatch = formula.noneMatch.slice(0, 40);

    // ---- 2. protected list ---------------------------------------------------------------------
    const round4 = parseRound4PriceUpdates();
    const round4Set = new Set(round4.names);
    // Scripts that wrote canonical_price_cache (grep-verified 2026-10-13): see `scriptWriters`.
    const scriptWriters = [
      { file: "apps/api/scripts/write_curation_round4.cjs", effect: "PC_UPDATES $set (+ possible insert of hake)", names: round4.names },
      { file: "apps/api/scripts/price_density_fix.cjs", effect: "mung bean sprouts: listings/per_unit_metric/n_supermarkets, priceFixPrev/priceFixBatch", names: ["mung bean sprouts"] },
      { file: "apps/api/scripts/investigate_recompute_costs_aggregate_quirk.cjs", effect: "TEMP-set sugar per_unit_metric.value then restored to hard-coded 0.00145 (lines 74, 102) — value may differ from the pre-test original", names: ["sugar"] },
    ];
    const scriptNameSet = new Map();
    for (const w of scriptWriters) for (const n of w.names) scriptNameSet.set(n, [...(scriptNameSet.get(n) || []), w.file]);
    const protectedList = [];
    for (const d of priceDocs) {
      const reasons = [];
      if (d.priceFixBatch || d.priceFixPrev) reasons.push(`priceFixBatch=${d.priceFixBatch ?? "?"} (price_density_fix.cjs)`);
      if (!d.metadata || d.metadata.source !== "serper") reasons.push(`metadata.source=${d.metadata?.source ?? "(missing)"}`);
      if (d.confidence === "manual_curated") reasons.push("confidence=manual_curated");
      if (d.curation_note || d.metadata?.curation_note) reasons.push("has curation_note");
      const extra = Object.keys(d).filter((k) => !STANDARD_KEYS.has(k) && k !== "priceFixPrev" && k !== "priceFixBatch" && k !== "priceFixAt" && k !== "curation_note");
      if (extra.length) reasons.push(`non-standard keys: ${extra.join(",")}`);
      if (scriptNameSet.has(d.canonical_name)) reasons.push(`written by script: ${scriptNameSet.get(d.canonical_name).join(", ")}`);
      if (reasons.length) protectedList.push({ canonical_name: d.canonical_name, reasons, confidence: d.confidence ?? null, fetched_at: d.metadata?.fetched_at ?? null });
    }
    const protectedNames = new Set(protectedList.map((p) => p.canonical_name));
    const round4MissingFromProtected = round4.names.filter((n) => !protectedNames.has(n));
    const round4NotInPriceCache = round4.names.filter((n) => !priceDocs.some((p) => p.canonical_name === n));

    // ---- 3. old rules (verified by reading the files) ---------------------------------------------
    const oldRules = {
      repo: "C:\\Project\\UseItUp\\useitup_backend\\src (frozen, read-only)",
      query: { file: `${OLD_REPO}/services/serper_price.service.js`, line: 142, rule: "POST https://google.serper.dev/shopping {q: `${name} price`, gl:'gb', location:'United Kingdom'}; `name` = canonical_name (weekly_price_refresh.js:57, no query_alias used)" },
      whitelist: { file: `${OLD_REPO}/services/serper_price.service.js`, lines: "6-9, 30-34", value: ["tesco", "sainsbury", "asda", "morrisons", "waitrose", "ocado", "iceland", "co-op", "coop", "aldi", "lidl"], rule: "substring match on listing `source`, lowercased" },
      blocklist: { file: `${OLD_REPO}/services/serper_price.service.js`, lines: "11-13, 31-32", value: ["amazon", "ebay"], rule: "source containing these is never a supermarket; NO title/keyword blocklist exists in the old code" },
      packParse: {
        file: `${OLD_REPO}/services/serper_price.service.js`, lines: "15-56",
        rule: "WEIGHT_VOLUME_RE /(\\d+(?:\\.\\d+)?)\\s?(kg|g|l|ml|cl)\\b/i -> g_or_ml (kg,l x1000, cl x10); MULTIPACK_RE /(\\d+)\\s?(?:pack|x|×)\\b/i multiplies qty; no weight but multipack -> {qty:N, unit:'each'}; EACH_RE /\\beach\\b/i -> {1,'each'}; else null. Falls back to canonical_ingredients.reference_pack (source_of_pack='reference').",
      },
      aggregate: {
        file: `${OLD_REPO}/services/serper_price.service.js`, lines: "91-101, 158-170",
        rule: "per_unit = price/pack.qty (rounded 4dp); per dimension (g_or_ml vs each) separately: trimOutliers (n>=5 -> drop 1 lowest + 1 highest) then median; confidence high(>=3 listings & any per_unit) / low(>=1 & per_unit) / price_only(>=1) / none; cheapest = lowest `price` listing (NOT per-unit).",
      },
      retry: { file: `${OLD_REPO}/services/rescue_shared.service.js`, lines: "74-100", rule: "up to 3 attempts (backoff 0/300/600ms) while n_supermarkets == 0 -> up to 3 credits per doc" },
      upsert: { file: `${OLD_REPO}/scripts/weekly_price_refresh.js`, lines: "43-92", rule: "all non-quarantined canonicals; `$set` whole cacheDoc (listings, per_unit_*, cheapest, confidence, needs_review, metadata{source:'serper',query_used,reference_pack_used,raw_listing_count,attempts,fetched_at}) with upsert — overwrites hand curation and writes no previous values" },
      kitchenSinkWarning: "Serper `price` is the *shown* price; no unit-price field is used. Titles are never checked against the ingredient (hence seeds / supplements / multipacks slipping in).",
    };

    // ---- 4/5. costing: baseline distribution + impact ranking -----------------------------------
    const quarantinedNames = new Set(canonDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
    const shimCol = (docs) => ({ find: () => ({ project: () => ({ toArray: async () => docs.filter((d) => d.quarantine !== true) }) }) });
    const index = await buildAliasIndex(shimCol(canonDocs));
    const resolveFn = (raw) => resolve(raw, index);
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));

    const publicRecipes = recipes.filter((r) => r.isPublic === true);
    const bucketOf = (v) => (v == null ? "unavailable" : v < 1 ? "<£1" : v < 3 ? "£1-3" : v < 5 ? "£3-5" : v < 8 ? "£5-8" : ">£8");
    const BUCKETS = ["<£1", "£1-3", "£3-5", "£5-8", ">£8", "unavailable"];
    const baseline = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    const baselineStored = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    const impact = new Map(); // canonical -> { perServingSum, recipes:Set, lines }
    let driftVsStored = 0;
    const perServingByRecipe = [];
    for (const r of publicRecipes) {
      const c = costRecipe(r, resolveFn, canonByName, priceMap, quarantinedNames);
      const ps = typeof c.perServing === "number" && Number.isFinite(c.perServing) && c.perServing > 0 ? c.perServing : null;
      baseline[bucketOf(ps)] += 1;
      const st = storedByRecipe.get(String(r._id));
      const sps = st && typeof st.perServing === "number" && st.perServing > 0 ? st.perServing : null;
      baselineStored[bucketOf(sps)] += 1;
      if (st && Math.abs((st.perServing ?? 0) - (c.perServing ?? 0)) > 1e-6) driftVsStored += 1;
      perServingByRecipe.push({ id: String(r._id), title: r.title, servings: r.servings ?? null, perServing: ps == null ? null : r4(ps), storedPerServing: sps == null ? null : r4(sps) });
      const servings = r.servings > 0 ? r.servings : 1;
      for (const l of c.lines) {
        if (!l.canonical_name || !(l.lineCost > 0)) continue;
        const e = impact.get(l.canonical_name) || { perServingSum: 0, recipes: new Set(), lineCount: 0 };
        e.perServingSum += l.lineCost / servings;
        e.recipes.add(String(r._id));
        e.lineCount += 1;
        impact.set(l.canonical_name, e);
      }
    }
    const spreadOf = (d) => {
      const out = {};
      for (const unit of ["g_or_ml", "each"]) {
        const v = valuesOf(d.listings, unit);
        if (!v.length) continue;
        const lo = Math.min(...v), hi = Math.max(...v);
        out[unit] = { n: v.length, min: r5(lo), median: r5(median(v)), max: r5(hi), spreadRatio: lo > 0 ? Math.round((hi / lo) * 10) / 10 : null };
      }
      return out;
    };
    const ranking = [...impact.entries()]
      .map(([name, e]) => {
        const d = priceMap.get(name);
        return {
          canonical_name: name,
          impactGbpSumPerServing: r4(e.perServingSum),
          publicRecipes: e.recipes.size,
          lines: e.lineCount,
          protected: protectedNames.has(name),
          confidence: d?.confidence ?? null,
          storedMetric: d?.per_unit_metric ?? null,
          storedCount: d?.per_unit_count ?? null,
          cheapest: d?.cheapest ?? null,
          listingSpread: d ? spreadOf(d) : null,
        };
      })
      .sort((a, b) => b.impactGbpSumPerServing - a.impactGbpSumPerServing);
    const impactTotal = ranking.reduce((s, x) => s + x.impactGbpSumPerServing, 0);

    // wide-spread canonicals overall (g_or_ml ratio > 5), with impact — candidates the guard must catch
    const wideSpread = priceDocs
      .map((d) => ({ canonical_name: d.canonical_name, spread: spreadOf(d), impact: impact.get(d.canonical_name)?.perServingSum ?? 0 }))
      .filter((x) => Object.values(x.spread).some((s) => s.spreadRatio && s.spreadRatio > 5))
      .sort((a, b) => b.impact - a.impact)
      .map((x) => ({ ...x, impact: r4(x.impact) }));

    // ---- 3. wrong-price source classification (spread > 5x) ----------------------------------------
    // For every doc whose per-unit spread (g_or_ml or each) exceeds 5x: where do the listings' packs come from
    // (title / reference_pack fallback / unknown), and is the spread explained by reference-pack listings?
    const SUSPECT_TITLE_RE = /\b(seeds?|plants?|grow|kit|supplements?|capsules?|tablets?|powder|pets?|dog|cat|candle|gift|hamper)\b/i;
    const ratioOf = (v) => (v.length >= 2 && Math.min(...v) > 0 ? Math.max(...v) / Math.min(...v) : null);
    const srcTotals = { title: 0, reference: 0, unknown: 0, other: 0 };
    const causeCounts = { resolvedByOutlierRule_3x: 0, reference_pack_explains: 0, reference_pack_involved_not_sufficient: 0, multipack_or_parse: 0, suspect_title_word: 0, no_reference_listing_genuine_or_other: 0 };
    const spreadDocs = [];
    for (const d of priceDocs) {
      const ls = (d.listings || []).filter((l) => typeof l.per_unit === "number" && l.per_unit > 0 && l.pack);
      for (const unit of ["g_or_ml", "each"]) {
        const lu = ls.filter((l) => l.pack.unit === unit);
        const ratio = ratioOf(lu.map((l) => l.per_unit));
        if (!ratio || ratio <= 5) continue;
        const src = count(lu, (l) => l.source_of_pack ?? "other");
        for (const k of Object.keys(src)) srcTotals[k in srcTotals ? k : "other"] += src[k];
        const titleOnly = lu.filter((l) => l.source_of_pack === "title");
        const titleRatio = ratioOf(titleOnly.map((l) => l.per_unit));
        const lo = lu.reduce((a, b) => (b.per_unit < a.per_unit ? b : a));
        const hi = lu.reduce((a, b) => (b.per_unit > a.per_unit ? b : a));
        const refInvolved = lu.some((l) => l.source_of_pack === "reference");
        const extremeIsRef = lo.source_of_pack === "reference" || hi.source_of_pack === "reference";
        const explained = refInvolved && titleOnly.length >= 1 && (titleRatio == null || titleRatio <= 5);
        const suspect = lu.some((l) => SUSPECT_TITLE_RE.test(String(l.title)));
        const multi = [lo, hi].some((l) => /(\d+)\s?(?:pack|x|×)\b/i.test(String(l.title)));
        const medAll = median(lu.map((l) => l.per_unit));
        const kept = lu.filter((l) => l.per_unit <= medAll * 3 && l.per_unit >= medAll / 3);
        const ratioAfterOutlierRule = ratioOf(kept.map((l) => l.per_unit));
        const resolvedByOutlierRule = kept.length >= 1 && (ratioAfterOutlierRule == null || ratioAfterOutlierRule <= 5);
        if (resolvedByOutlierRule) causeCounts.resolvedByOutlierRule_3x += 1;
        let cause;
        if (explained) cause = "reference_pack_explains";
        else if (refInvolved && extremeIsRef) cause = "reference_pack_involved_not_sufficient";
        else if (suspect) cause = "suspect_title_word";
        else if (multi) cause = "multipack_or_parse";
        else cause = "no_reference_listing_genuine_or_other";
        causeCounts[cause] += 1;
        spreadDocs.push({
          canonical_name: d.canonical_name, unit, ratio: Math.round(ratio * 10) / 10, impact: r4(impact.get(d.canonical_name)?.perServingSum ?? 0),
          sourceOfPack: src, titleOnlyRatio: titleRatio == null ? null : Math.round(titleRatio * 10) / 10, cause, resolvedByOutlierRule, ratioAfterOutlierRule: ratioAfterOutlierRule == null ? null : Math.round(ratioAfterOutlierRule * 10) / 10, keptAfterOutlierRule: kept.length,
          reference_pack: canonByName.get(d.canonical_name)?.reference_pack ?? null,
          low: { store: lo.store, title: lo.title, price: lo.price, pack: lo.pack, source_of_pack: lo.source_of_pack, per_unit: lo.per_unit },
          high: { store: hi.store, title: hi.title, price: hi.price, pack: hi.pack, source_of_pack: hi.source_of_pack, per_unit: hi.per_unit },
        });
      }
    }
    spreadDocs.sort((a, b) => b.impact - a.impact);
    const allListings = priceDocs.flatMap((d) => d.listings || []);
    const NAMED_RE = [
      ["broth", /\bbroth\b/i], ["stock", /\bstock\b/i], ["cola", /\bcola\b/i],
      ["chopped/canned tomatoes", /(chopped|canned|tinned|plum) tomato/i],
      ["rice", /(^|\s)rice(\s|$)/i],
    ];
    const NAMED_EXCLUDE = /vinegar|wine|noodle|paper|flour|milk|cake|cracker|pudding|syrup|bran/i;
    const namedGroups = {};
    for (const [label, re] of NAMED_RE) {
      namedGroups[label] = priceDocs
        .filter((d) => re.test(d.canonical_name) && !NAMED_EXCLUDE.test(d.canonical_name))
        .map((d) => ({
          canonical_name: d.canonical_name, confidence: d.confidence, reference_pack: canonByName.get(d.canonical_name)?.reference_pack ?? null,
          per_unit_metric: d.per_unit_metric ?? null, per_unit_count: d.per_unit_count ?? null, cheapest: d.cheapest ?? null,
          sourceOfPack: count(d.listings || [], (l) => l.source_of_pack ?? "other"),
          listings: (d.listings || []).map((l) => ({ store: l.store, title: l.title, price: l.price, pack: l.pack, source_of_pack: l.source_of_pack, per_unit: l.per_unit })),
        }));
    }
    // reference_pack fallback: do those listings ever reach per_unit_metric / per_unit_count?
    // computePerUnit() only aggregates pack.unit === 'g_or_ml' (metric) or 'each' (count); reference_pack units are g / ml / each.
    const refListings = [];
    for (const d of priceDocs) for (const l of d.listings || []) if (l.source_of_pack === "reference") refListings.push({ doc: d, l });
    const refDocs = new Set(refListings.map((x) => x.doc.canonical_name));
    const refAnalysis = {
      listings: refListings.length,
      docs: refDocs.size,
      listingsByPackUnit: count(refListings, (x) => x.l.pack?.unit ?? "(null)"),
      canonicalReferencePackUnits: count(canonDocs.filter((c) => c.reference_pack), (c) => c.reference_pack.unit),
      aggregateEligibleListings: refListings.filter((x) => x.l.pack && (x.l.pack.unit === "g_or_ml" || x.l.pack.unit === "each")).length,
      docsWithAnyAggregateEligibleRefListing: new Set(refListings.filter((x) => x.l.pack && (x.l.pack.unit === "g_or_ml" || x.l.pack.unit === "each")).map((x) => x.doc.canonical_name)).size,
      docsWithBothRefAndTitleListings: priceDocs.filter((d) => (d.listings || []).some((l) => l.source_of_pack === "reference") && (d.listings || []).some((l) => l.source_of_pack === "title")).length,
      docsWithRefListingsButMetricAndCountNull: priceDocs
        .filter((d) => refDocs.has(d.canonical_name) && !d.per_unit_metric && !d.per_unit_count)
        .map((d) => ({ canonical_name: d.canonical_name, refListings: (d.listings || []).filter((l) => l.source_of_pack === "reference").length, reference_pack: canonByName.get(d.canonical_name)?.reference_pack ?? null, publicRecipeImpact: r4(impact.get(d.canonical_name)?.perServingSum ?? 0) })),
      conclusion: "reference_pack listings carry pack.unit g/ml (not g_or_ml), so they are shown in `listings` with a per_unit but never enter per_unit_metric; only 'each' reference packs can reach per_unit_count.",
    };
    // title pack-parse issues (old regexes re-applied to the stored titles of listings whose pack came from the title)
    const WV = /(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i;
    const toBase = { g: 1, ml: 1, kg: 1000, l: 1000, cl: 10 };
    const parseIssues = { nxm_no_space_not_multiplied: [], n_pack_plus_total_weight_multiplied: [], pack_of_n_not_multiplied: [] };
    for (const d of priceDocs) {
      for (const l of d.listings || []) {
        if (l.source_of_pack !== "title" || !l.pack || l.pack.unit !== "g_or_ml") continue;
        const t = String(l.title);
        const wv = t.match(WV);
        if (!wv) continue;
        const single = parseFloat(wv[1]) * toBase[wv[2].toLowerCase()];
        const row = { canonical_name: d.canonical_name, store: l.store, title: t, price: l.price, parsedQty: l.pack.qty, per_unit: l.per_unit, impact: r4(impact.get(d.canonical_name)?.perServingSum ?? 0) };
        const nxm = t.match(/(\d+)\s?[x×]\s?(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i);
        if (nxm && !/(\d+)\s?(?:pack|x|×)\b/i.test(t) && Math.abs(l.pack.qty - single) < 1e-9) { row.likelyQty = parseInt(nxm[1], 10) * parseFloat(nxm[2]) * toBase[nxm[3].toLowerCase()]; parseIssues.nxm_no_space_not_multiplied.push(row); continue; }
        const np = t.match(/\b(\d+)\s?pack\b/i);
        if (np && !nxm && Math.abs(l.pack.qty - single * parseInt(np[1], 10)) < 1e-9 && parseInt(np[1], 10) > 1) { row.note = "multiplier applied to a weight that may already be the pack total"; parseIssues.n_pack_plus_total_weight_multiplied.push(row); continue; }
        const po = t.match(/pack of (\d+)/i);
        if (po && Math.abs(l.pack.qty - single) < 1e-9) { row.likelyQty = single * parseInt(po[1], 10); parseIssues.pack_of_n_not_multiplied.push(row); }
      }
    }
    const parseIssueSummary = Object.fromEntries(Object.entries(parseIssues).map(([k, v]) => [k, { count: v.length, examples: v.sort((a, b) => b.impact - a.impact).slice(0, 25) }]));
    const wrongPriceSources = {
      referencePackAnalysis: refAnalysis,
      titleParseIssues: parseIssueSummary,
      note: "source_of_pack over ALL listings in the cache, then over listings of docs with spread>5x",
      allListings: { total: allListings.length, bySourceOfPack: count(allListings, (l) => l.source_of_pack ?? "other"), noPack: allListings.filter((l) => !l.pack).length },
      spreadGt5: { docUnitCount: spreadDocs.length, listingsBySourceOfPack: srcTotals, causeCounts, docs: spreadDocs },
      namedGroups,
    };

    const report = {
      generatedAt: new Date().toISOString(),
      wrongPriceSources,
      composition,
      aggregateFormulaCheck: formula,
      protected: {
        count: protectedList.length,
        memoryClaim: "9 人手 doc (memory.md)",
        round4PriceUpdateNames: round4,
        round4MissingFromProtected,
        round4NotInPriceCache,
        scriptWriters: scriptWriters.map(({ names, ...w }) => ({ ...w, names })),
        items: protectedList,
      },
      oldRules,
      impact: {
        publicRecipes: publicRecipes.length,
        canonicalsWithCost: ranking.length,
        totalImpactGbpSumPerServing: r4(impactTotal),
        top30: ranking.slice(0, 30),
        top30ShareOfTotal: r4(ranking.slice(0, 30).reduce((s, x) => s + x.impactGbpSumPerServing, 0) / (impactTotal || 1)),
        top30ProtectedCount: ranking.slice(0, 30).filter((x) => x.protected).length,
      },
      wideSpreadCanonicals: { threshold: 5, count: wideSpread.length, top40ByImpact: wideSpread.slice(0, 40) },
      baselinePerServing: {
        method: "costRecipe() live, isPublic===true; perServing>0 else 'unavailable' (recipePerServingPrice rule)",
        publicRecipes: publicRecipes.length,
        distribution: baseline,
        storedRecipeCostDistribution: baselineStored,
        freshVsStoredPerServingDriftRecipes: driftVsStored,
        perRecipe: perServingByRecipe,
      },
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    console.log(`inventory -> ${OUT}`);
    console.log(JSON.stringify({
      composition: { total: composition.total, bySource: composition.bySource, byConfidence: composition.byConfidence, fetchedAt: composition.fetchedAt, perUnitMetricNull: composition.perUnitMetricNull, perUnitCountNull: composition.perUnitCountNull, bothNull: composition.bothNull, needsReview: composition.needsReview, zeroListings: composition.zeroListings, queryUsedDiffers: composition.queryUsedDiffersFromCanonical, canonicalsWithoutPriceDoc: composition.canonicalsWithoutPriceDoc, priceDocsWithoutCanonical: composition.priceDocsWithoutCanonical, quarantinedWithPriceDoc: composition.priceDocsForQuarantinedCanonical },
      topLevelKeys: composition.topLevelKeyCensus,
      formula: { docsWithMetric: formula.docsWithMetric, plainMean: formula.plainMean, plainMedian: formula.plainMedian, trimmedMedian: formula.trimmedMedian, noneMatch: formula.noneMatchCount },
      protected: { count: protectedList.length, names: protectedList.map((p) => `${p.canonical_name} [${p.reasons.join(" | ")}]`), round4MissingFromProtected, round4NotInPriceCache },
      impact: { publicRecipes: publicRecipes.length, canonicalsWithCost: ranking.length, top30ProtectedCount: report.impact.top30ProtectedCount, top30Share: report.impact.top30ShareOfTotal },
      baseline, baselineStored, driftVsStored, wideSpreadCount: wideSpread.length,
    }, null, 1));
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
