// cc_prompt_fragment_guard_instruction_text_gap.md (2026-09-09) -- removes the one known
// live instance of a whole instruction sentence leaked into an ingredient name:
// recipe 69b277e5f9069a06b5536b58 "Chicken Arrozcaldo", line
// { name: "add chicken and stir until it melts", quantity: 1, unit: "cube" }.
// Not a rename -- there's no real ingredient this maps to; it's pure instruction text, and
// the recipe already has a separate correct "chicken cube" (qty 1, unit "piece") line. The
// recipe_cost line for it was already priceable:false, reason:"unresolved" (verified via
// scan), so removal only helps coverage, doesn't drop priced data.
//
// Uses the real admin HTTP endpoint (PATCH /api/admin/recipes/:id in adminRecipes.ts),
// _id-preserving, same pattern as fix_live_recipes_fragment_names.cjs.
//
// Usage: node scripts/fix_instruction_text_ingredient.cjs [--write]
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const BASE_URL = "https://uiu-api.codeby-jackie.workers.dev";
const RECIPE_ID = "69b277e5f9069a06b5536b58";
const FRAGMENT_NAME = "add chicken and stir until it melts";

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

async function main() {
  const env = loadDevVars();
  const token = env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN missing from .dev.vars");
  console.log(`Mode: ${WRITE ? "WRITE (--write passed, will call PATCH)" : "DRY RUN (pass --write to commit)"}`);

  const getRes = await fetch(`${BASE_URL}/api/admin/recipes/${RECIPE_ID}`, {
    headers: { "X-Admin-Token": token },
  });
  if (!getRes.ok) throw new Error(`GET failed with ${getRes.status}`);
  const getBody = await getRes.json();
  const recipe = getBody.data;

  const stillHasFragment = recipe.ingredients.some((i) => i.name === FRAGMENT_NAME);
  if (!stillHasFragment) {
    console.log(`SKIP: "${FRAGMENT_NAME}" no longer present (stale plan) -- not touching`);
    return;
  }

  const beforeNames = recipe.ingredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`.trim());
  const newIngredients = recipe.ingredients.filter((i) => i.name !== FRAGMENT_NAME);
  const afterNames = newIngredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`.trim());

  console.log(`\nREMOVE from ${RECIPE_ID} "${recipe.title}"`);
  console.log(`  before: ${JSON.stringify(beforeNames)}`);
  console.log(`  after:  ${JSON.stringify(afterNames)}`);

  const result = { _id: RECIPE_ID, title: recipe.title, beforeNames, afterNames };

  if (WRITE) {
    const patchRes = await fetch(`${BASE_URL}/api/admin/recipes/${RECIPE_ID}`, {
      method: "PATCH",
      headers: { "X-Admin-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ ingredients: newIngredients }),
    });
    const patchBody = await patchRes.json().catch(() => null);
    console.log(`  PATCH -> ${patchRes.status} ${patchRes.ok ? "OK" : "FAILED"} ${patchRes.ok ? "" : JSON.stringify(patchBody)}`);
    result.patchStatus = patchRes.status;
    result.patchOk = patchRes.ok;
  }

  fs.writeFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "summaries", `2026-09-09_instruction-text-fix-${WRITE ? "write" : "dryrun"}.json`),
    JSON.stringify({ mode: WRITE ? "write" : "dryrun", ranAt: new Date().toISOString(), result }, null, 2)
  );
}

main();
