// npx tsx src/jobs/dailyRecipeDraftOutcome.test.ts — dailyRecipeDraft cron_run_log classification + refill limits
import {
  ATTEMPT_WORST_CASE,
  buildRefillSpecs,
  classifyDraftRun,
  emptyStats,
  MAX_REFILL_ROUNDS,
  MAX_REFILL_SPECS,
  PEXELS_RESERVE,
  recordError,
  refillCount,
  SUBREQUEST_BUDGET,
  SubrequestBudget,
} from "./dailyRecipeDraftOutcome";

let fail = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
};
const has = (label: string, s: string | undefined, needle: string) => eq(`${label} contains "${needle}"`, Boolean(s && s.includes(needle)), true);

// --- 11-23 07:00 scenario: 6 idea skips (exact/substring) + 2 same-dish, 0 created, no API errors ---
{
  const stats = emptyStats();
  stats.ideaSkips.exact = 4;
  stats.ideaSkips.substring = 2;
  stats.draftSkips.same_dish = 2;
  const r = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("all-deduped → ok", r.ok, true);
  eq("all-deduped → reason", r.reason, "all_deduped");
  eq("all-deduped → no errorMessage", r.errorMessage, undefined);
  has("all-deduped note", r.note, "skippedDuplicates 8");
  has("all-deduped note", r.note, "idea exact 4");
  has("all-deduped note", r.note, "idea substring 2");
  has("all-deduped note", r.note, "drafted same_dish 2");
  eq("all-deduped detail.skippedDuplicates", r.detail?.skippedDuplicates, 8);
  eq("no 'check wrangler tail' text", (r.note ?? "").includes("wrangler tail"), false);
}

// --- 0 created + real OpenRouter 402 → ok:false with the HTTP status ---
{
  const stats = emptyStats();
  stats.ideaSkips.exact = 1;
  recordError(stats, "openrouter", new Error("OpenRouter request failed: 402 Payment Required"));
  const r = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("402 → ok", r.ok, false);
  eq("402 → reason", r.reason, "api_error");
  has("402 errorMessage", r.errorMessage, "402 Payment Required");
  has("402 errorMessage", r.errorMessage, "openrouter:");
  has("402 errorMessage keeps dedup counts", r.errorMessage, "idea exact 1");
}

// --- Spoonacular 403 only ---
{
  const stats = emptyStats();
  recordError(stats, "spoonacular", new Error("Spoonacular request failed: 403 Forbidden"));
  const r = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("403 → ok", r.ok, false);
  has("403 errorMessage", r.errorMessage, "spoonacular: Spoonacular request failed: 403 Forbidden");
}

// --- error list is capped, count is not ---
{
  const stats = emptyStats();
  for (let i = 0; i < 9; i++) recordError(stats, "spoonacular", new Error(`fail ${i}`));
  eq("errors kept ≤ 5", stats.errors.length, 5);
  eq("errorCount counts all", stats.errorCount, 9);
}

// --- created > 0 ---
{
  const stats = emptyStats();
  eq("3/3 → created", classifyDraftRun({ created: 3, target: 3, alreadyCompletedToday: false, stats }).reason, "created");
  recordError(stats, "openrouter", new Error("OpenRouter request failed: 500"));
  const p = classifyDraftRun({ created: 1, target: 3, alreadyCompletedToday: false, stats });
  eq("1/3 with error → ok", p.ok, true);
  eq("1/3 → partial", p.reason, "partial");
  has("partial note", p.note, "created 1/3");
}

// --- already completed / nothing to do ---
eq("alreadyCompletedToday → ok", classifyDraftRun({ created: 0, target: 0, alreadyCompletedToday: true, stats: emptyStats() }).ok, true);
eq("target 0 → nothing_to_do", classifyDraftRun({ created: 0, target: 0, alreadyCompletedToday: false, stats: emptyStats() }).reason, "nothing_to_do");

