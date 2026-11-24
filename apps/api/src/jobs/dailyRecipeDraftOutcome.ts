/**
 * Pure helpers for dailyRecipeDraft (no Mongo / fetch imports, so the .test.ts runs under plain tsx):
 * - DraftRunStats: why candidates were dropped (dedup rule counts) and real API errors, kept apart.
 * - SubrequestBudget + buildRefillSpecs: bounded "refill" of ideas when dedup eats the day's specs.
 * - classifyDraftRun: turns a run into the cron_run_log { ok, reason, errorMessage/note } record.
 *
 * 2026-11-22/23: 3 specs attempted, 0 created, every candidate dropped by dedup — logged as
 * ok:false "check wrangler tail" with no reason. All-dedup is now ok:true reason "all_deduped";
 * only real Spoonacular/OpenRouter API errors (HTTP status / network) make a 0-created run ok:false.
 * Model-output errors (no content, bad JSON, wrong shape) are counted separately and never fail the run.
 * - triageItemLimit: the 07:00 invocation also runs dailyAutoTriage, which shares the same
 *   per-invocation subrequest cap, so triage only gets what the draft job left over.
 */
import type { RotationIdeaSpec } from "../services/recipeDraftGenerator";

export type DedupRule = "exact" | "substring" | "near_duplicate" | "same_dish" | "placeholder";
export type ErrorSource = "spoonacular" | "openrouter";

export interface DraftRunStats {
  /** Spoonacular candidates dropped before drafting (title vs existing/this-run titles). */
  ideaSkips: { exact: number; substring: number };
  /** Drafted recipes dropped after the OpenRouter call. */
  draftSkips: Record<DedupRule, number>;
  /** Spoonacular calls that returned 0 candidates (no error). */
  emptyIdeaBatches: number;
  /** same-dish check API failures — the draft is kept, so these never fail the run. */
  sameDishCheckErrors: number;
  /** Real API errors (HTTP status / network; message carries the status), first MAX_ERRORS_KEPT only. */
  errors: Array<{ source: ErrorSource; message: string }>;
  /** API errors only: these make a 0-created run ok:false and stop refill. */
  errorCount: number;
  /** Model-output errors (OpenRouter returned no content / unparseable JSON / wrong shape). Never fail the run. */
  modelOutputErrors: number;
  /** Day's own specs that ended without a draft (dedup OR error). */
  daySpecsSkipped: number;
  /** Refill specs that ended without a draft (dedup OR error). */
  refillSpecsSkipped: number;
  refillRounds: number;
  refillSpecs: number;
  /** Conservative subrequest estimate charged against SUBREQUEST_BUDGET. */
  subrequestsUsed: number;
  budgetExhausted: boolean;
}

const MAX_ERRORS_KEPT = 5;
const MAX_ERROR_MESSAGE_LENGTH = 200;

export function emptyStats(): DraftRunStats {
  return {
    ideaSkips: { exact: 0, substring: 0 },
    draftSkips: { exact: 0, substring: 0, near_duplicate: 0, same_dish: 0, placeholder: 0 },
    emptyIdeaBatches: 0,
    sameDishCheckErrors: 0,
    errors: [],
    errorCount: 0,
    modelOutputErrors: 0,
    daySpecsSkipped: 0,
    refillSpecsSkipped: 0,
    refillRounds: 0,
    refillSpecs: 0,
    subrequestsUsed: 0,
    budgetExhausted: false,
  };
}

/**
 * Model-output failures: draftRecipe() throws these when the HTTP call succeeded but the content
 * was empty / not JSON / not the Recipe shape (services/openrouter.ts). Everything else, notably
 * "<API> request failed: <status> ..." and network errors, is treated as a real API error.
 */
export function isModelOutputError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /^OpenRouter response\b/.test(message);
}

export function recordError(stats: DraftRunStats, source: ErrorSource, err: unknown): void {
  if (isModelOutputError(err)) {
    stats.modelOutputErrors += 1;
    return;
  }
  stats.errorCount += 1;
  if (stats.errors.length >= MAX_ERRORS_KEPT) return;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  stats.errors.push({ source, message });
}

