// Part 8 apply (Jackie sign-off 2026-10-11 21:51). Dry-run by default; --write applies a REVIEWED plan file.
//
//   node scripts/part8_apply.cjs                                     # dry run -> summaries/part8_apply_dryrun_2026-10-11.json
//   node scripts/part8_apply.cjs --write --from <plan.json> [--batch part8-...]
//   node scripts/part8_rollback.cjs <batch> [--write]                # undo
//
// Actions (all reversible, nothing deleted):
//   1. 17 recipes -> nutritionUnavailable:true (+ nutritionFlagBatch/At/Reason; kcal values kept)
//   2. Apple Curry Soup: servings 1 -> 4, nutrition re-derived per serving, recipe_cost recomputed
//   3. 2 Warm Chickpea recipes -> isPublic:false + withdrawnBatch/At/Reason (aborts if protected)
//   4. lowercase title fix (titleOriginal kept)
//   5. 31 junk mealType -> $unset mealType, original kept in mealTypeOriginal
// Also (report only, never written): coconut milk nutrition investigation.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { MongoClient, ObjectId } = require("mongodb");
const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

const WRITE = process.argv.includes("--write");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const FROM = argAfter("--from");
const SUMMARIES = path.resolve(__dirname, "../../../summaries");
const DRYRUN_FILE = path.join(SUMMARIES, "part8_apply_dryrun_2026-10-11.json");

const FLAG_IDS = [
  "69c473017393a7f0235b89b9", "69c4766a7393a7f0235b89c9", "69c4766a7393a7f0235b89ca", "69c4766a7393a7f0235b89cc",
  "69d191951648bcfb8b552615", "69d5776887d5d72710ae8ec3", "69d191951648bcfb8b55261d", "69d04b0f26a6c4c3877dfcc9",
  "69d5776887d5d72710ae8ecc", "69d5776887d5d72710ae8ec9", "69c5c81c64ee1f17b0563dcf", "6a42e050d33617bebef22d80",
  "6a5ff992a91e3f027a2961eb", "6a5ffd1ca91e3f027a2961f9", "6a7b9cdf8427001f36231d76", "6a863c85753b0060c3baeaf1",
  "6a88c731b58cdb4d516136af",
];
const APPLE_ID = "69c5c81c64ee1f17b0563dd0";
const WITHDRAW_IDS = ["6a863c85753b0060c3baeaf1", "6a88c731b58cdb4d516136af"];
const WITHDRAW_REASON = "ingredient lines are supermarket product titles";
const TITLE_ID = "69fa56304476f68485ccfcec";
const TITLE_NEW = "Fennel, Pepper & Lettuce Salad";
const JUNK_MEALTYPES = new Set(["pasta", "quick", "healthy", "trending", "vegetarian", "side dish"]);
const FLAG_REASON = "nutrition under-computed: <70% of ingredient lines have nutrition data (part8)";

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const oid = (s) => new ObjectId(s);
const round1 = (n) => Math.round(n * 10) / 10;

async function loadClassifier() {
  const p = path.resolve(__dirname, "../../../packages/shared/dist/index.js");
  return (await import(pathToFileURL(p).href)).classifyRecipeMealTypes;
}

