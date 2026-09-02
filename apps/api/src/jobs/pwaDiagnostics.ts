/**
 * PWA diagnostics + monitor (HANDOFF_pwa-diagnostics-monitor.md). Cloudflare
 * Cron Trigger job: no VM, no fixed persona — this replaces an earlier
 * SSH-based ops-monitoring approach (superseded 2026-08-22).
 * Runs hourly:
 *   - Every fire: collects a handful of health checks. Any "critical" one
 *     failing sends a Telegram alert (with a 1h cooldown per unchanged issue set).
 *   - Once/day at PWA_DIAGNOSTICS_DIGEST_HOUR_UK (Europe/London local time,
 *     DST-aware via Intl — never hardcode a UTC hour), asks OpenRouter to
 *     write a short human-language summary and sends that too.
 * State (last alert issue set/time, last digest date) persists in Mongo
 * (`pwa_diagnostics_state`, single doc) — same pattern as recipe_draft_state.
 */
import type { Document } from "mongodb";
import { withDb, type DbEnv } from "../db";
import { sendTelegram, type TelegramEnv } from "../services/telegram";
import { checkCronHealth, type CronHealthResult } from "../services/cronHealthMonitor";

export interface PwaDiagnosticsEnv extends DbEnv, TelegramEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  /** Optional — deploy-info check is skipped (non-critical) if either is unset. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** [vars], not secrets — Jackie can retune thresholds without a code change. */
  PWA_DIAGNOSTICS_RECIPE_COST_MIN_PCT?: string;
  PWA_DIAGNOSTICS_NUTRITION_MIN_PCT?: string;
  PWA_DIAGNOSTICS_DIGEST_HOUR_UK?: string;
}

export interface DiagnosticCheck {
  name: string;
  severity: "critical" | "info";
  ok: boolean;
  detail: string;
}

interface DiagnosticsStateDoc {
  lastAlertIssues: string[];
  lastAlertSentAt: string | null;
  lastDigestDate: string | null; // YYYY-MM-DD, Europe/London wall-clock date
}

