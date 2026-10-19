/**
 * cc_prompt_shopping_list_price_compare.md Part B — read-only data report (no writes, 0 Serper credits).
 *   node scripts/shopping_list_price_report.cjs   -> summaries/shopping_list_price_report_<date>_v2.json
 *   (v2 = Part B2: options go through makeTitleMatcher / classifyStockListing; also reports the wrong-product drops and a
 *    before/after storeTotals comparison against the committed v1 report.)
 *
 * 1. Every current shopping-list line (canonicalName from the stored field, else from the reviewed backfill dry-run JSON — the backfill
 *    is not written yet) with its full options + the storeTotals the API would return.
 * 2. Over ALL canonical_price_cache docs: qualified listings per doc (0 / 1 / 2-3 / 4-6 / 7+) and distinct stores per doc (1 / 2 / 3 / 4+).
 * 3. Listings dropped by the +-3x-of-median rule: count + first 20 (canonical, title, price).
 */
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const TODAY = new Date().toISOString().slice(0, 10);

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

async function loadModules() {
  const { build } = require("esbuild");
  const entryFile = path.join(API_ROOT, "scripts", "_slprice_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_slprice_bundle.mjs");
  fs.writeFileSync(
    entryFile,
    `export { buildPriceOptions, buildItemPrices, normaliseStore } from "../src/services/shoppingListPrices.ts";\nexport { computeShoppingListStoreTotals } from "../../../packages/shared/src/index.ts";\n`,
  );
  try {
    await build({ entryPoints: [entryFile], bundle: true, platform: "node", format: "esm", outfile: outFile, external: ["mongodb"], logLevel: "silent" });
    return await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
  } finally {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

const bucketDoc = (n) => (n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : "7+");
const bucketStores = (n) => (n >= 4 ? "4+" : String(n));

(async () => {
  const env = loadDevVars();
  const { buildPriceOptions, buildItemPrices, computeShoppingListStoreTotals } = await loadModules();
  const V1 = path.join(SUMMARIES, `shopping_list_price_report_${TODAY}.json`);
  const v1 = fs.existsSync(V1) ? JSON.parse(fs.readFileSync(V1, "utf8")) : null;
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB || "useitup");
  try {
    // --- 2 + 3: all canonical_price_cache docs
    const cache = await db.collection("canonical_price_cache").find({}, { projection: { canonical_name: 1, listings: 1, metadata: 1 } }).toArray();
    const canonByName = new Map((await db.collection("canonical_ingredients").find({}).toArray()).map((d) => [d.canonical_name, d]));
    const perDoc = { "0": 0, "1": 0, "2-3": 0, "4-6": 0, "7+": 0 };
    const perStores = { "0": 0, "1": 0, "2": 0, "3": 0, "4+": 0 };
    const dropped = [];
    const droppedProduct = [];
    let droppedOther = 0;
    let rawListings = 0;
    let qualified = 0;
    const byStore = {};
    for (const d of cache) {
      const r = buildPriceOptions(String(d.canonical_name), d.listings, canonByName.get(d.canonical_name));
      rawListings += Array.isArray(d.listings) ? d.listings.length : 0;
      qualified += r.options.length;
      perDoc[bucketDoc(r.options.length)]++;
      perStores[r.options.length === 0 ? "0" : bucketStores(new Set(r.options.map((o) => o.storeKey)).size)]++;
      dropped.push(...r.droppedOutliers);
      droppedProduct.push(...r.droppedProduct);
      droppedOther += r.droppedOther;
      for (const o of r.options) byStore[o.storeKey] = (byStore[o.storeKey] || 0) + 1;
    }

    // --- 1: current shopping-list lines
    const reviewedPath = path.join(SUMMARIES, "shopping_list_canonical_backfill_dryrun_2026-10-19.json");
    const reviewed = fs.existsSync(reviewedPath) ? JSON.parse(fs.readFileSync(reviewedPath, "utf8")) : { items: [] };
    const planned = new Map(reviewed.items.map((i) => [i._id, i.canonicalName]));
    const lineDocs = await db.collection("shopping_list_items").find({}).sort({ userId: 1, addedAt: 1 }).toArray();
    const cacheByName = new Map(cache.map((d) => [d.canonical_name, d]));
    const users = {};
    for (const d of lineDocs) {
      const canonicalName = typeof d.canonicalName === "string" ? d.canonicalName : (planned.get(String(d._id)) ?? null);
      const cacheDoc = canonicalName ? cacheByName.get(canonicalName) : null;
      const prices = cacheDoc ? buildItemPrices(canonicalName, cacheDoc, canonByName.get(canonicalName)) : null;
      (users[d.userId] ||= []).push({
        text: d.text,
        checked: !!d.checked,
        canonicalName,
        canonicalFrom: typeof d.canonicalName === "string" ? "stored field" : "backfill dry-run",
        prices,
        _item: { checked: !!d.checked, prices },
      });
    }
    const lines = Object.entries(users).map(([userId, items]) => ({
      userId,
      lines: items.map(({ _item, ...rest }) => rest),
      storeTotals: computeShoppingListStoreTotals(items.map((i) => i._item)),
    }));

    const reasonCounts = {};
    for (const x of droppedProduct) { const k = String(x.reason).replace(/[(:].*$/, ""); reasonCounts[k] = (reasonCounts[k] || 0) + 1; }
    const testerV1 = v1 ? v1.currentLines.find((u) => u.lines.length > 1) : null;
    const testerV2 = lines.find((u) => u.lines.length > 1);
    // listings v1 showed on the Tester lines that v2 no longer shows (for the "wrong product removed" check)
    const removedOnTester = [];
    if (testerV1 && testerV2) {
      for (const l2 of testerV2.lines) {
        const l1 = testerV1.lines.find((x) => x.text === l2.text);
        if (!l1 || !l1.prices) continue;
        const keep = new Set((l2.prices ? l2.prices.options : []).map((o) => `${o.storeKey}|${o.title}|${o.price}`));
        for (const o of l1.prices.options) if (!keep.has(`${o.storeKey}|${o.title}|${o.price}`)) removedOnTester.push({ line: l2.text, store: o.store, title: o.title, price: o.price });
      }
    }

    const out = {
      generatedAt: new Date().toISOString(),
      mode: "read-only; 0 Serper credits",
      note: "Shopping-list canonicalName comes from the stored field, else from the reviewed backfill dry-run (backfill not written yet).",
      currentLines: lines,
      testerStoreTotalsBeforeAfter: { before_v1: testerV1 ? testerV1.storeTotals : null, after_v2: testerV2 ? testerV2.storeTotals : null },
      testerOptionsRemovedSinceV1: removedOnTester,
      cacheDistribution: {
        docs: cache.length,
        rawListings,
        qualifiedListings: qualified,
        droppedOutlier3x: dropped.length,
        droppedWrongProduct: droppedProduct.length,
        droppedWrongProductByReason: reasonCounts,
        droppedOtherStoreOrPriceOrDuplicate: droppedOther,
        qualifiedListingsPerDoc: perDoc,
        distinctStoresPerDoc: perStores,
        qualifiedListingsByStore: byStore,
      },
      wrongProductDroppedFirst40: droppedProduct.slice(0, 40).map((x) => ({ canonical: x.canonical, store: x.store, title: x.title, price: x.price, reason: x.reason })),
      outlier3xDropped: { count: dropped.length, first20: dropped.slice(0, 20).map((x) => ({ canonical: x.canonical, store: x.store, title: x.title, price: x.price, perUnit: x.perUnit, median: x.median })) },
    };
    const outPath = path.join(SUMMARIES, `shopping_list_price_report_${TODAY}_v2.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log("docs", cache.length, "raw", rawListings, "qualified", qualified, "dropped3x", dropped.length, "droppedOther", droppedOther);
    console.log("wrong-product drops", droppedProduct.length, JSON.stringify(reasonCounts));
    console.log("tester options removed since v1:", removedOnTester.length);
    console.log("per doc", JSON.stringify(perDoc), "stores", JSON.stringify(perStores));
    for (const u of lines) {
      console.log(`user ...${u.userId.slice(-6)}: ${u.lines.length} line(s)`);
      for (const l of u.lines) console.log(`  ${l.text.padEnd(34)} ${l.canonicalName ?? "null"}  options=${l.prices ? l.prices.options.length : 0}`);
      console.log("  storeTotals:", JSON.stringify(u.storeTotals));
    }
    console.log("wrote", outPath);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
