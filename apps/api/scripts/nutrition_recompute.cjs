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
// Row actions (cloud review 2026-10-12 rules)
//   write                 non-flagged, non-authoritative recipe. after >= before -> write. after < before -> write only when
//                         every missing line (unresolved / no density / no per_item_g / no nutrition / unconvertible unit) is a
//                         spice / salt / pepper / water / herb (MINOR_MISSING_RE); old value -> `nutritionPrev`
//   hold_review           would be a write but held, with holdReasons: decrease_with_major_missing | kcal_out_of_range |
//                         frying_medium_counted | produce_density / cooked_density (canonical per-100g looks wrong).
//                         NOT written unless the reviewed file's action is changed to "write".
//   skip_flagged          nutritionUnavailable:true already (18) - never touched
//   skip_authoritative    source "spoonacular", stored per-serving nutrition (not nutritionApproximate), stored kcal in
//                         100..1200: that number comes from the source - skipped
//   flag_unavailable      same Spoonacular population but stored kcal > 1200 or < 100 per serving: nutrition untouched,
//                         recipe gets nutritionUnavailable:true (+ nutritionFlagBatch/At/Reason, same fields as Part 8)
//
// Canonical fixes (CANON_FIXES below) are simulated IN MEMORY on dry-run (nutrition_per_100g, per_item_g, aliases) and only
// written on --write; every touched field's old value is kept in `canonFixPrev` (+ `canonFixPrevAbsent` for fields that
// did not exist) with `nutritionFixBatch`, so nutrition_recompute_rollback.cjs restores them.
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

const COFID_PATH = path.resolve(__dirname, "../../../../assets/cofid/nutrition_per_100g.json");
// Canonical fixes (cc prompt 2026-10-12 + cloud review). nutrition: CoFID entry looked up BY CODE from the CoFID table
// (never retyped; cofidName is asserted against the table). Only the canonical -> CoFID mapping changes, never the CoFID table.
// per_item_g: edible portion (flesh / peeled), to match the flesh-only CoFID rows.
const CANON_FIXES = [
  { name: "coconut milk", cofid: "14-889", cofidName: "Coconut milk, retail", why: "was 14-820 'Coconut milk' (22 kcal thin drink)" },
  { name: "spinach", cofid: "13-572", cofidName: "Spinach, mature, raw", why: "was 17-417 'Spinach, dried' (211 kcal)" },
  { name: "mushroom", cofid: "13-505", cofidName: "Mushrooms, white, raw", why: "was 17-416 'Mushroom, dried' (159 kcal)" },
  { name: "corn", cofid: "13-529", cofidName: "Sweetcorn kernels, canned in water, drained", why: "was 17-645 'Corn snacks' (526 kcal); recipes measure kernels by the cup" },
  { name: "green beans, trimmed", cofid: "13-514", cofidName: "Beans, green, raw", why: "was 13-608 'Green beans, dried' (246 kcal)" },
  { name: "pear", cofid: "14-321", cofidName: "Pears, raw, flesh and skin", why: "was 14-196 'Pears, dried' (207 kcal)" },
  { name: "cooked rice (for serving)", cofid: "11-862", cofidName: "Rice, white, long grain, boiled in unsalted water", why: "was 356 kcal (raw rice) on a cooked-rice canonical" },
  { name: "eyed peas", cofid: "13-063", cofidName: "Beans, blackeye, whole, dried, boiled in unsalted water", why: "canonical is mangled 'black-eyed peas'; values were near-identical, now sourced by code" },
  {
    name: "avocado", perItemG: 140, addAliases: ["ripe avocado", "ripe avocados"],
    perItemGSource: "edible flesh only (CoFID avocado rows are flesh-only); USDA FDC 'Avocados, raw': 1 fruit without skin and seed = 136 g -> 140 g (cloud-specified); was 150",
  },
  {
    name: "bananas", perItemG: 110, addAliases: ["banana"],
    perItemGSource: "peeled/edible banana; USDA FDC 'Bananas, raw': 1 medium = 118 g peeled, CoFID 'weighed with skin' 51 vs 81 kcal flesh -> 110 g (cloud-specified)",
  },
  { name: "egg", addAliases: ["large egg", "large eggs", "_egg_"] },
  { name: "zucchini", addAliases: ["courgette", "courgettes"] },
  // --- cloud 2nd review (2026-10-12): 4 more suspect canonicals ---
  { round: 2, name: "chicken", cofid: "18-488", cofidName: "Chicken, meat, average, raw", why: "was 474 kcal/100 g (fat 48.3 — not a raw-meat value)" },
  { round: 2, name: "milk", cofid: "12-313", cofidName: "Milk, semi-skimmed, pasteurised, average", why: "was 12-329 'Milk, sheeps, raw' (93 kcal); UK default = semi-skimmed" },
  { round: 2, name: "cream", cofid: "12-334", cofidName: "Cream, fresh, double, including Jersey cream", why: "was 12-592 'Cream, fresh, clotted' (586 kcal); cloud: double cream" },
  { round: 2, name: "heavy cream", cofid: "12-334", cofidName: "Cream, fresh, double, including Jersey cream", why: "was 340 kcal / 36 g fat (not in CoFID, US heavy cream); cloud: double cream" },
  // --- cloud 3rd review (2026-10-12): CoFID has no dried rice-noodle row (only 11-725 boiled, 89 kcal) while recipes give dry oz;
  // copy the existing dry-weight canonical instead of inventing a number ---
  {
    round: 3, name: "rice noodles", copyNutritionFrom: "rice stick noodles", nutritionSource: "copied from rice stick noodles",
    why: "was 11-725 'Noodles, rice, fine, dried, boiled' (89 kcal, cooked weight) but recipes list dry oz; cloud: copy canonical 'rice stick noodles' (364 kcal, dry)",
  },
  // density_cup is OWNED by price_density_fix.cjs (written there, it drives the price too); here it is only simulated so the
  // nutrition numbers already use 104 g/cup. NOT written by nutrition_recompute --write.
  {
    round: 2, name: "mung bean sprouts", densityCup: 104, simulateOnly: true,
    densityCupSource: "USDA FDC 'Mung beans, mature seeds, sprouted, raw': 1 cup = 104 g (was 180) — cloud-specified",
  },
];
// Proposals NOT applied (report only): no CoFID entry exists, nothing is invented. (Round 3: rice noodles resolved below.)
const CANON_PROPOSALS_NOT_APPLIED = [];
// Spoonacular recipes that stay skip_authoritative although stored kcal is outside 100..1200 (cloud decision).
const FLAG_EXEMPT = new Map([
  ["6a5ff781a91e3f027a2961e9", "Korean Beef Rice Bowl: stored 1215 kcal accepted (cloud 2nd review 2026-10-12; recompute 1040)"],
]);

