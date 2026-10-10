// Part 11 (recipe data cleanup) — near-duplicate public recipes. READ-ONLY dry-run: find() only,
// writes nothing to Mongo. Output: summaries/2026-10-10_part11-dryrun.json
//
// Similarity (pair is "near-duplicate" when ALL hold):
//   - ingredient-name Jaccard >= ING_MIN  AND  title-token Jaccard >= TITLE_MIN
//   - OR normalised title keys are identical AND ingredient Jaccard >= ING_FLOOR
// Clusters are keeper-centred (best-quality recipe first; its direct matches join it) so
// A~B, B~C never chains A with C.
//
// Protected (must NOT be withdrawn): any recipe referenced by a meal_plans entry or a
// favourite_recipes row of ANY user. If a cluster holds protected members they outrank everything
// when choosing the keeper, and every protected member stays regardless.
//
// Usage (from uiu-pwa-v2/apps/api):  node scripts/part11_dedupe_dryrun.cjs
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const ING_MIN = 0.7;
const TITLE_MIN = 0.5;
const ING_FLOOR = 0.5;
// "medium" tier (flagged in output so a human eyeballs them): the LLM re-rolls ingredient lists,
// so true near-duplicates (e.g. the matcha smoothies) often sit at ingredient Jaccard 0.3-0.6.
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

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const recipes = await db.collection("recipes").find({ isPublic: true }).project({ title: 1, description: 1, imageUrl: 1, ingredients: 1, source: 1, tags: 1, mealType: 1, createdAt: 1 }).toArray();
    const costs = await db.collection("recipe_cost").find({}).project({ recipeId: 1, adjustedCoveragePct: 1 }).toArray();
    const cov = new Map(costs.map((c) => [String(c.recipeId), c.adjustedCoveragePct]));

    // Protected = used by anyone's meal plan / favourites.
    const usedBy = new Map(); // recipeId -> [{via,userId}]
    const addUse = (rid, via, userId) => {
      const k = String(rid);
      if (!usedBy.has(k)) usedBy.set(k, []);
      usedBy.get(k).push({ via, userId: userId ?? null });
    };
    for (const m of await db.collection("meal_plans").find({}).project({ recipeId: 1, userId: 1 }).toArray()) addUse(m.recipeId, "meal_plan", m.userId);
    for (const f of await db.collection("favourite_recipes").find({}).project({ recipeId: 1, userId: 1 }).toArray()) addUse(f.recipeId, "favourite", f.userId);

    const imgCount = new Map();
    for (const r of recipes) imgCount.set(r.imageUrl, (imgCount.get(r.imageUrl) || 0) + 1);

    const items = recipes.map((r) => {
      const id = String(r._id);
      const ing = new Set((r.ingredients || []).map((i) => ingKey(i.name)).filter(Boolean));
      const hasImage = !!r.imageUrl && !/img\.spoonacular\.com/.test(r.imageUrl);
      const uses = usedBy.get(id) || [];
      return {
        id, title: r.title, source: r.source, imageUrl: r.imageUrl || "", tt: titleTokens(r.title), ing,
        coverage: cov.has(id) ? cov.get(id) : null,
        hasImage, imageShared: (imgCount.get(r.imageUrl) || 0) > 1,
        descGood: !!r.description && !SPOON_AD.test(r.description),
        descLen: (r.description || "").length,
        createdAt: r.createdAt || "",
        protectedBy: uses,
      };
    });

    const rank = (a, b) =>
      (b.protectedBy.length > 0) - (a.protectedBy.length > 0) ||
      b.hasImage - a.hasImage ||
      (a.imageShared - b.imageShared) ||
      b.descGood - a.descGood ||
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      b.descLen - a.descLen ||
      String(a.createdAt).localeCompare(String(b.createdAt)) ||
      a.id.localeCompare(b.id);
    items.sort(rank);

    const sim = (a, b, tierWanted) => {
      const tj = jaccard(a.tt, b.tt);
      const ij = jaccard(a.ing, b.ing);
      const keyEq = [...a.tt].sort().join(" ") === [...b.tt].sort().join(" ");
      const strong = (ij >= ING_MIN && tj >= TITLE_MIN) || (keyEq && ij >= ING_FLOOR);
      const medium = !strong && ((tj >= MED_TITLE_HI && ij >= MED_ING_HI) || (tj >= TITLE_MIN && sharedTitle(a, b) >= MED_SHARED && ij >= MED_ING_HI) || (keyEq && ij >= MED_KEYEQ_ING));
      return { tj, ij, similar: tierWanted === "strong" ? strong : medium, tier: tierWanted };
    };

    const assigned = new Set();
    const groups = [];
    const fmt = (r, s) => ({
      recipeId: r.id, title: r.title, source: r.source, coverage: r.coverage, hasImage: r.hasImage, imageShared: r.imageShared, descGood: r.descGood,
      tier: s ? s.tier : "keeper", titleJaccardToKeeper: s ? +s.tj.toFixed(2) : 1, ingredientJaccardToKeeper: s ? +s.ij.toFixed(2) : 1,
      usedBy: r.protectedBy,
    });
    // Pass 1 = strong; pass 2 = medium, only over recipes pass 1 did not touch (so medium can never
    // steal a member from a strong group).
    for (const tier of ["strong", "medium"]) {
      for (const k of items) {
        if (assigned.has(k.id)) continue;
        const matches = [];
        for (const o of items) {
          if (o.id === k.id || assigned.has(o.id)) continue;
          const s = sim(k, o, tier);
          if (s.similar) matches.push({ o, s });
        }
        if (!matches.length) continue;
        assigned.add(k.id);
        for (const m of matches) assigned.add(m.o.id);
        const keep = fmt(k, null);
        const withdraw = [];
        const protectedMembers = [];
        for (const m of matches) {
          const row = fmt(m.o, m.s);
          if (m.o.protectedBy.length) protectedMembers.push(row);
          else withdraw.push(row);
        }
        groups.push({ groupId: 0, tier, size: matches.length + 1, keep, withdraw, protectedKept: protectedMembers, keeperIsProtected: k.protectedBy.length > 0 });
      }
    }
    groups.sort((a, b) => b.size - a.size);
    groups.forEach((g, i) => (g.groupId = i + 1));

    const withdrawIds = groups.flatMap((g) => g.withdraw.filter((w) => w.tier === "strong").map((w) => w.recipeId));
    const mediumCandidateIds = groups.flatMap((g) => g.withdraw.filter((w) => w.tier === "medium").map((w) => w.recipeId));
    const protectedInGroups = groups.flatMap((g) => [...(g.keeperIsProtected ? [g.keep] : []), ...g.protectedKept]);
    const summary = {
      thresholds: { strong: { ING_MIN, TITLE_MIN, ING_FLOOR }, medium: { MED_TITLE_HI, MED_ING_HI, MED_SHARED, MED_KEYEQ_ING } },
      withdrawByTier: { strong: groups.flatMap((g) => g.withdraw).filter((w) => w.tier === "strong").length, medium: groups.flatMap((g) => g.withdraw).filter((w) => w.tier === "medium").length },
      publicTotal: recipes.length,
      groups: groups.length,
      recipesInGroups: groups.reduce((n, g) => n + g.size, 0),
      suggestedWithdraw: withdrawIds.length,
      mediumCandidates: mediumCandidateIds.length,
      protectedInGroups: protectedInGroups.length,
      publicAfterWithdrawStrongOnly: recipes.length - withdrawIds.length,
      publicAfterWithdrawStrongAndMedium: recipes.length - withdrawIds.length - mediumCandidateIds.length,
      matchaSmoothieGroup: groups.filter((g) => [g.keep, ...g.withdraw, ...g.protectedKept].some((x) => /matcha/i.test(x.title))).map((g) => ({ groupId: g.groupId, size: g.size, keep: g.keep.title })),
    };
    const out = { generatedAt: new Date().toISOString(), dryRun: true, summary, withdrawIds, mediumCandidateIds, groups };
    const dest = path.resolve(__dirname, "../../../summaries/2026-10-10_part11-dryrun.json");
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log("wrote", dest);
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