async function main() {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const recipesCol = db.collection("recipes");

    if (WRITE) return await applyPlan(db, recipesCol);

    // ---------------- DRY RUN (read-only) ----------------
    const classify = await loadClassifier();
    const ciCol = db.collection("canonical_ingredients");
    const index = await buildAliasIndex(ciCol);
    const ingDocs = await ciCol.find({}).toArray();
    const ingMap = new Map(ingDocs.map((d) => [d.canonical_name, d]));
    const quarantined = new Set(ingDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()));
    const priceMap = new Map((await db.collection("canonical_price_cache").find({}).toArray()).map((d) => [d.canonical_name, d]));
    const resolveFn = (raw) => resolve(raw, index);

    const publicRecipes = await recipesCol.find({ isPublic: true }).toArray();
    const byId = new Map(publicRecipes.map((r) => [String(r._id), r]));
    const problems = [];
    const need = (id) => {
      const r = byId.get(id);
      if (!r) problems.push(`recipe ${id} is not a public recipe`);
      return r;
    };

    // 1. flags
    const flags = FLAG_IDS.map((id) => {
      const r = need(id);
      if (!r) return null;
      if (r.nutritionUnavailable === true) problems.push(`${id} already nutritionUnavailable`);
      return { id, title: r.title, storedCalories: r.nutrition?.calories ?? null, nutritionUnavailableBefore: r.nutritionUnavailable === true };
    }).filter(Boolean);

    // 2. Apple Curry Soup
    const apple = need(APPLE_ID);
    let appleAction = null;
    if (apple) {
      const oldCost = await db.collection("recipe_cost").findOne({ recipeId: apple._id });
      const modified = { ...apple, servings: 4 };
      const newCost = costRecipe(modified, resolveFn, ingMap, priceMap, quarantined);
      const lineKcal = (rec) => {
        const c = costRecipe(rec, resolveFn, ingMap, priceMap, quarantined);
        let k = 0, matched = 0, gramLines = 0;
        for (const l of c.lines) {
          if (!l.priceable || l.normUnit !== "g" || !l.canonical_name || !l.normValue) continue;
          gramLines += 1;
          const n = ingMap.get(l.canonical_name)?.nutrition_per_100g;
          if (!n) continue;
          matched += 1;
          k += (n.kcal * l.normValue) / 100;
        }
        return { k: Math.round(k), matched, gramLines };
      };
      const sum = lineKcal(apple);
      const oldN = apple.nutrition || {};
      const newN = {
        ...oldN,
        calories: Math.round((oldN.calories ?? 0) / 4),
        protein: round1((oldN.protein ?? 0) / 4),
        carbs: round1((oldN.carbs ?? 0) / 4),
        fat: round1((oldN.fat ?? 0) / 4),
      };
      appleAction = {
        id: APPLE_ID,
        title: apple.title,
        servingsBefore: apple.servings,
        servingsAfter: 4,
        nutritionBefore: oldN,
        nutritionAfter: newN,
        recomputedWholeRecipeKcalFromLines: sum,
        costBefore: oldCost ? { perServing: oldCost.perServing, basket: oldCost.basket, adjustedCoveragePct: oldCost.adjustedCoveragePct } : null,
        costAfter: { perServing: newCost.perServing, basket: newCost.basket, adjustedCoveragePct: newCost.adjustedCoveragePct },
        recipeCostDocBefore: oldCost,
        recipeCostDocAfter: { ...newCost },
      };
    }

    // 3. withdrawals + protection
    const planUse = new Map();
    const addUse = (rid, via) => { const k = String(rid); if (!planUse.has(k)) planUse.set(k, []); planUse.get(k).push(via); };
    for (const m of await db.collection("meal_plans").find({}).project({ recipeId: 1 }).toArray()) addUse(m.recipeId, "meal_plan");
    for (const f of await db.collection("favourite_recipes").find({}).project({ recipeId: 1 }).toArray()) addUse(f.recipeId, "favourite");
    const withdrawals = WITHDRAW_IDS.map((id) => {
      const r = need(id);
      return r ? { id, title: r.title, ingredientSample: (r.ingredients || []).slice(0, 4).map((i) => i.name), protectedBy: planUse.get(id) || [] } : null;
    }).filter(Boolean);
    const protectedHit = withdrawals.filter((w) => w.protectedBy.length);
    if (protectedHit.length) problems.push(`PROTECTED (meal plan / favourite): ${protectedHit.map((w) => w.title).join("; ")} - withdrawal must not proceed`);

    // 4. title
    const titleRec = need(TITLE_ID);
    const titleAction = titleRec ? { id: TITLE_ID, before: titleRec.title, after: TITLE_NEW } : null;

    // 5. junk mealType
    const mealTypeActions = [];
    for (const r of publicRecipes) {
      const mt = r.mealType;
      if (typeof mt === "string" && JUNK_MEALTYPES.has(mt.trim().toLowerCase())) {
        const before = [...classify({ title: r.title, tags: r.tags || [], mealType: r.mealType })].sort();
        const after = [...classify({ title: r.title, tags: r.tags || [] })].sort();
        mealTypeActions.push({ id: String(r._id), title: r.title, mealTypeBefore: mt, classBefore: before, classAfter: after });
      }
    }

    // classification report over all public recipes: before vs after
    const withdrawn = new Set(WITHDRAW_IDS);
    const junkIds = new Set(mealTypeActions.map((a) => a.id));
    const tally = (afterState) => {
      const counts = {};
      let unreachable = 0, n = 0;
      for (const r of publicRecipes) {
        const id = String(r._id);
        if (afterState && withdrawn.has(id)) continue;
        n += 1;
        const mealType = afterState && junkIds.has(id) ? undefined : r.mealType;
        const set = classify({ title: r.title, tags: r.tags || [], mealType });
        if (set.size === 0) unreachable += 1;
        for (const c of set) counts[c] = (counts[c] || 0) + 1;
      }
      return { recipes: n, perChip: counts, unreachableByAnyChip: unreachable };
    };
    const classification = { before: tally(false), after: tally(true), changedRecipes: mealTypeActions.filter((a) => a.classBefore.join() !== a.classAfter.join()).length };

    // coconut milk investigation (report only)
    const coco = { currentEntry: ingMap.get("coconut milk")?.nutrition_per_100g || null, publicRecipesUsing: [], note: null };
    for (const r of publicRecipes) {
      let c;
      try { c = costRecipe(r, resolveFn, ingMap, priceMap, quarantined); } catch { continue; }
      const lines = c.lines.filter((l) => l.canonical_name === "coconut milk");
      if (!lines.length) continue;
      const grams = lines.filter((l) => l.normUnit === "g").reduce((a, l) => a + (l.normValue || 0), 0);
      const ml = lines.filter((l) => l.normUnit === "ml").reduce((a, l) => a + (l.normValue || 0), 0);
      coco.publicRecipesUsing.push({
        id: String(r._id), title: r.title, gramLines: grams, mlLines: ml, nutritionUnavailable: r.nutritionUnavailable === true,
        storedCalories: r.nutrition?.calories ?? null, servings: r.servings ?? null,
        approxKcalUnderstatedWholeRecipe: Math.round(((169 - 22) * grams) / 100),
      });
    }
    let cofid = null;
    try {
      const f = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../assets/cofid/nutrition_per_100g.json"), "utf8"));
      cofid = (Array.isArray(f) ? f : f.items || []).filter((x) => /^coconut milk/i.test(x.food_name)).map((x) => ({ code: x.food_code, name: x.food_name, kcal: x.kcal_100g, protein: x.protein_100g, carbs: x.carbs_100g, fat: x.fat_100g }));
    } catch (e) { cofid = `unreadable: ${e.message}`; }
    coco.cofidEntries = cofid;
    coco.recipeCount = coco.publicRecipesUsing.length;
    coco.note =
      "Canonical 'coconut milk' maps to CoFID 14-820 'Coconut milk' (22 kcal/100g, the thin drink-style entry). " +
      "CoFID also has 'Coconut milk, retail' (169 kcal/100g) which is what canned coconut milk is. nutrition recompute only counts lines normalised to grams, " +
      "so ml/cup coconut milk lines contribute 0 kcal today.";

    const nutritionUnavailableBefore = await recipesCol.countDocuments({ nutritionUnavailable: true });
    const plan = {
      generatedAt: new Date().toISOString(),
      baseCommit: "dd13782",
      publicBefore: publicRecipes.length,
      expected: {
        publicAfter: publicRecipes.length - withdrawals.length,
        nutritionUnavailableTotalBefore: nutritionUnavailableBefore,
        nutritionUnavailableTotalAfter: nutritionUnavailableBefore + flags.length,
        junkMealTypeAfter: 0,
      },
      problems,
      actions: { flags, apple: appleAction, withdrawals, title: titleAction, mealType: mealTypeActions },
      classification,
      coconutMilk: coco,
    };
    fs.mkdirSync(SUMMARIES, { recursive: true });
    fs.writeFileSync(DRYRUN_FILE, JSON.stringify(plan, null, 2));

    console.log(`public before: ${plan.publicBefore}; expected public after: ${plan.expected.publicAfter}`);
    console.log(`nutritionUnavailable (all docs) before: ${nutritionUnavailableBefore}; expected after: ${plan.expected.nutritionUnavailableTotalAfter}`);
    console.log(`problems: ${problems.length ? "\n  - " + problems.join("\n  - ") : "none"}`);
    console.log(`flag nutritionUnavailable: ${flags.length}; withdraw: ${withdrawals.length} (protected hits: ${protectedHit.length}); title: ${titleAction ? 1 : 0}; junk mealType unset: ${mealTypeActions.length}`);
    if (appleAction) {
      console.log(`Apple Curry Soup: servings ${appleAction.servingsBefore} -> ${appleAction.servingsAfter}`);
      console.log(`  nutrition before ${JSON.stringify(appleAction.nutritionBefore)}`);
      console.log(`  nutrition after  ${JSON.stringify(appleAction.nutritionAfter)}  (line-sum whole recipe ~${appleAction.recomputedWholeRecipeKcalFromLines.k} kcal, ${appleAction.recomputedWholeRecipeKcalFromLines.matched}/${appleAction.recomputedWholeRecipeKcalFromLines.gramLines} gram lines)`);
      console.log(`  cost before ${JSON.stringify(appleAction.costBefore)}`);
      console.log(`  cost after  ${JSON.stringify(appleAction.costAfter)}`);
    }
    console.log("classification before:", JSON.stringify(classification.before));
    console.log("classification after: ", JSON.stringify(classification.after));
    console.log(`junk-mealType recipes whose chip set changes: ${classification.changedRecipes} of ${mealTypeActions.length}`);
    console.log(`coconut milk: current ${JSON.stringify(coco.currentEntry)}; used by ${coco.recipeCount} public recipes; CoFID: ${JSON.stringify(coco.cofidEntries)}`);
    console.log(`-> ${DRYRUN_FILE}`);
  } finally {
    await client.close();
  }
}

