// cc_prompt_recipe_data_cleanup.md Part 3 — rewrite Spoonacular-style `description`s via OpenRouter.
//
// Two phases, so the DB is only ever written from a REVIEWED file:
//   node scripts/part3_rewrite_descriptions.cjs                          # dry run: calls OpenRouter,
//        writes summaries/part3_descriptions_dryrun_<date>.json, touches NO DB document
//   node scripts/part3_rewrite_descriptions.cjs --write --from <file>    # applies exactly that file
//
// On write: original text -> `descriptionOriginal` (only if not already set), new text -> `description`.
// Only recipes whose current description is still exactly the `before` in the file are updated.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");
const fromIdx = process.argv.indexOf("--from");
const FROM = fromIdx > -1 ? process.argv[fromIdx + 1] : null;
const limIdx = process.argv.indexOf("--limit");
const LIMIT = limIdx > -1 ? Number(process.argv[limIdx + 1]) : Infinity;

const DETECT_SRC = "spoonacular|\\$\\d|calories|per serving|fans|score of|takes roughly|One portion of this dish contains|You can never have too many|Watching your figure";
const DETECT = new RegExp(DETECT_SRC, "i");
const BANNED_OUT = /spoonacular|calorie|kcal|per serving|\bfans?\b|score|£|\$|€|\d/i;

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

function validate(text) {
  if (typeof text !== "string") return "not a string";
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > 160) return `too long (${t.length})`;
  if (BANNED_OUT.test(t)) return "contains banned token/number";
  if (/<[a-z]/i.test(t)) return "contains markup";
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) return "more than 2 sentences";
  return null;
}

async function rewrite(env, recipe) {
  const ingredients = (recipe.ingredients || []).map((i) => i.name).filter(Boolean).slice(0, 14).join(", ");
  const sys =
    'You write short, appetising recipe blurbs for a UK budget-cooking app. Output ONLY JSON: {"description": string}. ' +
    "Rules: English; 1-2 sentences; at most 160 characters total; describe flavour and what makes the dish distinctive, " +
    "using ONLY the title and ingredients given (do not invent facts, techniques or origins not implied by them); " +
    "no numbers or digits at all, no prices, no calories or nutrition, no 'per serving', no mention of Spoonacular, fans, scores or similar recipes; " +
    "no markdown or HTML; do not start with 'This recipe'.";
  const user = `Title: ${recipe.title}\nIngredients: ${ingredients}\nTags: ${(recipe.tags || []).join(", ")}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.6,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user + (lastErr ? `\n\nYour previous answer was rejected: ${lastErr}. Fix it.` : "") },
        ],
      }),
    });
    if (!res.ok) {
      lastErr = `HTTP ${res.status}`;
      if (res.status === 402 || res.status === 401) throw new Error(`OpenRouter ${res.status} - STOP (credits/key)`);
      continue;
    }
    const body = await res.json();
    let text = null;
    try {
      const raw = body.choices[0].message.content;
      text = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "")).description;
    } catch {
      lastErr = "unparseable JSON";
      continue;
    }
    const bad = validate(text);
    if (!bad) return { text: text.trim(), attempts: attempt + 1 };
    lastErr = bad;
  }
  return { text: null, error: lastErr };
}

async function main() {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  try {
    const col = client.db(env.MONGODB_DB).collection("recipes");

    if (WRITE) {
      if (!FROM) throw new Error("--write requires --from <reviewed dry-run json>");
      const file = JSON.parse(fs.readFileSync(path.resolve(FROM), "utf8"));
      let updated = 0;
      let skipped = 0;
      for (const e of file.rewrites) {
        const res = await col.updateOne({ _id: new ObjectId(e.id), description: e.before }, [
          { $set: { descriptionOriginal: { $ifNull: ["$descriptionOriginal", "$description"] }, description: e.after } },
        ]);
        if (res.modifiedCount === 1) updated += 1;
        else skipped += 1;
      }
      console.log(`write done: updated=${updated} skipped(description changed/not found)=${skipped}`);
      return;
    }

    const retryIdx = process.argv.indexOf("--retry-failures");
    if (retryIdx > -1) {
      // Fill only the recipes that failed validation into the SAME dry-run file (extra attempts).
      const file = path.resolve(process.argv[retryIdx + 1]);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const still = [];
      for (const f of data.failures) {
        const r = await col.findOne({ _id: new ObjectId(f.id) });
        let out = null;
        for (let k = 0; k < 3 && !(out && out.text); k++) out = await rewrite(env, r);
        if (out && out.text) data.rewrites.push({ id: f.id, title: r.title, before: r.description, after: out.text, attempts: out.attempts });
        else still.push(f);
      }
      data.failures = still;
      data.rewritten = data.rewrites.length;
      data.failed = still.length;
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      console.log(`retry done: rewritten=${data.rewritten} failed=${data.failed}`);
      return;
    }

    const all = await col.find({ isPublic: true }).toArray();
    const candidates = all.filter((r) => typeof r.description === "string" && DETECT.test(r.description));
    const caseSensitive = all.filter((r) => typeof r.description === "string" && new RegExp(DETECT_SRC).test(r.description)).length;
    console.log(`public recipes: ${all.length}; matching regex (case-insens): ${candidates.length}; case-sensitive: ${caseSensitive}`);
    const todo = candidates.slice(0, LIMIT);

    const rewrites = [];
    const failures = [];
    const CONC = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) {
        const r = todo[cursor++];
        try {
          const out = await rewrite(env, r);
          if (out.text) rewrites.push({ id: String(r._id), title: r.title, before: r.description, after: out.text, attempts: out.attempts });
          else failures.push({ id: String(r._id), title: r.title, error: out.error });
        } catch (e) {
          failures.push({ id: String(r._id), title: r.title, error: String(e.message || e) });
          if (/STOP/.test(String(e.message))) cursor = todo.length;
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    const out = {
      generatedAt: new Date().toISOString(),
      model: env.OPENROUTER_MODEL,
      publicRecipes: all.length,
      matching: candidates.length,
      rewritten: rewrites.length,
      failed: failures.length,
      rewrites,
      failures,
    };
    const dir = path.resolve(__dirname, "../../../summaries");
    fs.mkdirSync(dir, { recursive: true });
    const outFile = path.join(dir, `part3_descriptions_dryrun_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`rewritten=${rewrites.length} failed=${failures.length} -> ${outFile}`);
    console.log("\n--- 10 before/after samples ---");
    const step = Math.max(1, Math.floor(rewrites.length / 10));
    for (let i = 0, n = 0; i < rewrites.length && n < 10; i += step, n++) {
      const s = rewrites[i];
      console.log(`\n[${s.title}] (${s.id})\nBEFORE: ${s.before}\nAFTER (${s.after.length}): ${s.after}`);
    }
    if (failures.length) console.log("\nfailures:", failures.slice(0, 5));
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
