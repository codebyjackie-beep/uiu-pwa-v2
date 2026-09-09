// cc_prompt_live_recipes_fragment_names.md (2026-09-09) — retroactive cleanup of the 11 live
// `recipes` docs with fragment-like ingredient names, per fresh scan via
// scan_live_recipes_fragment_names.cjs (see summaries/2026-09-09_live-recipes-fragment-scan-raw.json).
//
// Unlike the recipe_drafts cleanup (fix_drafts_fragment_names.cjs, which wrote directly via
// Mongo updateOne), this script edits LIVE recipes through the real admin HTTP endpoint
// (PATCH /api/admin/recipes/:id in adminRecipes.ts), per the task instruction — that endpoint
// is _id-preserving (updateOne only, never re-inserts), so meal_plans/recipe_cost recipeId
// references stay valid. It does NOT touch recipe_cost itself; that must be resynced
// separately afterward via POST /api/admin/recompute-costs?write=true (existing, safe,
// full-batch upsert job) — see summary for that follow-up step.
//
// Plan per recipe (see summaries/2026-09-09_live-recipes-fragment-scan-raw.json for full
// pre-edit ingredient lists used to derive this):
//   1. 69b1db92974afef25b93a44d  "a couple of pepper flakes" -> "red pepper flakes"  (rename)
//   2. 69b277e5f9069a06b5536b58  "pcs lemon"                 -> "lemon"               (rename)
//   3. 69c31de2b17f27d65b4f4ec9  "p of pepper"               -> "pepper"              (rename)
//   4. 69b4aeaee736bc836fd51337  "to 5 garlic cloves" (qty 3, unit "") duplicates an existing
//      "garlic cloves" (qty 4, unit "") line in the same recipe. Renaming without merging
//      would leave two identically-named ingredient lines. Plan: MERGE -> single "garlic
//      cloves" line, quantity 3+4=7, unit "". CAVEAT flagged for review, not a pure rename.
//   5. 69b277e5f9069a06b5536b5b  "a onion" -> "onion"  (rename). CAVEAT: this line is
//      CURRENTLY priceable (100% coverage) because "a onion" exact-matches the quarantined
//      canonical_ingredients doc of the same (garbage) name. Renaming to "onion" will make it
//      resolve against the real "onion" canonical entry instead -- price may change (expected
//      to still resolve, likely more accurately, but flagging since it's the one case going
//      from priceable->priceable via a different canonical doc, not unresolved->priceable).
//   6. 69b9587c7d3db8c999c7df7a  "t cream" (qty 1, unit "") -> SPLIT: name "cream", quantity 1,
//      unit "T" (Tablespoon). Justification: sibling line "chives" in the same recipe uses
//      unit "T" for tablespoon, and "t cream" reads as a leaked "T" unit token stuck to the
//      front of "cream" (same fragment pattern as the parser bug in commit 45ed583) -- this is
//      the one genuine quantity/unit-leaked-into-name case in this batch, not a pure rename.
//   7. 69c473017393a7f0235b89b5  "to 4 japanese cucumbers" -> "japanese cucumbers"  (rename)
//   8. 69c473017393a7f0235b89b6  "to 3 chilli padis"       -> "chilli padis"        (rename)
//   9. 69c7275f754babcc25875c8d  "a apple" -> "apple"  (rename)
//  10. 69c7275f754babcc25875c87  "i gem lettuce" -> SKIP. An earlier session's own
//      canonical_ingredients cleanup dry-run (summaries/2026-09-09_skip-list-28-cleanup-dryrun.txt)
//      explicitly judged this string "not confident enough to rename" -- honoring that prior
//      judgment rather than guessing (e.g. "iceberg gem lettuce" vs "gem lettuce" vs "romaine").
//      Left unedited; re-flagged in the summary as still-pending for a future session.
//  11. 69fa56304476f68485ccfcf7  "you can use regular basil" -> "basil"  (rename)
//
// Usage: node scripts/fix_live_recipes_fragment_names.cjs [--write]
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const BASE_URL = "https://uiu-api.codeby-jackie.workers.dev";

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

// action: "rename" (simple name swap), "merge" (fold a fragment line into an existing
// same-name line, summing quantity, then drop the fragment line), "split-unit" (fragment
// name carries a leaked unit token -> rewrite name+unit), "skip" (do not touch).
const PLAN = [
  { id: "69b1db92974afef25b93a44d", action: "rename", from: "a couple of pepper flakes", to: "red pepper flakes" },
  { id: "69b277e5f9069a06b5536b58", action: "rename", from: "pcs lemon", to: "lemon" },
  { id: "69c31de2b17f27d65b4f4ec9", action: "rename", from: "p of pepper", to: "pepper" },
  { id: "69b4aeaee736bc836fd51337", action: "merge", from: "to 5 garlic cloves", mergeInto: "garlic cloves" },
  { id: "69b277e5f9069a06b5536b5b", action: "rename", from: "a onion", to: "onion" },
  { id: "69b9587c7d3db8c999c7df7a", action: "split-unit", from: "t cream", toName: "cream", toUnit: "T" },
  { id: "69c473017393a7f0235b89b5", action: "rename", from: "to 4 japanese cucumbers", to: "japanese cucumbers" },
  { id: "69c473017393a7f0235b89b6", action: "rename", from: "to 3 chilli padis", to: "chilli padis" },
  { id: "69c7275f754babcc25875c8d", action: "rename", from: "a apple", to: "apple" },
  { id: "69c7275f754babcc25875c87", action: "skip", from: "i gem lettuce", reason: "prior session explicitly judged this not confident enough to rename (summaries/2026-09-09_skip-list-28-cleanup-dryrun.txt) -- honoring that judgment, not guessing" },
  { id: "69fa56304476f68485ccfcf7", action: "rename", from: "you can use regular basil", to: "basil" },
];