// A missing-nutrition line is "minor" (does not block a kcal decrease) only if it is a spice / salt / pepper / water / herb.
// Name-based on purpose - quantities are not used.
const MINOR_MISSING_RE = new RegExp(
  "^(" + [
    "(sea |kosher |table |fine |coarse |flaky |himalayan |rock )?salt", "(cold |hot |warm |boiling |ice |iced |lukewarm |filtered |tap )?water", "ice( cubes?)?",
    "(black |white |ground |freshly ground |cracked |crushed )?pepper(corns?)?", "salt (and|&) (freshly ground |ground |black |white )*pepper","(black|white|mixed|szechuan|sichuan|pink|green) peppercorns?",
    "(ground |dried )?(cayenne|cayenne pepper|paprika|smoked paprika|sweet paprika|hot paprika|chilli powder|chili powder|chilli flakes|chili flakes|red pepper flakes|crushed red pepper|crushed chilli flakes|ancho chile powder|ancho chilli powder)",
    "(ground |whole |dried )?(cumin|cumin seeds?|turmeric|ground turmeric|coriander|ground coriander|coriander seeds?|cinnamon|ground cinnamon|cinnamon sticks?|nutmeg|ground nutmeg|cardamom|cardamom pods?|cardamom powder|cloves?|ground cloves?|allspice|star anise|mustard seeds?|fennel seeds?|caraway seeds?|nigella seeds?|fenugreek|saffron|sumac|za'atar|garam masala|curry powder|five[- ]spice( powder)?|chinese five spice|mixed spice|ras el hanout|harissa powder|mustard powder|garlic powder|onion powder|(ground |fresh |grated |minced )?ginger( root| pieces?)?|thumb sized ginger|vanilla( extract| essence| pod)?)",
    "(fresh |dried |chopped |mixed |italian |ground )?(oregano|thyme|rosemary|basil|parsley|flat[- ]leaf parsley|coriander leaves|cilantro|dill|mint|sage|tarragon|chives|bay leaf|bay leaves|herbs|herbes de provence|marjoram|lemongrass|curry leaves|kaffir lime leaves|lime leaves)( leaves| sprigs?)?",
  ].join("|") + ")( to taste)?$",
);
// Cloud 3rd review (2026-10-12): a missing line is also "low-kcal" (does not block a kcal decrease) when it is a
// vegetable < 50 kcal/100 g, a thin liquid (lemon/lime juice, stock/broth), a condiment sauce (sriracha, hot sauce,
// worcestershire, soy) or garlic / baking powder / sugar substitute / generic spices. Anything else (bacon, pastry, bread,
// beans, chia, ghee, eggs, thighs, honey/agave/maple, parmesan, breadcrumbs, cornflour, yogurt, potatoes ...) stays "major".
const LOW_KCAL_MISSING_RE = new RegExp(
  "^(" + [
    "(fresh |raw |organic |baby |english |persian |mini |small |large |medium |red |green |yellow |orange |sweet |bell |sliced |chopped |diced )*(asparagus( spears?| tips)?|cucumbers?|zucchinis?|courgettes?|peppers?|(cherry |plum |vine |roma )?tomato(e)?s?|broccoli slaw|spinach|baby spinach)",
    "(fresh |freshly squeezed |bottled )?(lemon|lime|lemon or lime|lime or lemon) juice( from (a|an|half a|one|1) (lemon|lime))?",
    "(low[- ]sodium |reduced[- ]sodium |homemade |good[- ]quality )?(chicken|vegetable|veg|veggie|beef|fish) (stock|broth)", "(low[- ]sodium |reduced[- ]sodium )?(stock|broth)",
    "sriracha( sauce)?", "(louisiana |tabasco )?hot sauce", "tabasco( sauce)?", "worcestershire( sauce)?",
    "(light |dark |low[- ]sodium |reduced[- ]sodium |reduced salt )?soy sauce",
    "(fresh |minced |crushed )?garlic( cloves?)?", "baking powder", "(granulated |powdered )?sugar substitute", "(mixed |ground )?spices?",
  ].join("|") + ")( to taste)?$",
);
const isMinorMissing = (name) => MINOR_MISSING_RE.test(name) || LOW_KCAL_MISSING_RE.test(name);

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

