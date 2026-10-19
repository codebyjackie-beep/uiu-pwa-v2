// "Price unavailable" reduction (cc_prompt_unpriced_lines_fix.md, Parts B + C). Cloud workflow: dry-run -> commit JSON -> STOP for cloud review -> write.
//
//   node scripts/unpriced_fix.cjs                                              # DRY RUN (read-only DB, 0 Serper calls) -> summaries/unpriced_fix_dryrun_<date>.json
//   node scripts/unpriced_fix.cjs --write --from ../../summaries/unpriced_fix_dryrun_<date>.json --price-batch unpriced-<yyyymmdd> --canon-batch canonfix-<yyyymmdd> [--include id,id]
//   node scripts/unpriced_fix_rollback.cjs --price-batch <b> --canon-batch <b> [--write]
//
// Evidence: cached listings (canonical_price_cache) + the raw Serper listings stored by unpriced_fix_fetch.cjs (summaries/unpriced_fix_serper_<date>.json),
// so neither the dry-run nor the write ever calls Serper. recipeCost.ts is NOT touched.
//
// Items carry a tier:
//   spec           = cloud's Part C table, applied as specified
//   recommended    = Part B price docs / density the dry-run recommends writing (written by default in --write)
//   needs_decision = single-source, alias, or judgement items: simulated, but written only when named in --include (alias = $addToSet on the target doc's aliases)
// recipe_cost docs are NOT written here: after the price / canonical write, run recipe_cost_recompute.cjs (dry-run -> review -> --write --batch rcr-<date>).
// --write re-computes everything live and ABORTS (nothing written) when any item differs from the reviewed file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const TODAY = new Date().toISOString().slice(0, 10);
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes("--write");
const FROM = argAfter("--from");
const INCLUDE = new Set((argAfter("--include") || "").split(",").map((s) => s.trim()).filter(Boolean));
const OUT_DRYRUN = path.join(SUMMARIES, `unpriced_fix_dryrun_${TODAY}.json`);
const SERPER_FILE = path.join(SUMMARIES, "unpriced_fix_serper_2026-10-19.json");

// mirrors recipe_cost_recompute.cjs / packages/shared costDisplayTier
const FULL_PCT = 80;
const MIN_PCT = 50;
const tierOf = (pct) => (pct == null || !Number.isFinite(pct) ? "unavailable" : pct >= FULL_PCT ? "full" : pct >= MIN_PCT ? "partial" : "unavailable");
const BUCKETS = [{ key: "under1_5", test: (p) => p < 1.5 }, { key: "1_5to3", test: (p) => p >= 1.5 && p < 3 }, { key: "3plus", test: (p) => p >= 3 }];
const PER_SERVING_MAX = 8;
const DROP_MAX = 0.5;
const CREAMY_PRAWN_RISOTTO = "69d1933f0ce7d5269f695274";

