// Part 3 finalize (2026-10-11 Jackie sign-off): takes the reviewed dry-run file
// (summaries/part3_descriptions_dryrun_2026-10-11.json, dd13782) and
//   1. applies deterministic UK spelling on `after` (no LLM),
//   2. grounding-checks every `after` against title + ALL ingredient names,
//   3. regenerates ONLY the ungrounded ones (3 attempts, full ingredient list, "only these ingredients"),
//      keeping the original text (-> `skipped`) if they never pass validate + grounding.
// Writes summaries/part3_descriptions_final_2026-10-11.json. Touches NO DB document.
//
// Usage (from uiu-pwa-v2/apps/api):  node scripts/part3_finalize.cjs
// Apply (reviewed file only):        node scripts/part3_rewrite_descriptions.cjs --write --from ../../summaries/part3_descriptions_final_2026-10-11.json
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const IN_FILE = path.resolve(__dirname, "../../../summaries/part3_descriptions_dryrun_2026-10-11.json");
const OUT_FILE = path.resolve(__dirname, "../../../summaries/part3_descriptions_final_2026-10-11.json");

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

// ---- UK spelling (deterministic) ------------------------------------------------------------------
const UK = [
  [/\bscallions?\b/gi, (m) => (/s$/i.test(m) ? "spring onions" : "spring onion"), "scallion"],
  [/\bcilantro\b/gi, () => "coriander", "cilantro"],
  [/\beggplants?\b/gi, (m) => (/s$/i.test(m) ? "aubergines" : "aubergine"), "eggplant"],
  [/\bzucchinis?\b/gi, () => "courgette", "zucchini"],
  [/\barugula\b/gi, () => "rocket", "arugula"],
];
function matchCase(src, out) {
  if (src === src.toUpperCase() && src.length > 1) return out.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return out[0].toUpperCase() + out.slice(1);
  return out;
}
function ukFix(text, counts) {
  let t = text;
  for (const [re, fn, key] of UK) {
    t = t.replace(re, (m) => {
      counts[key] = (counts[key] || 0) + 1;
      return matchCase(m, fn(m));
    });
  }
  return t;
}
function ukNormaliseForMatch(text) {
  return ukFix(text, {});
}

// ---- validate (same rules as part3_rewrite_descriptions.cjs) -------------------------------------
const BANNED_OUT = /spoonacular|calorie|kcal|per serving|\bfans?\b|score|£|\$|€|\d/i;
function validate(text) {
  if (typeof text !== "string") return "not a string";
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > 160) return `too long (${t.length})`;
  if (BANNED_OUT.test(t)) return "contains banned token/number";
  if (/<[a-z]/i.test(t)) return "contains markup";
  if (t.split(/(?<=[.!?])\s+/).filter(Boolean).length > 2) return "more than 2 sentences";
  return null;
}

// ---- grounding -----------------------------------------------------------------------------------
// Food dictionary = every word of every canonical_ingredients name/alias, minus descriptive words.
const NOT_FOOD = new Set(
  ("sweet fresh red green black white yellow orange hot cold warm light dark whole ground dried large small extra virgin plain mixed " +
    "golden brown fine coarse thick thin soft hard raw ripe frozen canned tinned smoked roasted toasted baked fried grilled cooked " +
    "chopped sliced diced minced grated crushed boneless skinless low fat free reduced full instant quick wild baby young mild " +
    "organic natural pure real good best style type mix blend dry wet new old half double single top bottom side main of and or the a an " +
    "with without for in on to from into over under about per can jar pack packet bag box bunch head stalk clove cloves slice piece pieces " +
    "cup cups tablespoon tablespoons teaspoon teaspoons ounce ounces pound pounds gram grams ml litre oz lb tbsp tsp pinch dash handful " +
    "splash drop drops").split(" "),
);
// Generic class nouns: never flagged on their own (the distinguishing word carries the grounding).
const GENERIC = new Set(
  ("oil cheese sauce stock broth juice zest powder paste spice spices herb herbs vinegar seasoning dressing syrup salt water " +
    "leaves leaf nut nuts seed seeds root fruit fruits vegetable vegetables veg meat greens green salad soup sugar flour").split(" "),
);
// Descriptor words that live in canonical names ("sharp cheddar", "bite size ...") or are texture/flavour talk, never an ingredient claim.
const DESCRIPTOR = new Set(
  ("add adds bite bites flavour flavours flavor flavors served serve sized size heat sharp juicy creamy savory savoury veggie veggies little " +
    "base crust fry seasoned grainy seafood sticky salty tangy spicy crispy crunchy crunch rich bright silky smooth soft tender fluffy zesty " +
    "fragrant earthy sour bitter smoky herbal kick finish note lift twist touch hint topping filling coating glaze layer layers gentle " +
    "light lightly simple easy hearty comforting cosy cozy classic tasty delicious perfect lovely twist treat meal dish bowl side snack " +
    "dinner lunch breakfast brunch warming warm cool chilled chilly crisp crisply tender make makes made give gives lifted brightened " +
    "finished topped filled stuffed baked braised roasted grilled").split(" "),
);
// Flavour adjectives that DO assert an ingredient (garlicky -> garlic): checked against the recipe like a noun.
const DERIVED = { garlicky: "garlic", lemony: "lemon", buttery: "butter", peppery: "pepper", citrusy: "citrus", oniony: "onion", minty: "mint", gingery: "ginger", cheesy: "cheese", herby: "herb", nutty: "nut", chocolatey: "chocolate" };
const sing = (w) =>
  w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("oes") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