function buildNewIngredients(action, ingredients) {
  if (action.action === "rename") {
    return ingredients.map((ing) => (ing.name === action.from ? { ...ing, name: action.to } : ing));
  }
  if (action.action === "split-unit") {
    return ingredients.map((ing) => (ing.name === action.from ? { ...ing, name: action.toName, unit: action.toUnit } : ing));
  }
  if (action.action === "merge") {
    const fragLine = ingredients.find((i) => i.name === action.from);
    const targetLine = ingredients.find((i) => i.name === action.mergeInto);
    if (!fragLine || !targetLine) {
      throw new Error(`merge plan for "${action.from}" expected both "${action.from}" and "${action.mergeInto}" lines to exist`);
    }
    const mergedQty = (fragLine.quantity || 0) + (targetLine.quantity || 0);
    return ingredients
      .filter((i) => i !== fragLine)
      .map((i) => (i === targetLine ? { ...i, quantity: mergedQty } : i));
  }
  throw new Error(`unknown action ${action.action}`);
}

async function main() {
  const env = loadDevVars();
  const token = env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN missing from .dev.vars");
  console.log(`Mode: ${WRITE ? "WRITE (--write passed, will call PATCH)" : "DRY RUN (pass --write to commit)"}`);

  const results = [];
  for (const action of PLAN) {
    if (action.action === "skip") {
      console.log(`\nSKIP ${action.id}: "${action.from}" -- ${action.reason}`);
      results.push({ _id: action.id, action: "skip", from: action.from, reason: action.reason });
      continue;
    }

    const getRes = await fetch(`${BASE_URL}/api/admin/recipes/${action.id}`, {
      headers: { "X-Admin-Token": token },
    });
    if (!getRes.ok) {
      console.log(`ERROR ${action.id}: GET failed with ${getRes.status}`);
      results.push({ _id: action.id, action: "error", step: "get", status: getRes.status });
      continue;
    }
    const getBody = await getRes.json();
    const recipe = getBody.data;
    if (!recipe || !Array.isArray(recipe.ingredients)) {
      console.log(`ERROR ${action.id}: no ingredients array in fetched recipe`);
      results.push({ _id: action.id, action: "error", step: "get-shape" });
      continue;
    }

    const stillHasFragment = recipe.ingredients.some((i) => i.name === action.from);
    if (!stillHasFragment) {
      console.log(`SKIP ${action.id}: "${action.from}" no longer present (stale plan, recipe changed since scan) -- not touching`);
      results.push({ _id: action.id, action: "skip-stale", from: action.from });
      continue;
    }

    const beforeNames = recipe.ingredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`.trim());
    const newIngredients = buildNewIngredients(action, recipe.ingredients);
    const afterNames = newIngredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`.trim());

    console.log(`\n${action.action.toUpperCase()} ${action.id} "${recipe.title}"`);
    console.log(`  before: ${JSON.stringify(beforeNames)}`);
    console.log(`  after:  ${JSON.stringify(afterNames)}`);

    results.push({ _id: action.id, action: action.action, title: recipe.title, beforeNames, afterNames });

    if (WRITE) {
      const patchRes = await fetch(`${BASE_URL}/api/admin/recipes/${action.id}`, {
        method: "PATCH",
        headers: { "X-Admin-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients: newIngredients }),
      });
      const patchBody = await patchRes.json().catch(() => null);
      console.log(`  PATCH -> ${patchRes.status} ${patchRes.ok ? "OK" : "FAILED"} ${patchRes.ok ? "" : JSON.stringify(patchBody)}`);
      results[results.length - 1].patchStatus = patchRes.status;
      results[results.length - 1].patchOk = patchRes.ok;
    }
  }

  const summary = {
    fixed: results.filter((r) => r.action === "rename" || r.action === "merge" || r.action === "split-unit").length,
    skipped: results.filter((r) => r.action === "skip" || r.action === "skip-stale").length,
    errors: results.filter((r) => r.action === "error").length,
  };
  console.log(`\n=== Summary: ${summary.fixed} ${WRITE ? "fixed" : "planned"}, ${summary.skipped} skipped, ${summary.errors} errors ===`);

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", `2026-09-09_live-recipes-fragment-fix-${WRITE ? "write" : "dryrun"}.json`),
    JSON.stringify({ mode: WRITE ? "write" : "dryrun", ranAt: new Date().toISOString(), summary, results }, null, 2)
  );
}

main();
