// Regression test for the gap-aware daily recipe draft agent's pure logic
// (HANDOFF_daily-recipe-draft-agent.md + gap-aware addendum, 2026-07-30/31):
// computeGapMatrix, selectPriorityGapTargets, buildIdeaSpecs (5:15 quota +
// rotation cycling), and isTooSimilarTitle dedup. DB-touching functions
// (readDraftState/writeDraftState/fetchExistingTitles) are exercised
// separately against the real DB per the acceptance criteria, not here.
//
// Usage: node apps/api/scripts/test_recipe_draft_gap_rotation.mjs
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");

async function bundleService(entry, outname) {
  const outfile = path.join(apiRoot, "scripts", outname);
  await build({
    entryPoints: [path.join(apiRoot, "src/services", entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["mongodb"],
    logLevel: "silent",
  });
  return outfile;
}

function makeRecipe(id, mealSlots, overrides = {}) {
  return {
    id,
    title: `Recipe ${id}`,
    imageUrl: "",
    servings: 2,
    tags: [],
    cuisineType: null,
    ingredientNames: ["rice", "water"],
    cookMinutes: 15,
    calories: 400,
    protein: 10,
    costPerServing: 2,
    mealSlots: new Set(mealSlots),
    ...overrides,
  };
}

async function main() {
  const genFile = await bundleService("recipeDraftGenerator.ts", ".tmp-recipe-draft-gen-test.mjs");
  const gen = await import(`file://${genFile.replace(/\\/g, "/")}?t=${Date.now()}`);
  const { computeGapMatrix, selectPriorityGapTargets, buildIdeaSpecs, isTooSimilarTitle, ROTATION_CUISINES, ROTATION_DIETS } = gen;

  let failed = false;

  // --- Case A: computeGapMatrix produces exactly 40 cells (4 slots x 10 dietary keys). ---
  console.log("=== Case A: computeGapMatrix shape (4 slots x 10 dietary keys = 40 cells) ===");
  const pool = [
    makeRecipe("breakfast-only", ["breakfast"]),
    makeRecipe("lunch-dinner", ["lunch", "dinner"]),
    makeRecipe("all-slots", ["breakfast", "lunch", "dinner", "snack"]),
  ];
  const matrix = computeGapMatrix(pool);
  const caseAOk = matrix.length === 40;
  console.log(`  cells=${matrix.length} ${caseAOk ? "OK" : "FAIL"}`);
  if (!caseAOk) { failed = true; console.log("  CASE A: FAIL"); } else { console.log("  CASE A: PASS"); }

  // --- Case B: a deliberately narrow pool (1 eligible recipe for one specific
  // slot/dietary combo, per the 2026-07-30 breakfast-collapse diagnostic that
  // motivated the addendum) must surface that combo as a priority gap target. ---
  console.log("\n=== Case B: narrow combo (count=1) surfaces as a priority gap target ===");
  const narrowPool = [
    makeRecipe("narrow", ["breakfast"], { tags: ["gluten-free"] }), // will only match if DIETARY_FILTERS keys line up; count is what matters, not the label
    ...Array.from({ length: 30 }, (_, i) => makeRecipe(`wide-${i}`, ["breakfast", "lunch", "dinner", "snack"])),
  ];
  const narrowMatrix = computeGapMatrix(narrowPool);
  const minCount = Math.min(...narrowMatrix.map((c) => c.count));
  const targets = selectPriorityGapTargets(narrowMatrix, 5);
  const caseBOk = targets.length >= 5 && targets.every((t) => t.count <= targets[targets.length - 1].count) && targets[0].count === minCount;
  console.log(`  minCount=${minCount}, targets=${targets.length}, targets[0].count=${targets[0]?.count}`);
  if (!caseBOk) { failed = true; console.log("  CASE B: FAIL"); } else { console.log("  CASE B: PASS"); }

  // --- Case C: selectPriorityGapTargets ties-at-boundary — if the 5th and 6th
  // lowest counts are equal, both must be included (no arbitrary cut to exactly 5). ---
  console.log("\n=== Case C: ties at the 5th-place boundary all qualify ===");
  const tiedMatrix = [
    { slot: "breakfast", dietary: "a", count: 0 },
    { slot: "breakfast", dietary: "b", count: 1 },
    { slot: "breakfast", dietary: "c", count: 2 },
    { slot: "breakfast", dietary: "d", count: 3 },
    { slot: "breakfast", dietary: "e", count: 4 },
    { slot: "breakfast", dietary: "f", count: 4 }, // tied with e at boundary
    { slot: "breakfast", dietary: "g", count: 5 },
  ];
  const tiedTargets = selectPriorityGapTargets(tiedMatrix, 5);
  const caseCOk = tiedTargets.length === 6 && tiedTargets.some((t) => t.dietary === "f");
  console.log(`  selected=${tiedTargets.length} (expected 6, including tied "f") ${caseCOk ? "OK" : "FAIL"}`);
  if (!caseCOk) { failed = true; console.log("  CASE C: FAIL"); } else { console.log("  CASE C: PASS"); }

  // --- Case D: buildIdeaSpecs quota split — exactly 5 gap specs + 15 rotation
  // specs = 20 total, and rotation indices advance from the given state. ---
  console.log("\n=== Case D: buildIdeaSpecs 5:15 quota split + rotation index advance ===");
  const priorityTargets5 = tiedMatrix.slice(0, 5); // 5 entries, no ties triggered here
  const state0 = { lastCuisineIndex: -1, lastDietIndex: -1, gapTargetHistory: [] };
  const { specs, nextState, draftedTargets } = buildIdeaSpecs(priorityTargets5, state0);
  const gapSpecs = specs.filter((s) => s.kind === "gap");
  const rotationSpecs = specs.filter((s) => s.kind === "rotation");
  const caseDOk =
    specs.length === 20 &&
    gapSpecs.length === 5 &&
    rotationSpecs.length === 15 &&
    draftedTargets.length === 5 &&
    nextState.lastCuisineIndex === (14) % ROTATION_CUISINES.length && // advanced 15 times from -1: (-1+15) % 15 = 14
    nextState.lastDietIndex === (14) % ROTATION_DIETS.length; // (-1+15) % 10 = 4... check below instead of hardcoding
  console.log(`  total=${specs.length} gap=${gapSpecs.length} rotation=${rotationSpecs.length} nextCuisineIdx=${nextState.lastCuisineIndex} nextDietIdx=${nextState.lastDietIndex}`);
  const expectedCuisineIdx = (state0.lastCuisineIndex + 15) % ROTATION_CUISINES.length;
  const expectedDietIdx = (state0.lastDietIndex + 15) % ROTATION_DIETS.length;
  const caseDOk2 =
    specs.length === 20 && gapSpecs.length === 5 && rotationSpecs.length === 15 && draftedTargets.length === 5 &&
    nextState.lastCuisineIndex === expectedCuisineIdx && nextState.lastDietIndex === expectedDietIdx;
  if (!caseDOk2) { failed = true; console.log("  CASE D: FAIL"); } else { console.log("  CASE D: PASS"); }

  // --- Case D2: a second call starting from nextState must advance further
  // still (proves rotation state actually changes call-over-call, not just
  // that it looks non-default once — direct guard against the "Max pillar
  // rotation never actually rotated" class of bug at the pure-logic level). ---
  console.log("\n=== Case D2: rotation indices keep advancing on a second call ===");
  const second = buildIdeaSpecs(priorityTargets5, nextState);
  const caseD2Ok = second.nextState.lastCuisineIndex !== nextState.lastCuisineIndex || second.nextState.lastDietIndex !== nextState.lastDietIndex;
  console.log(`  round1 cuisineIdx=${nextState.lastCuisineIndex} round2 cuisineIdx=${second.nextState.lastCuisineIndex} ${caseD2Ok ? "OK" : "FAIL"}`);
  if (!caseD2Ok) { failed = true; console.log("  CASE D2: FAIL"); } else { console.log("  CASE D2: PASS"); }

  // --- Case E: isTooSimilarTitle dedup — exact match (case-insensitive) and
  // substring both directions should flag; genuinely distinct titles should not. ---
  console.log("\n=== Case E: isTooSimilarTitle dedup ===");
  const existing = ["Spicy Miso Ramen Bowl", "Classic Beef Lasagna"];
  const dupExact = isTooSimilarTitle("spicy miso ramen bowl", existing);
  const dupSubstring = isTooSimilarTitle("Spicy Miso Ramen Bowl with Extra Egg", existing);
  const notDup = isTooSimilarTitle("Grilled Peach Salad", existing);
  console.log(`  exact-match dup: ${dupExact} (expected true)`);
  console.log(`  substring dup: ${dupSubstring} (expected true)`);
  console.log(`  distinct title: ${notDup} (expected false)`);
  const caseEOk = dupExact === true && dupSubstring === true && notDup === false;
  if (!caseEOk) { failed = true; console.log("  CASE E: FAIL"); } else { console.log("  CASE E: PASS"); }

  fs.unlinkSync(genFile);
  if (failed) {
    console.log("\nOVERALL: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nOVERALL: PASS");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