function forms(word) {
  const w = word.toLowerCase();
  const out = new Set([w, sing(w)]);
  for (const suf of ["y", "ey", "ish", "ed", "ing"]) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length);
      out.add(stem);
      out.add(sing(stem));
      if (suf === "y" && stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) out.add(stem.slice(0, -1)); // nutty -> nut
    }
  }
  if (w === "chilli" || w === "chillies" || w === "chilies" || w === "chile") out.add("chili"), out.add("chilli");
  if (w === "chili") out.add("chilli");
  return out;
}
function words(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s'-]+/g, " ").split(/[\s-]+/).filter((w) => w.length > 2);
}

async function buildDict(db) {
  const dict = new Set();
  for (const d of await db.collection("canonical_ingredients").find({}).project({ canonical_name: 1, aliases: 1 }).toArray()) {
    for (const n of [d.canonical_name, ...(d.aliases || [])]) {
      for (const w of words(ukNormaliseForMatch(String(n || "")))) {
        if (NOT_FOOD.has(w) || GENERIC.has(w) || DESCRIPTOR.has(w)) continue;
        for (const f of forms(w)) dict.add(f);
        dict.add(sing(w));
      }
    }
  }
  return dict;
}

function groundSet(recipe) {
  const text = ukNormaliseForMatch([recipe.title, ...(recipe.ingredients || []).map((i) => i.name)].join(" "));
  const set = new Set();
  for (const w of words(text)) for (const f of forms(w)) set.add(f);
  return set;
}

/** Food words in `text` that are in the dictionary but nowhere in the recipe's title / ingredient names. */
function ungroundedWords(text, ground, dict) {
  const bad = [];
  const groundList = [...ground];
  const isGrounded = (w) => {
    if (ground.has(w)) return true;
    return groundList.some((g) => (g.length >= 4 && w.startsWith(g)) || (w.length >= 3 && g.startsWith(w)));
  };
  for (const raw of words(ukNormaliseForMatch(text))) {
    if (NOT_FOOD.has(raw) || DESCRIPTOR.has(raw)) continue;
    const base = DERIVED[raw] || raw;
    if (GENERIC.has(base)) continue;
    const exact = new Set([base, sing(base)]);
    const isFood = [...exact].some((f) => dict.has(f));
    if (!isFood) continue;
    const grounded = [...exact].some((f) => isGrounded(f));
    if (!grounded && !bad.includes(raw)) bad.push(raw);
  }
  return bad;
}

// ---- OpenRouter (regeneration of ungrounded only) ------------------------------------------------
async function regenerate(env, recipe, ground, dict, hint) {
  const ingredients = (recipe.ingredients || []).map((i) => i.name).filter(Boolean);
  const sys =
    'You write short, appetising recipe blurbs for a UK budget-cooking app. Output ONLY JSON: {"description": string}. ' +
    "Rules: British English; 1-2 sentences; at most 160 characters total; describe flavour and what makes the dish distinctive. " +
    "You may ONLY mention foods that appear in the title or the ingredient list given - do not name any other ingredient, spice, sauce or flavour source. " +
    "No numbers or digits, no prices, no calories or nutrition, no 'per serving', no mention of Spoonacular, fans, scores or similar recipes; " +
    "no markdown or HTML; do not start with 'This recipe'. Use UK words (spring onion, coriander, aubergine, courgette, rocket).";
  let lastErr = hint || "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const user =
      `Title: ${recipe.title}\nAllowed ingredients (ONLY these): ${ingredients.join(", ")}` +
      (lastErr ? `\n\nYour previous answer was rejected: ${lastErr}. Fix it.` : "");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.5,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      lastErr = `HTTP ${res.status}`;
      if (res.status === 402 || res.status === 401) throw new Error(`OpenRouter ${res.status} - STOP (credits/key)`);
      continue;
    }
    let text;
    try {
      const raw = (await res.json()).choices[0].message.content;
      text = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "")).description;
    } catch {
      lastErr = "unparseable JSON";
      continue;
    }
    if (typeof text !== "string") { lastErr = "not a string"; continue; }
    text = ukFix(text.trim(), {});
    const bad = validate(text);
    if (bad) { lastErr = bad; continue; }
    const ung = ungroundedWords(text, ground, dict);
    if (ung.length) { lastErr = `mentions ingredients not in the list: ${ung.join(", ")}`; continue; }
    return { text, attempts: attempt };
  }
  return { text: null, error: lastErr };
}