// --- 0 created, no dedup, no error (Spoonacular returned nothing) → ok:false no_candidates ---
{
  const stats = emptyStats();
  stats.emptyIdeaBatches = 9;
  const r = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("no candidates → ok", r.ok, false);
  eq("no candidates → reason", r.reason, "no_candidates");
}

// --- same-dish check failures (draft kept) never count as run errors ---
{
  const stats = emptyStats();
  stats.sameDishCheckErrors = 3;
  stats.draftSkips.near_duplicate = 2;
  eq("sameDishCheckErrors alone → all_deduped", classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats }).reason, "all_deduped");
}

// --- budget + refill limits ---
{
  const b = new SubrequestBudget();
  eq("budget limit constant", b.limit, SUBREQUEST_BUDGET);
  eq("fresh budget can attempt", b.canAttempt(), true);
  b.charge(SUBREQUEST_BUDGET - ATTEMPT_WORST_CASE - PEXELS_RESERVE);
  eq("exactly one worst-case attempt left", b.canAttempt(), true);
  b.charge(1);
  eq("one short → cannot attempt", b.canAttempt(), false);

  const fresh = () => new SubrequestBudget();
  eq("refill: missing 3 → 3", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh() }), 3);
  eq("refill: missing 1 → 1", refillCount({ target: 3, created: 2, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh() }), 1);
  eq("refill: target met → 0", refillCount({ target: 3, created: 3, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh() }), 0);
  eq("refill: max rounds → 0", refillCount({ target: 3, created: 0, roundsDone: MAX_REFILL_ROUNDS, refillSpecsSoFar: 0, budget: fresh() }), 0);
  eq("refill: spec cap trims", refillCount({ target: 3, created: 0, roundsDone: 1, refillSpecsSoFar: MAX_REFILL_SPECS - 1, budget: fresh() }), 1);
  eq("refill: spec cap reached → 0", refillCount({ target: 3, created: 0, roundsDone: 1, refillSpecsSoFar: MAX_REFILL_SPECS, budget: fresh() }), 0);
  eq("refill: budget gone → 0", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: b }), 0);

  // Simulate the loop as dailyRecipeDraft runs it, with every attempt deduped (worst cost):
  // it must stop, and never exceed SUBREQUEST_BUDGET.
  const sim = new SubrequestBudget();
  let rounds = 0, refillSpecs = 0, attempts = 0;
  const runSpec = () => { for (let a = 0; a < 3 && sim.canAttempt(); a++) { sim.charge(ATTEMPT_WORST_CASE); attempts++; } };
  for (let i = 0; i < 3; i++) runSpec();
  for (let guard = 0; guard < 100; guard++) {
    const n = refillCount({ target: 3, created: 0, roundsDone: rounds, refillSpecsSoFar: refillSpecs, budget: sim });
    if (n === 0) break;
    rounds++; refillSpecs += n;
    for (let i = 0; i < n; i++) runSpec();
  }
  eq("sim: never over budget", sim.used <= SUBREQUEST_BUDGET, true);
  eq("sim: rounds ≤ max", rounds <= MAX_REFILL_ROUNDS, true);
  eq("sim: worst case attempts bounded (= pre-existing 9)", attempts, 9);

  // Cheap dedup (idea-only skips cost just the Spoonacular call): refill does get budget.
  const cheap = new SubrequestBudget();
  for (let i = 0; i < 9; i++) cheap.charge(2);
  eq("cheap dedup leaves room for refill", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: cheap }), 3);
}

// --- refill specs continue the rotation, differ from the day's lockstep pairs ---
{
  const cuisines = ["a", "b", "c", "d", "e"];
  const diets = ["x", "y", "z", "w"];
  const specs = buildRefillSpecs(cuisines, diets, 0, 0, 3, 2);
  eq("refill specs", specs, [
    { kind: "rotation", cuisine: "e", diet: "x" },
    { kind: "rotation", cuisine: "a", diet: "w" },
  ]);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
if (fail) throw new Error(`${fail} failed`);
