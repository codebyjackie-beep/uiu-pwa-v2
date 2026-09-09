// cc_prompt_tablespoon_teaspoon_case_bug.md (2026-09-09) -- unit-test-style verification for
// the classifyUnit() T/t case-sensitivity fix in recipeCost.ts. No test framework is wired
// into this app (build = tsc --noEmit only), so this runs directly via `npx tsx` and asserts
// against the real exported function -- not a reimplementation, no drift risk.
import { classifyUnit } from "../src/services/recipeCost.ts";

type Case = { input: string; expectType: string; expectUnit?: string; expectMl?: number };

const VOLUME_TO_ML: Record<string, number> = {
  tsp: 5, teaspoon: 5, teaspoons: 5, t: 5,
  tbsp: 15, tablespoon: 15, tablespoons: 15, tbs: 15,
};

const cases: Case[] = [
  // The bug's core case: bare uppercase T must resolve to tablespoon (15ml), not teaspoon.
  { input: "T", expectType: "volume", expectUnit: "tbsp", expectMl: 15 },
  { input: "t", expectType: "volume", expectUnit: "t", expectMl: 5 },
  // Must not regress already-correct longer forms (never collided in the first place).
  { input: "Tbsp", expectType: "volume", expectUnit: "tbsp", expectMl: 15 },
  { input: "tbsp", expectType: "volume", expectUnit: "tbsp", expectMl: 15 },
  { input: "TABLESPOON", expectType: "volume", expectUnit: "tablespoon", expectMl: 15 },
  { input: "Tablespoon", expectType: "volume", expectUnit: "tablespoon", expectMl: 15 },
  { input: "teaspoon", expectType: "volume", expectUnit: "teaspoon", expectMl: 5 },
  { input: "Teaspoon", expectType: "volume", expectUnit: "teaspoon", expectMl: 5 },
  // Descriptor-noise stripping around the ambiguous letter must still work.
  { input: "T, packed", expectType: "volume", expectUnit: "tbsp", expectMl: 15 },
  { input: "t (heaping)", expectType: "volume", expectUnit: "t", expectMl: 5 },
  // Case-insensitivity for cup ("C") is unaffected -- only t/T was ever ambiguous.
  { input: "C", expectType: "volume", expectUnit: "c" },
];

let failures = 0;
for (const c of cases) {
  const result = classifyUnit(c.input);
  const ok =
    result.type === c.expectType &&
    (c.expectUnit === undefined || (result as any).unit === c.expectUnit) &&
    (c.expectMl === undefined || VOLUME_TO_ML[(result as any).unit] === c.expectMl);
  console.log(`${ok ? "PASS" : "FAIL"}  classifyUnit(${JSON.stringify(c.input)}) -> ${JSON.stringify(result)}`);
  if (!ok) failures++;
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
