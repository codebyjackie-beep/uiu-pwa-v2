// Nutrition recompute (cc prompt 2026-10-12 15:13, Part 2): re-derive `nutrition` for the public recipes
// with the shared gram conversion (src/services/nutritionGrams.ts) so ml / pc / unpriced lines stop
// counting as 0 kcal.
//
//   node scripts/nutrition_recompute.cjs                                   # DRY RUN (read-only) -> summaries/nutrition_recompute_dryrun_<date>.json
//   node scripts/nutrition_recompute.cjs --write --from ../../summaries/nutrition_recompute_dryrun_2026-10-12.json [--batch nutrition-...]
//   node scripts/nutrition_recompute_rollback.cjs <batch> [--write]        # undo
//
// Workflow (cloud rule): dry-run -> commit the JSON -> STOP for cloud review -> only then --write with the
// reviewed committed file. --write re-computes live and ABORTS the whole run (nothing written) if any row
// no longer matches the reviewed file (stored nutrition changed, recompute differs, recipe un-published...).
//
// Row actions
//   write                 non-flagged recipe, derived nutrition replaces `nutrition`; old value -> `nutritionPrev`
//   skip_flagged          nutritionUnavailable:true (18) — computed + listed, flag NEVER changed, nutrition untouched
//   hold_review           would be a write, but an objective guard tripped (see reviewFlags): after > 1200 or
//                         < 100 kcal/serving, a "(for frying)" medium line > 100 g counted as eaten, or a line
//                         whose canonical nutrition_per_100g looks wrong (produce > 110 kcal/100 g, "cooked"
//                         item at dry-food density). Listed for cloud; NOT written unless the reviewed file's
//                         action is changed to "write".
//   skip_authoritative    source "spoonacular" with a stored per-serving nutrition that is NOT nutritionApproximate:
//                         that number comes from the source and is better than any recompute — surfaced for cloud
//                         to decide; skipped unless --include-authoritative is passed on --write
//
// Coconut milk (Part 1): canonical `coconut milk` nutrition_per_100g currently holds a wrong CoFID row
// (22 kcal). The dry-run simulates the fix in memory (14-889: 169 kcal / 1.1 P / 3.3 C / 16.9 F per 100 g,
// no reduced-fat canonical exists, see below); --write applies it to the canonical docs with the
// previous nutrition_per_100g saved in `nutritionPer100gPrev` + `nutritionFixBatch` (rollback restores it).
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const SUMMARIES = path.resolve(API_ROOT, "../../summaries");
const WRITE = process.argv.includes("--write");
const INCLUDE_AUTHORITATIVE = process.argv.includes("--include-authoritative");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const FROM = argAfter("--from");
const TODAY = "2026-10-12";
const OUT_DRYRUN = path.join(SUMMARIES, `nutrition_recompute_dryrun_${TODAY}.json`);