async function applyPlan(db, recipesCol) {
  if (!FROM) throw new Error("--write requires --from <reviewed plan json>");
  const plan = JSON.parse(fs.readFileSync(path.resolve(FROM), "utf8"));
  if (plan.problems && plan.problems.length) throw new Error(`plan has unresolved problems: ${plan.problems.join("; ")}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const batch = argAfter("--batch") || `part8-${stamp}`;
  const now = new Date().toISOString();
  const applied = { batch, appliedAt: now, plan: path.basename(FROM), flags: [], apple: null, withdrawals: [], title: null, mealType: [], skipped: [] };
  const A = plan.actions;

  // 1. flags
  for (const f of A.flags) {
    const r = await recipesCol.updateOne(
      { _id: oid(f.id), nutritionUnavailable: { $ne: true } },
      { $set: { nutritionUnavailable: true, nutritionFlagBatch: batch, nutritionFlagAt: now, nutritionFlagReason: FLAG_REASON, part8Batch: batch } },
    );
    (r.modifiedCount ? applied.flags : applied.skipped).push(r.modifiedCount ? f.id : { id: f.id, why: "already flagged / not found" });
  }
  // 2. apple
  if (A.apple) {
    const a = A.apple;
    const cur = await recipesCol.findOne({ _id: oid(a.id) });
    if (cur && cur.servings === a.servingsBefore) {
      const r = await recipesCol.updateOne(
        { _id: oid(a.id), servings: a.servingsBefore },
        { $set: { servings: a.servingsAfter, nutrition: a.nutritionAfter, part8Batch: batch, part8PrevServings: a.servingsBefore, part8PrevNutrition: a.nutritionBefore } },
      );
      const { _id, ...costFields } = a.recipeCostDocAfter;
      const existing = await db.collection("recipe_cost").findOne({ recipeId: oid(a.id) });
      await db.collection("recipe_cost").updateOne(
        { recipeId: oid(a.id) },
        { $set: { recipeId: oid(a.id), ...costFields, computedAt: now, priceCacheStamp: existing?.priceCacheStamp ?? null, part8Batch: batch } },
        { upsert: true },
      );
      applied.apple = { id: a.id, modified: r.modifiedCount, servingsBefore: a.servingsBefore, servingsAfter: a.servingsAfter, nutritionBefore: a.nutritionBefore, nutritionAfter: a.nutritionAfter, recipeCostDocBefore: existing };
    } else applied.skipped.push({ id: a.id, why: "servings changed since dry-run" });
  }
  // 3. withdrawals (re-check protection at write time)
  const protectedNow = new Set();
  for (const m of await db.collection("meal_plans").find({ recipeId: { $in: A.withdrawals.map((w) => oid(w.id)) } }).project({ recipeId: 1 }).toArray()) protectedNow.add(String(m.recipeId));
  for (const f of await db.collection("favourite_recipes").find({ recipeId: { $in: A.withdrawals.map((w) => oid(w.id)) } }).project({ recipeId: 1 }).toArray()) protectedNow.add(String(f.recipeId));
  for (const w of A.withdrawals) {
    if (protectedNow.has(w.id)) { applied.skipped.push({ id: w.id, why: "protected at write time" }); continue; }
    const r = await recipesCol.updateOne(
      { _id: oid(w.id), isPublic: true },
      { $set: { isPublic: false, withdrawnAt: now, withdrawnBatch: batch, withdrawnReason: WITHDRAW_REASON, part8Batch: batch } },
    );
    (r.modifiedCount ? applied.withdrawals : applied.skipped).push(r.modifiedCount ? w.id : { id: w.id, why: "not public / not found" });
  }
  // 4. title
  if (A.title) {
    const r = await recipesCol.updateOne(
      { _id: oid(A.title.id), title: A.title.before },
      { $set: { title: A.title.after, titleOriginal: A.title.before, part8Batch: batch } },
    );
    applied.title = { id: A.title.id, modified: r.modifiedCount, before: A.title.before, after: A.title.after };
  }
  // 5. junk mealType
  for (const m of A.mealType) {
    const r = await recipesCol.updateOne(
      { _id: oid(m.id), mealType: m.mealTypeBefore },
      { $set: { mealTypeOriginal: m.mealTypeBefore, part8Batch: batch }, $unset: { mealType: "" } },
    );
    (r.modifiedCount ? applied.mealType : applied.skipped).push(r.modifiedCount ? { id: m.id, mealTypeBefore: m.mealTypeBefore } : { id: m.id, why: "mealType changed since dry-run" });
  }

  const out = path.join(SUMMARIES, `${batch}_applied.json`);
  fs.writeFileSync(out, JSON.stringify(applied, null, 2));
  console.log(`batch ${batch}: flags=${applied.flags.length} apple=${applied.apple ? "yes" : "no"} withdrawn=${applied.withdrawals.length} title=${applied.title?.modified || 0} mealTypeUnset=${applied.mealType.length} skipped=${applied.skipped.length}`);
  console.log(`-> ${out}`);
  console.log(`rollback: node scripts/part8_rollback.cjs ${batch} [--write]`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