async function main() {
  const env = loadDevVars();
  const input = JSON.parse(fs.readFileSync(IN_FILE, "utf8"));
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const dict = await buildDict(db);
    console.log(`food dictionary: ${dict.size} forms`);

    const ids = input.rewrites.map((r) => new ObjectId(r.id));
    const recipes = new Map((await db.collection("recipes").find({ _id: { $in: ids } }).toArray()).map((r) => [String(r._id), r]));

    // 1. UK spelling
    const ukCounts = {};
    const ukChangedIds = new Set();
    const items = input.rewrites.map((r) => {
      const per = {};
      const after = ukFix(r.after, per);
      const n = Object.values(per).reduce((a, b) => a + b, 0);
      for (const [k, v] of Object.entries(per)) ukCounts[k] = (ukCounts[k] || 0) + v;
      if (n) ukChangedIds.add(r.id);
      return { ...r, after, ukSpellingFixes: n || undefined, afterBeforeUk: n ? r.after : undefined };
    });
    console.log("UK spelling fixes:", ukCounts, "recipes changed:", ukChangedIds.size);

    // 2. grounding
    const ungrounded = [];
    for (const it of items) {
      const rec = recipes.get(it.id);
      if (!rec) { ungrounded.push({ id: it.id, title: it.title, words: ["<recipe not found>"], text: it.after }); continue; }
      const ung = ungroundedWords(it.after, groundSet(rec), dict);
      const v = validate(it.after); // a UK swap can push a blurb over 160 chars ("scallions" -> "spring onions")
      if (ung.length || v) ungrounded.push({ id: it.id, title: it.title, words: ung, validateError: v || undefined, text: it.after });
    }
    console.log(`ungrounded: ${ungrounded.length}`);
    for (const u of ungrounded) console.log(`  ${u.title} (${u.id}): ${u.words.join(", ")}\n    ${u.text}`);

    // 3. regenerate ungrounded only
    const regenerated = [];
    const skipped = [];
    for (const u of ungrounded) {
      const rec = recipes.get(u.id);
      if (!rec) { skipped.push({ id: u.id, title: u.title, reason: "recipe not found" }); continue; }
      const it = items.find((x) => x.id === u.id);
      const out = await regenerate(env, rec, groundSet(rec), dict, u.validateError ? `it failed validation (${u.validateError})` : `it mentioned ${u.words.join(", ")}, which are not in the ingredient list`);
      if (out.text) {
        regenerated.push({ id: u.id, title: u.title, was: it.after, now: out.text, ungroundedWords: u.words, validateError: u.validateError, attempts: out.attempts });
        it.after = out.text;
        it.regenerated = true;
      } else {
        skipped.push({ id: u.id, title: u.title, ungroundedWords: u.words, lastError: out.error, kept: "original description (not rewritten)" });
      }
    }
    const skippedIds = new Set(skipped.map((s) => s.id));
    const rewrites = items.filter((it) => !skippedIds.has(it.id));

    // final guard: every rewrite passes validate + UK + grounding again
    const finalBad = [];
    for (const it of rewrites) {
      const rec = recipes.get(it.id);
      const v = validate(it.after);
      const g = rec ? ungroundedWords(it.after, groundSet(rec), dict) : ["<no recipe>"];
      const uk = /\b(scallions?|cilantro|eggplants?|zucchinis?|arugula)\b/i.test(it.after);
      if (v || g.length || uk) finalBad.push({ id: it.id, title: it.title, validate: v, ungrounded: g, ukLeft: uk });
    }

    const out = {
      generatedAt: new Date().toISOString(),
      basedOn: "summaries/part3_descriptions_dryrun_2026-10-11.json (dd13782)",
      model: env.OPENROUTER_MODEL,
      publicRecipes: input.publicRecipes,
      matching: input.matching,
      rewritten: rewrites.length,
      failed: skipped.length,
      ukSpellingFixes: { counts: ukCounts, recipesChanged: ukChangedIds.size },
      ungrounded,
      regenerated,
      skipped,
      finalGuardFailures: finalBad,
      rewrites,
      failures: skipped,
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`\nrewrites=${rewrites.length} regenerated=${regenerated.length} skipped=${skipped.length} finalGuardFailures=${finalBad.length}`);
    console.log(`-> ${OUT_FILE}`);
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
