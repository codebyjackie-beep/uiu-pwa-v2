// Part 2 (expanded) — public recipes that share an imageUrl with another recipe, plus dead
// img.spoonacular.com images. READ-ONLY dry-run: Mongo find() only; the only network side
// effects are Pexels GETs (search / photo lookup) and HEADs on spoonacular URLs.
// Output: summaries/2026-10-10_part2-dryrun.json  (no --write mode exists in this script).
//
// Per shared-image group (same imageUrl, >= 2 public recipes):
//   - members flagged part11Withdraw:true (from summaries/2026-10-10_part11-dryrun.json
//     withdrawIds = strong tier only) need NO new photo — listed only.
//   - among the remaining members the keeper is the one whose title best overlaps the existing
//     photo's Pexels alt text (tie-break: Part 11 keeper, coverage); it keeps the original photo.
//   - every other remaining member gets a suggested Pexels photo: unique across the WHOLE library
//     (all recipes, public or not, plus everything already suggested in this run).
// Dead spoonacular images (HEAD != 2xx): no keeper, every member needs a new photo.
//
// Pexels free tier is 200 req/hour: the script waits out 429s (X-Ratelimit-Reset) and caches every
// response in PART2_CACHE (default: OS temp dir) so a re-run resumes instead of re-spending quota.
//
// Usage (from uiu-pwa-v2/apps/api):  node scripts/part2_shared_images_dryrun.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MongoClient } = require("mongodb");

const CACHE_PATH = process.env.PART2_CACHE || path.join(os.tmpdir(), "uiu_part2_pexels_cache.json");
const PER_PAGE = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const cache = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};
const saveCache = () => fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

