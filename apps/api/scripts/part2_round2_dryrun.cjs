// Part 2 round 2 — READ-ONLY (Mongo find + Pexels search). 3 candidates for each of the 14 recipes
// whose round-1 suggestion was rejected. Queries are short core dish names, not full titles.
// Excludes: every pexels id currently on any recipe, every round-1 suggestion (applied or rejected),
// and ids already offered to an earlier recipe in this run.
// Output: summaries/2026-10-10_part2-round2-dryrun.json
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const REJECTED = {
  "6ac80d84b0ca951a2fbf7484": ["spinach goat cheese frittata", "spinach frittata"],
  "6ac80d8eb0ca951a2fbf74a8": ["asparagus mushroom frittata", "asparagus frittata"],
  "6ac80dd0b0ca951a2fbf7590": ["frittata skillet", "breakfast frittata"],
  "6ac80dc8b0ca951a2fbf7572": ["lasagna rolls", "spinach ricotta lasagna"],
  "69d1933f0ce7d5269f69526d": ["prawns asparagus", "lemon herb prawns"],
  "69d1933f0ce7d5269f695271": ["prawn halloumi skewers", "halloumi skewers", "prawn skewers"],
  "69d1933f0ce7d5269f695276": ["honey garlic prawns", "garlic prawns"],
  "69d1933f0ce7d5269f695269": ["garlic butter prawns", "garlic prawns bread"],
  "6ac80db2b0ca951a2fbf7526": ["three bean chili", "bean chili"],
  "6ac80e17b0ca951a2fbf768a": ["spinach paneer", "palak paneer"],
  "6ac80e25b0ca951a2fbf76ba": ["korean fish rice bowl", "cabbage fish rice bowl"],
  "6ac80d59b0ca951a2fbf73ee": ["beetroot soup", "thai coconut soup"],
  "6ac80e18b0ca951a2fbf768c": ["japanese curry puff pastry", "curry puff"],
  "6ac80e29b0ca951a2fbf76c8": ["pulled pork sandwich", "glazed pork sandwich"],
};
const STOP = new Set(["a", "an", "the", "with", "and", "of", "in", "on"]);
const sing = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const toks = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w)).map(sing));
const BAD = /\b(can|cans|jar|package|packaged|bottle|label|logo|illustration|drawing|cartoon|vector)\b/i;
const pid = (u) => (/pexels\.com\/photos\/(\d+)\//.exec(u || "") || [])[1];

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
async function main() {
  const env = loadDevVars();
  const r1 = require("../../../summaries/2026-10-10_part2-dryrun-v2.json").needNewPhoto;
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  let recipes;
  try { recipes = await client.db(env.MONGODB_DB).collection("recipes").find({}).project({ title: 1, imageUrl: 1 }).toArray(); } finally { await client.close(); }
  const excluded = new Set(recipes.map((r) => pid(r.imageUrl)).filter(Boolean).map(Number));
  const rejectedIds = new Set(r1.filter((x) => REJECTED[x.recipeId]).map((x) => x.suggestion.pexelsId));
  for (const x of r1) excluded.add(x.suggestion.pexelsId);
  const offered = new Set();
  const out = [];
  let calls = 0;
  for (const [rid, queries] of Object.entries(REJECTED)) {
    const row = r1.find((x) => x.recipeId === rid);
    const pool = new Map();
    for (const q of queries) {
      const u = new URL("https://api.pexels.com/v1/search");
      u.searchParams.set("query", q); u.searchParams.set("per_page", "40"); u.searchParams.set("orientation", "landscape");
      const res = await fetch(u, { headers: { Authorization: env.PEXELS_API_KEY }, signal: AbortSignal.timeout(30000) });
      calls++;
      if (!res.ok) throw new Error(`pexels ${res.status} for "${q}"`);
      const qt = toks(q);
      for (const p of (await res.json()).photos || []) {
        if (excluded.has(p.id) || offered.has(p.id) || BAD.test(p.alt || "")) continue;
        const at = toks(p.alt);
        let hit = 0; for (const t of qt) if (at.has(t)) hit++;
        const score = hit / qt.size;
        if (score <= 0) continue;
        const prev = pool.get(p.id);
        if (!prev || score > prev.score) pool.set(p.id, { p, score, query: q });
      }
    }
    const top = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, 3);
    top.forEach((t) => offered.add(t.p.id));
    out.push({
      recipeId: rid, title: row.title, rejectedPexelsId: row.suggestion.pexelsId, queries,
      candidates: top.map((t) => ({ pexelsId: t.p.id, alt: t.p.alt || "", query: t.query, altMatch: +t.score.toFixed(2), srcMedium: t.p.src.medium, srcLarge: t.p.src.large, pexelsPage: t.p.url })),
      pexelsId: top.map((t) => t.p.id), alt: top.map((t) => t.p.alt || ""), srcMedium: top.map((t) => t.p.src.medium),
      lessThan3: top.length < 3,
    });
  }
  const summary = { recipes: out.length, withThreeCandidates: out.filter((o) => !o.lessThan3).length, pexelsHttpCalls: calls, excludedIdCount: excluded.size, dryRun: true };
  fs.writeFileSync(path.resolve(__dirname, "../../../summaries/2026-10-10_part2-round2-dryrun.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, recipes: out }, null, 2));
  console.log(JSON.stringify(summary));
  for (const o of out) { console.log("\n" + o.title); o.candidates.forEach((c) => console.log("  ", c.pexelsId, c.altMatch, "|", c.alt.slice(0, 90))); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