// name used for the minor/major missing-line decision: lower-case, text after a comma and (...) dropped
const cleanMissingName = (v) => String(v).toLowerCase().split(",")[0].replace(/\([^)]*\)?/g, "").replace(/\s+/g, " ").trim();

// Review guards — objective, no guessing: they only HOLD a row back, they never change a number.
const PRODUCE_RE = /\b(spinach|mushrooms?|corn|kale|broccoli|tomato(es)?|onions?|carrots?|lettuce|cucumber|peppers?|zucchini|courgettes?|cabbage|celery|asparagus|aubergines?|eggplants?|cauliflower|pumpkin|squash|beetroot|leeks?|radish(es)?|apples?|pears?|oranges?|lemons?|limes?|berries|berry|mango(es)?|bananas?|peach(es)?|grapes?|pineapple|melon|chard|peas?|green beans?)\b/;
const NOT_PLAIN_PRODUCE_RE = /eyed peas|black-eyed|split peas|chick ?peas?|dried|powder|ground|flakes|salt|paste|dried|seed|cayenne|cracked|clove|corn ?(flour|starch|meal)|popcorn|tortilla|chips|syrup|oil|juice|sauce|stock|broth|cream|chowder|ketchup|puree|sun-?dried/;
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

    // --- canonical fixes (simulated in memory on dry-run; written on --write) --------------------------
    const cofidRaw = JSON.parse(fs.readFileSync(COFID_PATH, "utf8"));
    const cofidByCode = new Map((Array.isArray(cofidRaw) ? cofidRaw : cofidRaw.items).map((x) => [x.food_code, x]));
    const docByName = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const canonFixes = [];
    for (const f of CANON_FIXES) {
      const d = docByName.get(f.name);
      if (!d) throw new Error(`canonical fix target missing: ${f.name}`);
      const set = {};
      const before = {};
      const absent = [];
      const rec = (field) => { if (d[field] === undefined) absent.push(field); before[field] = d[field] === undefined ? null : d[field]; };
      let cofid = null;
      if (f.cofid) {
        const c = cofidByCode.get(f.cofid);
        if (!c || c.food_name !== f.cofidName) throw new Error(`CoFID ${f.cofid} is not "${f.cofidName}" in the table (${c ? c.food_name : "missing"})`);
        cofid = { code: c.food_code, food_name: c.food_name, kcal: c.kcal_100g, protein: r2(c.protein_100g), carbs: r2(c.carbs_100g), fat: r2(c.fat_100g) };
        rec("nutrition_per_100g");
        set.nutrition_per_100g = { kcal: cofid.kcal, protein: cofid.protein, carbs: cofid.carbs, fat: cofid.fat };
      }
      if (f.copyNutritionFrom) {
        const src = docByName.get(f.copyNutritionFrom);
        const sn = src && src.nutrition_per_100g;
        if (!sn || typeof sn.kcal !== "number") throw new Error(`copy source ${f.copyNutritionFrom} has no nutrition_per_100g`);
        cofid = { code: null, food_name: `canonical "${f.copyNutritionFrom}"`, kcal: sn.kcal, protein: sn.protein, carbs: sn.carbs, fat: sn.fat };
        rec("nutrition_per_100g");
        set.nutrition_per_100g = { kcal: sn.kcal, protein: sn.protein, carbs: sn.carbs, fat: sn.fat };
        rec("nutrition_source");
        set.nutrition_source = f.nutritionSource;
      }
      if (f.perItemG != null) { rec("per_item_g"); set.per_item_g = f.perItemG; }
      if (f.densityCup != null) { rec("density_cup"); set.density_cup = f.densityCup; }
      if (f.addAliases) {
        rec("aliases");
        const cur = Array.isArray(d.aliases) ? d.aliases : [];
        const have = new Set(cur.map((a) => String(a).toLowerCase()));
        set.aliases = [...cur, ...f.addAliases.filter((a) => !have.has(a.toLowerCase()))];
      }
      canonFixes.push({ id: String(d._id), canonical_name: f.name, round: f.round || 1, simulateOnly: f.simulateOnly === true, cofid, why: f.why || null, perItemGSource: f.perItemGSource || null, densityCupSource: f.densityCupSource || null, before, after: set, absent });
    }
    // Proposed only (not simulated, not written): other coconut-milk canonicals with no nutrition at all.
    const fixedNames = new Set(CANON_FIXES.map((f) => f.name));
    const coconutProposals = canonDocs
      .filter((d) => /coconut (milk|cream)/.test(d.canonical_name) && !fixedNames.has(d.canonical_name))
      .map((d) => ({ canonical_name: d.canonical_name, nutrition_per_100g: d.nutrition_per_100g ?? null, density_cup: d.density_cup ?? null, per_item_g: d.per_item_g ?? null }));

    const fixById = new Map(canonFixes.map((f) => [f.id, f]));
    const simDocs = canonDocs.map((d) => (fixById.has(String(d._id)) ? { ...d, ...fixById.get(String(d._id)).after } : d));
    const ingredientsMapFixed = new Map(simDocs.map((d) => [d.canonical_name, d]));
    const ingredientsMapBefore = new Map(canonDocs.map((d) => [d.canonical_name, d]));
    // state after the FIRST review round only (all fixes except round 2) — to show what the 2nd round changed
    const ingredientsMapPrevRound = new Map(canonDocs.map((d) => {
      const fx = fixById.get(String(d._id));
      return [d.canonical_name, fx && fx.round < 2 ? { ...d, ...fx.after } : d];
    }));
    // state after rounds 1+2 (= the previous committed dry-run) — to show what the 3rd round changed
    const ingredientsMapRound2 = new Map(canonDocs.map((d) => {
      const fx = fixById.get(String(d._id));
      return [d.canonical_name, fx && fx.round <= 2 ? { ...d, ...fx.after } : d];
    }));
    // buildAliasIndex() only does collection.find({quarantine:{$ne:true}}).project().toArray() - feed it the simulated docs
    const shimCol = (docs) => ({ find: () => ({ project: () => ({ toArray: async () => docs.filter((d) => d.quarantine !== true) }) }) });
    const aliasIndex = await buildAliasIndex(shimCol(simDocs));
    const aliasIndexBefore = await buildAliasIndex(shimCol(canonDocs));
    const resolveFn = (raw) => resolve(raw, aliasIndex);
    const resolveFnBefore = (raw) => resolve(raw, aliasIndexBefore);

    const publicRecipes = await recipesCol.find({ isPublic: true }).toArray();
    console.log(`public recipes: ${publicRecipes.length}; canonical fixes: ${canonFixes.map((f) => f.canonical_name).join(", ") || "none"}`);

    const rows = [];
    for (const r of publicRecipes) {
      const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
      const res = computeRecipeNutrition(ings, r.servings, resolveFn, ingredientsMapFixed);
      const resOld = computeRecipeNutrition(ings, r.servings, resolveFnBefore, ingredientsMapBefore); // new code, canonical data as it is today
      const resPrev = computeRecipeNutrition(ings, r.servings, resolveFn, ingredientsMapPrevRound); // after round-1 fixes only
      const resRound2 = computeRecipeNutrition(ings, r.servings, resolveFn, ingredientsMapRound2); // after rounds 1+2
      const before = pickNutrition(r.nutrition);
      const after = pickNutrition(res.nutrition);
      const storedK = before?.calories ?? 0;
      const flagged = r.nutritionUnavailable === true;
      const authoritative = !flagged && r.source === "spoonacular" && r.nutritionApproximate !== true && storedK > 0;
      const reviewFlags = [];
      if (after && (after.calories > 1200 || after.calories < 100)) reviewFlags.push(`kcal_out_of_range:${after.calories}`);
      for (const l of res.lines) {
        if (FRYING_RE.test(String(l.rawName)) && (l.grams || 0) > 100 && l.kcal > 0) reviewFlags.push(`frying_medium_counted:${l.rawName}=${Math.round(l.grams)}g/${Math.round(l.kcal)}kcal`);
        const sd = suspectDensityLine(l);
        if (sd) reviewFlags.push(sd);
      }
      // lines that contributed 0 kcal: minor (spice/salt/pepper/water/herb by name) vs major
      const cleanName = (l) => cleanMissingName(l.canonical_name ?? l.rawName);
      const missingLines = res.lines.filter((l) => l.reason != null);
      const majorMissing = missingLines.filter((l) => !isMinorMissing(cleanName(l)));
      const majorMissingRound2Rule = missingLines.filter((l) => !MINOR_MISSING_RE.test(cleanName(l))); // rule before the 3rd review
      const decrease = !!(before && after && after.calories < before.calories);
      const holdReasons = [];
      let action;
      let flagReason = null;
      if (flagged) action = "skip_flagged";
      else if (authoritative) {
        if ((storedK > 1200 || storedK < 100) && !FLAG_EXEMPT.has(String(r._id))) {
          action = "flag_unavailable";
          flagReason = `spoonacular stored ${storedK} kcal/serving outside 100-1200 (nutrition recompute review 2026-10-12)`;
        } else {
          action = "skip_authoritative";
          if (FLAG_EXEMPT.has(String(r._id))) reviewFlags.push(`flag_exempt:${FLAG_EXEMPT.get(String(r._id))}`);
        }
      } else {
        action = "write";
        if (reviewFlags.length) { action = "hold_review"; for (const f of reviewFlags) holdReasons.push(f.split(":")[0]); }
        if (decrease && majorMissing.length) { action = "hold_review"; holdReasons.push("decrease_with_major_missing"); }
      }
      rows.push({
        id: String(r._id),
        title: r.title,
        source: r.source ?? null,
        servings: r.servings ?? null,
        nutritionUnavailable: flagged,
        nutritionApproximate: r.nutritionApproximate === true,
        action,
        reviewFlags: [...new Set(reviewFlags)],
        holdReasons: [...new Set(holdReasons)],
        flagReason,
        decrease,
        // hold -> write because of the 3rd-review low-kcal rule (every missing line is low-kcal; the old rule would have held it)
        relaxedByRound3: action === "write" && decrease && majorMissing.length === 0 && majorMissingRound2Rule.length > 0,
        relaxedLines: action === "write" && decrease && majorMissing.length === 0 ? majorMissingRound2Rule.map((l) => `${l.canonical_name ?? l.rawName} (${l.reason})`) : [],
        majorMissing: decrease || action === "hold_review" ? majorMissing.map((l) => ({ raw: l.rawName, c: l.canonical_name, why: l.reason })) : [],
        minorMissingCount: missingLines.length - majorMissing.length,
        before,
        after,
        afterWithoutCanonFixes: pickNutrition(resOld.nutrition),
        afterRound1: pickNutrition(resPrev.nutrition),
        afterRound2: pickNutrition(resRound2.nutrition),
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
      holdReasonCounts: rows.filter((x) => x.action === "hold_review").reduce((a, x) => { for (const h of x.holdReasons) a[h] = (a[h] || 0) + 1; return a; }, {}),
      writeRowsDecrease: rows.filter((x) => x.action === "write" && x.decrease).length,
      // must be 0 by construction: a write row that goes DOWN while a non-spice/salt/pepper/water/herb line has no kcal
      writeRowsDecreaseWithMajorMissing: rows.filter((x) => x.action === "write" && x.decrease && x.majorMissing.length).length,
      heldDecreaseWithMajorMissing: rows.filter((x) => x.holdReasons.includes("decrease_with_major_missing")).length,
      // informational: write rows that go UP/equal but still have a major line without kcal (under-count remains)
      writeRowsStillMissingMajorLines: rows.filter((x) => x.action === "write" && x.lines.some((l) => l.why != null && !isMinorMissing(cleanMissingName(l.c ?? l.raw)))).length,
      relaxedByRound3: rows.filter((x) => x.relaxedByRound3).length,
      canonFixEffect: rows.filter((x) => x.after && x.afterWithoutCanonFixes && x.after.calories !== x.afterWithoutCanonFixes.calories)
        .map((x) => ({ id: x.id, title: x.title, action: x.action, without: x.afterWithoutCanonFixes.calories, withFix: x.after.calories })),
    };
    stats.canonFixEffectCount = stats.canonFixEffect.length;

    const writeRows = rows.filter((x) => x.action === "write" && x.before && x.after);
    const top20 = [...writeRows].sort((a, b) => Math.abs(b.deltaCalories) - Math.abs(a.deltaCalories)).slice(0, 20).map((x) => ({
      id: x.id, title: x.title, servings: x.servings, before: x.before.calories, after: x.after.calories, delta: x.deltaCalories,
      coverage: x.nutritionLineCoverage,
      mainAddedLines: x.lines.filter((l) => l.kcal > 0).sort((a, b) => b.kcal - a.kcal).slice(0, 4).map((l) => ({ raw: l.raw, unit: l.u, grams: l.g, kcal: l.kcal, method: l.m })),
    }));

    const writeOrHold = rows.filter((x) => (x.action === "write" || x.action === "hold_review") && x.before && x.after);
    const decreases = writeOrHold.filter((x) => x.deltaCalories < 0).sort((a, b) => a.deltaCalories - b.deltaCalories).map((x) => ({
      id: x.id, title: x.title, source: x.source, servings: x.servings, before: x.before.calories, after: x.after.calories, delta: x.deltaCalories,
      coverage: x.nutritionLineCoverage, action: x.action, holdReasons: x.holdReasons,
      majorMissing: x.majorMissing.map((m) => `${m.c ?? m.raw} (${m.why})`),
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

    // report-only: produce-looking canonicals still carrying a high kcal/100 g after the fixes above (never written)
    const suspectCanonicalScan = simDocs
      .filter((d) => d.nutrition_per_100g && d.nutrition_per_100g.kcal > 60 && PRODUCE_RE.test(d.canonical_name.toLowerCase()) && !NOT_PLAIN_PRODUCE_RE.test(d.canonical_name.toLowerCase()) && d.quarantine !== true)
      .map((d) => ({ canonical_name: d.canonical_name, kcalPer100g: d.nutrition_per_100g.kcal, recipe_count: d.recipe_count ?? null }))
      .sort((a, b) => b.kcalPer100g - a.kcalPer100g);
    // recipes with a line on a canonical touched by the 2nd review round (chicken / milk / cream / heavy cream)
    const ROUND2_NAMES = new Set(CANON_FIXES.filter((f) => f.round === 2 && f.cofid).map((f) => f.name));
    const point1Affected = rows
      .filter((x) => x.lines.some((l) => ROUND2_NAMES.has(l.c)))
      .map((x) => ({
        id: x.id, title: x.title, source: x.source, servings: x.servings, action: x.action, stored: x.before?.calories ?? null,
        afterRound1: x.afterRound1?.calories ?? null, afterRound2: x.afterRound2?.calories ?? null, afterRound3: x.after?.calories ?? null,
        canonLines: x.lines.filter((l) => ROUND2_NAMES.has(l.c)).map((l) => `${l.c}: ${l.q} ${l.u} = ${l.g}g${l.why ? " (" + l.why + ")" : ""}`),
      }))
      .sort((a, b) => Math.abs((b.afterRound2 ?? 0) - (b.afterRound1 ?? 0)) - Math.abs((a.afterRound2 ?? 0) - (a.afterRound1 ?? 0)));
    // 3rd review: the recipes with a "rice noodles" line (canonical now copied from rice stick noodles) ...
    const riceNoodleRecipes = rows
      .filter((x) => x.lines.some((l) => l.c === "rice noodles"))
      .map((x) => ({
        id: x.id, title: x.title, source: x.source, servings: x.servings, action: x.action, holdReasons: x.holdReasons,
        stored: x.before?.calories ?? null, afterRound2: x.afterRound2?.calories ?? null, afterRound3: x.after?.calories ?? null,
        finalKcal: finalKcal(x), inRange200to700: finalKcal(x) != null && finalKcal(x) >= 200 && finalKcal(x) <= 700,
        riceNoodleLines: x.lines.filter((l) => l.c === "rice noodles").map((l) => `${l.q} ${l.u} = ${l.g}g, ${l.kcal} kcal`),
      }));
    // ... and the rows that moved hold_review -> write because of the low-kcal missing-line rule
    const holdToWrite = rows
      .filter((x) => x.relaxedByRound3)
      .map((x) => ({
        id: x.id, title: x.title, servings: x.servings, stored: x.before?.calories ?? null, after: x.after?.calories ?? null,
        coverage: x.nutritionLineCoverage, relaxedLines: x.relaxedLines,
        inRange100to1200: x.after != null && x.after.calories >= 100 && x.after.calories <= 1200,
      }));
    const flagUnavailable = rows.filter((x) => x.action === "flag_unavailable").map((x) => ({
      id: x.id, title: x.title, source: x.source, servings: x.servings, storedKcal: x.before?.calories ?? null, recomputeKcal: x.after?.calories ?? null,
      coverage: x.nutritionLineCoverage, reason: x.flagReason,
    }));

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
    const recipeKcal = new Map(rows.map((x) => [x.id, { before: x.before?.calories ?? null, after: finalKcal(x), unavailable: x.nutritionUnavailable || x.action === "flag_unavailable" }]));
    const planSets = await db.collection("meal_plan_sets").find({}).toArray();
    const entryKeys = new Set();
    const plans = [];
    for (const s of planSets) {
      const entries = await db.collection("meal_plans").find({ planId: s._id }).toArray();
      entries.forEach((e) => Object.keys(e).forEach((k) => entryKeys.add(k)));
      const perDay = new Map();
      for (const e of entries) {
        const k = recipeKcal.get(String(e.recipeId));
        const d = perDay.get(e.dayIndex) || { before: 0, after: 0, afterExcludingUnavailable: 0, unavailableEntries: 0, unknown: 0 };
        if (k) {
          d.before += Math.round(k.before ?? 0); d.after += Math.round(k.after ?? 0);
          if (k.unavailable) d.unavailableEntries += 1; else d.afterExcludingUnavailable += Math.round(k.after ?? 0);
        } else d.unknown += 1; // non-public recipe: not recomputed here
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
      stats, canonFixes, canonProposalsNotApplied: CANON_PROPOSALS_NOT_APPLIED, flagExempt: [...FLAG_EXEMPT].map(([id, why]) => ({ id, why })), point1Affected, riceNoodleRecipes, holdToWrite, coconutProposals, suspectCanonicalScan, flagUnavailable,
      top20Changes: top20, outOfRange, topNullLines: topNull, nullLineTotalsByReason: nullTotals,
      flaggedUnavailable: flaggedReport, samples, impact,
      decreases, suspectPer100g,
      held: rows.filter((x) => x.action === "hold_review").map((x) => ({ id: x.id, title: x.title, servings: x.servings, before: x.before?.calories ?? null, after: x.after?.calories ?? null, reviewFlags: x.reviewFlags })),
      rows,
    };

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify(out, null, 1));
      console.log(`DRY RUN → ${OUT_DRYRUN}`);
      console.log(JSON.stringify({ byAction: stats.byAction, holdReasonCounts: stats.holdReasonCounts, distribution: stats.distribution, writeRowsDecrease: stats.writeRowsDecrease, writeRowsDecreaseWithMajorMissing: stats.writeRowsDecreaseWithMajorMissing, heldDecreaseWithMajorMissing: stats.heldDecreaseWithMajorMissing, writeRowsStillMissingMajorLines: stats.writeRowsStillMissingMajorLines, canonFixEffectCount: stats.canonFixEffectCount, flagUnavailable: flagUnavailable.length, outOfRange: outOfRange.length, canonFixes: canonFixes.map((f) => `${f.canonical_name}: ${f.before.nutrition_per_100g ? f.before.nutrition_per_100g.kcal : "-"} -> ${f.after.nutrition_per_100g ? f.after.nutrition_per_100g.kcal : "-"} ${f.cofid ? f.cofid.code : ""}`) }, null, 1));
      return;
    }

    // ================= WRITE (reviewed file) =================
    if (!FROM) throw new Error("--write requires --from <reviewed dry-run json>");
    const reviewed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), FROM), "utf8"));
    const problems = [];
    const byId = new Map(rows.map((x) => [x.id, x]));
    const plan = [];
    const flagPlan = [];
    for (const rr of reviewed.rows) {
      if (rr.action === "skip_flagged") {
        const live = byId.get(rr.id);
        if (live && live.nutritionUnavailable !== true) problems.push(`${rr.id} ${rr.title}: flag changed`);
        continue;
      }
      if (rr.action === "hold_review") continue; // only written if cloud flipped the reviewed row to "write"
      if (rr.action === "skip_authoritative" && !INCLUDE_AUTHORITATIVE) continue;
      const live = byId.get(rr.id);
      if (!live) { problems.push(`${rr.id} ${rr.title}: no longer public / missing`); continue; }
      if (live.title !== rr.title) problems.push(`${rr.id}: title changed (${live.title})`);
      if (!same(live.before, rr.before)) problems.push(`${rr.id} ${rr.title}: stored nutrition changed since review`);
      if (live.nutritionUnavailable) problems.push(`${rr.id} ${rr.title}: now flagged unavailable`);
      if (rr.action === "flag_unavailable") {
        if (live.action !== "flag_unavailable") problems.push(`${rr.id} ${rr.title}: live action is ${live.action}, reviewed flag_unavailable`);
        flagPlan.push({ id: rr.id, title: rr.title, storedKcal: live.before?.calories ?? null, reason: live.flagReason });
        continue;
      }
      if (!same(live.after, rr.after)) problems.push(`${rr.id} ${rr.title}: recompute differs from reviewed (${JSON.stringify(live.after)} vs ${JSON.stringify(rr.after)})`);
      if (rr.action === "write" && live.action !== "write" && live.action !== "hold_review" && live.action !== "skip_authoritative") problems.push(`${rr.id} ${rr.title}: live action ${live.action}`);
      plan.push({ id: rr.id, title: rr.title, before: live.before, after: live.after, coverage: live.nutritionLineCoverage });
    }
    const sig = (fixes) => JSON.stringify((fixes || []).map((f) => [f.canonical_name, f.simulateOnly === true, f.after]));
    if (sig(reviewed.canonFixes) !== sig(canonFixes)) problems.push("canonical fix set / values differ from the reviewed file");
    if (problems.length) {
      console.error(["ABORT - guard failures (nothing written):", ...problems.slice(0, 40)].join("\n  "));
      process.exit(1);
    }

    const batch = argAfter("--batch") || `nutrition-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const at = new Date();
    // 1) canonical fixes first (so the stored recipe numbers match what a live recompute will give).
    //    Old values of every touched field -> canonFixPrev (+ canonFixPrevAbsent for fields that did not exist).
    let canonModified = 0;
    const writableFixes = canonFixes.filter((f) => !f.simulateOnly); // simulate-only (mung bean density) is written by price_density_fix.cjs
    for (const f of writableFixes) {
      const res = await canonCol.updateOne(
        { _id: new ObjectId(f.id), nutritionFixBatch: { $exists: false } },
        { $set: { ...f.after, canonFixPrev: f.before, canonFixPrevAbsent: f.absent, nutritionFixBatch: batch, nutritionFixCofid: f.cofid ? f.cofid.code : null, nutritionFixAt: at } },
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
    // 3) Spoonacular recipes with an out-of-range stored value: flag only (nutrition untouched; same fields as Part 8)
    let flagsModified = 0;
    for (const f of flagPlan) {
      const res = await recipesCol.updateOne(
        { _id: new ObjectId(f.id), nutritionUnavailable: { $ne: true } },
        { $set: { nutritionUnavailable: true, nutritionFlagBatch: batch, nutritionFlagAt: at, nutritionFlagReason: f.reason } },
      );
      flagsModified += res.modifiedCount;
    }
    console.log(`WRITE batch ${batch}: canonical modified ${canonModified}/${writableFixes.length}; recipes modified ${recipesModified}/${plan.length}; flagged unavailable ${flagsModified}/${flagPlan.length}`);
    if (recipesModified !== plan.length || canonModified !== writableFixes.length || flagsModified !== flagPlan.length) process.exitCode = 1;

    // re-query evidence
    const after = await recipesCol.find({ nutritionRecomputeBatch: batch }).project({ title: 1, nutrition: 1, nutritionPrev: 1 }).toArray();
    const flagStill = await recipesCol.countDocuments({ isPublic: true, nutritionUnavailable: true });
    const evidence = {
      batch, appliedAt: at.toISOString(), source: path.basename(path.resolve(process.cwd(), FROM)),
      canonicalModified: canonModified, recipesModified, flagsModified,
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