let pexelsKey = "";
let pexelsCalls = 0;
async function pexelsGet(url) {
  if (cache[url]) return cache[url];
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: pexelsKey }, signal: AbortSignal.timeout(30_000) });
    pexelsCalls++;
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Math.max(30_000, reset - Date.now() + 5_000);
      console.error(`[pexels] 429 — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Pexels ${res.status} for ${url}`);
    const json = await res.json();
    cache[url] = json;
    saveCache();
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(remaining) && remaining < 3) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Math.max(30_000, reset - Date.now() + 5_000);
      console.error(`[pexels] quota exhausted — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    } else {
      await sleep(300);
    }
    return json;
  }
}

const STOP = new Set(["a", "an", "the", "with", "and", "of", "in", "on", "for", "to", "recipe", "style", "easy", "quick", "simple", "homemade", "classic", "best", "food", "dish", "served", "plate", "bowl", "white", "wooden", "table", "top", "view", "close", "up"]);
const sing = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const toks = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w)).map(sing));
const overlap = (title, alt) => {
  const a = toks(title), b = toks(alt);
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return a.size ? n / a.size : 0;
};
const pexelsId = (u) => (/pexels\.com\/photos\/(\d+)\//.exec(u || "") || [])[1] || null;

async function headOk(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, status: `error:${e.message}` };
  }
}

async function main() {
  const env = loadDevVars();
  pexelsKey = env.PEXELS_API_KEY;
  const p11 = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../summaries/2026-10-10_part11-dryrun.json"), "utf8"));
  const withdrawSet = new Set(p11.withdrawIds);
  const mediumSet = new Set(p11.mediumCandidateIds || []);
  const p11Keepers = new Set(p11.groups.map((g) => g.keep.recipeId));

  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  let allRecipes, costs;
  try {
    const db = client.db(env.MONGODB_DB);
    allRecipes = await db.collection("recipes").find({}).project({ title: 1, imageUrl: 1, isPublic: 1 }).toArray();
    costs = await db.collection("recipe_cost").find({}).project({ recipeId: 1, adjustedCoveragePct: 1 }).toArray();
  } finally {
    await client.close();
  }
  const cov = new Map(costs.map((c) => [String(c.recipeId), c.adjustedCoveragePct ?? -1]));
  const pub = allRecipes.filter((r) => r.isPublic);

  const usedPexelsIds = new Set();
  for (const r of allRecipes) {
    const id = pexelsId(r.imageUrl);
    if (id) usedPexelsIds.add(id);
  }

  // group public recipes by imageUrl
  const byUrl = new Map();
  for (const r of pub) {
    if (!r.imageUrl) continue;
    if (!byUrl.has(r.imageUrl)) byUrl.set(r.imageUrl, []);
    byUrl.get(r.imageUrl).push(r);
  }
  const sharedGroups = [...byUrl.entries()].filter(([, m]) => m.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const sharedRecipeCount = sharedGroups.reduce((n, [, m]) => n + m.length, 0);

  // spoonacular host audit (all public)
  const spoonUrls = [...byUrl.keys()].filter((u) => /img\.spoonacular\.com/.test(u));
  const spoonHead = new Map();
  console.error("[part2] HEAD-checking", spoonUrls.length, "spoonacular urls");
  for (const u of spoonUrls) spoonHead.set(u, await headOk(u));
  console.error("[part2] HEAD done");
  const spoonDead = new Set([...spoonHead.entries()].filter(([, v]) => !v.ok).map(([u]) => u));
  // dead single-use spoonacular urls are not "shared" but are still Part 2's original 12
  const deadGroups = [...spoonDead].filter((u) => byUrl.get(u).length < 2).map((u) => [u, byUrl.get(u)]);
  const groups = [...sharedGroups, ...deadGroups];

  const items = []; // flat per-recipe rows
  const groupsOut = [];
  const needPhoto = []; // rows needing a search, in order

  for (const [url, members] of groups) {
    const dead = spoonDead.has(url);
    const pid = pexelsId(url);
    let existingAlt = null;
    if (pid) {
      const j = await pexelsGet(`https://api.pexels.com/v1/photos/${pid}`);
      existingAlt = j.alt || "";
    }
    const live = members.filter((m) => !withdrawSet.has(String(m._id)));
    let keeper = null;
    if (!dead && live.length) {
      keeper = [...live].sort((a, b) => {
        const oa = existingAlt ? overlap(a.title, existingAlt) : 0, ob = existingAlt ? overlap(b.title, existingAlt) : 0;
        return ob - oa || (p11Keepers.has(String(b._id)) - p11Keepers.has(String(a._id))) || (cov.get(String(b._id)) ?? -1) - (cov.get(String(a._id)) ?? -1) || String(a._id).localeCompare(String(b._id));
      })[0];
    }
    const rows = members.map((m) => {
      const id = String(m._id);
      const w = withdrawSet.has(id);
      const row = {
        recipeId: id, title: m.title, currentImageUrl: url,
        part11Withdraw: w, part11MediumCandidate: mediumSet.has(id),
        role: w ? "withdrawn-no-photo-needed" : keeper && id === String(keeper._id) ? "keeps-original" : "needs-new-photo",
        keeperAltOverlap: existingAlt != null ? +overlap(m.title, existingAlt).toFixed(2) : null,
      };
      if (row.role === "needs-new-photo") needPhoto.push(row);
      items.push(row);
      return row;
    });
    groupsOut.push({
      imageUrl: url, pexelsPhotoId: pid, existingAlt, deadSpoonacular: dead, spoonacularHead: dead || /spoonacular/.test(url) ? spoonHead.get(url) : undefined,
      memberCount: members.length, keeperRecipeId: keeper ? String(keeper._id) : null, members: rows,
    });
  }

  // Suggestions
  const chosen = new Set(); // pexels ids picked this run
  for (const row of needPhoto) {
    const queries = [`${row.title} food dish`, `${[...toks(row.title)].slice(0, 4).join(" ")} food`];
    let best = null;
    for (const q of queries) {
      const u = new URL("https://api.pexels.com/v1/search");
      u.searchParams.set("query", q);
      u.searchParams.set("per_page", String(PER_PAGE));
      u.searchParams.set("orientation", "landscape");
      const j = await pexelsGet(u.toString());
      const cands = (j.photos || []).filter((p) => !usedPexelsIds.has(String(p.id)) && !chosen.has(String(p.id)));
      const scored = cands.map((p, i) => ({ p, score: overlap(row.title, p.alt || ""), i })).sort((a, b) => b.score - a.score || a.i - b.i);
      if (scored.length && (!best || scored[0].score > best.score)) best = { ...scored[0], query: q };
      if (best && best.score >= 0.4) break;
    }
    if (best) {
      chosen.add(String(best.p.id));
      row.suggestion = {
        pexelsId: best.p.id, alt: best.p.alt || "", query: best.query, altOverlap: +best.score.toFixed(2),
        lowConfidence: best.score < 0.25,
        srcMedium: best.p.src.medium, srcLarge: best.p.src.large, pexelsPage: best.p.url,
      };
    } else {
      row.suggestion = null;
    }
  }

  const needs = items.filter((i) => i.role === "needs-new-photo");
  const summary = {
    publicTotal: pub.length,
    sharedImageGroups: sharedGroups.length,
    recipesSharingAnImage: sharedRecipeCount,
    deadSpoonacularUrls: spoonDead.size,
    deadSpoonacularRecipes: [...spoonDead].reduce((n, u) => n + byUrl.get(u).length, 0),
    spoonacularHostPublicRecipes: spoonUrls.reduce((n, u) => n + byUrl.get(u).length, 0),
    rowsInScope: items.length,
    part11WithdrawTrue: items.filter((i) => i.part11Withdraw).length,
    keepsOriginal: items.filter((i) => i.role === "keeps-original").length,
    needNewPhoto: needs.length,
    needNewPhotoOfWhichMediumCandidate: needs.filter((i) => i.part11MediumCandidate).length,
    suggestionsFound: needs.filter((i) => i.suggestion).length,
    suggestionsMissing: needs.filter((i) => !i.suggestion).length,
    suggestionsLowConfidence: needs.filter((i) => i.suggestion && i.suggestion.lowConfidence).length,
    uniqueSuggestedPexelsIds: new Set(needs.filter((i) => i.suggestion).map((i) => i.suggestion.pexelsId)).size,
    pexelsHttpCallsThisRun: pexelsCalls,
  };
  const out = { generatedAt: new Date().toISOString(), dryRun: true, summary, groups: groupsOut, needNewPhoto: needs };
  const dest = path.resolve(__dirname, "../../../summaries/2026-10-10_part2-dryrun.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("wrote", dest);
}

main().catch((e) => { console.error(e); process.exit(1); });
