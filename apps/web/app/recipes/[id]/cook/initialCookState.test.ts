/**
 * 2026-10-08 resume-bug fix verification — standalone assertion script (same no-framework
 * pattern as timer.test.ts). Run with:
 *   npx tsx "apps/web/app/recipes/[id]/cook/initialCookState.test.ts"
 */
import { initialCookState, type InitialCookState } from "./CookMode";

interface Case {
  label: string;
  saved: { done: number[]; current: number } | null;
  stepCount: number;
  expected: InitialCookState;
}

const cases: Case[] = [
  {
    label: "no saved progress at all",
    saved: null,
    stepCount: 5,
    expected: { resumeChoice: "resolved", savedProgress: null },
  },
  {
    label: "done has entries",
    saved: { done: [0, 1], current: 2 },
    stepCount: 5,
    expected: { resumeChoice: "prompt", savedProgress: { current: 2, done: [0, 1] } },
  },
  {
    label: "only current > 0, no done entries (Next pressed without ticking)",
    saved: { done: [], current: 2 },
    stepCount: 5,
    expected: { resumeChoice: "prompt", savedProgress: { current: 2, done: [] } },
  },
  {
    label: "current out of range (steps shrank since saving) — no resume offered",
    saved: { done: [1], current: 99 },
    stepCount: 5,
    expected: { resumeChoice: "resolved", savedProgress: null },
  },
  {
    label: "done contains an out-of-range index — filtered, still resumable",
    saved: { done: [0, 10, -1], current: 0 },
    stepCount: 5,
    expected: { resumeChoice: "prompt", savedProgress: { current: 0, done: [0] } },
  },
  {
    label: "everything done (done covers all valid indices)",
    saved: { done: [0, 1, 2, 3, 4], current: 4 },
    stepCount: 5,
    expected: { resumeChoice: "prompt", savedProgress: { current: 4, done: [0, 1, 2, 3, 4] } },
  },
  {
    label: "current at 0 with no done entries — nothing to resume, no false prompt",
    saved: { done: [], current: 0 },
    stepCount: 5,
    expected: { resumeChoice: "resolved", savedProgress: null },
  },
];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let failed = 0;
for (const { label, saved, stepCount, expected } of cases) {
  const actual = initialCookState(saved, stepCount);
  const pass = deepEqual(actual, expected);
  if (!pass) failed++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label} => ${JSON.stringify(actual)}  (expected ${JSON.stringify(expected)})`,
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
