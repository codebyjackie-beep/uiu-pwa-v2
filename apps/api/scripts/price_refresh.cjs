// Guarded price refresh — Part 1 script (dry-run by default; one-off, run on Jackie's PC).
//
//   node scripts/price_refresh.cjs --pilot                      # impact top 30 + broth/stock family (Part 2)
//   node scripts/price_refresh.cjs --all                        # every eligible canonical (Part 3)
//   node scripts/price_refresh.cjs --only "rice,cola"           # names, or a path to a .txt/.json list
//   node scripts/price_refresh.cjs --offline --pilot            # no Serper: re-process cached listings (logic test)
//   node scripts/price_refresh.cjs --write --from <reviewed.json> --batch refresh-20261013   # Part 4
//   node scripts/price_refresh.cjs --check-only --from <reviewed.json>                      # re-check live vs dry-run, no write
//
// Serper key: process.env.SERPER_API_KEY, else apps/api/.dev.vars SERPER_API_KEY.
// Never touches the old Atlas cluster / old repo. Dry-run writes ONLY a JSON file under summaries/.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const INVENTORY_JSON = path.join(SUMMARIES, "price_refresh_inventory_2026-10-13.json");
const SERPER_URL = "https://google.serper.dev/shopping";
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 2; // first call + retry-on-0 once (cloud decision 10-13 point 1)

// ------------------------------------------------------------------------------------------------
// args
// ------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { flags: new Set(), kv: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const k = t.slice(2);
    if (["only", "from", "batch", "out"].includes(k)) a.kv[k] = argv[++i];
    else a.flags.add(k);
  }
  return a;
}

function loadDevVars() {
  const env = {};
  const p = path.join(API_ROOT, ".dev.vars");
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
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
  const entryFile = path.join(API_ROOT, "scripts", "_pr_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_pr_bundle.mjs");
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

// ------------------------------------------------------------------------------------------------
// BASELINE — old logic, verbatim from C:\Project\UseItUp\useitup_backend\src\services\serper_price.service.js
// (L6-56, 72-123, 158-170). Do not "improve" this block: it is the reference the guarded numbers are compared with.
// ------------------------------------------------------------------------------------------------
const UK_SUPERMARKETS = ["tesco", "sainsbury", "asda", "morrisons", "waitrose", "ocado", "iceland", "co-op", "coop", "aldi", "lidl"];
const MARKETPLACE_BLOCKLIST = ["amazon", "ebay"];
const WEIGHT_VOLUME_RE = /(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i;
const MULTIPACK_RE = /(\d+)\s?(?:pack|x|×)\b/i;
const EACH_RE = /\beach\b/i;
const UNIT_TO_GRAMS_OR_ML = { g: 1, ml: 1, kg: 1000, l: 1000, cl: 10 };

function _cleanPrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(num) ? num : null;
}
function _isUkSupermarket(source) {
  const s = (source || "").toLowerCase();
  if (MARKETPLACE_BLOCKLIST.some((m) => s.includes(m))) return false;
  return UK_SUPERMARKETS.some((m) => s.includes(m));
}
function _parsePackFromTitle(title) {
  if (!title) return null;
  const wv = title.match(WEIGHT_VOLUME_RE);
  if (wv) {
    const qty = parseFloat(wv[1]) * UNIT_TO_GRAMS_OR_ML[wv[2].toLowerCase()];
    const multi = title.match(MULTIPACK_RE);
    return { qty: multi ? qty * parseInt(multi[1], 10) : qty, unit: "g_or_ml" };
  }
  const multi = title.match(MULTIPACK_RE);
  if (multi) return { qty: parseInt(multi[1], 10), unit: "each" };
  if (EACH_RE.test(title)) return { qty: 1, unit: "each" };
  return null;
}
function _trimOutliers(values) {
  if (values.length < 5) return values;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.slice(1, -1);
}
function _median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function computePerUnit(rawListings, referencePack = null) {
  const listings = rawListings.map((s) => {
    const price = _cleanPrice(s.price);
    const titlePack = _parsePackFromTitle(s.title);
    const pack = titlePack || referencePack || null;
    const sourcePack = titlePack ? "title" : (referencePack ? "reference" : "unknown");
    const perUnit = price != null && pack ? price / pack.qty : null;
    return { store: s.store, title: s.title, price, pack, source_of_pack: sourcePack, per_unit: perUnit != null ? Math.round(perUnit * 10000) / 10000 : null };
  }).filter((l) => l.price != null);
  const cheapest = listings.length ? listings.reduce((min, l) => (l.price < min.price ? l : min)) : null;
  const metricValues = listings.filter((l) => l.per_unit != null && l.pack?.unit === "g_or_ml").map((l) => l.per_unit);
  const countValues = listings.filter((l) => l.per_unit != null && l.pack?.unit === "each").map((l) => l.per_unit);
  const perUnitMetric = _median(_trimOutliers(metricValues));
  const perUnitCount = _median(_trimOutliers(countValues));
  const hasAnyPerUnit = perUnitMetric != null || perUnitCount != null;
  let confidence = "none";
  if (listings.length >= 3 && hasAnyPerUnit) confidence = "high";
  else if (listings.length >= 1 && hasAnyPerUnit) confidence = "low";
  else if (listings.length >= 1) confidence = "price_only";
  return {
    per_unit_metric: perUnitMetric != null ? { value: perUnitMetric, unit: "g_or_ml", n: metricValues.length } : null,
    per_unit_count: perUnitCount != null ? { value: perUnitCount, unit: "each", n: countValues.length } : null,
    cheapest: cheapest ? { store: cheapest.store, price: cheapest.price, title: cheapest.title } : null,
    n_supermarkets: listings.length,
    listings,
    confidence,
  };
}

// ------------------------------------------------------------------------------------------------
// GUARDED — new rules (cloud decisions 10-13)
// ------------------------------------------------------------------------------------------------
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const r5 = (v) => (v == null ? null : Math.round(v * 1e5) / 1e5);
const r6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = String(f(x)); m[k] = (m[k] || 0) + 1; } return m; };

