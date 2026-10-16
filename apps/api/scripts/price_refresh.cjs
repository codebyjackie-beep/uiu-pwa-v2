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
    if (["only", "from", "batch", "out", "from-listings"].includes(k)) a.kv[k] = argv[++i];
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
      `export * from "../src/services/priceRefreshGuard.ts";`,
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
// Guard logic (baseline, Guard 2/3/5/6, pack-parse, rules 10/16/21/22, stock family, protection) lives in
// src/services/priceRefreshGuard.ts — ONE copy shared with the Worker job. It is bundled by loadServices() and bound here.
// ------------------------------------------------------------------------------------------------
let computePerUnit, makeTitleMatcher, evaluateListings, buildUpdateSet, titleHasFullName, liveProtectReasons, curSnapshot, snapshotsEqual,
  buildStockGroup, stockProposal, classifyStockListing, docStockType, titleStockTypes, _cleanPrice, _isUkSupermarket, _median, r4, r5, r6, countBy,
  MARKETPLACE_BLOCKLIST, STOCK_NAME_RE, CORE_TYPES, RISE_CAP;
function bindGuard(m) {
  ({ computeBaseline: computePerUnit, makeTitleMatcher, evaluateListings, buildUpdateSet, titleHasFullName, liveProtectReasons, curSnapshot, snapshotsEqual,
    buildStockGroup, stockProposal, classifyStockListing, docStockType, titleStockTypes, cleanPrice: _cleanPrice, isUkSupermarket: _isUkSupermarket, median: _median, r4, r5, r6, countBy,
    MARKETPLACE_BLOCKLIST, STOCK_NAME_RE, CORE_TYPES, RISE_CAP } = m);
}

