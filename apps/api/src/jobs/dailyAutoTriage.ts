/**
 * Daily auto-triage of pending recipe drafts (Jackie 2026-11-07). Runs in the 07:00 UTC cron right after
 * dailyRecipeDraft, using the same rules + same apply function as the admin "Run auto-triage" button
 * (services/recipeDraftTriage.ts), so every approve still passes the AI same-dish check (#29, #33, #34).
 *
 * Off unless AUTO_TRIAGE_CRON = "true" (wrangler.toml). At most AUTO_TRIAGE_MAX_PER_RUN drafts per day so a
 * bad day can't flood the library; everything else waits for tomorrow or the admin page.
 * Rollback: POST /api/admin/recipe-drafts/triage/rollback { batchId } — batch id is in the Telegram summary.
 */
import type { PexelsEnv } from "../services/pexels";
import type { OpenRouterEnv } from "../services/openrouter";
import { withDb, type DbEnv } from "../db";
import { applyTriageChunk, newBatchId, planTriage } from "../services/recipeDraftTriage";
import { sendTelegram, type TelegramEnv } from "../services/telegram";

export const AUTO_TRIAGE_MAX_PER_RUN = 10;

export type DailyAutoTriageEnv = DbEnv & PexelsEnv & Partial<OpenRouterEnv> & TelegramEnv & { AUTO_TRIAGE_CRON?: string };

export interface DailyAutoTriageSummary {
  enabled: boolean;
  skipped?: string;
  batchId?: string;
  approved: number;
  rejected: number;
  needsReview: number;
  stayedPending: number;
}

export async function dailyAutoTriage(env: DailyAutoTriageEnv): Promise<DailyAutoTriageSummary> {
  const empty = { approved: 0, rejected: 0, needsReview: 0, stayedPending: 0 };
  if (env.AUTO_TRIAGE_CRON !== "true") return { enabled: false, skipped: "AUTO_TRIAGE_CRON is not \"true\"", ...empty };

  return withDb(env, async (db) => {
    const plan = await planTriage(db);
    if (plan.sanityGateTripped) {
      await sendTelegram(env, `⚠️ Auto-triage skipped: sanity gate (approve ${plan.counts.approve_candidate}, reject ${plan.counts.reject}).`).catch(() => {});
      return { enabled: true, skipped: "sanity gate", ...empty };
    }
    const ids = [...plan.ids.approve_candidate, ...plan.ids.reject, ...plan.ids.needs_review].slice(0, AUTO_TRIAGE_MAX_PER_RUN);
    if (ids.length === 0) return { enabled: true, skipped: "nothing to triage", ...empty };

    const batchId = newBatchId();
    const r = await applyTriageChunk(db, env, ids, batchId);
    const summary = {
      enabled: true,
      batchId,
      approved: r.approved.length,
      rejected: r.rejected.length,
      needsReview: r.needsReviewMarked.length,
      stayedPending: r.stayedPending.length,
    };
    await sendTelegram(
      env,
      `🍳 Auto-triage ${batchId}: approved ${summary.approved}, rejected ${summary.rejected}, needs review ${summary.needsReview}, still pending ${summary.stayedPending}.`,
    ).catch(() => {});
    return summary;
  });
}
