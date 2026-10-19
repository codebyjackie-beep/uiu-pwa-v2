// recipe_cost recompute for all PUBLIC recipes after the alias / per_item_g / nutrition-adjacent canonical changes (2026-10-12).
//
//   node scripts/recipe_cost_recompute.cjs                                        # DRY RUN (read-only) -> summaries/recipe_cost_recompute_dryrun_<date>.json
//   node scripts/recipe_cost_recompute.cjs --write --from ../../summaries/recipe_cost_recompute_dryrun_2026-10-12.json [--batch rcr-...]
//   node scripts/recipe_cost_recompute_rollback.cjs <batch> [--write]            # undo
//
// Uses the production costRecipe() with exactly the inputs of jobs/precomputeRecipeCosts.ts (all canonical docs, all price docs,
// quarantine-filtered alias index, quarantinedNames) and compares against the stored recipe_cost docs.
// Only PUBLIC recipes whose recomputed cost differs from the stored doc are rewritten; previous doc -> `costFixPrev`, `costFixBatch`.
// --write re-computes live, ABORTS when anything differs from the reviewed file or when the anomaly gate trips
// (perServing > £8, or perServing drops by more than 50%).
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const WRITE = process.argv.includes("--write");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const FROM = argAfter("--from");
const TODAY = "2026-10-12";
// --out <file> keeps an earlier committed dry-run from being overwritten (default stays the 2026-10-12 name)
const OUT_DRYRUN = argAfter("--out") ? path.resolve(process.cwd(), argAfter("--out")) : path.join(SUMMARIES, `recipe_cost_recompute_dryrun_${TODAY}.json`);

// mirrors packages/shared costDisplayTier + apps/web/app/lib/recipeFilters PRICE_BUCKETS
const FULL_PCT = 80;
const MIN_PCT = 50;
const tier = (pct) => (pct == null || !Number.isFinite(pct) ? "unavailable" : pct >= FULL_PCT ? "full" : pct >= MIN_PCT ? "partial" : "unavailable");
const BUCKETS = [
  { key: "under1_5", test: (p) => p < 1.5 },
  { key: "1_5to3", test: (p) => p >= 1.5 && p < 3 },
  { key: "3plus", test: (p) => p >= 3 },
];
const PER_SERVING_MAX = 8;
const DROP_MAX = 0.5;
const PLAN_NAME_RE = /weekly plan 6/i;
// Cloud Part 4 decision 29 (2026-10-16, ba6595e): the anomaly gate is waived ONLY for these 18 recipes (+12 cloud-approved 2026-10-19, below) (16 stock-line drops,
// Caprese Salad tomato/mozzarella corrections, Crab Cakes Eggs Benedict unchanged > £8). Any other recipe tripping the gate aborts.
const GATE_ALLOWLIST = {
  "69c31de2b17f27d65b4f4ecf": "Azteca Soup",
  "69d1933f0ce7d5269f695270": "Cajun King Prawns with Dirty Rice",
  "69b5c9a95ee86d48cd96c675": "Chicken Porridge",
  "69b9587c7d3db8c999c7df81": "Crab Cakes Eggs Benedict",
  "69c31de2b17f27d65b4f4ec9": "Creamy Broccoli & Celery Soup",
  "69d1933f0ce7d5269f695274": "Creamy Prawn Risotto",
  "69b1db93974afef25b93a452": "Quick and Easy Caprese Salad",
  "69b1db93974afef25b93a455": "Quick and Easy Southwestern Corn Chowder",
  "69d1933f0ce7d5269f695272": "Quick Prawn and Chorizo Paella",
  "69d04b0f26a6c4c3877dfcd3": "Red Curry Stew & Vegetable Noodles",
  "69b1db93974afef25b93a473": "Red Kidney Bean Jambalaya",
  "69b1db92974afef25b93a449": "Red Lentil Soup with Chicken and Turnips",
  "69d04b0f26a6c4c3877dfcd2": "Red quinoa cranberry arugula soup",
  "69d5776887d5d72710ae8ec8": "Rustic Vegetable & Dumpling Stew with Soda-Glazed Tomatoes & Herb Salad",
  "69c31de2b17f27d65b4f4eca": "Savoy Cabbage and Celery Root Soup with Leek Confit",
  "6ac80e0cb0ca951a2fbf7664": "Smoky Butternut Black Bean Chili with Bulgur",
  "69c473017393a7f0235b89b4": "Thai Shrimp",
  "69c31dd4b17f27d65b4f4ec4": "Vegan Colcannon Soup",
  // cloud 2026-10-19 (unpriced-lines fix, 13 ids = all tier upgrades, none > £8, none dropped; "Red quinoa cranberry arugula soup" above is the 13th):
  "69b1db92974afef25b93a44d": "Chicken and Roasted Broccoli Salad With Goat Cheese", // tier unavailable -> partial
  "69b4af41734a319b1f59a1c5": "Baked Chicken With Lemon & Garlic", // tier partial -> full
  "69c31de2b17f27d65b4f4ec8": "Caponata Style Celery Spaghetti", // tier partial -> full
  "69b1db93974afef25b93a453": "Quick and Easy Scallop Pasta", // tier unavailable -> partial
  "69c31de2b17f27d65b4f4ec7": "Celery Apple Risotto With Crispy Pancetta", // tier partial -> full
  "69d191951648bcfb8b552615": "Zesty Avocado Toast with Ginger-Shallot Relish", // tier partial -> full
  "69d5710287d5d72710ae8eb0": "Crock Pot Chicken Pho", // tier partial -> full
  "69c7275f754babcc25875c89": "Easy Tabouleh", // tier partial -> full
  "69d1933f0ce7d5269f695273": "Crispy Sesame Prawn Toast", // tier partial -> full
  "69d191951648bcfb8b55261d": "Black Bean Burgers with Caramelized Onions & Avocado Mash", // tier partial -> full
  "69c7275f754babcc25875c8a": "Winter Fattoush Salad", // tier partial -> full
  "6a5ff781a91e3f027a2961e9": "Korean Beef Rice Bowl", // tier unavailable -> partial
};

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r2 = (v) => Math.round(v * 100) / 100;
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
  const entryFile = path.join(API_ROOT, "scripts", "_rcr_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_rcr_bundle.mjs");
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

