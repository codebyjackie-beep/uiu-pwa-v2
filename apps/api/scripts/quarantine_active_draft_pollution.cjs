// cc_prompt_recipe_import_parser_fragments.md (2026-09-09) follow-up.
//
// While investigating the parser-fragment root cause, found that recipe_drafts with
// importMethod=undefined (the DAILY AI DRAFT AGENT, src/jobs/dailyRecipeDraft.ts) had
// repeatedly reused "to 5 garlic cloves" (11x, Aug 4 - Sep 8) and "a onion" (7x,
// Aug 27 - Sep 3) as ingredient names. Root cause of the *repetition*: the daily agent
// forces the LLM to pick ingredient names "verbatim" from a canonicalNames list built
// as `allIngredientDocs.filter(d => !d.quarantine)` (dailyRecipeDraft.ts:121) — so a
// single un-quarantined fragment entry gets silently reused every single day until
// someone quarantines it. "to 5 garlic cloves" is already fixed as a side effect of
// today's 28-entry canonical_ingredients cleanup (write_skip_list_28_cleanup.cjs). This
// script quarantines the 2 remaining entries found still live/un-quarantined that were
// actively feeding this same active-pollution mechanism as of 2026-09-09: "a onion"
// (7 drafts) and "p of pepper" (found via the same fragment-name regex scan, not yet
// confirmed reused by a draft title but same shape). Narrow and justified as closing
// an ACTIVE ongoing-pollution bug (the whole point of the parser-fragment prompt),
// not a broader retroactive data cleanup (which is explicitly out of scope).
//
// Usage: node scripts/quarantine_active_draft_pollution.cjs [--write]
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WRITE = process.argv.includes("--write");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, idx)] = value;
  }
  return env;
}

const TARGETS = ["a onion", "p of pepper"];

(async () => {
  const env = loadDevVars();
  console.log(`Mode: ${WRITE ? "WRITE (--write passed)" : "DRY RUN (pass --write to commit)"}`);
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const col = db.collection("canonical_ingredients");

  for (const name of TARGETS) {
    const before = await col.findOne({ canonical_name: name });
    if (!before) {
      console.log(`SKIP "${name}": not found`);
      continue;
    }
    console.log(`"${name}" quarantine ${before.quarantine ?? false} -> true`);
    if (WRITE) await col.updateOne({ canonical_name: name }, { $set: { quarantine: true } });
  }

  await client.close();
})();
