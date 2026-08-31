/**
 * Cron silent-failure monitor (prompt: "Cron靜默failure監察", 2026-08-31).
 *
 * Root cause of the 2026-08-29/31 outage: igContentAgent/dailyRecipeDraft/pwaDiagnostics
 * all run inside `ctx.waitUntil(job(env).catch(err => console.error(...)))` in index.ts's
 * scheduled() handler — any thrown error (that outage: OpenRouter 402) is swallowed into
 * console.error, so Cloudflare Analytics' "success" status can never tell the difference
 * between a real success and a job that threw immediately. recordCronRun() gives each job
 * a queryable trail independent of that wrapper; checkCronHealth() (called from the hourly
 * pwaDiagnostics cron, HANDOFF_pwa-diagnostics-monitor.md) turns that trail into an alert.
 */
import type { Document } from "mongodb";
import { withDb, type DbEnv } from "../db";
import { sendTelegram, type TelegramEnv } from "./telegram";

export type MonitoredJobName = "igContentAgent" | "dailyRecipeDraft" | "pwaDiagnostics";

interface CronRunLogDoc {
  jobName: MonitoredJobName;
  firedAt: Date;
  ok: boolean;
  errorMessage?: string;
  itemsProcessed?: number;
}

const TTL_SECONDS = 30 * 24 * 60 * 60; // "3. cron_run_log唔使無限長" — keep 30 days, Mongo TTL index does the sweep.

/** Called from index.ts's scheduled() .then()/.catch() for each monitored job — records every run, success or failure. */
export async function recordCronRun(
  env: DbEnv,
  record: { jobName: MonitoredJobName; ok: boolean; errorMessage?: string; itemsProcessed?: number },
): Promise<void> {
  await withDb(env, async (db) => {
    const col = db.collection<Document>("cron_run_log");
    await col.createIndex({ firedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    await col.insertOne({ ...record, firedAt: new Date() } as unknown as Document);
  });
}

/**
 * Expected max gap between runs, generous enough to absorb the batching/retry jitter each
 * job already has (see dailyRecipeDraft.ts's BATCH_SIZE comment) without false-alarming.
 */
const JOB_EXPECTATIONS: Record<MonitoredJobName, { maxIntervalMinutes: number }> = {
  igContentAgent: { maxIntervalMinutes: 24 * 60 + 60 }, // daily 09:00 UTC + 1h buffer
  dailyRecipeDraft: { maxIntervalMinutes: 3 * 60 + 30 }, // fires every 3h (event.cron "0 4,7,10,13,16,19,22 * * *")
  pwaDiagnostics: { maxIntervalMinutes: 60 + 15 }, // hourly
};

interface CronHealthStateDoc {
  jobName: MonitoredJobName;
  alerting: boolean;
}

async function readHealthState(env: DbEnv, jobName: MonitoredJobName): Promise<CronHealthStateDoc> {
  return withDb(env, async (db) => {
    const doc = (await db.collection("cron_health_state").findOne({ jobName })) as Document | null;
    return { jobName, alerting: Boolean(doc?.alerting) };
  });
}

async function saveHealthState(env: DbEnv, jobName: MonitoredJobName, alerting: boolean): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection("cron_health_state").updateOne({ jobName }, { $set: { jobName, alerting } }, { upsert: true });
  });
}

export interface CronHealthResult {
  jobName: MonitoredJobName;
  unhealthy: boolean;
  reason?: string;
  alertSent: boolean;
  recoverySent: boolean;
}

/**
 * "連續2次或以上ok:false" OR "過咗理應執行嘅時間都冇任何record" both count as unhealthy.
 * Edge-triggered alert/recovery (only sends on state transition) — same "避免持續洗版" intent
 * as pwaDiagnostics.ts's existing issue-set-unchanged dedup, simplified to per-job on/off.
 */
async function evaluateJob(env: DbEnv & TelegramEnv, jobName: MonitoredJobName): Promise<CronHealthResult> {
  const { maxIntervalMinutes } = JOB_EXPECTATIONS[jobName];
  const records = await withDb(env, async (db) =>
    db
      .collection<Document>("cron_run_log")
      .find({ jobName })
      .sort({ firedAt: -1 })
      .limit(5)
      .toArray(),
  ) as unknown as CronRunLogDoc[];

  let failStreak = 0;
  for (const r of records) {
    if (!r.ok) failStreak++;
    else break;
  }

  const lastRecord = records[0];
  const overdue = lastRecord ? Date.now() - new Date(lastRecord.firedAt).getTime() > maxIntervalMinutes * 60 * 1000 : false;
  const unhealthy = records.length > 0 && (failStreak >= 2 || overdue);

  const lastSuccess = records.find((r) => r.ok);
  const lastErrorMessage = lastRecord?.errorMessage;
  const reason = overdue
    ? `無run record超過${maxIntervalMinutes}分鐘（理應執行嘅時間已過）`
    : failStreak >= 2
      ? `連續${failStreak}次失敗`
      : undefined;

  const state = await readHealthState(env, jobName);
  let alertSent = false;
  let recoverySent = false;

  if (unhealthy && !state.alerting) {
    const lines = [
      `🚨 *Cron監察 — ${jobName} 異常*`,
      "",
      `原因: ${reason}`,
      `最後一次成功: ${lastSuccess ? new Date(lastSuccess.firedAt).toISOString() : "無記錄"}`,
      `最新錯誤: ${lastErrorMessage ?? "(無)"}`,
    ];
    await sendTelegram(env, lines.join("\n"));
    alertSent = true;
    await saveHealthState(env, jobName, true);
  } else if (!unhealthy && state.alerting) {
    await sendTelegram(env, `✅ *Cron監察 — ${jobName} 已回復正常*`);
    recoverySent = true;
    await saveHealthState(env, jobName, false);
  }

  return { jobName, unhealthy, reason, alertSent, recoverySent };
}

export async function checkCronHealth(env: DbEnv & TelegramEnv): Promise<CronHealthResult[]> {
  const jobNames = Object.keys(JOB_EXPECTATIONS) as MonitoredJobName[];
  const results: CronHealthResult[] = [];
  for (const jobName of jobNames) {
    results.push(await evaluateJob(env, jobName));
  }
  return results;
}