// perServing as the app uses it (recipePerServingPrice): finite and > 0, else null
const psOf = (c) => { const v = c && num(c.perServing); return v != null && v > 0 ? v : null; };
const covOf = (c) => (c ? num(c.adjustedCoveragePct) : null);

// stats over a recipeId -> cost-ish map, for the public recipes + plan sets
function stats(publicIds, costById, planSets, planEntries, titleById) {
  const tiers = { full: 0, partial: 0, unavailable: 0 };
  const buckets = { under1_5: 0, "1_5to3": 0, "3plus": 0, excluded_no_price_or_unavailable: 0 };
  for (const id of publicIds) {
    const c = costById.get(id);
    const t = tier(covOf(c));
    tiers[t] += 1;
    const ps = psOf(c);
    if (ps == null || t === "unavailable") { buckets.excluded_no_price_or_unavailable += 1; continue; }
    buckets[BUCKETS.find((b) => b.test(ps)).key] += 1;
  }
  const plans = [];
  for (const s of planSets) {
    const entries = planEntries.get(String(s._id)) || [];
    let total = 0;
    let missing = 0;
    const byDay = {};
    for (const e of entries) {
      const ps = psOf(costById.get(String(e.recipeId)));
      if (ps == null) { missing += 1; continue; }
      const v = ps * (e.servings ?? 1);
      total += v;
      byDay[e.dayIndex] = (byDay[e.dayIndex] || 0) + v;
    }
    plans.push({
      name: s.name, id: String(s._id), isActive: s.isActive === true, entries: entries.length, entriesWithoutPrice: missing,
      total: r2(total), byDay: Object.fromEntries(Object.entries(byDay).sort().map(([k, v]) => [k, r2(v)])),
    });
  }
  return { tiers, buckets, plans };
}

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
    const recipes = await recipesCol.find({}).project({ title: 1, isPublic: 1, servings: 1, ingredients: 1 }).toArray();
    // full docs needed by costRecipe — re-read the fields it uses without projection guesswork
    const recipesFull = await recipesCol.find({}).toArray();
    const storedCosts = await costCol.find({}).toArray();
    const storedById = new Map(storedCosts.map((d) => [String(d.recipeId), d]));
    const titleById = new Map(recipes.map((r) => [String(r._id), r.title]));

    const quarantinedNames = new Set(canonDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
    const shimCol = { find: () => ({ project: () => ({ toArray: async () => canonDocs.filter((d) => d.quarantine !== true) }) }) };
    const index = await buildAliasIndex(shimCol);
    const resolveFn = (raw) => resolve(raw, index);
    const ingredientsMap = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const priceCacheStamp = priceDocs.reduce((max, d) => {
      const f = d.metadata && d.metadata.fetched_at;
      const t = f ? new Date(f).getTime() : 0;
      return t > max ? t : max;
    }, 0);

    const publicIds = recipesFull.filter((r) => r.isPublic === true).map((r) => String(r._id));
    const publicSet = new Set(publicIds);

    const changed = [];
    let nonPublicChanged = 0;
    let publicUnchanged = 0;
    const freshById = new Map();
    for (const r of recipesFull) {
      const id = String(r._id);
      const fresh = JSON.parse(JSON.stringify(costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames)));
      freshById.set(id, fresh);
      const st = storedById.get(id) || null;
      const differs =
        !st ||
        Math.abs((num(st.basket) ?? 0) - fresh.basket) > 1e-6 ||
        Math.abs((num(st.perServing) ?? 0) - fresh.perServing) > 1e-6 ||
        Math.abs((num(st.adjustedCoveragePct) ?? 0) - fresh.adjustedCoveragePct) > 1e-6 ||
        Math.abs((num(st.adjustedPriceable) ?? 0) - fresh.adjustedPriceable) > 1e-9 ||
        Math.abs((num(st.adjustedTotal) ?? 0) - fresh.adjustedTotal) > 1e-9;
      if (!publicSet.has(id)) { if (differs) nonPublicChanged += 1; continue; }
      if (!differs) { publicUnchanged += 1; continue; }

      // line-level: newly priced / un-priced / cost-changed lines vs the stored doc (matched by index, then by rawName)
      const stLines = Array.isArray(st && st.lines) ? st.lines : [];
      const lineChanges = [];
      fresh.lines.forEach((l, i) => {
        const sl = stLines[i] && stLines[i].rawName === l.rawName ? stLines[i] : stLines.find((x) => x.rawName === l.rawName);
        const wasPriced = !!(sl && sl.priceable);
        const cb = sl ? num(sl.lineCost) ?? 0 : 0;
        const ca = num(l.lineCost) ?? 0;
        if (wasPriced !== !!l.priceable || Math.abs(cb - ca) > 1e-9) {
          lineChanges.push({
            raw: l.rawName, qty: l.quantity ?? null, unit: l.rawUnit ?? null,
            canonicalBefore: sl ? sl.canonical_name ?? null : null, canonicalAfter: l.canonical_name ?? null,
            pricedBefore: wasPriced, pricedAfter: !!l.priceable,
            reasonBefore: sl && !sl.priceable ? sl.reason ?? null : null, reasonAfter: !l.priceable ? l.reason ?? null : null,
            normAfter: l.normValue != null ? `${r4(l.normValue)} ${l.normUnit}` : null,
            perUnitAfter: l.perUnit ?? null, costBefore: r4(cb), costAfter: r4(ca),
            kind: !wasPriced && l.priceable ? "newly_priced" : wasPriced && !l.priceable ? "no_longer_priced" : "cost_changed",
          });
        }
      });
      const psB = psOf(st);
      const psA = psOf(fresh);
      const covB = covOf(st);
      const covA = covOf(fresh);
      changed.push({
        id, title: r.title, servings: r.servings ?? null, hadStored: !!st,
        before: { basket: st ? r4(num(st.basket) ?? 0) : null, perServing: psB != null ? r4(psB) : null, adjustedCoveragePct: covB != null ? r4(covB) : null, tier: tier(covB) },
        after: { basket: r4(fresh.basket), perServing: psA != null ? r4(psA) : null, adjustedCoveragePct: r4(fresh.adjustedCoveragePct), tier: tier(fresh.adjustedCoveragePct) },
        perServingChangePct: psB != null && psA != null && psB > 0 ? r4(((psA - psB) / psB) * 100) : null,
        lineChanges,
      });
    }
    changed.sort((a, b) => a.title.localeCompare(b.title));

    // ---- anomaly gate ----
    const anomalies = [];
    for (const c of changed) {
      const a = c.after.perServing;
      const b = c.before.perServing;
      if (a != null && a > PER_SERVING_MAX) anomalies.push({ id: c.id, title: c.title, rule: `perServing > £${PER_SERVING_MAX}`, before: b, after: a });
      if (a != null && b != null && b > 0 && a < b * (1 - DROP_MAX)) anomalies.push({ id: c.id, title: c.title, rule: `perServing dropped > ${DROP_MAX * 100}%`, before: b, after: a });
      if (a == null && b != null) anomalies.push({ id: c.id, title: c.title, rule: "perServing became unavailable", before: b, after: a });
    }
    // unchanged public recipes already > £8 (information)
    const publicAbove8 = publicIds
      .map((id) => ({ id, title: titleById.get(id), perServing: psOf(freshById.get(id)) }))
      .filter((x) => x.perServing != null && x.perServing > PER_SERVING_MAX)
      .map((x) => ({ ...x, perServing: r4(x.perServing) }));

    // ---- before/after stats ----
    const planSets = await db.collection("meal_plan_sets").find({}).toArray();
    const planEntries = new Map();
    for (const s of planSets) planEntries.set(String(s._id), await db.collection("meal_plans").find({ planId: s._id }).toArray());
    const beforeMap = new Map(publicIds.map((id) => [id, storedById.get(id) || null]));
    const afterMap = new Map(publicIds.map((id) => [id, storedById.get(id) || null]));
    for (const c of changed) afterMap.set(c.id, freshById.get(c.id));
    const sBefore = stats(publicIds, beforeMap, planSets, planEntries, titleById);
    const sAfter = stats(publicIds, afterMap, planSets, planEntries, titleById);

    const transitions = {};
    for (const c of changed) {
      const k = `${c.before.tier} -> ${c.after.tier}`;
      transitions[k] = (transitions[k] || 0) + 1;
    }
    const big = changed.filter((c) => c.perServingChangePct != null && Math.abs(c.perServingChangePct) > 30 || (c.before.perServing == null) !== (c.after.perServing == null));

    const report = {
      generatedAt: new Date().toISOString(),
      priceCacheStamp,
      counts: { recipesTotal: recipesFull.length, publicRecipes: publicIds.length, publicChanged: changed.length, publicUnchanged, nonPublicChangedNotWritten: nonPublicChanged, perServingChangeOver30pct: big.length, publicWithoutStoredDoc: changed.filter((c) => !c.hadStored).length },
      gate: { perServingMax: PER_SERVING_MAX, dropMax: DROP_MAX, anomalyCount: anomalies.length, anomalies, publicAbove8Now: publicAbove8 },
      tierTransitions: transitions,
      tiersBefore: sBefore.tiers, tiersAfter: sAfter.tiers,
      priceBucketsBefore: sBefore.buckets, priceBucketsAfter: sAfter.buckets,
      plansBefore: sBefore.plans, plansAfter: sAfter.plans,
      perServingChangeOver30pct: big,
      changed,
      afterFull: changed.map((c) => ({ id: c.id, cost: freshById.get(c.id) })),
    };

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify(report, null, 1));
      console.log(`DRY RUN -> ${OUT_DRYRUN}`);
      console.log(JSON.stringify({
        counts: report.counts, gate: { anomalyCount: anomalies.length, anomalies, publicAbove8Now: publicAbove8 },
        tierTransitions: transitions, tiersBefore: sBefore.tiers, tiersAfter: sAfter.tiers,
        priceBucketsBefore: sBefore.buckets, priceBucketsAfter: sAfter.buckets,
        plansBefore: sBefore.plans.filter((p) => PLAN_NAME_RE.test(p.name)), plansAfter: sAfter.plans.filter((p) => PLAN_NAME_RE.test(p.name)),
      }, null, 1));
      return;
    }

    // ---------------- WRITE (guarded) ----------------
    if (!FROM) throw new Error("--write needs --from <reviewed dry-run json>");
    const reviewed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), FROM), "utf8"));
    const bad = [];
    // the gate stays ON; only the ids cloud reviewed one by one (GATE_ALLOWLIST) may trip it
    const unlisted = anomalies.filter((a) => !GATE_ALLOWLIST[a.id]);
    if (unlisted.length) bad.push(`anomaly gate tripped for ${unlisted.length} recipe(s) not in GATE_ALLOWLIST: ${unlisted.slice(0, 10).map((a) => `${a.title} (${a.rule})`).join("; ")}`);
    const revUnlisted = (reviewed.gate.anomalies || []).filter((a) => !GATE_ALLOWLIST[a.id]);
    if (revUnlisted.length) bad.push(`reviewed file has ${revUnlisted.length} anomalies outside GATE_ALLOWLIST — not an approved file`);
    if (reviewed.priceCacheStamp !== priceCacheStamp) bad.push(`priceCacheStamp ${priceCacheStamp} != reviewed ${reviewed.priceCacheStamp} (price cache refreshed since review)`);
    const revById = new Map(reviewed.changed.map((c) => [c.id, c]));
    if (revById.size !== changed.length) bad.push(`changed count ${changed.length} != reviewed ${revById.size}`);
    for (const c of changed) {
      const rv = revById.get(c.id);
      if (!rv) { bad.push(`${c.id} ${c.title}: not in reviewed file`); continue; }
      if (rv.after.basket !== c.after.basket || rv.after.perServing !== c.after.perServing || rv.after.adjustedCoveragePct !== c.after.adjustedCoveragePct
        || rv.before.basket !== c.before.basket) bad.push(`${c.id} ${c.title}: differs from reviewed`);
    }
    if (bad.length) {
      console.error(["ABORT - guard failures (nothing written):", ...bad.slice(0, 30)].join("\n  "));
      process.exit(1);
    }
    const batch = argAfter("--batch") || `rcr-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const at = new Date();
    let modified = 0;
    for (const c of changed) {
      const cost = freshById.get(c.id);
      const st = storedById.get(c.id);
      const prev = st ? (({ _id, ...rest }) => rest)(JSON.parse(JSON.stringify(st))) : null;
      const res = await costCol.updateOne(
        st ? { recipeId: new ObjectId(c.id), computedAt: st.computedAt } : { recipeId: new ObjectId(c.id) },
        { $set: { recipeId: new ObjectId(c.id), ...cost, computedAt: at.toISOString(), priceCacheStamp, costFixPrev: prev, costFixBatch: batch } },
        { upsert: !st },
      );
      modified += (res.modifiedCount || 0) + (res.upsertedCount || 0);
    }
    console.log(`WRITE batch ${batch}: recipe_cost ${modified}/${changed.length}`);
    if (modified !== changed.length) process.exitCode = 1;

    // ---- re-query + compare with the dry-run ----
    const nowDocs = await costCol.find({}).toArray();
    const nowById = new Map(nowDocs.map((d) => [String(d.recipeId), d]));
    const nowMap = new Map(publicIds.map((id) => [id, nowById.get(id) || null]));
    const sNow = stats(publicIds, nowMap, planSets, planEntries, titleById);
    let rowMismatch = 0;
    for (const c of changed) {
      const d = nowById.get(c.id);
      if (!d || r4(d.basket) !== c.after.basket || psOf(d) !== psOf(freshById.get(c.id)) || r4(d.adjustedCoveragePct) !== c.after.adjustedCoveragePct || d.costFixBatch !== batch) rowMismatch += 1;
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const evidence = {
      batch, appliedAt: at.toISOString(), source: path.basename(path.resolve(process.cwd(), FROM)),
      recipeCostModified: modified, expected: changed.length,
      gateAllowlist: { waivedIds: anomalies.map((a) => a.id), allowlistSize: Object.keys(GATE_ALLOWLIST).length, ref: "cloud Part 4 decision 29" },
      requery: {
        rowMismatch,
        tiers: sNow.tiers, tiersMatchDryRunAfter: same(sNow.tiers, reviewed.tiersAfter),
        priceBuckets: sNow.buckets, bucketsMatchDryRunAfter: same(sNow.buckets, reviewed.priceBucketsAfter),
        plans: sNow.plans.filter((p) => PLAN_NAME_RE.test(p.name)),
        plansMatchDryRunAfter: same(sNow.plans, reviewed.plansAfter),
        publicAbove8: publicIds.filter((id) => (psOf(nowById.get(id)) || 0) > PER_SERVING_MAX).length,
      },
    };
    const outApplied = path.join(SUMMARIES, `recipe_cost_recompute_${batch}_applied.json`);
    fs.writeFileSync(outApplied, JSON.stringify(evidence, null, 1));
    console.log(JSON.stringify(evidence, null, 1));
    console.log(`evidence -> ${outApplied}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