// CoFID coconut milk rows (cc prompt 2026-10-12): only the mapping changes, never the CoFID table.
const COCONUT_FIX = {
  "coconut milk": { code: "14-889", kcal: 169, protein: 1.1, carbs: 3.3, fat: 16.9 },
};
// CoFID 14-890 (reduced-fat coconut milk, 79 kcal/100g) applies to a reduced-fat/light canonical — none exists
// in canonical_ingredients today (checked 2026-10-12: only "coconut milk" and "coconut milk (full-fat)"), and the
// prompt gives only the kcal figure, so macros are NOT invented: such a doc would be listed in coconutProposals.

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
  const entryFile = path.join(API_ROOT, "scripts", "_nutrition_recompute_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_nutrition_recompute_bundle.mjs");
  fs.writeFileSync(
    entryFile,
    [
      `export { buildAliasIndex, resolve } from "../src/services/ingredientResolver.ts";`,
      `export { computeRecipeNutrition } from "../src/services/nutritionGrams.ts";`,
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

// Review guards — objective, no guessing: they only HOLD a row back, they never change a number.
const PRODUCE_RE = /\b(spinach|mushrooms?|corn|kale|broccoli|tomato(es)?|onions?|carrots?|lettuce|cucumber|peppers?|zucchini|courgettes?|cabbage|celery|asparagus|aubergines?|eggplants?|cauliflower|pumpkin|squash|beetroot|leeks?|radish(es)?|apples?|pears?|oranges?|lemons?|limes?|berries|berry|mango(es)?|bananas?|peach(es)?|grapes?|pineapple|melon|chard|peas?|green beans?)\b/;
const NOT_PLAIN_PRODUCE_RE = /powder|ground|flakes|salt|paste|dried|seed|cayenne|cracked|clove|corn ?(flour|starch|meal)|popcorn|tortilla|chips|syrup|oil|juice|sauce|stock|broth|cream|chowder|ketchup|puree|sun-?dried/;
function suspectDensityLine(l) {
  if (!l.canonical_name || !l.grams || !l.kcal) return null;
  const dens = (l.kcal / l.grams) * 100;
  const n = l.canonical_name.toLowerCase();
  if (PRODUCE_RE.test(n) && !NOT_PLAIN_PRODUCE_RE.test(n) && dens > 110) return `produce_density:${n}=${Math.round(dens)}kcal/100g`;
  if (/\b(cooked|boiled|steamed)\b/.test(`${n} ${String(l.rawName).toLowerCase()}`) && dens > 200) return `cooked_density:${n}=${Math.round(dens)}kcal/100g`;
  return null;
}
const FRYING_RE = /\bfor (deep[- ]?|shallow[- ]?)?frying\b/i;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pickNutrition = (n) => (n ? { calories: num(n.calories), protein: num(n.protein), carbs: num(n.carbs), fat: num(n.fat) } : null);
const BUCKETS = ["<150", "150-300", "300-600", "600-900", ">900"];
function bucket(k) {
  if (k == null) return "n/a";
  if (k < 150) return "<150";
  if (k < 300) return "150-300";
  if (k < 600) return "300-600";
  if (k <= 900) return "600-900";
  return ">900";
}
function dist(values) {
  const d = Object.fromEntries([...BUCKETS, "n/a"].map((b) => [b, 0]));
  for (const v of values) d[bucket(v)] += 1;
  return d;
}
const same = (a, b) =>
  !!a && !!b && a.calories === b.calories && a.protein === b.protein && a.carbs === b.carbs && a.fat === b.fat;

async function main() {
  const env = loadDevVars();
  const { buildAliasIndex, resolve, computeRecipeNutrition } = await loadServices();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  try {
    const canonCol = db.collection("canonical_ingredients");
    const recipesCol = db.collection("recipes");
    const canonDocs = await canonCol.find({}).toArray();

    // --- canonical overrides (simulated in memory on dry-run; written on --write) ---------------------
    const canonFixes = [];
    for (const d of canonDocs) {
      const name = d.canonical_name;
      const fix = COCONUT_FIX[name] || null;
      if (!fix) continue;
      canonFixes.push({
        id: String(d._id),
        canonical_name: name,
        cofidCode: fix.code,
        before: d.nutrition_per_100g ?? null,
        after: { kcal: fix.kcal, protein: fix.protein, carbs: fix.carbs, fat: fix.fat },
      });
    }
    // Proposed only (not simulated, not written): other coconut-milk canonicals with no nutrition at all.
    const coconutProposals = canonDocs
      .filter((d) => /coconut (milk|cream)/.test(d.canonical_name) && !COCONUT_FIX[d.canonical_name])
      .map((d) => ({ canonical_name: d.canonical_name, nutrition_per_100g: d.nutrition_per_100g ?? null, density_cup: d.density_cup ?? null, per_item_g: d.per_item_g ?? null }));

    const ingredientsMapFixed = new Map();
    for (const d of canonDocs) ingredientsMapFixed.set(d.canonical_name, d);
    const ingredientsMapBefore = new Map(ingredientsMapFixed);
    for (const f of canonFixes) {
      const d = ingredientsMapFixed.get(f.canonical_name);
      ingredientsMapFixed.set(f.canonical_name, { ...d, nutrition_per_100g: { ...(d.nutrition_per_100g || {}), ...f.after } });
    }
    const aliasIndex = await buildAliasIndex(canonCol);
    const resolveFn = (raw) => resolve(raw, aliasIndex);

    const publicRecipes = await recipesCol.find({ isPublic: true }).toArray();
    console.log(`public recipes: ${publicRecipes.length}; canonical fixes: ${canonFixes.map((f) => f.canonical_name).join(", ") || "none"}`);

    const rows = [];
    for (const r of publicRecipes) {
      const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
      const res = computeRecipeNutrition(ings, r.servings, resolveFn, ingredientsMapFixed);
      const resOld = computeRecipeNutrition(ings, r.servings, resolveFn, ingredientsMapBefore); // isolates the coconut effect
      const before = pickNutrition(r.nutrition);
      const after = pickNutrition(res.nutrition);
      const flagged = r.nutritionUnavailable === true;
      const authoritative = !flagged && r.source === "spoonacular" && r.nutritionApproximate !== true && (before?.calories ?? 0) > 0;
      const reviewFlags = [];
      if (after && (after.calories > 1200 || after.calories < 100)) reviewFlags.push(`kcal_out_of_range:${after.calories}`);
      for (const l of res.lines) {
        if (FRYING_RE.test(String(l.rawName)) && (l.grams || 0) > 100 && l.kcal > 0) reviewFlags.push(`frying_medium_counted:${l.rawName}=${Math.round(l.grams)}g/${Math.round(l.kcal)}kcal`);
        const sd = suspectDensityLine(l);
        if (sd) reviewFlags.push(sd);
      }
      const baseAction = flagged ? "skip_flagged" : authoritative ? "skip_authoritative" : "write";
      const action = baseAction === "write" && reviewFlags.length ? "hold_review" : baseAction;
      rows.push({
        id: String(r._id),
        title: r.title,
        source: r.source ?? null,
        servings: r.servings ?? null,
        nutritionUnavailable: flagged,
        nutritionApproximate: r.nutritionApproximate === true,
        action,
        reviewFlags: [...new Set(reviewFlags)],
        before,
        after,
        afterWithoutCoconutFix: pickNutrition(resOld.nutrition),
        nutritionLineCoverage: res.nutrition.nutritionLineCoverage,
        deltaCalories: before && after ? after.calories - before.calories : null,
        unchangedValues: same(before, after),
        // compact line view: enough for review + the top-null table, full detail only for the 5 samples below
        lines: res.lines.map((l) => ({
          raw: l.rawName, q: l.quantity, u: l.rawUnit, c: l.canonical_name, g: l.grams == null ? null : Math.round(l.grams * 10) / 10,
          m: l.method, why: l.reason, kcal: Math.round(l.kcal * 10) / 10, cov: l.inCoverage,
        })),
      });
    }

    // ---- stats ------------------------------------------------------------------------------------
    const nonFlagged = rows.filter((x) => !x.nutritionUnavailable);
    const finalKcal = (x) => (x.action === "write" ? x.after?.calories ?? null : x.before?.calories ?? null);
    const stats = {
      recipes: rows.length,
      byAction: rows.reduce((a, x) => ((a[x.action] = (a[x.action] || 0) + 1), a), {}),
      distribution: {
        beforeStored: dist(rows.map((x) => x.before?.calories ?? null)),
        afterAllRecomputed: dist(rows.map((x) => x.after?.calories ?? null)),
        afterProposedActions: dist(rows.map(finalKcal)),
        buckets: BUCKETS,
      },
      writeRows: rows.filter((x) => x.action === "write").length,
      heldRows: rows.filter((x) => x.action === "hold_review").length,
      writeRowsValuesUnchanged: rows.filter((x) => x.action === "write" && x.unchangedValues).length,
      coconutEffect: rows.filter((x) => x.after && x.afterWithoutCoconutFix && x.after.calories !== x.afterWithoutCoconutFix.calories)
        .map((x) => ({ id: x.id, title: x.title, without: x.afterWithoutCoconutFix.calories, withFix: x.after.calories })),
    };

    const writeRows = rows.filter((x) => x.action === "write" && x.before && x.after);
    const top20 = [...writeRows].sort((a, b) => Math.abs(b.deltaCalories) - Math.abs(a.deltaCalories)).slice(0, 20).map((x) => ({
      id: x.id, title: x.title, servings: x.servings, before: x.before.calories, after: x.after.calories, delta: x.deltaCalories,
      coverage: x.nutritionLineCoverage,
      mainAddedLines: x.lines.filter((l) => l.kcal > 0).sort((a, b) => b.kcal - a.kcal).slice(0, 4).map((l) => ({ raw: l.raw, unit: l.u, grams: l.g, kcal: l.kcal, method: l.m })),
    }));

    const writeOrHold = rows.filter((x) => (x.action === "write" || x.action === "hold_review") && x.before && x.after);
    const decreases = writeOrHold.filter((x) => x.deltaCalories < 0).sort((a, b) => a.deltaCalories - b.deltaCalories).map((x) => ({
      id: x.id, title: x.title, source: x.source, servings: x.servings, before: x.before.calories, after: x.after.calories, delta: x.deltaCalories,
      coverage: x.nutritionLineCoverage, action: x.action,
      topLines: x.lines.filter((l) => l.kcal > 0).sort((a, b) => b.kcal - a.kcal).slice(0, 4).map((l) => `${l.raw}: ${l.q} ${l.u} = ${l.g}g, ${l.kcal}kcal`),
    }));
    const suspectAgg = new Map();
    for (const x of rows) for (const l of x.lines) {
      const sd = suspectDensityLine({ canonical_name: l.c, grams: l.g, kcal: l.kcal, rawName: l.raw });
      if (!sd) continue;
      const key = l.c;
      const e = suspectAgg.get(key) || { canonical_name: key, kcalPer100g: Math.round((l.kcal / l.g) * 100), lines: 0, recipes: new Set() };
      e.lines += 1; e.recipes.add(x.id); suspectAgg.set(key, e);
    }
    const suspectPer100g = [...suspectAgg.values()].map((e) => ({ canonical_name: e.canonical_name, kcalPer100g: e.kcalPer100g, lines: e.lines, recipes: e.recipes.size })).sort((a, b) => b.recipes - a.recipes);

    const outOfRange = rows
      .filter((x) => { const k = finalKcal(x); return k != null && (k > 1200 || k < 100); })
      .map((x) => ({ id: x.id, title: x.title, servings: x.servings, action: x.action, before: x.before?.calories ?? null, after: x.after?.calories ?? null, finalKcal: finalKcal(x), coverage: x.nutritionLineCoverage, nutritionUnavailable: x.nutritionUnavailable }));

    // still-null lines across all public recipes (excl. pantry/water/salt which are not "missing")
    const nullAgg = new Map();
    for (const x of rows) {
      for (const l of x.lines) {
        if (!l.cov) continue;
        if (l.why == null) continue;
        const key = `${l.c ?? `(unresolved) ${String(l.raw).toLowerCase()}`}|${l.why}`;
        let e = nullAgg.get(key);
        if (!e) nullAgg.set(key, (e = { canonical: l.c, name: l.c ?? String(l.raw).toLowerCase(), reason: l.why, lines: 0, recipes: new Set(), units: new Map() }));
        e.lines += 1;
        e.recipes.add(x.id);
        e.units.set(l.u || "(none)", (e.units.get(l.u || "(none)") || 0) + 1);
      }
    }
    const NEED = { missing_density: "add density_cup (or a liquid-table entry)", missing_per_item_g: "add per_item_g", unmapped_unit: "unit word unmapped (add to Table C / unit table)", unit_unconvertible: "unit is unconvertible (to taste / pinch…)", no_nutrition: "add nutrition_per_100g", unresolved: "alias/canonical missing", canonical_doc_missing: "canonical doc missing", bad_quantity: "quantity 0/NaN" };
    const topNull = [...nullAgg.values()]
      .sort((a, b) => b.recipes.size - a.recipes.size || b.lines - a.lines)
      .slice(0, 30)
      .map((e) => ({ name: e.name, reason: e.reason, recipes: e.recipes.size, lines: e.lines, topUnits: [...e.units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u, n]) => `${u}×${n}`), need: NEED[e.reason] || "" }));
    const nullTotals = {};
    for (const e of nullAgg.values()) nullTotals[e.reason] = (nullTotals[e.reason] || 0) + e.lines;

    const flaggedReport = rows.filter((x) => x.nutritionUnavailable).map((x) => ({
      id: x.id, title: x.title, source: x.source, servings: x.servings, before: x.before?.calories ?? null, after: x.after?.calories ?? null,
      coverage: x.nutritionLineCoverage, suggestion: x.nutritionLineCoverage >= 0.8 && x.after && x.after.calories >= 100 && x.after.calories <= 1200 ? "unflag candidate (coverage >= 0.8, kcal plausible)" : "keep flagged",
    }));

    const SAMPLE_TITLES = ["Sweet Potato & Avocado Hash", "Kale With Red Onion", "Goan-Style Curry Mussels", "Apple Curry Soup", "Almond-Matcha Morning Fuel Smoothie"];
    const samples = SAMPLE_TITLES.map((t) => {
      const x = rows.find((r) => r.title.toLowerCase() === t.toLowerCase()) || rows.find((r) => r.title.toLowerCase().includes(t.toLowerCase()));
      return x ? { title: x.title, id: x.id, servings: x.servings, action: x.action, before: x.before, after: x.after, coverage: x.nutritionLineCoverage, lines: x.lines } : { title: t, missing: true };
    });

    // ---- meal plans / logs impact -----------------------------------------------------------------
    const recipeKcal = new Map(rows.map((x) => [x.id, { before: x.before?.calories ?? null, after: finalKcal(x) }]));
    const planSets = await db.collection("meal_plan_sets").find({}).toArray();
    const entryKeys = new Set();
    const plans = [];
    for (const s of planSets) {
      const entries = await db.collection("meal_plans").find({ planId: s._id }).toArray();
      entries.forEach((e) => Object.keys(e).forEach((k) => entryKeys.add(k)));
      const perDay = new Map();
      for (const e of entries) {
        const k = recipeKcal.get(String(e.recipeId));
        const d = perDay.get(e.dayIndex) || { before: 0, after: 0, unknown: 0 };
        if (k) { d.before += Math.round(k.before ?? 0); d.after += Math.round(k.after ?? 0); } else d.unknown += 1; // non-public recipe: not recomputed here
        perDay.set(e.dayIndex, d);
      }
      plans.push({
        name: s.name, id: String(s._id), isActive: s.isActive === true, entries: entries.length,
        calPerDay: [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, v]) => ({ day, ...v })),
      });
    }
    const mealLogs = await db.collection("meal_logs").countDocuments({});
    const mealLogsWithRecipe = await db.collection("meal_logs").countDocuments({ recipeId: { $exists: true } });
    const impact = {
      mealPlansEntryKeys: [...entryKeys].sort(),
      mealPlansCopyCalories: [...entryKeys].some((k) => /calor|nutrition|kcal/i.test(k)),
      note: "meal_plans entries hold recipeId/servings only; calories are read live from recipes.nutrition (routes/mealPlan.ts toEntryView) so the new numbers show immediately; nothing to migrate.",
      mealLogs: { total: mealLogs, withRecipeId: mealLogsWithRecipe, note: "meal_logs store their own calories per entry (photo/manual/barcode); none are recipe-derived copies → not affected." },
      plans,
    };

    const out = {
      generatedAt: new Date().toISOString(),
      baseCommit: "3349e50+",
      stats, canonFixes, coconutProposals,
      top20Changes: top20, outOfRange, topNullLines: topNull, nullLineTotalsByReason: nullTotals,
      flaggedUnavailable: flaggedReport, samples, impact,
      decreases, suspectPer100g,
      held: rows.filter((x) => x.action === "hold_review").map((x) => ({ id: x.id, title: x.title, servings: x.servings, before: x.before?.calories ?? null, after: x.after?.calories ?? null, reviewFlags: x.reviewFlags })),
      rows,
    };

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify(out, null, 1));
      console.log(`DRY RUN → ${OUT_DRYRUN}`);
      console.log(JSON.stringify({ byAction: stats.byAction, distribution: stats.distribution, coconutRecipes: stats.coconutEffect.length, outOfRange: outOfRange.length, canonFixes: canonFixes.map((f) => `${f.canonical_name}: ${f.before?.kcal} -> ${f.after.kcal}`) }, null, 1));
      return;
    }

    // ================= WRITE (reviewed file) =================
    if (!FROM) throw new Error("--write requires --from <reviewed dry-run json>");
    const reviewed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), FROM), "utf8"));
    const problems = [];
    const byId = new Map(rows.map((x) => [x.id, x]));
    const plan = [];
    for (const rr of reviewed.rows) {
      if (rr.action === "skip_flagged") {
        const live = byId.get(rr.id);
        if (live && live.nutritionUnavailable !== true) problems.push(`${rr.id} ${rr.title}: flag changed`);
        continue;
      }
      if (rr.action === "skip_authoritative" && !INCLUDE_AUTHORITATIVE) continue;
      const live = byId.get(rr.id);
      if (!live) { problems.push(`${rr.id} ${rr.title}: no longer public / missing`); continue; }
      if (live.title !== rr.title) problems.push(`${rr.id}: title changed (${live.title})`);
      if (!same(live.before, rr.before)) problems.push(`${rr.id} ${rr.title}: stored nutrition changed since review`);
      if (!same(live.after, rr.after)) problems.push(`${rr.id} ${rr.title}: recompute differs from reviewed (${JSON.stringify(live.after)} vs ${JSON.stringify(rr.after)})`);
      if (live.nutritionUnavailable) problems.push(`${rr.id} ${rr.title}: now flagged unavailable`);
      plan.push({ id: rr.id, title: rr.title, before: live.before, after: live.after, coverage: live.nutritionLineCoverage });
    }
    const reviewedFixes = (reviewed.canonFixes || []).map((f) => f.canonical_name).sort().join();
    if (reviewedFixes !== canonFixes.map((f) => f.canonical_name).sort().join()) problems.push(`canonical fix set differs from reviewed (${reviewedFixes})`);
    if (problems.length) {
      console.error("ABORT — guard failures (nothing written):\n  " + problems.slice(0, 40).join("\n  "));
      process.exit(1);
    }

    const batch = argAfter("--batch") || `nutrition-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const at = new Date();
    // 1) canonical coconut fix first (so the stored recipe numbers match what live recompute will give)
    let canonModified = 0;
    for (const f of canonFixes) {
      const res = await canonCol.updateOne(
        { _id: new ObjectId(f.id), nutritionFixBatch: { $exists: false } },
        { $set: { nutrition_per_100g: f.after, nutritionPer100gPrev: f.before, nutritionFixBatch: batch, nutritionFixCofid: f.cofidCode, nutritionFixAt: at } },
      );
      canonModified += res.modifiedCount;
    }
    // 2) recipes — old nutrition kept in nutritionPrev (null when there was none)
    let recipesModified = 0;
    for (const p of plan) {
      const cur = await recipesCol.findOne({ _id: new ObjectId(p.id) }, { projection: { nutrition: 1 } });
      const merged = { ...(cur.nutrition || {}), ...p.after, nutritionLineCoverage: p.coverage };
      const res = await recipesCol.updateOne(
        { _id: new ObjectId(p.id), nutritionRecomputeBatch: { $exists: false } },
        { $set: { nutrition: merged, nutritionPrev: cur.nutrition ?? null, nutritionRecomputeBatch: batch, nutritionRecomputeAt: at } },
      );
      recipesModified += res.modifiedCount;
    }
    console.log(`WRITE batch ${batch}: canonical modified ${canonModified}/${canonFixes.length}; recipes modified ${recipesModified}/${plan.length}`);
    if (recipesModified !== plan.length || canonModified !== canonFixes.length) process.exitCode = 1;

    // re-query evidence
    const after = await recipesCol.find({ nutritionRecomputeBatch: batch }).project({ title: 1, nutrition: 1, nutritionPrev: 1 }).toArray();
    const flagStill = await recipesCol.countDocuments({ isPublic: true, nutritionUnavailable: true });
    const evidence = {
      batch, appliedAt: at.toISOString(), source: path.basename(path.resolve(process.cwd(), FROM)),
      canonicalModified: canonModified, recipesModified,
      flaggedStillUnavailable: flagStill,
      distributionAfter: dist((await recipesCol.find({ isPublic: true }).project({ nutrition: 1 }).toArray()).map((r) => r.nutrition?.calories ?? null)),
      sample: after.slice(0, 10).map((r) => ({ id: String(r._id), title: r.title, before: r.nutritionPrev?.calories ?? null, after: r.nutrition.calories })),
    };
    const file = path.join(SUMMARIES, `${batch}_applied.json`);
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 1));
    console.log(`→ ${file}`);
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