// Guard 3 — title must mention the canonical (head noun / alias) and must not contain excluded words.
const EXCLUDE_WORDS = [
  ["seed", /\bseeds?\b/i], ["plant", /\bplants?\b(?![\s-]*based)/i], ["grow", /\bgrow\b/i], ["kit", /\bkit\b/i],
  ["supplement", /\bsupplements?\b/i], ["capsule", /\bcapsules?\b/i], ["tablet", /\btablets?\b/i], ["powder", /\bpowder\b/i],
  ["pet", /\bpets?\b/i], ["dog", /\bdogs?\b/i], ["cat", /\bcats?\b/i], ["candle", /\bcandles?\b/i], ["gift", /\bgifts?\b/i], ["hamper", /\bhampers?\b/i],
];
function stem(w) {
  w = w.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|s|z|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
const TOKEN_STOP = new Set(["of", "and", "or", "with", "the", "in", "a", "an", "for", "to", "fresh", "raw", "hot", "cold", "whole", "dried", "dry", "large", "small", "medium", "extra", "plain", "free", "range", "organic", "low", "fat", "reduced", "light", "style", "piece", "pieces", "cut", "sliced", "diced", "chopped", "minced", "peeled", "boneless", "skinless", "lean", "cooked", "canned", "tinned", "frozen", "unsalted", "salted", "sweet", "red", "green", "white", "black", "brown", "yellow", "mixed", "natural"]);
// UK/US and spelling variants a supermarket title may use instead of the canonical word
const TOKEN_SYNONYMS = {
  shrimp: ["prawn"], shrimps: ["prawn"], prawn: ["shrimp"], prawns: ["shrimp"], chickpea: ["chick pea", "chick-pea", "chana"], chickpeas: ["chick pea", "chick-pea", "chana"],
  aubergine: ["eggplant"], eggplant: ["aubergine"], courgette: ["zucchini"], zucchini: ["courgette"], coriander: ["cilantro"], cilantro: ["coriander"],
  arugula: ["rocket"], rocket: ["arugula"], scallion: ["spring onion"], scallions: ["spring onion"], ground: ["mince"], mince: ["ground"], cornstarch: ["cornflour"], cornflour: ["cornstarch"],
};
function tokenStems(phrase) {
  const out = new Set();
  if (!phrase) return out;
  const cleaned = normChilli(String(phrase).toLowerCase()).replace(/[(),]/g, " ");
  for (const t of cleaned.split(/[^a-zà-ÿ]+/)) {
    if (!t || t.length < 3 || TOKEN_STOP.has(t)) continue;
    out.add(stem(t));
    for (const syn of TOKEN_SYNONYMS[t] || []) out.add(stem(syn).replace(/s$/, ""));
  }
  return out;
}
// Guard 3 is deliberately lenient: ANY content token of canonical_name / query_alias / aliases may appear in the title
// (it exists to drop non-food and wrong-category listings, not to demand an exact product name).
function makeTitleMatcher(canon, priceDoc) {
  const name = canon?.canonical_name ?? priceDoc?.canonical_name;
  const phrases = [name, canon?.query_alias, ...(Array.isArray(canon?.aliases) ? canon.aliases : [])].filter((x) => typeof x === "string");
  const tokens = new Set();
  for (const p of phrases) for (const h of tokenStems(p)) tokens.add(h);
  const nameLower = String(name || "").toLowerCase();
  const exclusions = EXCLUDE_WORDS.filter(([label]) => !new RegExp(`\\b${label}`, "i").test(nameLower)); // canonical that itself contains the word keeps it
  return (title) => {
    const t = String(title || "").toLowerCase();
    for (const [label, re] of exclusions) if (re.test(t)) return { ok: false, reason: `excluded_word:${label}` };
    if (!tokens.size) return { ok: true };
    const tStems = [...tokenStems(normChilli(t))];
    const hit = [...tokens].some((tok) => tStems.some((ts) => ts === tok || (ts.length >= 4 && tok.length >= 4 && (ts.startsWith(tok) || tok.startsWith(ts)))));
    return hit ? { ok: true } : { ok: false, reason: "title_no_match" };
  };
}
const normChilli = (s) => s.replace(/\bchill?(?:ies|ie|i|y|es|e)\b/g, "chilli");

// Pack parse fixes (cloud decision point 4). Only used by `guarded`; baseline keeps the old regexes.
function parsePackGuarded(title, referencePack) {
  const flags = [];
  const t = String(title || "");
  const nxm = t.match(/(\d+)\s?[x×]\s?(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i);
  if (nxm) {
    const qty = parseInt(nxm[1], 10) * parseFloat(nxm[2]) * UNIT_TO_GRAMS_OR_ML[nxm[3].toLowerCase()];
    flags.push("nxm_multiplied");
    return { pack: { qty, unit: "g_or_ml" }, source: "title", flags };
  }
  const wv = t.match(WEIGHT_VOLUME_RE);
  if (wv) {
    const single = parseFloat(wv[1]) * UNIT_TO_GRAMS_OR_ML[wv[2].toLowerCase()];
    const np = t.match(/\b(\d+)\s?pack\b/i);
    const po = t.match(/\bpack of (\d+)\b/i);
    const n = np ? parseInt(np[1], 10) : po ? parseInt(po[1], 10) : null;
    if (n && n > 1) {
      flags.push("ambiguous_pack");
      return { pack: null, source: "title", flags, ambiguous: { n, weight: single, asTotal: { qty: single, unit: "g_or_ml" }, asEach: { qty: single * n, unit: "g_or_ml" } } };
    }
    const multi = t.match(MULTIPACK_RE); // "2x ... 400g" / "4 x" (old behaviour, kept)
    return { pack: { qty: multi ? single * parseInt(multi[1], 10) : single, unit: "g_or_ml" }, source: "title", flags };
  }
  const po = t.match(/\bpack of (\d+)\b/i);
  if (po) { flags.push("pack_of_n_each"); return { pack: { qty: parseInt(po[1], 10), unit: "each" }, source: "title", flags }; }
  const multi = t.match(MULTIPACK_RE);
  if (multi) return { pack: { qty: parseInt(multi[1], 10), unit: "each" }, source: "title", flags };
  if (EACH_RE.test(t)) return { pack: { qty: 1, unit: "each" }, source: "title", flags };
  if (referencePack) return { pack: referencePack, source: "reference", flags };
  return { pack: null, source: "unknown", flags };
}

// One guarded evaluation. ambiguousMode: "exclude" | "total" | "each"
function guardedEvaluate(rawListings, ctx, ambiguousMode) {
  const rows = rawListings.map((s) => {
    const price = _cleanPrice(s.price);
    const row = { store: s.store, title: s.title, price, status: "kept", reason: null, flags: [], pack: null, source_of_pack: "unknown", per_unit: null };
    if (price == null) { row.status = "dropped"; row.reason = "no_price"; return row; }
    const m = ctx.matcher(s.title);
    if (!m.ok) { row.status = "dropped"; row.reason = m.reason; return row; }
    const p = parsePackGuarded(s.title, ctx.referencePack);
    row.flags = p.flags;
    row.source_of_pack = p.source;
    if (p.ambiguous) {
      row.ambiguous = p.ambiguous;
      if (ambiguousMode === "exclude") { row.status = "ambiguous"; row.reason = "ambiguous_pack"; return row; }
      row.pack = ambiguousMode === "total" ? p.ambiguous.asTotal : p.ambiguous.asEach;
    } else row.pack = p.pack;
    if (row.pack && price != null) row.per_unit = r4(price / row.pack.qty);
    return row;
  });
  // Guard 5 — doc-level outlier: per dimension, drop values >3x or <1/3 of the median, then re-median.
  const dims = {};
  for (const unit of ["g_or_ml", "each"]) {
    const cands = rows.filter((r) => r.status === "kept" && r.per_unit != null && r.per_unit > 0 && r.pack?.unit === unit);
    if (!cands.length) continue;
    const med = _median(cands.map((r) => r.per_unit));
    const kept = [];
    for (const r of cands) {
      if (r.per_unit > med * 3 || r.per_unit < med / 3) { r.status = "dropped"; r.reason = `outlier_3x(median ${r5(med)})`; } else kept.push(r);
    }
    dims[unit] = { n: kept.length, medianBefore: med, value: _median(kept.map((r) => r.per_unit)), droppedOutliers: cands.length - kept.length };
  }
  const priced = rows.filter((r) => (r.status === "kept" || r.status === "ambiguous") && r.price != null); // passed Guard 3, not an outlier
  const cheapestRow = priced.length ? priced.reduce((m, r) => (r.price < m.price ? r : m)) : null;
  const metric = dims.g_or_ml ? { value: dims.g_or_ml.value, unit: "g_or_ml", n: dims.g_or_ml.n } : null;
  const countD = dims.each ? { value: dims.each.value, unit: "each", n: dims.each.n } : null;
  const nValidAny = rows.filter((r) => r.status === "kept" && r.per_unit != null).length;
  let confidence = "none";
  if (nValidAny >= 3) confidence = "high";
  else if (nValidAny >= 1) confidence = "low";
  else if (priced.length) confidence = "price_only";
  return {
    rows,
    per_unit_metric: metric && metric.n >= 1 ? metric : null,
    per_unit_count: countD && countD.n >= 1 ? countD : null,
    cheapest: cheapestRow ? { store: cheapestRow.store, price: cheapestRow.price, title: cheapestRow.title } : null,
    n_supermarkets: rows.filter((r) => r.status === "kept" || r.status === "ambiguous").length,
    confidence,
    dims,
  };
}

// Guard 6 — new vs current.
function decide(cur, g, rawCount) {
  if (rawCount === 0) return { action: "keep_old", reason: "no_whitelisted_listings_after_retry", fields: [] };
  const nM = g.per_unit_metric?.n || 0;
  const nC = g.per_unit_count?.n || 0;
  if (Math.max(nM, nC) < 2) {
    const dropped = countBy(g.rows.filter((r) => r.status !== "kept"), (r) => String(r.reason).replace(/\(.*$/, "").replace(/^excluded_word:.*$/, "excluded_word"));
    const nPer = g.rows.filter((r) => r.status === "kept" && r.per_unit == null).length;
    return { action: "hold_low_n", reason: Math.max(nM, nC) === 0 ? "no_valid_listing_after_guards" : "only_1_valid_listing", detail: { rawListings: rawCount, kept_without_pack: nPer, dropped }, fields: [] };
  }
  const supported = [];
  if (nM >= 2) supported.push("per_unit_metric");
  if (nC >= 2) supported.push("per_unit_count");
  const curDims = ["per_unit_metric", "per_unit_count"].filter((k) => cur[k] && cur[k].value != null);
  if (curDims.length && !curDims.some((d) => supported.includes(d))) return { action: "hold", reason: "dimension_lost", fields: [], supported };
  const ratios = {};
  let breach = null;
  for (const d of supported) {
    if (!cur[d] || !(cur[d].value > 0)) continue;
    const r = g[d].value / cur[d].value;
    ratios[d] = Math.round(r * 1000) / 1000;
    if (r > 3 || r < 1 / 3) breach = d;
  }
  if (breach) return { action: "hold", reason: `ratio_out_of_range:${breach}=${ratios[breach]}`, fields: [], supported, ratios };
  return { action: "update", reason: "ok", fields: supported, supported, ratios };
}

// ------------------------------------------------------------------------------------------------
// STOCK family (cloud decision point 5): £/ml of made-up stock from cube/pot listings that state a piece count.
// ------------------------------------------------------------------------------------------------
const STOCK_NAME_RE = /\b(broth|stock|bouillon)\b/i;
const CORE_TYPES = ["chicken", "beef", "fish", "vegetable"];
function docStockType(name) {
  const l = name.toLowerCase();
  let best = null;
  for (const [t, re] of [["chicken", /\bchicken\b/], ["beef", /\bbeef\b/], ["fish", /\bfish\b/], ["vegetable", /\bveg(?:etable)?s?\b/]]) {
    const m = l.match(re);
    if (m && (best == null || m.index < best.idx)) best = { type: t, idx: m.index };
  }
  return best ? { type: best.type, source: "name_first_type_word" } : { type: "vegetable", source: "default_vegetable_no_type_word" };
}
function titleStockTypes(title) {
  const l = title.toLowerCase();
  const out = [];
  if (/\bchicken\b/.test(l)) out.push("chicken");
  if (/\bbeef\b/.test(l)) out.push("beef");
  if (/\bfish\b/.test(l)) out.push("fish");
  if (/\bveg(?:etable)?s?\b/.test(l)) out.push("vegetable");
  return out;
}
function stockCount(title) {
  const t = title;
  let m = t.match(/(\d+)\s?[x×]\s?\d+(?:\.\d+)?\s?(?:kg|g|l|ml|cl)\b/i);
  if (m) return { n: parseInt(m[1], 10), rule: "NxMg" };
  m = t.match(/(?<![\d.])(\d+)\s+(?!(?:kg|g|l|ml|cl)\b)(?:[a-z&'-]+\s+){0,3}?(?:cubes?|pots?)\b/i);
  if (m) return { n: parseInt(m[1], 10), rule: "N_cubes_or_pots" };
  m = t.match(/\bpack of (\d+)\b/i);
  if (m) return { n: parseInt(m[1], 10), rule: "pack_of_N" };
  m = t.match(/(?<![\d.])(\d+)\s?pack\b/i);
  if (m) return { n: parseInt(m[1], 10), rule: "N_pack" };
  m = t.match(/(?<![a-z\d])x\s?(\d+)\b(?!\s?(?:kg|g|l|ml|cl)\b)/i);
  if (m) return { n: parseInt(m[1], 10), rule: "xN" }; // "Stock Pots x4 112g"
  return null;
}
function stockMl(title) {
  const l = title.toLowerCase();
  if (/\boxo\b/.test(l)) return { ml: 190, source: "oxo_cube_190ml" };
  if (/\bknorr\b/.test(l)) return { ml: 500, source: /\bpots?\b/.test(l) ? "knorr_stock_pot_500ml" : "knorr_stock_cube_500ml" };
  return { ml: 190, source: "other_or_own_brand_190ml" };
}
function classifyStockListing(l, groupType) {
  const title = String(l.title || "");
  const lower = title.toLowerCase();
  const price = _cleanPrice(l.price);
  const base = { store: l.store, title, price };
  if (price == null || !(price > 0)) return { ...base, used: false, reason: "no_price" };
  if (!_isUkSupermarket(l.store)) return { ...base, used: false, reason: "not_whitelisted_store" };
  const types = titleStockTypes(title);
  if (/\bgranul\w*\b|\bpowder\b/.test(lower)) return { ...base, used: false, reason: "stock_granules" };
  const isCubePot = /\bcubes?\b|\bpots?\b/.test(lower);
  if (!isCubePot) {
    const hasSize = /\d\s?(?:kg|g|l|ml|cl)\b/.test(lower) || /\b(?:carton|ready|fresh|liquid|bottle)\b/.test(lower);
    return { ...base, used: false, reason: hasSize ? "stock_ready_made" : "stock_no_form" };
  }
  if (!types.length) return { ...base, used: false, reason: "stock_type_unknown" };
  const otherCore = types.filter((t) => t !== groupType);
  if (!types.includes(groupType) || otherCore.length) return { ...base, used: false, reason: `stock_type_mismatch(title:${types.join("+")},need:${groupType})` };
  const c = stockCount(title);
  if (!c) return { ...base, used: false, reason: "stock_no_count" };
  if (!(c.n >= 1 && c.n <= 120)) return { ...base, used: false, reason: `stock_count_implausible(${c.n})` };
  const { ml, source } = stockMl(title);
  const perCube = price / c.n;
  return { ...base, used: true, count: c.n, count_rule: c.rule, ml, ml_source: source, per_cube: r4(perCube), per_ml: perCube / ml, per_l: r4((perCube / ml) * 1000) };
}

// ------------------------------------------------------------------------------------------------
// Serper
// ------------------------------------------------------------------------------------------------
async function serperShopping(apiKey, q) {
  const resp = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q, gl: "gb", location: "United Kingdom" }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep null */ }
  if (!resp.ok) throw new Error(`Serper HTTP ${resp.status}: ${text.slice(0, 160)}`);
  const shopping = Array.isArray(body?.shopping) ? body.shopping : [];
  return { shopping, credits: typeof body?.credits === "number" ? body.credits : null };
}
// retry-on-0 (whitelisted) once; returns whitelisted listings + per-call log
async function fetchWithRetry(apiKey, q, creditLog) {
  const calls = [];
  let listings = [];
  let totalRaw = 0;
  let blocked = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { shopping, credits } = await serperShopping(apiKey, q);
    creditLog.calls += 1;
    creditLog.creditsReported += credits ?? 0;
    if (credits == null) creditLog.callsWithoutCredits += 1;
    totalRaw = shopping.length;
    const uk = shopping.filter((s) => _isUkSupermarket(s.source));
    blocked = shopping.filter((s) => MARKETPLACE_BLOCKLIST.some((m) => (s.source || "").toLowerCase().includes(m))).length;
    calls.push({ q, attempt, credits, serperResults: shopping.length, whitelisted: uk.length });
    listings = uk.map((s) => ({ store: s.source, title: s.title, price: s.price }));
    if (listings.length >= 1) break;
  }
  return { listings, calls, serperResultsLastCall: totalRaw, blocklistedLastCall: blocked };
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ------------------------------------------------------------------------------------------------
// protected list = live rules (same as inventory) U reviewed inventory JSON
// ------------------------------------------------------------------------------------------------
const STANDARD_KEYS = new Set(["_id", "canonical_name", "per_unit_metric", "per_unit_count", "cheapest", "n_supermarkets", "listings", "confidence", "needs_review", "metadata",
  "priceFixPrev", "priceFixBatch", "priceFixAt", "refreshPrev", "refreshBatch", "refreshAt"]); // refresh* are our own bookkeeping, not curation
function liveProtectReasons(d) {
  const reasons = [];
  if (d.priceFixBatch || d.priceFixPrev) reasons.push(`priceFixBatch=${d.priceFixBatch ?? "?"}`);
  if (!d.metadata || d.metadata.source !== "serper") reasons.push(`metadata.source=${d.metadata?.source ?? "(missing)"}`);
  if (typeof d.confidence === "string" && d.confidence.startsWith("manual")) reasons.push(`confidence=${d.confidence}`);
  if (d.curation_note || d.metadata?.curation_note) reasons.push("has curation_note");
  const extra = Object.keys(d).filter((k) => !STANDARD_KEYS.has(k) && k !== "curation_note");
  if (extra.length) reasons.push(`non-standard keys: ${extra.join(",")}`);
  return reasons;
}

// ------------------------------------------------------------------------------------------------
// Write path (Part 4) — only reachable with --write --from <reviewed JSON> --batch <id>
// ------------------------------------------------------------------------------------------------
const sameVal = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9);
function curSnapshot(d) {
  return {
    metric: d.per_unit_metric ? { value: d.per_unit_metric.value, n: d.per_unit_metric.n } : null,
    count: d.per_unit_count ? { value: d.per_unit_count.value, n: d.per_unit_count.n } : null,
    cheapest: d.cheapest ? { store: d.cheapest.store, price: d.cheapest.price, title: d.cheapest.title } : null,
    n_supermarkets: d.n_supermarkets ?? null,
    confidence: d.confidence ?? null,
    fetched_at: d.metadata?.fetched_at ? new Date(d.metadata.fetched_at).toISOString() : null,
  };
}
function snapshotsEqual(a, b) {
  return sameVal(a.metric?.value, b.metric?.value) && sameVal(a.count?.value, b.count?.value) && a.n_supermarkets === b.n_supermarkets &&
    a.confidence === b.confidence && a.fetched_at === b.fetched_at && (a.cheapest?.price ?? null) === (b.cheapest?.price ?? null);
}
async function runWrite(args, env) {
  const from = args.kv.from;
  if (!from) throw new Error("--from <reviewed dry-run JSON> required");
  const rep = JSON.parse(fs.readFileSync(path.resolve(from), "utf8"));
  const writeMode = args.flags.has("write");
  const batch = args.kv.batch || `refresh-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const targets = rep.docs.filter((d) => d.action === "update" || d.action === "nominal_stock");
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const col = client.db(env.MONGODB_DB).collection("canonical_price_cache");
    const live = new Map((await col.find({ canonical_name: { $in: targets.map((t) => t.canonical_name) } }).toArray()).map((d) => [d.canonical_name, d]));
    const mismatches = [];
    for (const t of targets) {
      const d = live.get(t.canonical_name);
      if (!d) { mismatches.push({ canonical_name: t.canonical_name, why: "missing_live_doc" }); continue; }
      if (liveProtectReasons(d).length) { mismatches.push({ canonical_name: t.canonical_name, why: `now_protected: ${liveProtectReasons(d).join("|")}` }); continue; }
      if (!snapshotsEqual(curSnapshot(d), t.current)) mismatches.push({ canonical_name: t.canonical_name, why: "live_differs_from_dry_run_current", live: curSnapshot(d), dryRun: t.current });
    }
    console.log(JSON.stringify({ mode: writeMode ? "WRITE" : "CHECK_ONLY", batch, from, targets: targets.length, mismatches: mismatches.length }, null, 1));
    if (mismatches.length) { console.log(JSON.stringify(mismatches.slice(0, 20), null, 1)); throw new Error(`ABORT: ${mismatches.length} doc(s) differ from the reviewed dry-run; nothing written`); }
    if (!writeMode) { console.log("check-only OK: live == dry-run `current` for every target"); return; }
    if (!rep.batchApproved && !args.flags.has("i-have-cloud-approval")) throw new Error("ABORT: pass --i-have-cloud-approval once cloud has reviewed this JSON");
    const now = new Date();
    const ops = [];
    for (const t of targets) {
      const d = live.get(t.canonical_name);
      const set = { refreshBatch: batch, refreshAt: now, refreshPrev: { per_unit_metric: d.per_unit_metric ?? null, per_unit_count: d.per_unit_count ?? null, cheapest: d.cheapest ?? null, n_supermarkets: d.n_supermarkets ?? null, listings: d.listings ?? [], confidence: d.confidence ?? null, needs_review: d.needs_review ?? null, price_basis: d.price_basis ?? null, curation_note: d.curation_note ?? null, metadata: d.metadata ?? null } };
      for (const [k, v] of Object.entries(t.proposed.set)) set[k] = v;
      set["metadata.fetched_at"] = now;
      ops.push({ updateOne: { filter: { canonical_name: t.canonical_name }, update: { $set: set } } });
    }
    const res = await col.bulkWrite(ops, { ordered: true });
    console.log(JSON.stringify({ batch, matched: res.matchedCount, modified: res.modifiedCount }, null, 1));
  } finally {
    await client.close();
  }
}

// ------------------------------------------------------------------------------------------------
// main (dry-run)
// ------------------------------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const fileEnv = loadDevVars();
  const env = { ...fileEnv };
  if (args.flags.has("write") || args.flags.has("check-only")) return runWrite(args, env);

  const offline = args.flags.has("offline");
  const apiKey = process.env.SERPER_API_KEY || fileEnv.SERPER_API_KEY;
  if (!offline && !apiKey) {
    console.error("SERPER_API_KEY not found (process.env or apps/api/.dev.vars). Add it to .dev.vars (gitignored) or run with --offline.");
    process.exit(2);
  }
  const outPath = args.kv.out ? path.resolve(args.kv.out) : path.join(SUMMARIES, args.flags.has("all") ? "price_refresh_full_dryrun_2026-10-13.json" : "price_refresh_pilot_dryrun_2026-10-13.json");
  const { buildAliasIndex, resolve, costRecipe } = await loadServices();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const startedAt = new Date();
  try {
    const canonDocs = await db.collection("canonical_ingredients").find({}).toArray();
    const priceDocs = await db.collection("canonical_price_cache").find({}).toArray();
    const recipes = await db.collection("recipes").find({}).toArray();
    const canonByName = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(canonDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
    const shimCol = (docs) => ({ find: () => ({ project: () => ({ toArray: async () => docs.filter((d) => d.quarantine !== true) }) }) });
    const index = await buildAliasIndex(shimCol(canonDocs));
    const resolveFn = (raw) => resolve(raw, index);

    // protected = live rules U reviewed Part 0 list
    let invProtected = [];
    let invTop30 = [];
    if (fs.existsSync(INVENTORY_JSON)) {
      const inv = JSON.parse(fs.readFileSync(INVENTORY_JSON, "utf8"));
      invProtected = (inv.protected?.items || []).map((p) => p.canonical_name);
      invTop30 = (inv.impact?.top30 || []).map((x) => x.canonical_name);
    }
    const protectedMap = new Map();
    for (const d of priceDocs) { const r = liveProtectReasons(d); if (r.length) protectedMap.set(d.canonical_name, r); }
    for (const n of invProtected) if (!protectedMap.has(n)) protectedMap.set(n, ["in reviewed Part 0 protected list"]);

    // baseline costing + impact ranking (live)
    const publicRecipes = recipes.filter((r) => r.isPublic === true);
    const perServing = (c) => (typeof c.perServing === "number" && Number.isFinite(c.perServing) && c.perServing > 0 ? c.perServing : null);
    const costAll = (pm) => publicRecipes.map((r) => ({ r, c: costRecipe(r, resolveFn, canonByName, pm, quarantinedNames) }));
    const baseCosts = costAll(priceMap);
    const impact = new Map();
    const recipesByCanon = new Map();
    for (const { r, c } of baseCosts) {
      const servings = r.servings > 0 ? r.servings : 1;
      for (const l of c.lines) {
        if (!l.canonical_name || !(l.lineCost > 0)) continue;
        const e = impact.get(l.canonical_name) || { sum: 0, recipes: new Set() };
        e.sum += l.lineCost / servings;
        e.recipes.add(String(r._id));
        impact.set(l.canonical_name, e);
        if (!recipesByCanon.has(l.canonical_name)) recipesByCanon.set(l.canonical_name, new Set());
        recipesByCanon.get(l.canonical_name).add(String(r._id));
      }
    }
    const ranking = [...impact.entries()].map(([name, e]) => ({ name, sum: e.sum, recipes: e.recipes.size })).sort((a, b) => b.sum - a.sum);
    const rankOf = new Map(ranking.map((x, i) => [x.name, i + 1]));
    const recipeById = new Map(publicRecipes.map((r) => [String(r._id), r]));
    const baseServingById = new Map(baseCosts.map(({ r, c }) => [String(r._id), perServing(c)]));

    // ---- selection ------------------------------------------------------------------------------
    const eligibleDocs = priceDocs.filter((d) => canonByName.has(d.canonical_name) && canonByName.get(d.canonical_name).quarantine !== true);
    const notTouched = {
      orphanPriceDocs: priceDocs.filter((d) => !canonByName.has(d.canonical_name)).map((d) => d.canonical_name),
      quarantinedPriceDocs: priceDocs.filter((d) => canonByName.get(d.canonical_name)?.quarantine === true).map((d) => d.canonical_name),
      canonicalsWithoutPriceDoc: canonDocs.filter((c) => c.quarantine !== true && !priceMap.has(c.canonical_name)).map((c) => c.canonical_name),
    };
    let selected;
    let selectionNote;
    if (args.kv.only) {
      let names;
      const p = path.resolve(args.kv.only);
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8");
        names = p.endsWith(".json") ? JSON.parse(txt) : txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } else names = args.kv.only.split(",").map((s) => s.trim()).filter(Boolean);
      selected = names;
      selectionNote = `--only (${names.length} names)`;
    } else if (args.flags.has("all")) {
      selected = eligibleDocs.map((d) => d.canonical_name);
      selectionNote = "--all eligible (non-quarantined canonical with a price doc)";
    } else {
      const top30 = ranking.slice(0, 30).map((x) => x.name);
      const stockNames = eligibleDocs.filter((d) => STOCK_NAME_RE.test(d.canonical_name)).map((d) => d.canonical_name);
      selected = [...new Set([...top30, ...stockNames])];
      selectionNote = `--pilot: impact top 30 (${top30.length}) + broth/stock family (${stockNames.length}); top30 matches Part 0 JSON: ${JSON.stringify(top30) === JSON.stringify(invTop30)}`;
    }
    const eligibleSet = new Set(eligibleDocs.map((d) => d.canonical_name));
    const creditLog = { calls: 0, creditsReported: 0, callsWithoutCredits: 0 };

    // ---- per doc --------------------------------------------------------------------------------
    const stockQueryCache = new Map(); // type -> Promise<fetch result>
    const stockQuery = (type) => {
      if (!stockQueryCache.has(type)) stockQueryCache.set(type, fetchWithRetry(apiKey, `${type} stock cubes price`, creditLog));
      return stockQueryCache.get(type);
    };

    const processOne = async (name) => {
      const base = { canonical_name: name, impactRank: rankOf.get(name) ?? null, impactGbpPerServingSum: r4(impact.get(name)?.sum ?? 0), publicRecipes: impact.get(name)?.recipes.size ?? 0 };
      const doc = priceMap.get(name);
      if (!doc) return { ...base, action: "skipped_no_price_doc", reason: "no canonical_price_cache doc" };
      if (!eligibleSet.has(name)) return { ...base, action: "skipped_not_eligible", reason: canonByName.has(name) ? "quarantined canonical" : "orphan price doc" };
      const cur = curSnapshot(doc);
      if (protectedMap.has(name)) return { ...base, action: "protected_skip", reason: protectedMap.get(name).join(" | "), current: cur };
      const canon = canonByName.get(name);
      const referencePack = canon?.reference_pack || null;

      // ---------------- stock family ----------------
      if (STOCK_NAME_RE.test(name)) {
        const { type, source: typeSource } = docStockType(name);
        const cached = (doc.listings || []).map((l) => ({ store: l.store, title: l.title, price: l.price, origin: "cache" }));
        let rows = cached.map((l) => ({ ...classifyStockListing(l, type), origin: "cache" }));
        let usable = rows.filter((r) => r.used);
        let serperLog = null;
        if (usable.length < 2 && !offline) {
          const f = await stockQuery(type);
          serperLog = { query: `${type} stock cubes price`, calls: f.calls };
          const seen = new Set(rows.map((r) => `${r.store}|${r.title}|${r.price}`));
          for (const l of f.listings) {
            const c = { ...classifyStockListing(l, type), origin: "serper_type_query" };
            const key = `${c.store}|${c.title}|${c.price}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(c);
          }
          usable = rows.filter((r) => r.used);
        }
        const baseline = computePerUnit(cached, referencePack);
        const out = { ...base, family: "stock", stock: { type, typeSource }, current: cur, baseline: { per_unit_metric: baseline.per_unit_metric, per_unit_count: baseline.per_unit_count, cheapest: baseline.cheapest, basis: "old computePerUnit() over cached listings (no Serper for stock docs)" }, serper: serperLog, listings: rows.map((r) => ({ ...r, per_ml: r.per_ml != null ? r6(r.per_ml) : undefined })) };
        out.dropped_reason_counts = countBy(rows.filter((r) => !r.used), (r) => r.reason.replace(/\(.*$/, ""));
        if (!usable.length) return { ...out, action: "hold_stock", reason: "no_usable_cube_or_pot_listing_with_count", oldPerL: cur.metric ? r4(cur.metric.value * 1000) : null, newPerL: null };
        const med = _median(usable.map((r) => r.per_ml));
        const perL = med * 1000;
        const nearest = usable.reduce((m, r) => (Math.abs(r.per_ml - med) < Math.abs(m.per_ml - med) ? r : m));
        const out2 = { ...out, oldPerL: cur.metric ? r4(cur.metric.value * 1000) : null, newPerL: r4(perL), newPerMl: r6(med), n_used: usable.length, flags: usable.length === 1 ? ["n_used_1"] : [] };
        const note = `Stock cube made up: £${r4(nearest.per_cube)} per cube ÷ ${nearest.ml} ml = £${r4(perL).toFixed(2)}/L, source ${nearest.store} ${nearest.title}`;
        if (perL < 0.2 || perL > 1.0) return { ...out2, action: "hold_stock", reason: "stock_out_of_range", flags: ["stock_out_of_range"], proposed: { set: { per_unit_metric: { value: r6(med), unit: "g_or_ml", n: usable.length }, confidence: "manual_nominal", price_basis: "stock_cube_made_up", curation_note: note } } };
        return {
          ...out2, action: "nominal_stock", reason: "ok",
          proposed: { set: { per_unit_metric: { value: r6(med), unit: "g_or_ml", n: usable.length }, confidence: "manual_nominal", price_basis: "stock_cube_made_up", curation_note: note }, protectAfterWrite: true },
        };
      }

      // ---------------- normal path ----------------
      let rawListings;
      let fetchInfo;
      if (offline) {
        rawListings = (doc.listings || []).map((l) => ({ store: l.store, title: l.title, price: l.price }));
        fetchInfo = { mode: "offline_cache_listings", whitelisted: rawListings.length };
      } else {
        try {
          const f = await fetchWithRetry(apiKey, `${name} price`, creditLog);
          rawListings = f.listings;
          fetchInfo = { mode: "serper", calls: f.calls, whitelisted: f.listings.length, serperResultsLastCall: f.serperResultsLastCall, blocklistedLastCall: f.blocklistedLastCall };
        } catch (e) {
          return { ...base, action: "fetch_error", reason: String(e.message || e).slice(0, 200), current: cur };
        }
      }
      const baseline = computePerUnit(rawListings, referencePack);
      const ctx = { matcher: makeTitleMatcher(canon, doc), referencePack };
      let g = guardedEvaluate(rawListings, ctx, "exclude");
      let ambiguityFallback = null;
      const nAny = (g.per_unit_metric?.n || 0) + (g.per_unit_count?.n || 0);
      if (nAny === 0 && g.rows.some((r) => r.status === "ambiguous")) {
        const tot = guardedEvaluate(rawListings, ctx, "total");
        const each = guardedEvaluate(rawListings, ctx, "each");
        const dist = (x) => {
          let best = null;
          for (const [k, cs] of [["per_unit_metric", cur.metric], ["per_unit_count", cur.count]]) {
            if (x[k] && cs && cs.value > 0) { const d = Math.abs(Math.log(x[k].value / cs.value)); best = best == null ? d : Math.min(best, d); }
          }
          return best;
        };
        const dt = dist(tot), de = dist(each);
        if (dt != null && de != null) {
          const chosen = dt <= de ? "total" : "each";
          g = chosen === "total" ? tot : each;
          ambiguityFallback = { chosen, reason: "0 valid listing after excluding ambiguous_pack; both readings computed, closer to current value chosen", total: { metric: tot.per_unit_metric, count: tot.per_unit_count }, each: { metric: each.per_unit_metric, count: each.per_unit_count }, current: { metric: cur.metric, count: cur.count } };
        } else ambiguityFallback = { chosen: null, reason: "no current value to compare; ambiguous listings stay excluded", total: { metric: tot.per_unit_metric, count: tot.per_unit_count }, each: { metric: each.per_unit_metric, count: each.per_unit_count } };
      }
      const decision = decide({ per_unit_metric: cur.metric, per_unit_count: cur.count }, g, rawListings.length);
      const listingsOut = g.rows.map((r) => {
        const old = baseline.listings.find((b) => b.title === r.title && b.store === r.store && b.price === r.price);
        return {
          store: r.store, title: r.title, price: r.price, status: r.status, reason: r.reason, flags: r.flags,
          baseline: old ? { pack: old.pack, source_of_pack: old.source_of_pack, per_unit: old.per_unit } : null,
          guarded: { pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit },
          ambiguous: r.ambiguous,
        };
      });
      const proposedSet = {};
      let proposed = null;
      if (decision.action === "update") {
        for (const f of decision.fields) proposedSet[f] = g[f];
        proposedSet.cheapest = g.cheapest;
        proposedSet.n_supermarkets = g.n_supermarkets;
        proposedSet.listings = g.rows.filter((r) => r.status === "kept" || r.status === "ambiguous").map((r) => ({ store: r.store, title: r.title, price: r.price, pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit, ...(r.status === "ambiguous" ? { ambiguous_pack: true } : {}) }));
        proposedSet.confidence = g.confidence;
        proposedSet.needs_review = g.confidence === "none" || g.confidence === "low" || g.n_supermarkets === 0;
        proposedSet["metadata.source"] = "serper";
        proposedSet["metadata.query_used"] = name;
        proposedSet["metadata.raw_listing_count"] = rawListings.length;
        proposedSet["metadata.attempts"] = fetchInfo.calls ? fetchInfo.calls.length : null;
        proposed = { set: proposedSet };
      }
      const ratioMetric = g.per_unit_metric && cur.metric?.value > 0 ? Math.round((g.per_unit_metric.value / cur.metric.value) * 1000) / 1000 : null;
      const ratioCount = g.per_unit_count && cur.count?.value > 0 ? Math.round((g.per_unit_count.value / cur.count.value) * 1000) / 1000 : null;
      return {
        ...base, family: "normal", action: decision.action, reason: decision.reason, current: cur, fetch: fetchInfo,
        baseline: { per_unit_metric: baseline.per_unit_metric, per_unit_count: baseline.per_unit_count, cheapest: baseline.cheapest, confidence: baseline.confidence, n_supermarkets: baseline.n_supermarkets },
        guarded: { per_unit_metric: g.per_unit_metric, per_unit_count: g.per_unit_count, cheapest: g.cheapest, confidence: g.confidence, n_supermarkets: g.n_supermarkets, outlierMedians: g.dims },
        ratio: { guardedVsCurrent: { metric: ratioMetric, count: ratioCount }, baselineVsCurrent: { metric: baseline.per_unit_metric && cur.metric?.value > 0 ? Math.round((baseline.per_unit_metric.value / cur.metric.value) * 1000) / 1000 : null, count: baseline.per_unit_count && cur.count?.value > 0 ? Math.round((baseline.per_unit_count.value / cur.count.value) * 1000) / 1000 : null } },
        ambiguityFallback, decisionDetail: decision.detail ?? null, listings: listingsOut, proposed,
        fieldsToWrite: decision.fields,
      };
    };

    const results = await pool(selected, CONCURRENCY, async (n, i) => {
      const r = await processOne(n);
      if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${selected.length}\n`);
      return r;
    });

    // ---- per-serving recompute with proposed values ---------------------------------------------
    const newPriceMap = new Map(priceMap);
    for (const r of results) {
      if ((r.action === "update" || r.action === "nominal_stock") && r.proposed) {
        const d = { ...priceMap.get(r.canonical_name) };
        for (const [k, v] of Object.entries(r.proposed.set)) if (!k.includes(".")) d[k] = v;
        newPriceMap.set(r.canonical_name, d);
      }
    }
    const newCosts = costAll(newPriceMap);
    const BUCKETS = ["<£1", "£1-3", "£3-5", "£5-8", ">£8", "unavailable"];
    const bucketOf = (v) => (v == null ? "unavailable" : v < 1 ? "<£1" : v < 3 ? "£1-3" : v < 5 ? "£3-5" : v < 8 ? "£5-8" : ">£8");
    const distBase = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    const distNew = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    const changes = [];
    const newServingById = new Map();
    for (const { r, c } of newCosts) {
      const id = String(r._id);
      const nps = perServing(c);
      newServingById.set(id, nps);
      const ops = baseServingById.get(id);
      distBase[bucketOf(ops)] += 1;
      distNew[bucketOf(nps)] += 1;
      if (ops != null && nps != null && Math.abs(nps - ops) > 1e-9) changes.push({ id, title: r.title, servings: r.servings ?? null, oldPerServing: r4(ops), newPerServing: r4(nps), delta: r4(nps - ops), pct: Math.round(((nps - ops) / ops) * 1000) / 10 });
      else if ((ops == null) !== (nps == null)) changes.push({ id, title: r.title, servings: r.servings ?? null, oldPerServing: r4(ops), newPerServing: r4(nps), delta: null, pct: null, note: "availability changed" });
    }
    changes.sort((a, b) => Math.abs(b.delta ?? 99) - Math.abs(a.delta ?? 99));

    // ---- aggregates -------------------------------------------------------------------------------
    const actionCounts = countBy(results, (r) => r.action);
    const normalDocs = results.filter((r) => r.family === "normal");
    const allListings = normalDocs.flatMap((d) => d.listings || []);
    const ruleEffect = {
      guard3_title_no_match: allListings.filter((l) => l.reason === "title_no_match"),
      guard3_excluded_word: allListings.filter((l) => String(l.reason).startsWith("excluded_word")),
      guard5_outlier_3x: allListings.filter((l) => String(l.reason).startsWith("outlier_3x")),
      pack_nxm_multiplied: allListings.filter((l) => l.flags.includes("nxm_multiplied") && l.baseline?.pack && l.guarded.pack && l.baseline.pack.qty !== l.guarded.pack.qty),
      pack_of_n_each: allListings.filter((l) => l.flags.includes("pack_of_n_each") && (l.baseline?.pack?.qty ?? null) !== (l.guarded.pack?.qty ?? null)),
      ambiguous_pack: allListings.filter((l) => l.status === "ambiguous" || (l.flags || []).includes("ambiguous_pack")),
    };
    const ruleEffectSummary = Object.fromEntries(Object.entries(ruleEffect).map(([k, v]) => [k, { listings: v.length, examples: v.slice(0, 5).map((l) => ({ title: l.title, store: l.store, price: l.price, reason: l.reason, baselinePack: l.baseline?.pack ?? null, guardedPack: l.guarded?.pack ?? null, per_unit_old: l.baseline?.per_unit ?? null, per_unit_new: l.guarded?.per_unit ?? null })) }]));
    const recipeRows = (name) => [...(recipesByCanon.get(name) || [])].map((id) => ({ id, title: recipeById.get(id)?.title, oldPerServing: r4(baseServingById.get(id)), newPerServing: r4(newServingById.get(id)) }));
    const holdList = results.filter((r) => ["hold", "hold_low_n", "hold_stock"].includes(r.action)).map((r) => ({
      canonical_name: r.canonical_name, action: r.action, reason: r.reason, impactGbpPerServingSum: r.impactGbpPerServingSum,
      current: r.family === "stock" ? { perL: r.oldPerL } : { metric_per_kg_or_L: r.current?.metric ? r4(r.current.metric.value * 1000) : null, count_each: r.current?.count ? r4(r.current.count.value) : null },
      proposedNotWritten: r.family === "stock" ? { perL: r.newPerL } : { metric_per_kg_or_L: r.guarded?.per_unit_metric ? r4(r.guarded.per_unit_metric.value * 1000) : null, count_each: r.guarded?.per_unit_count ? r4(r.guarded.per_unit_count.value) : null },
      publicRecipesAffected: recipeRows(r.canonical_name),
    }));
    const stockRecipes = new Map();
    for (const r of results.filter((x) => x.family === "stock")) for (const row of recipeRows(r.canonical_name)) stockRecipes.set(row.id, { ...row, via: [...(stockRecipes.get(row.id)?.via || []), r.canonical_name] });

    const report = {
      generatedAt: new Date().toISOString(),
      script: "apps/api/scripts/price_refresh.cjs",
      mode: offline ? "DRY-RUN offline (cached listings re-processed, no Serper)" : "DRY-RUN (Serper live, no DB write)",
      selection: { note: selectionNote, requested: selected.length },
      credits: { ...creditLog, startedAt: startedAt.toISOString(), note: "creditsReported = sum of `credits` field in Serper responses; callsWithoutCredits = responses lacking that field" },
      protectedCount: protectedMap.size,
      summary: { total: results.length, actionCounts, sumCheck: Object.values(actionCounts).reduce((s, x) => s + x, 0) === results.length },
      notTouched: { orphan: notTouched.orphanPriceDocs.length, quarantined: notTouched.quarantinedPriceDocs.length, noPriceDoc: notTouched.canonicalsWithoutPriceDoc.length, lists: notTouched },
      ruleEffect: ruleEffectSummary,
      perServing: {
        publicRecipes: publicRecipes.length,
        distributionBaseline: distBase,
        distributionWithProposed: distNew,
        recipesChanged: changes.length,
        top15Changes: changes.slice(0, 15),
        note: "proposed = action update + nominal_stock docs in THIS run only; everything else keeps live values",
      },
      holds: holdList,
      stockRecipes: [...stockRecipes.values()],
      docs: results,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`dry-run -> ${outPath}`);
    console.log(JSON.stringify({ selection: selectionNote, total: results.length, actionCounts, credits: creditLog, perServing: { base: distBase, withProposed: distNew, changed: changes.length }, ruleEffect: Object.fromEntries(Object.entries(ruleEffectSummary).map(([k, v]) => [k, v.listings])) }, null, 1));
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