export function totalDedupSkips(stats: DraftRunStats): number {
  return stats.ideaSkips.exact + stats.ideaSkips.substring + Object.values(stats.draftSkips).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Refill limits (PR: "auto top-up ideas when dedup eats the day's specs")
// ---------------------------------------------------------------------------

/** At most this many extra rounds of fresh rotation specs after the day's own specs. */
export const MAX_REFILL_ROUNDS = 3;
/** Hard cap on refill specs per invocation (each round adds at most `target - created`). */
export const MAX_REFILL_SPECS = 6;
/**
 * Draft-job subrequest budget, shared by the day's specs AND all refill specs. 39 = the worst
 * case the draft job alone was already sized for (3 specs x 3 attempts x 4 + 3 Pexels). Refill
 * never raises the DRAFT JOB's worst case. The whole 07:00 invocation (draft + dailyAutoTriage +
 * Telegram) is kept under Cloudflare's 50/invocation cap (hit live 2026-08-04) by triageItemLimit():
 * triage only gets what the draft job left over.
 */
export const SUBREQUEST_BUDGET = 39;
/** Worst-case cost of one attempt: Spoonacular (x2 if its 429 retry fires) + OpenRouter draft + same-dish check. */
export const ATTEMPT_WORST_CASE = 4;
/** Charged per Spoonacular call (assume its single 429 retry fired — we can't see it from here). */
export const SPOONACULAR_COST = 2;
/** Reserved so a successful attempt can still fetch its Pexels photo. */
export const PEXELS_RESERVE = 1;

export class SubrequestBudget {
  used = 0;
  constructor(readonly limit: number = SUBREQUEST_BUDGET) {}
  /** True if one more worst-case attempt (+ its photo) still fits. */
  canAttempt(): boolean {
    return this.used + ATTEMPT_WORST_CASE + PEXELS_RESERVE <= this.limit;
  }
  charge(n: number): void {
    this.used += n;
  }
}

/** How many refill specs to add for the next round, or 0 to stop. No refill once any API error was seen (don't keep hitting a broken API). */
export function refillCount(args: { target: number; created: number; roundsDone: number; refillSpecsSoFar: number; budget: SubrequestBudget; apiErrorCount: number }): number {
  const missing = args.target - args.created;
  if (missing <= 0) return 0;
  if (args.apiErrorCount > 0) return 0;
  if (args.roundsDone >= MAX_REFILL_ROUNDS) return 0;
  if (!args.budget.canAttempt()) return 0;
  return Math.max(0, Math.min(missing, MAX_REFILL_SPECS - args.refillSpecsSoFar));
}

/**
 * Fresh rotation specs for a refill round. `offset` = how many rotation slots were already used
 * this run, so refill specs continue the rotation instead of repeating the day's cuisine/diet.
 * Diet steps by 3 so the (cuisine, diet) pair differs from the day's lockstep pairs.
 * Does NOT advance the persisted rotation state (tomorrow's specs are unchanged).
 */
export function buildRefillSpecs(cuisines: readonly string[], diets: readonly string[], lastCuisineIndex: number, lastDietIndex: number, offset: number, count: number): RotationIdeaSpec[] {
  const specs: RotationIdeaSpec[] = [];
  for (let i = 0; i < count; i++) {
    const k = offset + i + 1;
    specs.push({
      kind: "rotation",
      cuisine: cuisines[(lastCuisineIndex + k) % cuisines.length]!,
      diet: diets[(lastDietIndex + k * 3) % diets.length]!,
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Whole-invocation cap: dailyRecipeDraft + dailyAutoTriage run in the same 07:00 cron fire
// ---------------------------------------------------------------------------

/** Cloudflare per-invocation subrequest cap (observed live 2026-08-04). */
export const INVOCATION_SUBREQUEST_CAP = 50;
/** Headroom for anything not charged explicitly (e.g. Mongo connects, recordCronRun). */
export const INVOCATION_SAFETY_MARGIN = 5;
/** Triage worst case per draft (services/recipeDraftTriage.ts approve path): image check, Pexels fallback, re-check, same-dish LLM, approve-time Pexels. */
export const TRIAGE_PER_ITEM_WORST_CASE = 5;
/** Triage fixed cost: one Telegram message (summary or sanity-gate warning). */
export const TRIAGE_FIXED_COST = 1;

/**
 * How many drafts dailyAutoTriage may process after the draft job used `draftSubrequestsUsed`
 * subrequests in the same invocation. 0 = skip triage this run (recorded as skipped_budget).
 */
export function triageItemLimit(draftSubrequestsUsed: number, maxPerRun: number): number {
  const left = INVOCATION_SUBREQUEST_CAP - INVOCATION_SAFETY_MARGIN - TRIAGE_FIXED_COST - Math.max(0, draftSubrequestsUsed);
  return Math.max(0, Math.min(maxPerRun, Math.floor(left / TRIAGE_PER_ITEM_WORST_CASE)));
}

// ---------------------------------------------------------------------------
// cron_run_log classification
// ---------------------------------------------------------------------------

export type DraftRunReason = "already_completed" | "nothing_to_do" | "created" | "partial" | "all_deduped" | "all_dropped" | "no_candidates" | "api_error";

export interface DraftRunClassification {
  ok: boolean;
  reason: DraftRunReason;
  /** Set only when ok:false (Telegram alert shows it). */
  errorMessage?: string;
  /** Human summary for ok:true runs. */
  note?: string;
  detail?: { dedupSkips: number; ideaSkips: DraftRunStats["ideaSkips"]; draftSkips: DraftRunStats["draftSkips"]; errorCount: number; modelOutputErrors: number; daySpecsSkipped: number; refillSpecsSkipped: number; refillRounds: number; refillSpecs: number; subrequestsUsed: number };
}

function describeSkips(stats: DraftRunStats): string {
  const parts: string[] = [];
  if (stats.ideaSkips.exact) parts.push(`idea exact ${stats.ideaSkips.exact}`);
  if (stats.ideaSkips.substring) parts.push(`idea substring ${stats.ideaSkips.substring}`);
  for (const [rule, n] of Object.entries(stats.draftSkips)) if (n) parts.push(`drafted ${rule} ${n}`);
  return `dedupSkips ${totalDedupSkips(stats)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function describeRefill(stats: DraftRunStats): string {
  return `refill rounds ${stats.refillRounds}/${MAX_REFILL_ROUNDS}, refill specs ${stats.refillSpecs}, subrequests ~${stats.subrequestsUsed}/${SUBREQUEST_BUDGET}${stats.budgetExhausted ? " (budget exhausted)" : ""}`;
}

function describeErrors(stats: DraftRunStats): string {
  const msgs = stats.errors.map((e) => `${e.source}: ${e.message}`).join("; ");
  const parts: string[] = [];
  if (stats.errorCount > 0) parts.push(`api errors ${stats.errorCount}${msgs ? ` [${msgs}]` : ""}`);
  if (stats.modelOutputErrors > 0) parts.push(`model output errors ${stats.modelOutputErrors}`);
  return parts.join("; ");
}

export function classifyDraftRun(run: { created: number; target: number; alreadyCompletedToday: boolean; stats: DraftRunStats }): DraftRunClassification {
  const { created, target, stats } = run;
  if (run.alreadyCompletedToday) return { ok: true, reason: "already_completed", note: "today's drafts already completed" };
  if (target === 0) return { ok: true, reason: "nothing_to_do", note: "0 specs to attempt" };

  const detail = {
    dedupSkips: totalDedupSkips(stats),
    ideaSkips: stats.ideaSkips,
    draftSkips: stats.draftSkips,
    errorCount: stats.errorCount,
    modelOutputErrors: stats.modelOutputErrors,
    daySpecsSkipped: stats.daySpecsSkipped,
    refillSpecsSkipped: stats.refillSpecsSkipped,
    refillRounds: stats.refillRounds,
    refillSpecs: stats.refillSpecs,
    subrequestsUsed: stats.subrequestsUsed,
  };
  const head = `created ${created}/${target}; ${describeSkips(stats)}; ${describeRefill(stats)}`;
  const errs = describeErrors(stats);
  const tail = errs ? `; ${errs}` : "";

  if (created >= target) return { ok: true, reason: "created", note: head + tail, detail };
  if (created > 0) return { ok: true, reason: "partial", note: head + tail, detail };
  if (stats.errorCount > 0) return { ok: false, reason: "api_error", errorMessage: `api_error: ${head}${tail}`, detail };
  if (stats.modelOutputErrors > 0) return { ok: true, reason: "all_dropped", note: `all_dropped (dedup + model output errors): ${head}${tail}`, detail };
  if (totalDedupSkips(stats) > 0) return { ok: true, reason: "all_deduped", note: `all_deduped: ${head}`, detail };
  return { ok: false, reason: "no_candidates", errorMessage: `no_candidates: Spoonacular returned 0 ideas (${stats.emptyIdeaBatches} empty batches); ${head}`, detail };
}
