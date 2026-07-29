// Deliberate regression case for the 2026-07-29 ALLERGEN_KEYWORDS French
// expansion, covering both French-ingredient recipes found by
// audit_ingredient_language.cjs.
//
// CORRECTION vs. the original ask: the two French recipes were originally
// both described as containing "farine de blé" text. On direct inspection
// of the raw ingredients, only "Instant Noodles Onion Chicken Flavor"
// (_id 69b4a8c564f3ba3a3aebef0b) actually contains wheat flour
// ("farine de blé"). "Roast chicken & caramelised onion"
// (_id 69b4a8c564f3ba3a3aebef07) is potatoes/oil/sugar/salt/onion
// powder/garlic powder/spices — no cereal ingredient at all — so it is
// correctly NOT excluded by cereals_gluten, before or after this change.
// This script checks both, so the "excluded" claim is proven against the
// recipe that actually contains the allergen, not asserted against the
// wrong one.
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");

function loadDevVars() {
  const p = path.join(apiRoot, ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const outfile = path.join(apiRoot, "scripts", ".tmp-cereals-gluten-test.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/services/mealPlanGenerator.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["mongodb"],
    logLevel: "silent",
  });
  const { buildPool, ALLERGEN_KEYWORDS } = await import(`file://${outfile.replace(/\\/g, "/")}?t=${Date.now()}`);

  const env = loadDevVars();
  const pool = await buildPool(env);
  const forbidden = ALLERGEN_KEYWORDS.cereals_gluten;
  console.log("=== ALLERGEN_KEYWORDS.cereals_gluten ===");
  console.log(JSON.stringify(forbidden));

  const cases = [
    { id: "69b4a8c564f3ba3a3aebef0b", title: "Instant Noodles Onion Chicken Flavor", expectExcluded: true },
    { id: "69b4a8c564f3ba3a3aebef07", title: "Roast chicken & caramelised onion", expectExcluded: false },
  ];

  let ok = true;
  for (const c of cases) {
    const target = pool.find((r) => r.id === c.id);
    const hits = target.ingredientNames.filter((n) => forbidden.some((k) => n.includes(k)));
    const excluded = hits.length > 0;
    console.log(`\n=== ${c.title} (${c.id}) ===`);
    console.log(`  ingredientNames: ${JSON.stringify(target.ingredientNames)}`);
    console.log(`  matched ingredient lines: ${JSON.stringify(hits)}`);
    console.log(`  cereals_gluten filter would exclude this recipe: ${excluded} (expected: ${c.expectExcluded})`);
    if (excluded !== c.expectExcluded) {
      ok = false;
      console.error(`  FAIL: expected excluded=${c.expectExcluded}, got ${excluded}`);
    }
  }

  console.log(
    ok
      ? "\nPASS: the recipe that actually contains wheat (\"farine de blé\") is now correctly excluded by cereals_gluten " +
        "(previously a false negative with English-only keywords); the recipe with no cereal ingredient is correctly left alone."
      : "\nFAIL: see above.",
  );
  if (!ok) process.exitCode = 1;

  fs.unlinkSync(outfile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
