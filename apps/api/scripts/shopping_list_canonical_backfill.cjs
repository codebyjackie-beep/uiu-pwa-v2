/**
 * cc_prompt_shopping_list_price_compare.md Part A.5 — backfill shopping_list_items.canonicalName for items saved before Part A.
 *
 *   node scripts/shopping_list_canonical_backfill.cjs                         # dry-run (default): lists text -> canonicalName|null for ALL users,
 *                                                                              # writes summaries/shopping_list_canonical_backfill_dryrun_<date>.json
 *   node scripts/shopping_list_canonical_backfill.cjs --write --from <json> --batch slcanon-YYYYMMDD
 *
 * Resolution = the same resolver costRecipe() uses, EXACT / ALIAS only (a fuzzy hit counts as unresolved -> null).
 * Only items with no canonicalName field at all are touched. A write stores canonicalNamePrev (the old value, null if the field was
 * missing) + canonicalNamePrevAbsent + canonicalNameBatch so shopping_list_canonical_backfill_rollback.cjs can restore exactly.
 * Write refuses unless the reviewed JSON still matches a fresh dry-run line for line.
 */
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const TODAY = new Date().toISOString().slice(0, 10);
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes("--write");
const FROM = argAfter("--from");
const BATCH = argAfter("--batch");
const OUT = path.join(SUMMARIES, `shopping_list_canonical_backfill_dryrun_${TODAY}.json`);

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

async function loadResolver() {
  const { build } = require("esbuild");
  const entryFile = path.join(API_ROOT, "scripts", "_slcanon_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_slcanon_bundle.mjs");
  fs.writeFileSync(entryFile, `export { buildAliasIndex, resolve } from "../src/services/ingredientResolver.ts";\n`);
  try {
    await build({ entryPoints: [entryFile], bundle: true, platform: "node", format: "esm", outfile: outFile, external: ["mongodb"], logLevel: "silent" });
    return await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
  } finally {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

async function plan(db) {
  const { buildAliasIndex, resolve } = await loadResolver();
  const index = await buildAliasIndex(db.collection("canonical_ingredients"));
  const docs = await db.collection("shopping_list_items").find({ canonicalName: { $exists: false } }).sort({ userId: 1, addedAt: 1 }).toArray();
  const resolved = docs.map((d) => ({ d, r: resolve(String(d.text || ""), index) }));
  const items = resolved.map(({ d, r }) => ({
    _id: String(d._id),
    userId: d.userId,
    text: d.text,
    checked: !!d.checked,
    canonicalName: "canonical_name" in r && r.method === "exact" ? r.canonical_name : null,
  }));
  const fuzzyOnly = resolved
    .filter(({ r }) => "canonical_name" in r && r.method === "fuzzy")
    .map(({ d, r }) => ({ text: d.text, fuzzyWouldBe: r.canonical_name }));
  return { items, fuzzyOnly };
}

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB || "useitup");
  try {
    const { items, fuzzyOnly } = await plan(db);
    const total = await db.collection("shopping_list_items").countDocuments({});
    if (!WRITE) {
      const out = {
        generatedAt: new Date().toISOString(),
        mode: "dry-run",
        rule: "ingredientResolver exact/alias only (no fuzzy); null = unresolved",
        shoppingListItemsTotal: total,
        withoutCanonicalNameField: items.length,
        resolved: items.filter((i) => i.canonicalName).length,
        unresolved: items.filter((i) => !i.canonicalName).length,
        fuzzyOnlyNotUsed: fuzzyOnly,
        items,
      };
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(`dry-run: ${items.length} item(s) without canonicalName of ${total}; resolved ${out.resolved}, null ${out.unresolved}`);
      for (const i of items) console.log(`  ${String(i.userId).slice(-6)}  ${String(i.text).padEnd(36)} -> ${i.canonicalName}`);
      console.log("wrote", OUT);
      return;
    }
    if (!FROM || !BATCH) throw new Error("--write needs --from <reviewed dry-run json> and --batch <name>");
    const reviewed = JSON.parse(fs.readFileSync(FROM, "utf8"));
    const key = (arr) => JSON.stringify(arr.map((i) => [i._id, i.text, i.canonicalName]));
    if (key(reviewed.items) !== key(items)) throw new Error("fresh dry-run differs from the reviewed file — re-run the dry-run and get it reviewed again");
    const at = new Date().toISOString();
    let written = 0;
    for (const i of items) {
      const res = await db.collection("shopping_list_items").updateOne(
        { _id: new ObjectId(i._id), canonicalName: { $exists: false } },
        { $set: { canonicalName: i.canonicalName, canonicalNamePrev: null, canonicalNamePrevAbsent: true, canonicalNameBatch: BATCH, canonicalNameAt: at } },
      );
      written += res.modifiedCount;
    }
    const after = await db.collection("shopping_list_items").countDocuments({ canonicalNameBatch: BATCH });
    const missing = await db.collection("shopping_list_items").countDocuments({ canonicalName: { $exists: false } });
    console.log(`wrote ${written}/${items.length}; re-query canonicalNameBatch=${BATCH}: ${after}; still missing field: ${missing}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