const WORKER_SCRIPT_NAME = "uiu-api";
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h — same issue set doesn't re-alert within this window
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function num(val: string | undefined, fallback: number): number {
  const n = val !== undefined ? Number(val) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function checkUptime(): Promise<DiagnosticCheck> {
  try {
    const res = await fetchWithTimeout("https://useitup.uk/", FETCH_TIMEOUT_MS);
    return {
      name: "uptime",
      severity: "critical",
      ok: res.ok,
      detail: `useitup.uk -> HTTP ${res.status}`,
    };
  } catch (err) {
    return { name: "uptime", severity: "critical", ok: false, detail: `useitup.uk unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Deliberately NOT a self-fetch to uiu-api's own public URL — apps/web's
 * wrangler.toml documents Cloudflare's same-zone subrequest loop protection
 * (error 1042) biting exactly that pattern. A direct Mongo ping is the
 * equivalent "is the API's core dependency alive" signal without the risk.
 */
async function checkApiHealth(env: DbEnv): Promise<DiagnosticCheck> {
  try {
    await withDb(env, async (db) => {
      await db.command({ ping: 1 });
    });
    return { name: "api_health", severity: "critical", ok: true, detail: "Mongo ping ok" };
  } catch (err) {
    return { name: "api_health", severity: "critical", ok: false, detail: `Mongo ping failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkRecipeCostCoverage(env: DbEnv & Pick<PwaDiagnosticsEnv, "PWA_DIAGNOSTICS_RECIPE_COST_MIN_PCT">): Promise<DiagnosticCheck> {
  const minPct = num(env.PWA_DIAGNOSTICS_RECIPE_COST_MIN_PCT, 50);
  try {
    const pct = await withDb(env, async (db) => {
      const col = db.collection<Document>("recipe_cost");
      const docs = await col.find({}, { projection: { adjustedPriceable: 1, adjustedTotal: 1 } }).toArray();
      let priceable = 0;
      let total = 0;
      for (const d of docs) {
        priceable += Number(d.adjustedPriceable) || 0;
        total += Number(d.adjustedTotal) || 0;
      }
      return total > 0 ? (priceable / total) * 100 : 0;
    });
    return {
      name: "recipe_cost_coverage",
      severity: "critical",
      ok: pct >= minPct,
      detail: `line-weighted adjusted coverage ${pct.toFixed(1)}% (min ${minPct}%)`,
    };
  } catch (err) {
    return { name: "recipe_cost_coverage", severity: "critical", ok: false, detail: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkNutritionCoverage(env: DbEnv & Pick<PwaDiagnosticsEnv, "PWA_DIAGNOSTICS_NUTRITION_MIN_PCT">): Promise<DiagnosticCheck> {
  const minPct = num(env.PWA_DIAGNOSTICS_NUTRITION_MIN_PCT, 30);
  try {
    const pct = await withDb(env, async (db) => {
      const col = db.collection<Document>("canonical_ingredients");
      const total = await col.countDocuments();
      const withNutrition = await col.countDocuments({ nutrition_per_100g: { $exists: true, $ne: null } });
      return total > 0 ? (withNutrition / total) * 100 : 0;
    });
    return {
      name: "nutrition_per_100g_coverage",
      severity: "critical",
      ok: pct >= minPct,
      detail: `canonical_ingredients nutrition_per_100g coverage ${pct.toFixed(1)}% (min ${minPct}%)`,
    };
  } catch (err) {
    return { name: "nutrition_per_100g_coverage", severity: "critical", ok: false, detail: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Non-critical — a summary-only "what's live" line, never blocks/alerts on its own. */
async function checkLatestDeploy(env: Pick<PwaDiagnosticsEnv, "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID">): Promise<DiagnosticCheck> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { name: "latest_deploy", severity: "info", ok: true, detail: "deploy info unavailable (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set)" };
  }
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_SCRIPT_NAME}/deployments`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    if (!res.ok) throw new Error(`Cloudflare API ${res.status}`);
    const json = (await res.json()) as { result?: { deployments?: Array<{ id: string; created_on: string; annotations?: Record<string, string> }> } };
    const latest = json.result?.deployments?.[0];
    if (!latest) return { name: "latest_deploy", severity: "info", ok: true, detail: "no deployment history returned" };
    const message = latest.annotations?.["workers/message"] ?? "(no message)";
    return { name: "latest_deploy", severity: "info", ok: true, detail: `${WORKER_SCRIPT_NAME} latest deploy ${latest.created_on} — ${message}` };
  } catch (err) {
    return { name: "latest_deploy", severity: "info", ok: true, detail: `deploy info lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function collectChecks(env: PwaDiagnosticsEnv): Promise<DiagnosticCheck[]> {
  return Promise.all([
    checkUptime(),
    checkApiHealth(env),
    checkRecipeCostCoverage(env),
    checkNutritionCoverage(env),
    checkLatestDeploy(env),
  ]);
}

async function readState(env: DbEnv): Promise<DiagnosticsStateDoc> {
  return withDb(env, async (db) => {
    const doc = (await db.collection("pwa_diagnostics_state").findOne({})) as Document | null;
    return {
      lastAlertIssues: (doc?.lastAlertIssues as string[]) ?? [],
      lastAlertSentAt: (doc?.lastAlertSentAt as string) ?? null,
      lastDigestDate: (doc?.lastDigestDate as string) ?? null,
    };
  });
}

async function saveState(env: DbEnv, patch: Partial<DiagnosticsStateDoc>): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection("pwa_diagnostics_state").updateOne({}, { $set: patch }, { upsert: true });
  });
}

function formatAlertMessage(broken: DiagnosticCheck[]): string {
  const lines = ["*UIU PWA — 監測警報*", ""];
  for (const c of broken) lines.push(`❌ ${c.name}: ${c.detail}`);
  return lines.join("\n");
}

function getUkParts(now: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

async function callOpenRouterForSummary(env: PwaDiagnosticsEnv, checks: DiagnosticCheck[]): Promise<string> {
  const prompt =
    `你係UseItUp PWA嘅系統監測摘要員。以下係一輪health check嘅原始結果（JSON），` +
    `請用繁體中文寫一段簡短（4-6句）嘅每日摘要俾non-technical嘅product owner睇，` +
    `講清楚系統整體係咪健康、有冇需要留意嘅地方，唔使逐條讀出全部細節，唔好用JSON格式回覆，淨係普通文字：\n\n` +
    JSON.stringify(checks, null, 2);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter response had no message content");
  return content.trim();
}

export interface DiagnosticsRunResult {
  checks: DiagnosticCheck[];
  brokenIssues: string[];
  alertSent: boolean;
  digestSent: boolean;
  /** Cron 靜默failure監察 (2026-08-31 prompt) — igContentAgent/dailyRecipeDraft/pwaDiagnostics run health, piggybacked on this hourly cron per the prompt's §2 ("可以摺落現有pwaDiagnostics.ts嘅hourly cron"). */
  cronHealth: CronHealthResult[];
}

/**
 * @param opts.forceDigest - bypass the "is it 10am UK" gate (manual verification only).
 * @param opts.forceAlert - bypass the issue-set-unchanged/cooldown dedup (manual verification only).
 */
export async function runDiagnostics(
  env: PwaDiagnosticsEnv,
  opts: { forceDigest?: boolean; forceAlert?: boolean } = {},
): Promise<DiagnosticsRunResult> {
  const checks = await collectChecks(env);
  const broken = checks.filter((c) => c.severity === "critical" && !c.ok);
  const brokenIssues = broken.map((c) => c.name).sort();

  const state = await readState(env);
  let alertSent = false;

  const issuesChanged = JSON.stringify(brokenIssues) !== JSON.stringify([...state.lastAlertIssues].sort());
  const cooldownExpired = !state.lastAlertSentAt || Date.now() - new Date(state.lastAlertSentAt).getTime() >= ALERT_COOLDOWN_MS;

  if (brokenIssues.length > 0 && (opts.forceAlert || issuesChanged || cooldownExpired)) {
    await sendTelegram(env, formatAlertMessage(broken));
    alertSent = true;
    await saveState(env, { lastAlertIssues: brokenIssues, lastAlertSentAt: new Date().toISOString() });
  } else if (brokenIssues.length === 0 && state.lastAlertIssues.length > 0) {
    // Recovery notice — issues existed before, all clear now.
    await sendTelegram(env, "✅ *UIU PWA — 監測警報解除*\n\n之前嘅critical issue而家已經恢復正常。");
    alertSent = true;
    await saveState(env, { lastAlertIssues: [], lastAlertSentAt: new Date().toISOString() });
  }

  let digestSent = false;
  const { date: todayUk, hour: hourUk } = getUkParts(new Date());
  const digestHour = num(env.PWA_DIAGNOSTICS_DIGEST_HOUR_UK, 10);
  if (opts.forceDigest || (hourUk === digestHour && state.lastDigestDate !== todayUk)) {
    const summary = await callOpenRouterForSummary(env, checks);
    await sendTelegram(env, `*UIU PWA — 每日摘要*\n\n${summary}`);
    digestSent = true;
    await saveState(env, { lastDigestDate: todayUk });
  }

  const cronHealth = await checkCronHealth(env);

  return { checks, brokenIssues, alertSent, digestSent, cronHealth };
}