const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
  const entryFile = path.join(API_ROOT, "scripts", "_unpriced_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_unpriced_bundle.mjs");
  fs.writeFileSync(
    entryFile,
    [
      `export { buildAliasIndex, resolve } from "../src/services/ingredientResolver.ts";`,
      `export { costRecipe } from "../src/services/recipeCost.ts";`,
      `export * as G from "../src/services/priceRefreshGuard.ts";`,
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

// ------------------------------------------------------------------------------------------------
// evidence helpers
// ------------------------------------------------------------------------------------------------
const UK = ["tesco", "sainsbury", "asda", "morrisons", "waitrose", "ocado", "iceland", "co-op", "coop", "aldi", "lidl"];
const storeKey = (s) => UK.find((u) => String(s || "").toLowerCase().includes(u)) || String(s || "").toLowerCase();
const dedupKey = (l) => `${storeKey(l.store)}|${String(l.title || "").toLowerCase().trim()}`;
const priceNum = (p) => (typeof p === "number" ? p : Number(String(p).replace(/[^0-9.]/g, "")));
const hasTitleSize = (t) => /\b\d+(?:\.\d+)?\s?(?:g|kg|ml|l|cl)\b/i.test(String(t || ""));

/** serper listings for a canonical; `onlyFirstQueryOrSized` keeps q[1] listings only if they carry a size in the title or already appear in q[0]. */
function serperFor(serper, canonical, { onlyFirstQueryOrSized = false } = {}) {
  const qs = (serper.byCanonical[canonical] || []);
  const out = new Map();
  qs.forEach((q, qi) => {
    for (const l of q.listings) {
      const k = dedupKey(l);
      if (qi > 0 && onlyFirstQueryOrSized && !out.has(k) && !hasTitleSize(l.title)) continue;
      if (!out.has(k)) out.set(k, { store: l.store, title: l.title, price: priceNum(l.price), from: `serper:${q.q}` });
    }
  });
  return [...out.values()];
}
const cachedFor = (doc) => (doc && Array.isArray(doc.listings) ? doc.listings : []).map((l) => ({ store: l.store, title: l.title, price: priceNum(l.price), from: "cache" }));
/** merge: later arrays win on (store,title) so fresh Serper prices replace the cached ones */
function mergeListings(...arrs) {
  const m = new Map();
  for (const a of arrs) for (const l of a) m.set(dedupKey(l), l);
  return [...m.values()];
}

// ------------------------------------------------------------------------------------------------
// the change set
// ------------------------------------------------------------------------------------------------
function buildItems(ctx) {
  const { G, canonMap, priceMap, serper } = ctx;
  const items = [];
  const getPrice = (n) => priceMap.get(n);
  const prevPrice = (d) => ({
    per_unit_metric: d.per_unit_metric ?? null, per_unit_count: d.per_unit_count ?? null, cheapest: d.cheapest ?? null, n_supermarkets: d.n_supermarkets ?? null,
    listings: d.listings ?? [], confidence: d.confidence ?? null, needs_review: d.needs_review ?? null, curation_note: d.curation_note ?? null,
  });

  // ---- Part C (spec) ----------------------------------------------------------------------------
  const SPEC = [
    ["parmesan", "density_cup", 100, "USDA FoodData Central, Cheese, parmesan, grated: 1 cup = 100 g"],
    ["cornflour", "density_cup", 128, "USDA FoodData Central, Cornstarch: 1 cup = 128 g"],
    ["agave nectar", "density_cup", 336, "USDA FoodData Central, Syrups, agave: 1 tbsp = 21 g (=> 1 cup = 336 g)"],
    ["chicken", "density_cup", 140, "USDA FoodData Central, Chicken, cooked, chopped: 1 cup = 140 g"],
    ["juice of lemon", "per_item_g", 48, "USDA FoodData Central, Lemon juice, raw: juice of 1 lemon = 48 g"],
    ["thumb sized ginger", "per_item_g", 11, "USDA FoodData Central, Ginger root, raw: 1 inch piece (thumb) = 11 g"],
    ["ginger", "per_item_g", 11, "USDA FoodData Central, Ginger root, raw: 1 inch piece (thumb) = 11 g"],
  ];
  for (const [name, field, value, source] of SPEC) items.push({ id: `canon:${name}:${field}`, kind: "canon", tier: "spec", target: name, field, value, source });

  // ---- Part B: guard-computed price docs -------------------------------------------------------
  const guardItem = ({ name, refPack, dropRe, listings, tier, note, extra }) => {
    const raw = listings.filter((l) => !(dropRe && dropRe.test(l.title))).map((l) => ({ store: l.store, title: l.title, price: l.price }));
    const gctx = { matcher: () => ({ ok: true }), referencePack: refPack };
    const g = G.computeGuarded(raw, gctx, "exclude");
    const real = G.makeTitleMatcher(canonMap.get(name), getPrice(name));
    const doc = getPrice(name);
    const kept = g.rows.filter((r) => r.status === "kept");
    const set = {
      per_unit_metric: g.per_unit_metric, per_unit_count: g.per_unit_count, cheapest: g.cheapest, n_supermarkets: g.n_supermarkets,
      listings: g.rows.filter((r) => r.status === "kept" || r.status === "ambiguous").map((r) => ({ store: r.store, title: r.title, price: r.price, pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit })),
      confidence: "manual_curated", needs_review: false,
    };
    const dim = g.per_unit_metric ? "per_unit_metric" : "per_unit_count";
    const v = g[dim];
    set.curation_note = `unpriced-fix ${TODAY}: ${dim === "per_unit_metric" ? "£/g" : "£/each"} = median of ${v ? v.n : 0} UK supermarket listings (cached + Serper ${TODAY}); ${note}; cheapest listing: ${g.cheapest ? `${g.cheapest.store} "${g.cheapest.title}" £${g.cheapest.price}` : "n/a"}`;
    return {
      id: `price:${name}`, kind: "price", tier, target: name, set, before: prevPrice(doc), refPack, dim, value: v,
      evidence: { rows: g.rows.map((r) => ({ store: r.store, title: r.title, price: r.price, status: r.status, reason: r.reason, pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit, realTitleMatcherOk: real(r.title).ok })), dropped: listings.filter((l) => dropRe && dropRe.test(l.title)).map((l) => l.title) },
      ...(extra || {}),
    };
  };

  const sesame = "sesame seeds (for garnish)";
  items.push(guardItem({
    name: sesame, refPack: { qty: 100, unit: "g_or_ml" }, dropRe: /ottogi|roasted/i, tier: "recommended",
    listings: mergeListings(cachedFor(getPrice(sesame)), serperFor(serper, sesame)),
    note: "pack = canonical reference_pack 100 g (own-brand sesame seed jars; no sizes in Shopping titles); Ottogi roasted sesame (Korean product) dropped",
  }));
  items.push(guardItem({
    name: "arborio rice", refPack: { qty: 500, unit: "g_or_ml" }, dropRe: null, tier: "recommended",
    listings: serperFor(serper, "arborio rice", { onlyFirstQueryOrSized: true }),
    note: "pack assumed 500 g for the unsized hits of the '500g' query (no canonical reference_pack); title sizes win (Tesco Risotto Rice 1Kg); only today's Serper hits used (cached ones have no size)",
  }));
  items.push(guardItem({
    name: "eggplant", refPack: { qty: 1, unit: "each" }, dropRe: /organic|natoora|daylesford|wholegood|yarden|\d+\s?g\b/i, tier: "recommended",
    listings: serperFor(serper, "eggplant"),
    note: "UK name aubergine; priced per each (titles 'Aubergine Each'); organic / specialty / sized-by-weight listings dropped",
  }));
  for (const name of ["arugula", "baby arugula"]) {
    items.push(guardItem({
      name, refPack: { qty: 60, unit: "g_or_ml" }, dropRe: /salad|babyleaf/i, tier: "recommended",
      listings: serperFor(serper, "arugula"),
      note: "UK name wild rocket; 2 listings state 60 g in the title (Tesco Wild Rocket 60G, Fresh & Naked Wild Rocket 60g), unsized own-brand wild rocket bags assumed 60 g; mixed 'salad' / babyleaf bags dropped",
    }));
  }

  // fresh ginger: copy of the live `ginger` doc (n=7, high, Tesco/Sainsbury's Ginger 100g titled listings)
  {
    const gdoc = getPrice("ginger");
    const fdoc = getPrice("fresh ginger");
    const v = gdoc && gdoc.per_unit_metric ? gdoc.per_unit_metric.value : null;
    items.push({
      id: "price:fresh ginger", kind: "price", tier: "recommended", target: "fresh ginger",
      set: {
        per_unit_metric: v != null ? { value: v, unit: "g_or_ml", n: gdoc.per_unit_metric.n } : null, per_unit_count: null,
        cheapest: gdoc ? gdoc.cheapest : null, n_supermarkets: fdoc ? fdoc.n_supermarkets : null, listings: fdoc ? fdoc.listings : [],
        confidence: "manual_curated", needs_review: false,
        curation_note: `unpriced-fix ${TODAY}: £/g copied from the sibling canonical "ginger" (${gdoc && gdoc.per_unit_metric ? `n=${gdoc.per_unit_metric.n}, ${gdoc.confidence}` : "n/a"}; Tesco Ginger 100g £1.25 / Sainsbury's Ginger 100g £1.25 titled listings). NOT derived from the cached "Sainsbury's Root Ginger Loose £5.60" (that is a per-kg price; reading it as the 100 g reference pack would be 10x too high).`,
      },
      before: fdoc ? prevPrice(fdoc) : null, refPack: null, dim: "per_unit_metric", value: v ? { value: v, n: gdoc.per_unit_metric.n } : null,
      evidence: { sibling: "ginger", siblingMetric: gdoc ? gdoc.per_unit_metric : null, siblingCheapest: gdoc ? gdoc.cheapest : null, trapRejected: "Sainsbury's Root Ginger Loose £5.60 x reference pack 100 g = £0.056/g (10x)" },
    });
  }

  // ---- extra canonical fields the price docs above need to price the recipe units -------------------
  items.push({ id: "canon:fresh ginger:density_cup", kind: "canon", tier: "recommended", target: "fresh ginger", field: "density_cup", value: 96, source: "USDA FoodData Central, Ginger root, raw: 1 tbsp (grated) = 6 g (=> 1 cup = 96 g); same value as the existing `ginger` canonical" });
  for (const name of ["arugula", "baby arugula"]) items.push({ id: `canon:${name}:density_cup`, kind: "canon", tier: "recommended", target: name, field: "density_cup", value: 20, source: "USDA FoodData Central, Arugula, raw: 1 cup = 20 g" });

  // ---- needs_decision ------------------------------------------------------------------------------
  {
    const name = "ancho chile powder";
    const sized = serperFor(serper, name).filter((l) => hasTitleSize(l.title));
    const m = sized.find((l) => /M&S/.test(l.title));
    const doc = getPrice(name);
    const v = m ? Math.round((m.price / 25) * 1e5) / 1e5 : null;
    items.push({
      id: `price:${name}`, kind: "price", tier: "needs_decision", target: name,
      set: {
        per_unit_metric: v != null ? { value: v, unit: "g_or_ml", n: 1 } : null, per_unit_count: null,
        cheapest: m ? { store: m.store, price: m.price, title: m.title } : null, n_supermarkets: 1,
        listings: m ? [{ store: m.store, title: m.title, price: m.price, pack: { qty: 25, unit: "g_or_ml" }, source_of_pack: "title", per_unit: v }] : [],
        confidence: "manual_curated", needs_review: false,
        curation_note: `unpriced-fix ${TODAY}: SINGLE sized listing (the ">=2 sized listings" rule is NOT met): Ocado "Cook With M&S Ancho Chilli, 25g" £2.65 = £${v}/g. Cached listings were wrong products (Gran Luchito BBQ / taco seasoning mixes, Waitrose hot chilli powder); Sainsbury's / M&S "Ancho Chilli Flakes" carry no size.`,
      },
      before: prevPrice(doc), refPack: null, dim: "per_unit_metric", value: v != null ? { value: v, n: 1 } : null,
      evidence: { sizedListings: sized, note: "Serper (2 calls) found no second sized ancho listing" },
    });
  }
  // alias scenarios: simulated by remapping the resolved canonical; written (cloud-approved 2026-10-19, via --include) by adding the alias to the `to` doc's aliases
  items.push({ id: "alias:lemon zest->lemon", kind: "alias", tier: "needs_decision", target: "lemon zest", to: "lemon", note: "lemon doc: 10 recipes, high, £0.3625 each, per_item_g 58. '(none)' lines price as one whole lemon; teaspoon lines stay unpriced (lemon has no density_cup)" });
  items.push({ id: "alias:lime zest->lime", kind: "alias", tier: "needs_decision", target: "lime zest", to: "lime", note: "same as lemon zest; lime doc £0.19 each, per_item_g 67" });
  items.push({ id: "alias:lemon juice from a lemon->juice of lemon", kind: "alias", tier: "needs_decision", target: "lemon juice from a lemon", to: "juice of lemon", note: "its own price doc is WRONG (the only listing is 'Waitrose Still Lemonade' £3.75); juice of lemon has density_cup 244, manual £0.0087/ml" });
  return items;
}

// ------------------------------------------------------------------------------------------------
// simulation
// ------------------------------------------------------------------------------------------------
function applyItems(items, base) {
  const canonMap = new Map(base.canonMap);
  const priceMap = new Map(base.priceMap);
  const aliasMap = new Map();
  for (const it of items) {
    if (it.kind === "canon") canonMap.set(it.target, { ...canonMap.get(it.target), [it.field]: it.value });
    else if (it.kind === "price") priceMap.set(it.target, { ...priceMap.get(it.target), ...it.set });
    else if (it.kind === "alias") aliasMap.set(it.target, it.to);
  }
  return { canonMap, priceMap, aliasMap };
}

function simulate(ctx, items) {
  const { recipes, resolveFn, quarantinedNames, costRecipe, base, pantryOf } = ctx;
  const { canonMap, priceMap, aliasMap } = applyItems(items, base);
  const rf = aliasMap.size ? (raw) => { const r = resolveFn(raw); if (r && r.canonical_name && aliasMap.has(r.canonical_name)) return { ...r, canonical_name: aliasMap.get(r.canonical_name) }; return r; } : resolveFn;
  const out = new Map();
  for (const r of recipes) out.set(String(r._id), costRecipe(r, rf, canonMap, priceMap, quarantinedNames));
  return { costs: out, pantryOf: (l) => pantryOf(l, canonMap) };
}

function summarise(sim, recipes, titleById) {
  let totalLines = 0, unpriced = 0, priceUnavailable = 0, pantryShown = 0;
  const reasons = {};
  const tiers = { full: 0, partial: 0, unavailable: 0 };
  const buckets = { under1_5: 0, "1_5to3": 0, "3plus": 0, excluded_no_price_or_unavailable: 0 };
  for (const r of recipes) {
    const c = sim.costs.get(String(r._id));
    for (const l of c.lines) {
      totalLines++;
      if (l.priceable) continue;
      unpriced++;
      reasons[l.reason || "(none)"] = (reasons[l.reason || "(none)"] || 0) + 1;
      if (sim.pantryOf(l)) pantryShown++; else priceUnavailable++;
    }
    const t = tierOf(num(c.adjustedCoveragePct));
    tiers[t]++;
    const ps = num(c.perServing);
    if (ps == null || !(ps > 0) || t === "unavailable") buckets.excluded_no_price_or_unavailable++;
    else buckets[BUCKETS.find((b) => b.test(ps)).key]++;
  }
  return { totalLines, unpricedLines: unpriced, priceUnavailableLinesShown: priceUnavailable, pantryStapleLinesShown: pantryShown, unpricedByReason: reasons, tiers, buckets };
}

function diffRecipes(before, after, recipes) {
  const changed = [], gate = [];
  for (const r of recipes) {
    const id = String(r._id);
    const b = before.costs.get(id), a = after.costs.get(id);
    const lineDiffs = [];
    b.lines.forEach((lb, i) => {
      const la = a.lines[i];
      if (lb.priceable !== la.priceable || Math.abs((lb.lineCost || 0) - (la.lineCost || 0)) > 1e-9) {
        lineDiffs.push({ raw: lb.rawName, canonical: lb.canonical_name ?? la.canonical_name ?? null, qty: lb.quantity ?? null, unit: lb.rawUnit ?? null, beforeReason: lb.priceable ? null : lb.reason, afterReason: la.priceable ? null : la.reason, costBefore: r4(lb.lineCost || 0), costAfter: r4(la.lineCost || 0), norm: la.priceable ? `${r4(la.normValue)} ${la.normUnit}` : null, perUnit: la.priceable ? la.perUnit : null });
      }
    });
    if (!lineDiffs.length) continue;
    const psB = num(b.perServing), psA = num(a.perServing);
    const tB = tierOf(num(b.adjustedCoveragePct)), tA = tierOf(num(a.adjustedCoveragePct));
    const row = { id, title: r.title, servings: r.servings ?? null, perServingBefore: r4(psB), perServingAfter: r4(psA), basketBefore: r4(b.basket), basketAfter: r4(a.basket), coverageBefore: r4(b.adjustedCoveragePct), coverageAfter: r4(a.adjustedCoveragePct), tierBefore: tB, tierAfter: tA, lineDiffs };
    changed.push(row);
    const flags = [];
    if (psA != null && psA > PER_SERVING_MAX) flags.push(`perServing_after > £${PER_SERVING_MAX}`);
    if (psB != null && psB > 0 && psA != null && psA < psB * (1 - DROP_MAX)) flags.push("perServing dropped > 50%");
    if (tA !== tB) flags.push(`tier ${tB} -> ${tA}`);
    if (flags.length) gate.push({ id, title: r.title, flags, perServingBefore: row.perServingBefore, perServingAfter: row.perServingAfter, tierBefore: tB, tierAfter: tA });
  }
  return { changed, gate };
}

// ------------------------------------------------------------------------------------------------
(async () => {
  const env = loadDevVars();
  const { buildAliasIndex, resolve, costRecipe, G } = await loadServices();
  const serper = JSON.parse(fs.readFileSync(SERPER_FILE, "utf8"));
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  try {
    const canonCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const canonDocs = await canonCol.find({}).toArray();
    const priceDocs = await priceCol.find({}).toArray();
    const recipes = await db.collection("recipes").find({ isPublic: true }).toArray();
    const titleById = new Map(recipes.map((r) => [String(r._id), r.title]));
    const storedCosts = await db.collection("recipe_cost").find({ recipeId: { $in: recipes.map((r) => r._id) } }).toArray();
    const storedById = new Map(storedCosts.map((d) => [String(d.recipeId), d]));
    const canonMap = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(canonDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
    const shimCol = (docs) => ({ find: () => ({ project: () => ({ toArray: async () => docs.filter((d) => d.quarantine !== true) }) }) });
    const index = await buildAliasIndex(shimCol(canonDocs));
    const resolveFn = (raw) => resolve(raw, index);
    const pantryOf = (l, cm) => !l.priceable && typeof l.canonical_name === "string" && !!(cm.get(l.canonical_name) && (cm.get(l.canonical_name).is_pantry === true || cm.get(l.canonical_name).pantry_staple === true));

    const base = { canonMap, priceMap };
    const ctx = { G, canonMap, priceMap, serper, recipes, resolveFn, quarantinedNames, costRecipe, base, pantryOf };
    const items = buildItems(ctx);
    for (const it of items) {
      if (it.target === "fresh ginger") it.group = "group:fresh ginger (price + density_cup)";
      else if (it.target === "arugula") it.group = "group:arugula (price + density_cup)";
      else if (it.target === "baby arugula") it.group = "group:baby arugula (price + density_cup)";
    }
    const problems = [];
    for (const it of items) {
      if (it.kind === "canon" && !canonMap.get(it.target)) problems.push(`canonical missing: ${it.target}`);
      if (it.kind === "price" && !priceMap.get(it.target)) problems.push(`price doc missing: ${it.target}`);
      if (it.kind === "price" && !(it.set.per_unit_metric || it.set.per_unit_count)) problems.push(`no per-unit computed for ${it.target}`);
    }

    // ---- baseline + scenarios --------------------------------------------------------------------
    const simBase = simulate(ctx, []);
    let drift = 0;
    for (const r of recipes) { const st = storedById.get(String(r._id)); if (st && Math.abs((st.basket ?? 0) - simBase.costs.get(String(r._id)).basket) > 1e-6) drift++; }
    const sumBase = summarise(simBase, recipes, titleById);
    const tiersOf = (names) => items.filter((it) => names.includes(it.tier));
    const scen = {};
    for (const [name, tiers] of [["spec", ["spec"]], ["spec_plus_recommended", ["spec", "recommended"]], ["all_including_needs_decision", ["spec", "recommended", "needs_decision"]]]) {
      const its = tiersOf(tiers);
      const sim = simulate(ctx, its);
      const d = diffRecipes(simBase, sim, recipes);
      const sum = summarise(sim, recipes, titleById);
      const crr = d.changed.find((c) => c.id === CREAMY_PRAWN_RISOTTO);
      scen[name] = { items: its.map((i) => i.id), summary: sum, recipesChanged: d.changed.length, gateAnomalies: d.gate, gateAnomalyCount: d.gate.length, changed: d.changed.map(({ lineDiffs, ...rest }) => rest), lineDiffsByRecipe: Object.fromEntries(d.changed.map((c) => [c.title, c.lineDiffs])), creamyPrawnRisotto: crr || null };
    }
    // isolated effect per item
    const groupOf = (it) => it.group || it.id;
    const groups = [...new Set(items.map(groupOf))];
    const perItem = groups.map((gid) => {
      const gits = items.filter((i) => groupOf(i) === gid);
      const it = { id: gid, tier: gits[0].tier };
      const sim = simulate(ctx, gits);
      const d = diffRecipes(simBase, sim, recipes);
      const fixed = d.changed.flatMap((c) => c.lineDiffs.filter((l) => l.beforeReason && !l.afterReason).map((l) => ({ recipe: c.title, raw: l.raw, qty: l.qty, unit: l.unit, was: l.beforeReason, cost: l.costAfter })));
      const stillUnpriced = d.changed.flatMap((c) => c.lineDiffs.filter((l) => l.beforeReason && l.afterReason).map((l) => ({ recipe: c.title, raw: l.raw, unit: l.unit, was: l.beforeReason, now: l.afterReason })));
      return { id: it.id, tier: it.tier, linesNowPriced: fixed.length, recipesChanged: d.changed.length, fixed, targetLinesStillUnpriced: stillUnpriced };
    });
    // lines still unpriced for the targets (for the report-only items)
    const targetLines = (name) => {
      const out = [];
      for (const r of recipes) for (const l of simBase.costs.get(String(r._id)).lines) if (l.canonical_name === name) out.push({ recipe: r.title, raw: l.rawName, qty: l.quantity ?? null, unit: l.rawUnit ?? null, priceable: l.priceable, reason: l.reason ?? null });
      return out;
    };
    const reportOnly = {
      cloves: { note: "all 6 public lines are the whole SPICE (clove) - not garlic; NOT changed (cloud instruction)", lines: targetLines("cloves"), canonical: { density_cup: canonMap.get("cloves").density_cup ?? null, per_item_g: canonMap.get("cloves").per_item_g ?? null }, price: priceMap.get("cloves") ? priceMap.get("cloves").per_unit_metric : null },
      egg: { note: "6 unpriced lines have unit 'count' / 'unit' / 'eggs' = reason unmapped_unit. COUNT_REAL_UNITS (recipeCost.ts:36) does not contain them and classifyUnit() has no alias hook, so this CANNOT be fixed with canonical data - needs a 1-line code change (add 'count','unit','eggs' to COUNT_REAL_UNITS). Not done: cloud said do not change recipeCost.ts pricing logic.", lines: targetLines("egg").filter((l) => !l.priceable) },
      bread: { note: "slice(s) is in UNCONVERTIBLE_UNITS (recipeCost.ts:41), classified before any per-item lookup, so 'slice = 36 g' cannot be applied through canonical data (per_item_g would not be consulted). Needs a code change (e.g. PER_ITEM_UNIT_G.slice.bread + remove slice from UNCONVERTIBLE_UNITS). Not done: same rule.", lines: targetLines("bread").filter((l) => !l.priceable) },
      asparagus: { note: "NOT done (cloud: not now). Reasons: 3 cup lines need density_cup (not in Part C), 'stalks'/'spears' lines need a per_item_g (spear weight ~16-20 g; table value is a judgement), 'bunch' is unmapped_unit (needs a code/table entry) - mixed causes, 6 lines in 5 recipes", lines: targetLines("asparagus").filter((l) => !l.priceable) },
      "saffron threads": { note: "NOT done (cloud: not now). Reasons: price doc is manual £10.25/g (0.4 g jar), so any fix is expensive-looking; 3 teaspoon lines need a density (a tsp of threads ~0.7 g) and 3 'pinch' lines hit UNCONVERTIBLE_UNITS (pinch) - code change needed. Even priced a pinch (~0.05 g) is ~£0.5 per line, which can trip the per-serving gate", lines: targetLines("saffron threads").filter((l) => !l.priceable) },
      "plain greek yogurt": { note: "listed as no_price_in_cache but there is NO price doc at all (not a price-only doc) - needs a fresh Serper search (not in this batch)", lines: targetLines("plain greek yogurt") },
    };

    // ---- auto-refresh run state (read-only) ---------------------------------------------------------
    const runs = await db.collection("price_refresh_runs").find({}).sort({ startedAt: -1 }).limit(3).project({ queue: 0, results: 0, listings: 0 }).toArray();
    const report = {
      generatedAt: new Date().toISOString(),
      note: "dry-run only; DB read-only, 0 Serper calls (listings from summaries/unpriced_fix_serper_2026-10-19.json: 12 calls, 24 credits)",
      latestRefreshRuns: runs.map((r) => ({ runId: r.runId, status: r.status, batch: r.batch ?? null, schedule: r.schedule ?? null, startedAt: r.startedAt, updatedAt: r.updatedAt, dryRun: r.dryRun ?? null })),
      baseline: { publicRecipes: recipes.length, ...sumBase, freshVsStoredBasketDriftRecipes: drift },
      problems,
      items: items.map((it) => ({ ...it, effect: perItem.find((p) => p.id === (it.group || it.id)) })),
      scenarios: scen,
      reportOnly,
    };

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify(report, null, 1));
      console.log(`DRY RUN -> ${OUT_DRYRUN}`);
      console.log(JSON.stringify({ problems, latestRefreshRuns: report.latestRefreshRuns, baseline: report.baseline }, null, 1));
      for (const [k, s] of Object.entries(scen)) console.log(k, JSON.stringify({ recipesChanged: s.recipesChanged, unpriced: s.summary.unpricedLines, priceUnavailableShown: s.summary.priceUnavailableLinesShown, tiers: s.summary.tiers, buckets: s.summary.buckets, gate: s.gateAnomalies.map((g) => `${g.title}: ${g.flags.join("; ")} (${g.perServingBefore}->${g.perServingAfter})`) }));
      for (const p of perItem) console.log(`${p.tier.padEnd(14)} ${p.id.padEnd(48)} lines+${p.linesNowPriced} recipes ${p.recipesChanged}`);
      return;
    }

    // ---------------- WRITE (guarded) ----------------
    if (!FROM) throw new Error("--write needs --from <reviewed dry-run json>");
    const priceBatch = argAfter("--price-batch");
    const canonBatch = argAfter("--canon-batch");
    if (!priceBatch || !canonBatch) throw new Error("--write needs --price-batch and --canon-batch");
    const reviewed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), FROM), "utf8"));
    const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
    const bad = [...problems];
    const revById = new Map(reviewed.items.map((i) => [i.id, i]));
    const toWrite = items.filter((it) => it.tier === "spec" || it.tier === "recommended" || INCLUDE.has(it.id));
    for (const it of toWrite) {
      const rv = revById.get(it.id);
      if (!rv) { bad.push(`${it.id}: not in reviewed file`); continue; }
      const mine = it.kind === "alias" ? { target: it.target, to: it.to } : it.kind === "canon" ? { field: it.field, value: it.value } : { set: it.set, before: it.before };
      const theirs = it.kind === "alias" ? { target: rv.target, to: rv.to } : rv.kind === "canon" ? { field: rv.field, value: rv.value } : { set: rv.set, before: rv.before };
      // listings carry no timestamps, so a plain structural compare is stable
      if (hash(mine) !== hash(theirs)) bad.push(`${it.id}: differs from the reviewed file (live data changed since the dry-run) - re-run the dry-run and re-review`);
    }
    for (const id of INCLUDE) if (!items.some((i) => i.id === id)) bad.push(`--include ${id}: unknown item`);
    // protection / marker preconditions
    for (const it of toWrite) {
      if (it.kind === "price") { const d = priceMap.get(it.target); if (d.priceFixBatch || d.curation_note || (typeof d.confidence === "string" && d.confidence.startsWith("manual"))) bad.push(`${it.id}: price doc already curated/protected (${d.confidence}, priceFixBatch=${d.priceFixBatch ?? "-"})`); }
      if (it.kind === "canon" && canonMap.get(it.target).unpricedFixBatch) bad.push(`${it.id}: canonical already has unpricedFixBatch=${canonMap.get(it.target).unpricedFixBatch}`);
      if (it.kind === "alias") {
        // cloud 2026-10-19: an alias = add `target` to the `aliases` of the `to` canonical doc. Pre-verify with the real resolver that the key then resolves to `to`.
        const toDoc = canonMap.get(it.to);
        if (!toDoc) { bad.push(`${it.id}: target canonical "${it.to}" missing`); continue; }
        if (toDoc.aliasFixBatch) bad.push(`${it.id}: "${it.to}" already has aliasFixBatch=${toDoc.aliasFixBatch}`);
        if ((toDoc.aliases || []).some((a) => String(a).toLowerCase() === it.target.toLowerCase())) bad.push(`${it.id}: "${it.to}" already has alias "${it.target}"`);
        const docsAfter = canonDocs.map((d) => (d.canonical_name === it.to ? { ...d, aliases: [...(d.aliases || []), it.target] } : d));
        const r = resolve(it.target, await buildAliasIndex(shimCol(docsAfter)));
        if (!r || r.canonical_name !== it.to) bad.push(`${it.id}: after adding the alias "${it.target}" still resolves to ${r && r.canonical_name} (expected ${it.to}) - collision winner is another doc`);
      }
    }
    if (bad.length) { console.error(["ABORT - guard failures (nothing written):", ...bad.slice(0, 40)].join("\n  ")); process.exit(1); }

    const at = new Date();
    const evidence = { priceBatch, canonBatch, appliedAt: at.toISOString(), source: path.basename(path.resolve(process.cwd(), FROM)), included: [...INCLUDE], price: [], canon: [], overrides: [] };
    let failed = false;
    for (const it of toWrite.filter((i) => i.kind === "price")) {
      const d = priceMap.get(it.target);
      const res = await priceCol.updateOne(
        { _id: d._id, priceFixBatch: { $exists: false } },
        { $set: { ...it.set, priceFixPrev: it.before, priceFixBatch: priceBatch, priceFixAt: at } },
      );
      evidence.price.push({ target: it.target, modified: res.modifiedCount });
      if (res.modifiedCount !== 1) failed = true;
      // overrides are read once at queue build (priceRefresh.ts:195); priceFixBatch/curation_note protection is re-checked at queue build, decide and write (:207/:476/:579). Both are set.
      await db.collection("price_refresh_overrides").updateOne(
        { canonical_name: it.target },
        { $setOnInsert: { canonical_name: it.target, decision: "skip", note: `manual_curated by ${priceBatch}`, ref: "cc_prompt_unpriced_lines_fix Part B", createdAt: at } },
        { upsert: true },
      );
      evidence.overrides.push(it.target);
    }
    const byCanon = new Map();
    for (const it of toWrite.filter((i) => i.kind === "canon")) { const a = byCanon.get(it.target) || []; a.push(it); byCanon.set(it.target, a); }
    for (const [target, its] of byCanon) {
      const d = canonMap.get(target);
      const set = {}, prev = {}, src = {};
      for (const it of its) { set[it.field] = it.value; prev[it.field] = { value: d[it.field] === undefined ? null : d[it.field], absent: d[it.field] === undefined }; src[it.field] = it.source; }
      const res = await canonCol.updateOne(
        { _id: d._id, unpricedFixBatch: { $exists: false } },
        { $set: { ...set, unpricedFixPrev: prev, unpricedFixSource: src, unpricedFixBatch: canonBatch, unpricedFixAt: at } },
      );
      evidence.canon.push({ target, fields: Object.keys(set), modified: res.modifiedCount });
      if (res.modifiedCount !== 1) failed = true;
    }
    // aliases (cloud-approved needs_decision items named in --include): add `target` to the `to` doc's aliases; markers allow an exact rollback
    for (const it of toWrite.filter((i) => i.kind === "alias")) {
      const d = canonMap.get(it.to);
      const res = await canonCol.updateOne(
        { _id: d._id, aliasFixBatch: { $exists: false }, aliases: { $ne: it.target } },
        { $addToSet: { aliases: it.target }, $set: { aliasFixBatch: canonBatch, aliasFixAdded: [it.target], aliasFixAt: at } },
      );
      evidence.alias = evidence.alias || [];
      evidence.alias.push({ id: it.id, alias: it.target, to: it.to, modified: res.modifiedCount });
      if (res.modifiedCount !== 1) failed = true;
      // the alias source's own price doc (e.g. "lemon juice from a lemon" = Waitrose Still Lemonade) is a WRONG product: keep it, flag it, and stop the auto refresh re-fetching it
      const pd = priceMap.get(it.target);
      if (it.target === "lemon juice from a lemon" && pd) {
        const q = await priceCol.updateOne(
          { _id: pd._id, quarantine_note: { $exists: false } },
          { $set: { quarantine_note: `unpriced-fix ${TODAY}: WRONG PRODUCT - the only listing is "Waitrose Still Lemonade" £3.75, not lemon juice. Line names now alias to "juice of lemon" (${canonBatch}); do not price from this doc.`, quarantineNoteBatch: priceBatch } },
        );
        await db.collection("price_refresh_overrides").updateOne(
          { canonical_name: it.target },
          { $setOnInsert: { canonical_name: it.target, decision: "skip", note: `manual_curated by ${priceBatch}`, ref: "cc_prompt_unpriced_lines_fix alias lemon juice from a lemon", createdAt: at } },
          { upsert: true },
        );
        evidence.alias.push({ id: it.id, quarantineNote: it.target, modified: q.modifiedCount });
        if (q.modifiedCount !== 1) failed = true;
      }
    }
    evidence.requery = {
      price: (await priceCol.find({ priceFixBatch: priceBatch }).project({ canonical_name: 1, per_unit_metric: 1, per_unit_count: 1, confidence: 1 }).toArray()).map((d) => ({ name: d.canonical_name, metric: d.per_unit_metric, count: d.per_unit_count, confidence: d.confidence })),
      alias: (await canonCol.find({ aliasFixBatch: canonBatch }).project({ canonical_name: 1, aliases: 1 }).toArray()).map((d) => ({ name: d.canonical_name, aliases: d.aliases })),
      canon: (await canonCol.find({ unpricedFixBatch: canonBatch }).project({ canonical_name: 1, density_cup: 1, per_item_g: 1 }).toArray()).map((d) => ({ name: d.canonical_name, density_cup: d.density_cup ?? null, per_item_g: d.per_item_g ?? null })),
    };
    const outApplied = path.join(SUMMARIES, `unpriced_fix_${priceBatch}_applied.json`);
    fs.writeFileSync(outApplied, JSON.stringify(evidence, null, 1));
    console.log(`WRITE price ${evidence.price.length} docs (${priceBatch}), canonical ${evidence.canon.length} docs (${canonBatch}); evidence -> ${outApplied}`);
    console.log("NEXT: node scripts/recipe_cost_recompute.cjs --out ../../summaries/recipe_cost_recompute_dryrun_<date>.json  (review) then --write --from <that> --batch rcr-<date>");
    if (failed) process.exitCode = 1;
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
