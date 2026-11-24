// npx tsx src/jobs/dailyRecipeDraftOutcome.test.ts — dailyRecipeDraft cron_run_log classification + refill limits
import {
  ATTEMPT_WORST_CASE,
  buildRefillSpecs,
  classifyDraftRun,
  emptyStats,
  MAX_REFILL_ROUNDS,
  MAX_REFILL_SPECS,
  PEXELS_RESERVE,
  INVOCATION_SUBREQUEST_CAP,
  INVOCATION_SAFETY_MARGIN,
  isModelOutputError,
  recordError,
  refillCount,
  SUBREQUEST_BUDGET,
  SubrequestBudget,
  TRIAGE_FIXED_COST,
  TRIAGE_PER_ITEM_WORST_CASE,
  triageItemLimit,
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
  has("all-deduped note", r.note, "dedupSkips 8");
  has("all-deduped note", r.note, "idea exact 4");
  has("all-deduped note", r.note, "idea substring 2");
  has("all-deduped note", r.note, "drafted same_dish 2");
  eq("all-deduped detail.dedupSkips", r.detail?.dedupSkips, 8);
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
  eq("refill: missing 3 → 3", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh(), apiErrorCount: 0 }), 3);
  eq("refill: missing 1 → 1", refillCount({ target: 3, created: 2, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh(), apiErrorCount: 0 }), 1);
  eq("refill: target met → 0", refillCount({ target: 3, created: 3, roundsDone: 0, refillSpecsSoFar: 0, budget: fresh(), apiErrorCount: 0 }), 0);
  eq("refill: max rounds → 0", refillCount({ target: 3, created: 0, roundsDone: MAX_REFILL_ROUNDS, refillSpecsSoFar: 0, budget: fresh(), apiErrorCount: 0 }), 0);
  eq("refill: spec cap trims", refillCount({ target: 3, created: 0, roundsDone: 1, refillSpecsSoFar: MAX_REFILL_SPECS - 1, budget: fresh(), apiErrorCount: 0 }), 1);
  eq("refill: spec cap reached → 0", refillCount({ target: 3, created: 0, roundsDone: 1, refillSpecsSoFar: MAX_REFILL_SPECS, budget: fresh(), apiErrorCount: 0 }), 0);
  eq("refill: budget gone → 0", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: b, apiErrorCount: 0 }), 0);

  // Simulate the loop as dailyRecipeDraft runs it, with every attempt deduped (worst cost):
  // it must stop, and never exceed SUBREQUEST_BUDGET.
  const sim = new SubrequestBudget();
  let rounds = 0, refillSpecs = 0, attempts = 0;
  const runSpec = () => { for (let a = 0; a < 3 && sim.canAttempt(); a++) { sim.charge(ATTEMPT_WORST_CASE); attempts++; } };
  for (let i = 0; i < 3; i++) runSpec();
  for (let guard = 0; guard < 100; guard++) {
    const n = refillCount({ target: 3, created: 0, roundsDone: rounds, refillSpecsSoFar: refillSpecs, budget: sim, apiErrorCount: 0 });
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
  eq("cheap dedup leaves room for refill", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: cheap, apiErrorCount: 0 }), 3);
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

// --- B: no refill after an API error ---
eq("refill: api error → 0", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: new SubrequestBudget(), apiErrorCount: 1 }), 0);

// --- E: model-output errors are not API errors ---
{
  eq("isModelOutputError: no content", isModelOutputError(new Error("OpenRouter response had no message content")), true);
  eq("isModelOutputError: bad shape", isModelOutputError(new Error("OpenRouter response did not match the expected Recipe shape")), true);
  eq("isModelOutputError: content not JSON", isModelOutputError(new Error("OpenRouter response content was not valid JSON")), true);
  eq("isModelOutputError: bare SyntaxError (res.json on HTML body) is API", isModelOutputError(new SyntaxError("Unexpected token '<'")), false);
  eq("isModelOutputError: 402 is API", isModelOutputError(new Error("OpenRouter request failed: 402")), false);
  eq("isModelOutputError: Spoonacular 403 is API", isModelOutputError(new Error("Spoonacular request failed: 403")), false);
  const stats = emptyStats();
  recordError(stats, "openrouter", new Error("OpenRouter response did not match the expected Recipe shape"));
  recordError(stats, "openrouter", new Error("OpenRouter response content was not valid JSON"));
  eq("model errors not in errorCount", stats.errorCount, 0);
  eq("modelOutputErrors counted", stats.modelOutputErrors, 2);
  const m = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("only model errors, 0 dedup → ok:false", m.ok, false);
  eq("only model errors, 0 dedup → model_output_error", m.reason, "model_output_error");
  has("model_output_error errorMessage", m.errorMessage, "model output errors 2");
  stats.draftSkips.same_dish = 1;
  const r = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats });
  eq("model errors + dedup → ok", r.ok, true);
  eq("model errors + dedup → all_dropped", r.reason, "all_dropped");
  has("all_dropped note", r.note, "model output errors 2");
  const s2 = emptyStats();
  recordError(s2, "spoonacular", new SyntaxError("Unexpected token '<'"));
  eq("res.json SyntaxError → errorCount", s2.errorCount, 1);
  eq("res.json SyntaxError → api_error", classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats: s2 }).reason, "api_error");
  eq("model errors don't block refill", refillCount({ target: 3, created: 0, roundsDone: 0, refillSpecsSoFar: 0, budget: new SubrequestBudget(), apiErrorCount: stats.errorCount }), 3);
  recordError(stats, "openrouter", new Error("OpenRouter request failed: 429"));
  eq("model + API error → api_error", classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats }).reason, "api_error");
}

// --- C: detail carries day/refill split ---
{
  const stats = emptyStats();
  stats.ideaSkips.exact = 1; stats.daySpecsSkipped = 3; stats.refillSpecsSkipped = 2;
  const d = classifyDraftRun({ created: 0, target: 3, alreadyCompletedToday: false, stats }).detail;
  eq("detail.daySpecsSkipped", d?.daySpecsSkipped, 3);
  eq("detail.refillSpecsSkipped", d?.refillSpecsSkipped, 2);
}

// --- A: triage gets only what the draft job left of the 50 cap ---
{
  const per = TRIAGE_PER_ITEM_WORST_CASE;
  const fixed = INVOCATION_SAFETY_MARGIN + TRIAGE_FIXED_COST;
  eq("triage: draft used 0 → capped at max 10", triageItemLimit(0, 10), Math.min(10, Math.floor((INVOCATION_SUBREQUEST_CAP - fixed) / per)));
  eq("triage per-item worst case = 6", per, 6);
  eq("triage: draft used 0 → 7", triageItemLimit(0, 10), 7);
  eq("triage: Rex counterexample draft 4 → 6 (4+36+1=41)", triageItemLimit(4, 10), 6);
  eq("triage: draft used 15 → 4", triageItemLimit(15, 10), 4);
  eq("triage: draft used full 39 → 0 (skip)", triageItemLimit(SUBREQUEST_BUDGET, 10), 0);
  for (let used = 0; used <= SUBREQUEST_BUDGET; used++) {
    const n = triageItemLimit(used, 10);
    if (used + TRIAGE_FIXED_COST + n * per > INVOCATION_SUBREQUEST_CAP - INVOCATION_SAFETY_MARGIN) eq(`triage: total under cap at used=${used}`, false, true);
  }
  eq("triage: total under cap for all draft spends", true, true);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
if (fail) throw new Error(`${fail} failed`);
