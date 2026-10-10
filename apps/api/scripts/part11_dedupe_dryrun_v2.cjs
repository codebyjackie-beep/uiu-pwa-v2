// Part 11 v2 — transitive near-duplicate grouping + 1 keeper per diet class (meat / fish-seafood / vegetarian).
// READ-ONLY dry-run: find() only, writes nothing to Mongo. Output: summaries/2026-10-10_part11-dryrun-v2.json
//
// Grouping: any two public recipes passing the strong OR medium similarity test (same thresholds as v1)
// are linked; connected components (union-find) form one "dish family" group. Within a group, recipes are
// split by diet class derived from INGREDIENTS (meat > fish-seafood > vegetarian), and each class keeps
// one keeper (coverage -> own image -> good description). Protected recipes (any meal_plans /
// favourite_recipes row) are never withdrawn; if a class holds protected members they ARE its keepers.
//
// Usage (from uiu-pwa-v2/apps/api):  node scripts/part11_dedupe_dryrun_v2.cjs
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const ING_MIN = 0.7, TITLE_MIN = 0.5, ING_FLOOR = 0.5;
const MED_TITLE_HI = 0.8, MED_ING_HI = 0.4, MED_SHARED = 4, MED_KEYEQ_ING = 0.3;
const sharedTitle = (a, b) => { let n = 0; for (const x of a.tt) if (b.tt.has(x)) n++; return n; };

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

const TITLE_STOP = new Set(["a", "an", "the", "with", "and", "of", "in", "on", "for", "to", "recipe", "style", "easy", "quick", "simple", "homemade", "classic", "best"]);
const ING_STOP = new Set(["fresh", "chopped", "diced", "sliced", "minced", "ground", "large", "small", "medium", "ripe", "frozen", "dried", "plain", "unsweetened", "optional", "extra", "virgin", "finely", "roughly", "whole", "boneless", "skinless", "raw", "cooked", "of", "a", "the", "or", "and", "to", "taste"]);
const sing = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const titleTokens = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !TITLE_STOP.has(w)).map(sing));
function ingKey(name) {
  const base = String(name || "").toLowerCase().replace(/\(.*?\)/g, " ").split(",")[0];
  return base.replace(/[^a-z ]+/g, " ").split(" ").filter((w) => w && !ING_STOP.has(w)).map(sing).sort().join(" ");
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const SPOON_AD = /spoonacular|\$\d|calories|per serving|fans|score of|takes roughly|One portion of this dish contains|You can never have too many|Watching your figure/i;

const MEAT = /\b(chicken|beef|pork|lamb|turkey|duck|bacon|ham|sausages?|chorizo|mince|steak|veal|salami|prosciutto|pancetta|gammon|venison|goose|rabbit|meatballs?|pepperoni|brisket|mutton|hot dogs?|frankfurters?|lardons?|oxtail|liver|black pudding|bratwurst|kielbasa|mortadella)\b/i;
const FISH = /\b(salmon|tuna|cod|haddock|prawns?|shrimps?|fish|anchov(y|ies)|mackerel|sardines?|trout|crab|lobster|mussels?|clams?|squid|calamari|scallops?|oysters?|sea ?bass|halibut|tilapia|pollock|pollack|kippers?|herring|monkfish|plaice|langoustines?|octopus|whitebait|bream)\b/i;
// stock/sauce/plant-based lines don't make a dish "meat"/"fish" (fish sauce, vegetable stock, jackfruit "pulled pork"…)
const NOT_PROTEIN = /\b(stock|broth|bouillon|fish sauce|worcestershire|oyster sauce|vegetable|veggie|jackfruit|plant|vegan|meatless|mushroom)\b/i;
function dietOf(r) {
  let meat = false, fish = false;
  for (const i of r.ingredients || []) {
    const n = String(i.name || "");
    if (NOT_PROTEIN.test(n)) continue;
    if (MEAT.test(n)) meat = true;
    else if (FISH.test(n)) fish = true;
  }
  return meat ? "meat" : fish ? "fish-seafood" : "vegetarian";
}
const FAMILIES = {
  frittata: /frittata/i, miso: /miso/i, "shepherd+cottage": /shepherd|cottage pie/i, moroccan: /moroccan/i,
  "sloppy joes": /sloppy/i, lasagna: /lasagn/i, tabbouleh: /tabbou?l/i, matcha: /matcha/i,
};
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];
const DIETS = ["meat", "fish-seafood", "vegetarian"];

