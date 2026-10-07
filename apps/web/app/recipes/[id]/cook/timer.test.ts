/**
 * cc_prompt_recipe-list-redesign-and-cook-mode.md verification requirement — standalone
 * assertion script (no vitest/jest in this repo; not adding one just for this). Run with:
 *   npx tsx "apps/web/app/recipes/[id]/cook/timer.test.ts"
 */
import { extractTimerSeconds } from "./timer";

const cases: Array<[string, number | null]> = [
  ["Simmer for 5 minutes", 300],
  ["Bake for 1 hour", 3600],
  ["Cook for 10-15 minutes until golden", 600],
  ["Rest for about 30 secs", 30],
  ["Roast for 2 hrs 30 mins", 9000],
  ["Add salt and pepper to taste", null],
  ["Marinate for 10 to 15 minutes", 600],
  ["Boil for 1 minute", 60],
  ["Let stand for 45 seconds", 45],
  ["Preheat oven and bake for 20 min", 1200],
  ["Chill in the fridge overnight", null],
  ["Simmer 2-3 mins", 120],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = extractTimerSeconds(input);
  const pass = actual === expected;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  extractTimerSeconds(${JSON.stringify(input)}) = ${actual}  (expected ${expected})`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