// Cloud decisions on individual holds (rule 15). `from` = the action the reviewed run produced.
// `from` = actions the review saw (override applies only if the computed action is one of them). `ref` = which review decided.
const P2 = "Part 2 live pilot decision 15";
const P3 = "Part 3 full dry-run decision 23";
const P4 = "Final dry-run decisions 25-26";
const KEEP_ANY = ["hold", "hold_low_n", "hold_rise", "update"]; // keep_old wins over whatever the guards computed
const CLOUD_OVERRIDES = {
  tomato: { ref: P2, from: ["hold"], decision: "update", note: "write count £0.166 each (Tesco/Ocado 6 Pack ÷ 6, real price; old £0.518 ~3x too high) + metric as guarded; count ratio 0.32 accepted" },
  egg: { ref: P2, from: ["hold_low_n"], decision: "keep_old", note: "keep old £0.265 each; only 1 listing, £0.70 each not plausible" },
  "flank steak": { ref: P2, from: ["hold"], decision: "keep_old", note: "keep old £15/kg; £56/kg not plausible" },
  "lump crab meat": { ref: P2, from: ["hold_low_n"], decision: "keep_old", note: "keep old value" },
  // --- Part 3 (decision 23) ---
  "white onion": { ref: P3, from: ["hold_low_n", "hold", "hold_rise", "update"], decision: "set_metric", perKg: 1.25, listingTitle: "Iceland Onions 1kg", note: "write metric £1.25/kg (Iceland Onions 1kg £1.25; old £8/kg wrong); count unchanged" },
  tomatoe: { ref: P3, from: ["hold"], decision: "update", copyMetricFrom: "tomato", note: "same as tomato: count £0.166 each as guarded; metric = tomato's guarded value" },
  pepper: { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "keep old £9/kg; black vs bell pepper ambiguity, 43 recipe lines listed for cloud to judge" },
  corn: { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "keep old value" },
  "vegetable oil": { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "keep old value" },
  "basa fillets": { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "keep old value" },
  mango: { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "keep old value" },
  // --- final dry-run review (decisions 25-26) ---
  "oregano leaves": { ref: P4, from: KEEP_ANY, decision: "skip", note: "skip (not written): £228/kg is a dried-herb jar price, recipes use fresh oregano; stays unpriced" },
};
// remaining small-impact holds of the Part 3 run: keep old value
for (const n of ["vinegar", "chili pepper flakes", "dill", "multigrain bread", "ground turmeric", "saffron", "fresh basil, torn", "garlic paste", "fresh basil leaves", "lettuce leaves", "snow peas", "muffins", "sage", "tomato slices", "ginger ale", "cola (regular) or ginger ale", "raspberry jam"]) {
  CLOUD_OVERRIDES[n] = { ref: P3, from: KEEP_ANY, decision: "keep_old", note: "small-impact hold: keep old value" };
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
  const svc = await loadServices();
  bindGuard(svc);
  if (args.flags.has("write") || args.flags.has("check-only")) return runWrite(args, env);

  const offline = args.flags.has("offline");
  const apiKey = process.env.SERPER_API_KEY || fileEnv.SERPER_API_KEY;
  if (!offline && !apiKey) {
    console.error("SERPER_API_KEY not found (process.env or apps/api/.dev.vars). Add it to .dev.vars (gitignored) or run with --offline.");
    process.exit(2);
  }
  const outPath = args.kv.out ? path.resolve(args.kv.out) : path.join(SUMMARIES, args.flags.has("all") ? "price_refresh_full_dryrun_2026-10-13.json" : "price_refresh_pilot_dryrun_2026-10-13.json");
  const { buildAliasIndex, resolve, costRecipe } = svc;
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
    // --from-listings <json>: reuse listings already fetched by an earlier dry-run (0 credits for those docs)
    const reuseMap = new Map();
    let reuseSourceName = null;
    if (args.kv["from-listings"]) {
      const rp = path.resolve(args.kv["from-listings"]);
      reuseSourceName = path.basename(rp);
      const src = JSON.parse(fs.readFileSync(rp, "utf8"));
      for (const d of src.docs || []) {
        if (d.family !== "normal" || !["serper", "reused_listings"].includes(d.fetch?.mode) || !Array.isArray(d.listings)) continue;
        reuseMap.set(d.canonical_name, { listings: d.listings.map((l) => ({ store: l.store, title: l.title, price: l.price })), calls: d.fetch.calls, serperResultsLastCall: d.fetch.serperResultsLastCall, blocklistedLastCall: d.fetch.blocklistedLastCall });
      }
      creditLog.reusedFrom = { file: reuseSourceName, docs: reuseMap.size, priorCredits: src.credits ? { calls: src.credits.calls, creditsReported: src.credits.creditsReported } : null };
    }

    // ---- per doc --------------------------------------------------------------------------------
    // ---- stock groups (cloud rule 9): pool usable cube/pot listings of ALL non-protected stock-family canonicals by type ----
    const stockDocs = eligibleDocs.filter((d) => STOCK_NAME_RE.test(d.canonical_name) && !protectedMap.has(d.canonical_name));
    const stockGroups = {};
    for (const t of CORE_TYPES) stockGroups[t] = { type: t, appliedTo: [], contributingCanonicals: [], serper: null };
    for (const d of stockDocs) stockGroups[docStockType(d.canonical_name).type].appliedTo.push(d.canonical_name);
    for (const t of CORE_TYPES) {
      if (!stockGroups[t].appliedTo.length) { stockGroups[t].result = "no_canonical_of_this_type"; continue; }
      const cachedByDoc = stockDocs.map((d) => [d.canonical_name, d.listings || []]);
      let grp = buildStockGroup(t, cachedByDoc); // pooling + median live in src/services/priceRefreshGuard.ts
      let serper = null;
      if (!grp.nUsed && !offline && reuseMap.size > 0) serper = { query: `${t} stock cubes price`, skipped: "recompute_from_listings_mode_never_calls_serper" };
      else if (!grp.nUsed && !offline) {
        try {
          const f = await fetchWithRetry(apiKey, `${t} stock cubes price`, creditLog);
          serper = { query: `${t} stock cubes price`, calls: f.calls, whitelisted: f.listings.length };
          grp = buildStockGroup(t, cachedByDoc, f.listings);
        } catch (e) { serper = { query: `${t} stock cubes price`, error: String(e.message || e).slice(0, 160) }; }
      }
      Object.assign(stockGroups[t], grp, { serper });
    }

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
        const grp = stockGroups[type];
        const cached = (doc.listings || []).map((l) => ({ store: l.store, title: l.title, price: l.price }));
        const baseline = computePerUnit(cached, referencePack);
        const own = cached.map((l) => classifyStockListing(l, type));
        const out = {
          ...base, family: "stock", stock: { type, typeSource }, stockGroup: type, current: cur,
          baseline: { per_unit_metric: baseline.per_unit_metric, per_unit_count: baseline.per_unit_count, cheapest: baseline.cheapest, basis: "old computePerUnit() over this doc's cached listings" },
          ownCachedListings: { total: own.length, usableForGroup: own.filter((r) => r.used).length, dropped: countBy(own.filter((r) => !r.used), (r) => String(r.reason).replace(/\(.*$/, "")) },
          group: { type, result: grp.result, nUsed: grp.nUsed ?? 0, medianPerL: grp.medianPerL ?? null, serper: grp.serper },
          oldPerL: cur.metric ? r4(cur.metric.value * 1000) : null,
        };
        if (!grp.nUsed) return { ...out, action: "hold_stock", reason: "no_usable_cube_or_pot_listing_in_type_group", newPerL: null };
        const { set } = stockProposal(type, grp); // grp.nUsed > 0 here
        const out2 = { ...out, newPerL: grp.medianPerL, newPerMl: grp.medianPerMl, n_used: grp.nUsed, flags: grp.nUsed === 1 ? ["n_used_1"] : [] };
        if (grp.result === "stock_out_of_range") return { ...out2, action: "hold_stock", reason: "stock_out_of_range", flags: [...out2.flags, "stock_out_of_range"], proposed: { set } };
        return { ...out2, action: "nominal_stock", reason: "ok", proposed: { set, protectAfterWrite: true } };
      }

      // ---------------- normal path ----------------
      let rawListings;
      let fetchInfo;
      if (reuseMap.has(name)) {
        const re = reuseMap.get(name);
        rawListings = re.listings;
        fetchInfo = { mode: "reused_listings", source: reuseSourceName, calls: re.calls, whitelisted: rawListings.length, serperResultsLastCall: re.serperResultsLastCall, blocklistedLastCall: re.blocklistedLastCall };
      } else if (offline) {
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
      const { g, decision: computedDecision, ambiguityFallback } = evaluateListings(rawListings, cur, ctx);
      let decision = computedDecision;
      // cloud per-canonical decisions (Part 2 live pilot review, rule 15). Applied only if the computed action is the one the review saw.
      let override = null;
      let setMetric = null;
      const ov = CLOUD_OVERRIDES[name];
      if (ov) {
        if (ov.from.includes(decision.action)) {
          override = { by: "cloud", date: "2026-10-15", ref: ov.ref, decision: ov.decision, originalAction: decision.action, originalReason: decision.reason, note: ov.note };
          if (ov.decision === "update" && decision.supported && decision.supported.length) decision = { ...decision, action: "update", reason: `cloud_override(${decision.reason})`, fields: decision.supported };
          else if (ov.decision === "set_metric") {
            const lst = g.rows.find((r) => r.title === ov.listingTitle && (r.status === "kept" || r.status === "ambiguous"));
            if (lst) {
              setMetric = { value: r6(ov.perKg / 1000), listing: { store: lst.store, price: lst.price, title: lst.title } };
              decision = { action: "update", reason: `cloud_override(${decision.reason})`, fields: ["per_unit_metric"], supported: ["per_unit_metric"], detail: decision.detail };
            } else override = { ...override, skipped: true, note: `override NOT applied: listing "${ov.listingTitle}" not in the kept listings` };
          } else if (ov.decision === "keep_old" && decision.action === "update") decision = { action: "hold", reason: `cloud_keep_old(${decision.reason})`, fields: [], supported: decision.supported, ratios: decision.ratios };
          else if (ov.decision === "skip" && decision.action === "update") decision = { action: "hold", reason: `cloud_skip(${decision.reason})`, fields: [], supported: decision.supported, ratios: decision.ratios };
        } else override = { by: "cloud", skipped: true, expectedAction: ov.from, actualAction: decision.action, note: "override NOT applied: computed action differs from the one cloud reviewed" };
      }
      const listingsOut = g.rows.map((r) => {
        const old = baseline.listings.find((b) => b.title === r.title && b.store === r.store && b.price === r.price);
        return {
          store: r.store, title: r.title, price: r.price, status: r.status, reason: r.reason, flags: r.flags,
          baseline: old ? { pack: old.pack, source_of_pack: old.source_of_pack, per_unit: old.per_unit } : null,
          guarded: { pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit },
          ambiguous: r.ambiguous,
          ...(r.rule10Rescued ? { rule10Rescued: r.rule10Rescued } : {}),
          ...(r.processedFormExempt ? { processedFormExempt: r.processedFormExempt } : {}),
          ...(r.rule22Rescued ? { rule22Rescued: r.rule22Rescued } : {}),
        };
      });
      let proposed = null;
      if (decision.action === "update") {
        const proposedSet = buildUpdateSet(name, g, decision, rawListings.length, fetchInfo.calls ? fetchInfo.calls.length : null);
        if (setMetric) { proposedSet.per_unit_metric = { value: setMetric.value, unit: "g_or_ml", n: 1 }; proposedSet.cheapest = setMetric.listing; }
        proposed = { set: proposedSet };
      }
      const ratioMetric = g.per_unit_metric && cur.metric?.value > 0 ? Math.round((g.per_unit_metric.value / cur.metric.value) * 1000) / 1000 : null;
      const ratioCount = g.per_unit_count && cur.count?.value > 0 ? Math.round((g.per_unit_count.value / cur.count.value) * 1000) / 1000 : null;
      return {
        ...base, family: "normal", action: decision.action, reason: decision.reason, current: cur, fetch: fetchInfo,
        baseline: { per_unit_metric: baseline.per_unit_metric, per_unit_count: baseline.per_unit_count, cheapest: baseline.cheapest, confidence: baseline.confidence, n_supermarkets: baseline.n_supermarkets },
        guarded: { per_unit_metric: g.per_unit_metric, per_unit_count: g.per_unit_count, cheapest: g.cheapest, confidence: g.confidence, n_supermarkets: g.n_supermarkets, outlierMedians: g.dims },
        ratio: { guardedVsCurrent: { metric: ratioMetric, count: ratioCount }, baselineVsCurrent: { metric: baseline.per_unit_metric && cur.metric?.value > 0 ? Math.round((baseline.per_unit_metric.value / cur.metric.value) * 1000) / 1000 : null, count: baseline.per_unit_count && cur.count?.value > 0 ? Math.round((baseline.per_unit_count.value / cur.count.value) * 1000) / 1000 : null } },
        override, keepOldByCloud: !!(override && !override.skipped && (override.decision === "keep_old" || override.decision === "skip")),
        ambiguityFallback, decisionDetail: decision.detail ?? null, listings: listingsOut, proposed,
        fieldsToWrite: decision.fields,
      };
    };

    const results = await pool(selected, CONCURRENCY, async (n, i) => {
      const r = await processOne(n);
      if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${selected.length}\n`);
      return r;
    });

    // cloud decision 23: `tomatoe` takes tomato's guarded metric (count stays its own guarded value, identical £0.166)
    for (const r of results) {
      const spec = CLOUD_OVERRIDES[r.canonical_name];
      if (!spec || !spec.copyMetricFrom || r.action !== "update" || !r.override || r.override.skipped) continue;
      const src = results.find((x) => x.canonical_name === spec.copyMetricFrom);
      const gm = src && src.guarded && src.guarded.per_unit_metric;
      if (gm && r.proposed && r.proposed.set && r.proposed.set.per_unit_metric) {
        r.override.copiedMetricFrom = { canonical: src.canonical_name, value: gm.value, ownGuardedValue: r.guarded.per_unit_metric ? r.guarded.per_unit_metric.value : null };
        r.proposed.set.per_unit_metric = { ...gm };
      }
    }

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

    // ---- rule 17: bucket moves + what is still > £8 -------------------------------------------------
    const lineMap = (c, servings) => {
      const m = new Map();
      for (const l of c.lines || []) if (l.canonical_name && l.lineCost > 0) m.set(l.canonical_name, (m.get(l.canonical_name) || 0) + l.lineCost / servings);
      return m;
    };
    const actionOf = new Map(results.map((r) => [r.canonical_name, r.keepOldByCloud ? `${r.action}(cloud keep_old)` : r.action]));
    const newCostById = new Map(newCosts.map(({ r, c }) => [String(r._id), c]));
    const bucketMoves = [];
    const stillOver8 = [];
    for (const { r, c } of baseCosts) {
      const id = String(r._id);
      const servings = r.servings > 0 ? r.servings : 1;
      const ops = baseServingById.get(id);
      const nps = newServingById.get(id);
      const ob = bucketOf(ops);
      const nb = bucketOf(nps);
      const oldL = lineMap(c, servings);
      const newL = lineMap(newCostById.get(id), servings);
      const deltas = [...new Set([...oldL.keys(), ...newL.keys()])].map((k) => ({ canonical_name: k, oldPerServing: r4(oldL.get(k) ?? 0), newPerServing: r4(newL.get(k) ?? 0), delta: r4((newL.get(k) ?? 0) - (oldL.get(k) ?? 0)), action: actionOf.get(k) ?? "not_in_this_run" }));
      const reasons = deltas.filter((d) => Math.abs(d.delta) > 1e-9).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
      if (ob !== nb) bucketMoves.push({ id, title: r.title, servings: r.servings ?? null, fromBucket: ob, toBucket: nb, oldPerServing: r4(ops), newPerServing: r4(nps), mainReasonCanonicals: reasons });
      if (nb === ">£8") stillOver8.push({ id, title: r.title, servings: r.servings ?? null, oldPerServing: r4(ops), newPerServing: r4(nps), topLines: deltas.sort((a, b) => b.newPerServing - a.newPerServing).slice(0, 3) });
    }
    bucketMoves.sort((a, b) => Math.abs((b.newPerServing ?? 0) - (b.oldPerServing ?? 0)) - Math.abs((a.newPerServing ?? 0) - (a.oldPerServing ?? 0)));
    const bucketMoveMatrix = countBy(bucketMoves, (m) => `${m.fromBucket} -> ${m.toBucket}`);

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
      rule10_rescued_by_exemption: allListings.filter((l) => Array.isArray(l.rule10Rescued) && l.rule10Rescued.length),
      processed_form_excluded: allListings.filter((l) => String(l.reason).startsWith("processed_form")),
      processed_form_exempt_by_name_or_alias: allListings.filter((l) => Array.isArray(l.processedFormExempt) && l.processedFormExempt.length),
      rule22_relaxed_listings_passed_form_guard: allListings.filter((l) => Array.isArray(l.rule22Rescued) && l.rule22Rescued.length),
    };
    const pfByCanon = normalDocs.map((d) => ({ canonical_name: d.canonical_name, impactGbpPerServingSum: d.impactGbpPerServingSum, action: d.action, excluded: (d.listings || []).filter((l) => String(l.reason).startsWith("processed_form")).map((l) => ({ title: l.title, store: l.store, price: l.price, reason: l.reason })) })).filter((x) => x.excluded.length).sort((a, b) => b.impactGbpPerServingSum - a.impactGbpPerServingSum);
    const pfLabelCounts = countBy(ruleEffect.processed_form_excluded, (l) => String(l.reason).replace(/^processed_form:/, ""));
    const ruleEffectSummary = Object.fromEntries(Object.entries(ruleEffect).map(([k, v]) => [k, { listings: v.length, examples: v.slice(0, 5).map((l) => ({ title: l.title, store: l.store, price: l.price, reason: l.reason, status: l.status, rule10Rescued: l.rule10Rescued, baselinePack: l.baseline?.pack ?? null, guardedPack: l.guarded?.pack ?? null, per_unit_old: l.baseline?.per_unit ?? null, per_unit_new: l.guarded?.per_unit ?? null })) }]));
    // rule 11: listings kept by the lenient Guard 3 although the title lacks the full canonical name; by doc impact, max 3 per doc
    const lenientKept = [];
    for (const d of normalDocs) {
      const kept = (d.listings || []).filter((l) => (l.status === "kept" || l.status === "ambiguous") && !titleHasFullName(l.title, d.canonical_name));
      for (const l of kept.slice(0, 3)) lenientKept.push({ canonical_name: d.canonical_name, impactRank: d.impactRank, impactGbpPerServingSum: d.impactGbpPerServingSum, store: l.store, title: l.title, price: l.price, status: l.status, per_unit_guarded: l.guarded?.per_unit ?? null, docAction: d.action });
    }
    lenientKept.sort((a, b) => b.impactGbpPerServingSum - a.impactGbpPerServingSum);
    const lenientTotal = normalDocs.reduce((s, d) => s + (d.listings || []).filter((l) => (l.status === "kept" || l.status === "ambiguous") && !titleHasFullName(l.title, d.canonical_name)).length, 0);
    const recipeRows = (name) => [...(recipesByCanon.get(name) || [])].map((id) => ({ id, title: recipeById.get(id)?.title, oldPerServing: r4(baseServingById.get(id)), newPerServing: r4(newServingById.get(id)) }));
    // rule 22 effect: listings that the relaxed scopes let through, by label / canonical, and whether they survived the other guards
    const rescued22 = [];
    for (const d of normalDocs) for (const l of d.listings || []) if (Array.isArray(l.rule22Rescued) && l.rule22Rescued.length) rescued22.push({ canonical_name: d.canonical_name, docAction: d.action, labels: l.rule22Rescued, title: l.title, store: l.store, price: l.price, status: l.status, reason: l.reason });
    const rule22 = {
      listingsPassedFormGuard: rescued22.length,
      keptAfterOtherGuards: rescued22.filter((x) => x.status === "kept" || x.status === "ambiguous").length,
      byLabel: countBy(rescued22.flatMap((x) => x.labels), (l) => l),
      byCanonical: Object.entries(countBy(rescued22, (x) => x.canonical_name)).sort((a, b) => b[1] - a[1]).map(([canonical_name, n]) => ({ canonical_name, n, action: normalDocs.find((d) => d.canonical_name === canonical_name)?.action })),
      examples: rescued22.slice(0, 25),
      note: "listings whose title matches dried / smoked / garlic & herb / in butter but whose canonical is now exempt (rule 22); some may still be dropped by title_no_match / outlier guards (see status)",
    };
    // rule 23: the 43 recipe lines that use canonical `pepper` (raw text) so cloud can judge black vs bell pepper
    const pepperLines = [];
    for (const { r, c } of baseCosts) {
      const servings = r.servings > 0 ? r.servings : 1;
      for (const l of c.lines || []) if (l.canonical_name === "pepper") pepperLines.push({ recipeId: String(r._id), recipeTitle: r.title, rawName: l.rawName, quantity: l.quantity, unit: l.rawUnit, lineCost: r4(l.lineCost), perServing: l.lineCost > 0 ? r4(l.lineCost / servings) : null });
    }
    const holdRiseList = results.filter((r) => r.action === "hold_rise").map((r) => ({
      canonical_name: r.canonical_name, family: r.family, reason: r.reason, impactGbpPerServingSum: r.impactGbpPerServingSum, publicRecipes: r.publicRecipes,
      current: { metric_per_kg_or_L: r.current?.metric ? r4(r.current.metric.value * 1000) : null, count_each: r.current?.count ? r4(r.current.count.value) : null },
      proposedNotWritten: { metric_per_kg_or_L: r.guarded?.per_unit_metric ? r4(r.guarded.per_unit_metric.value * 1000) : null, count_each: r.guarded?.per_unit_count ? r4(r.guarded.per_unit_count.value) : null },
      ratio: r.ratio?.guardedVsCurrent ?? null,
    })).sort((a, b) => b.impactGbpPerServingSum - a.impactGbpPerServingSum);
    const holdList = results.filter((r) => ["hold", "hold_low_n", "hold_rise", "hold_stock"].includes(r.action)).map((r) => ({
      canonical_name: r.canonical_name, action: r.action, reason: r.reason, impactGbpPerServingSum: r.impactGbpPerServingSum, override: r.override ?? null, keepOldByCloud: !!r.keepOldByCloud,
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
      processedForm: { excludedListings: ruleEffect.processed_form_excluded.length, byLabel: pfLabelCounts, exemptByNameOrAlias: ruleEffect.processed_form_exempt_by_name_or_alias.length, canonicalsAffectedTop40ByImpact: pfByCanon.slice(0, 40), canonicalsAffected: pfByCanon.length },
      bucketMoves: { count: bucketMoves.length, matrix: bucketMoveMatrix, moves: bucketMoves },
      stillOver8,
      overrides: results.filter((r) => r.override).map((r) => ({ canonical_name: r.canonical_name, ...r.override, resultingAction: r.action })),
      holdLowNWithPublicImpact: holdList.filter((h) => h.action === "hold_low_n" && h.publicRecipesAffected.length).sort((a, b) => b.impactGbpPerServingSum - a.impactGbpPerServingSum),
      holdRise: { count: holdRiseList.length, withPublicImpact: holdRiseList.filter((h) => h.publicRecipes > 0).length, capX: RISE_CAP, list: holdRiseList },
      rule22,
      pepperLines: { count: pepperLines.length, recipes: new Set(pepperLines.map((x) => x.recipeId)).size, lines: pepperLines },
      guard3LenientKept: { totalListings: lenientTotal, note: "kept/ambiguous listings whose title lacks some word of the full canonical_name; top 30 by doc impact, max 3 per doc", top30: lenientKept.slice(0, 30) },
      stockGroups,
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