async function main() {
  const { classifyRecipeMealTypes } = await import(require("url").pathToFileURL(path.resolve(__dirname, "../../../packages/shared/dist/index.js")).href);
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const recipes = await db.collection("recipes").find({ isPublic: true }).project({ title: 1, description: 1, imageUrl: 1, ingredients: 1, source: 1, tags: 1, mealType: 1, createdAt: 1 }).toArray();
    const costs = await db.collection("recipe_cost").find({}).project({ recipeId: 1, adjustedCoveragePct: 1 }).toArray();
    const cov = new Map(costs.map((c) => [String(c.recipeId), c.adjustedCoveragePct]));
    const usedBy = new Map();
    const addUse = (rid, via, userId) => { const k = String(rid); if (!usedBy.has(k)) usedBy.set(k, []); usedBy.get(k).push({ via, userId: userId ?? null }); };
    for (const m of await db.collection("meal_plans").find({}).project({ recipeId: 1, userId: 1 }).toArray()) addUse(m.recipeId, "meal_plan", m.userId);
    for (const f of await db.collection("favourite_recipes").find({}).project({ recipeId: 1, userId: 1 }).toArray()) addUse(f.recipeId, "favourite", f.userId);
    const imgCount = new Map();
    for (const r of recipes) imgCount.set(r.imageUrl, (imgCount.get(r.imageUrl) || 0) + 1);

    const items = recipes.map((r) => {
      const id = String(r._id);
      const hasImage = !!r.imageUrl && !/img\.spoonacular\.com/.test(r.imageUrl);
      return {
        id, title: r.title, imageUrl: r.imageUrl || "", tt: titleTokens(r.title),
        ing: new Set((r.ingredients || []).map((i) => ingKey(i.name)).filter(Boolean)),
        coverage: cov.has(id) ? cov.get(id) : null, hasImage, imageShared: (imgCount.get(r.imageUrl) || 0) > 1,
        descGood: !!r.description && !SPOON_AD.test(r.description), descLen: (r.description || "").length,
        createdAt: r.createdAt || "", protectedBy: usedBy.get(id) || [], diet: dietOf(r),
        slots: [...classifyRecipeMealTypes({ title: r.title || "", tags: r.tags || [], mealType: r.mealType })].filter((s) => SLOTS.includes(s)),
      };
    });
    // keeper rank: coverage desc -> own (unshared, non-spoonacular) image -> good description
    const rank = (a, b) =>
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      (b.hasImage && !b.imageShared) - (a.hasImage && !a.imageShared) ||
      b.hasImage - a.hasImage ||
      b.descGood - a.descGood || b.descLen - a.descLen ||
      String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);

    const parent = items.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const tj = jaccard(a.tt, b.tt), ij = jaccard(a.ing, b.ing);
      const keyEq = [...a.tt].sort().join(" ") === [...b.tt].sort().join(" ");
      const strong = (ij >= ING_MIN && tj >= TITLE_MIN) || (keyEq && ij >= ING_FLOOR);
      const medium = (tj >= MED_TITLE_HI && ij >= MED_ING_HI) || (tj >= TITLE_MIN && sharedTitle(a, b) >= MED_SHARED && ij >= MED_ING_HI) || (keyEq && ij >= MED_KEYEQ_ING);
      if (strong || medium) parent[find(i)] = find(j);
    }
    const comps = new Map();
    items.forEach((it, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(it); });

    const familyName = (members) => {
      const cnt = new Map();
      for (const m of members) for (const t of m.tt) cnt.set(t, (cnt.get(t) || 0) + 1);
      const top = [...cnt.entries()].filter(([, c]) => c >= Math.ceil(members.length / 2)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t);
      return top.length ? top.join(" ") : members.slice().sort(rank)[0].title;
    };
    const row = (m, action, reason, keeperTitle, link) => ({ ...(link||{}), recipeId: m.id, title: m.title, diet: m.diet, imageUrl: m.imageUrl, coverage: m.coverage, action, reason, keeperTitle: keeperTitle || null, usedBy: m.protectedBy });

    const groups = [];
    const withdrawIds = [];
    for (const members of comps.values()) {
      if (members.length < 2) continue;
      const rows = [];
      for (const d of DIETS) {
        const sub = members.filter((m) => m.diet === d).sort(rank);
        if (!sub.length) continue;
        const prot = sub.filter((m) => m.protectedBy.length);
        const keepers = prot.length ? prot : [sub[0]];
        for (const k of keepers) rows.push(row(k, k.protectedBy.length ? "keep-protected" : "keep", k.protectedBy.length ? "protected (meal plan / favourite)" : `best of ${sub.length} ${d} in family (coverage, own image, description)`));
        for (const m of sub) {
          if (keepers.includes(m)) continue;
          withdrawIds.push(m.id);
          const tj = jaccard(m.tt, keepers[0].tt), ij = jaccard(m.ing, keepers[0].ing);
          rows.push(row(m, "withdraw", `same family + diet (${d}) as keeper "${keepers[0].title}"`, keepers[0].title, { titleJaccardToKeeper: +tj.toFixed(2), ingredientJaccardToKeeper: +ij.toFixed(2), weakLink: tj < 0.3 && ij < 0.3 }));
        }
      }
      groups.push({ family: familyName(members), size: members.length, diets: Object.fromEntries(DIETS.map((d) => [d, members.filter((m) => m.diet === d).length])), withdraw: rows.filter((r) => r.action === "withdraw").length, weakLinkWithdrawals: rows.filter((r) => r.weakLink).length, recipes: rows });
    }
    groups.sort((a, b) => b.size - a.size);
    groups.forEach((g, i) => (g.groupId = i + 1));

    const wset = new Set(withdrawIds);
    const after = items.filter((m) => !wset.has(m.id));
    const famCounts = {};
    for (const [name, re] of Object.entries(FAMILIES)) {
      const f = (arr) => { const o = { total: 0, meat: 0, "fish-seafood": 0, vegetarian: 0 }; for (const m of arr) if (re.test(m.title)) { o.total++; o[m.diet]++; } return o; };
      famCounts[name] = { before: f(items), after: f(after) };
    }
    const slotTable = (arr) => { const t = {}; for (const d of DIETS) { t[d] = { total: 0 }; for (const s of SLOTS) t[d][s] = 0; } for (const m of arr) { t[m.diet].total++; for (const s of m.slots) t[m.diet][s]++; } return t; };
    const summary = {
      publicBefore: items.length, groups: groups.length, recipesInGroups: groups.reduce((n, g) => n + g.size, 0),
      weakLinkWithdrawals: groups.reduce((n, g) => n + g.weakLinkWithdrawals, 0),
      withdraw: withdrawIds.length, publicAfter: after.length,
      protectedTotal: items.filter((m) => m.protectedBy.length).length, protectedWithdrawn: items.filter((m) => m.protectedBy.length && wset.has(m.id)).length,
      largestGroups: groups.slice(0, 15).map((g) => ({ family: g.family, size: g.size, diets: g.diets, withdraw: g.withdraw })),
      dietBefore: Object.fromEntries(DIETS.map((d) => [d, items.filter((m) => m.diet === d).length])),
      dietAfter: Object.fromEntries(DIETS.map((d) => [d, after.filter((m) => m.diet === d).length])),
      familyCounts: famCounts,
      mealSlotsByDiet: { before: slotTable(items), after: slotTable(after) },
    };
    const out = { generatedAt: new Date().toISOString(), dryRun: true, summary, withdrawIds, groups };
    const dest = path.resolve(__dirname, "../../../summaries/2026-10-10_part11-dryrun-v2.json");
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(summary));
    console.log("wrote", dest);
  } finally { await client.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
