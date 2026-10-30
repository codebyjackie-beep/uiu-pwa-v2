/**
 * Milestone 3 (Jackie 2026-10-28) — Premium entitlement + per-user AI usage meter.
 *
 * - Plans: free / trial / premium. Reverse trial: 7 days of full Premium, no card, started the
 *   first time a signed-in user is seen while PREMIUM_ENFORCE is on (so pre-launch beta use
 *   never burns anyone's trial). Paid access comes from Stripe (Phase B) via `premiumUntil`.
 * - Limits per UTC calendar month: PREMIUM_LIMITS in @uiu/shared.
 * - `ai_usage`: one doc per request that made ≥1 OpenRouter call {userId, feature, month, counted,
 *   costUsd, calls, at}. counted=false (error / "paste it manually") logs cost but uses no allowance.
 *   costUsd is OpenRouter's own `usage.cost` summed over every OpenRouter call the request made
 *   (e.g. video retries), captured by a fetch wrapper scoped with AsyncLocalStorage — no call
 *   site changes needed.
 * - PREMIUM_ENFORCE !== "true" → nothing is ever blocked; usage is still recorded (real cost data
 *   before launch). Kill switch = set it back to anything but "true".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "mongodb";
import { PREMIUM_LIMITS, PREMIUM_TRIAL_DAYS, type MyPlan, type PlanKind, type PremiumFeature } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export interface PremiumEnv extends DbEnv {
  PREMIUM_ENFORCE?: string;
  /** Comma-separated Clerk user ids that always count as Premium (Jackie's own accounts). */
  PREMIUM_COMP_USER_IDS?: string;
}

export const AI_USAGE = "ai_usage";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// OpenRouter cost meter
// ---------------------------------------------------------------------------

interface MeterStore {
  calls: number;
  costUsd: number;
}

const meter = new AsyncLocalStorage<MeterStore>();
let fetchWrapped = false;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Asks OpenRouter to include `usage.cost` (no-op if the caller already set `usage`). */
function withUsageAccounting(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (!body || typeof body !== "object" || "usage" in body) return init;
    return { ...init, body: JSON.stringify({ ...body, usage: { include: true } }) };
  } catch {
    return init;
  }
}

/** Idempotent. Wraps global fetch so OpenRouter calls made inside a metered request add to its store. */
export function installOpenRouterMeter(): void {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const store = meter.getStore();
    if (!store || !requestUrl(input).startsWith("https://openrouter.ai/api/")) return original(input, init);
    const res = await original(input, withUsageAccounting(init));
    store.calls += 1;
    try {
      const json = (await res.clone().json()) as { usage?: { cost?: unknown } };
      if (typeof json?.usage?.cost === "number") store.costUsd += json.usage.cost;
    } catch {
      // non-JSON / error body — the call still counts, cost unknown
    }
    return res;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

interface UserPlanFields {
  trialEndsAt?: string | null;
  premiumUntil?: string | null;
  stripeCancelAtPeriodEnd?: boolean | null;
  stripeSubscriptionStatus?: string | null;
}

function compIds(env: PremiumEnv): Set<string> {
  return new Set((env.PREMIUM_COMP_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function planKind(user: UserPlanFields | null, userId: string, env: PremiumEnv, now: Date): PlanKind {
  if (compIds(env).has(userId)) return "premium";
  if (user?.premiumUntil && Date.parse(user.premiumUntil) > now.getTime()) return "premium";
  if (user?.trialEndsAt && Date.parse(user.trialEndsAt) > now.getTime()) return "trial";
  return "free";
}

/**
 * Loads the user's plan fields. When enforcement is on and the user has never had a trial,
 * starts the 7-day trial now (atomic: only sets it if still unset). Users without a `users`
 * doc yet (sync not run) get the trial on their doc via upsert-free update → they stay free
 * until /api/users/sync creates the doc; the web always syncs first, so this is an edge case.
 */
async function loadPlanFields(db: Db, userId: string, enforced: boolean, now: Date): Promise<UserPlanFields | null> {
  const users = db.collection("users");
  if (enforced) {
    const trialEndsAt = new Date(now.getTime() + PREMIUM_TRIAL_DAYS * DAY_MS).toISOString();
    await users.updateOne(
      { clerkUserId: userId, trialStartedAt: { $exists: false } },
      { $set: { trialStartedAt: now.toISOString(), trialEndsAt } },
    );
  }
  return (await users.findOne(
    { clerkUserId: userId },
    { projection: { trialEndsAt: 1, premiumUntil: 1, stripeCancelAtPeriodEnd: 1, stripeSubscriptionStatus: 1 } },
  )) as UserPlanFields | null;
}

async function usageCounts(db: Db, userId: string, month: string): Promise<Map<string, number>> {
  const rows = await db
    .collection(AI_USAGE)
    .aggregate<{ _id: string; n: number }>([
      { $match: { userId, month, counted: true } },
      { $group: { _id: "$feature", n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function getMyPlan(env: PremiumEnv, userId: string, now = new Date()): Promise<MyPlan> {
  const enforced = env.PREMIUM_ENFORCE === "true";
  const { fields, counts } = await withDb(env, async (db) => ({
    fields: await loadPlanFields(db, userId, enforced, now),
    counts: await usageCounts(db, userId, monthKey(now)),
  }));
  const usage = {} as MyPlan["usage"];
  for (const f of Object.keys(PREMIUM_LIMITS) as PremiumFeature[]) {
    usage[f] = { used: counts.get(f) ?? 0, limit: PREMIUM_LIMITS[f] };
  }
  return {
    plan: planKind(fields, userId, env, now),
    enforced,
    trialEndsAt: fields?.trialEndsAt ?? null,
    premiumUntil: fields?.premiumUntil ?? null,
    cancelAtPeriodEnd: Boolean(fields?.stripeCancelAtPeriodEnd) && fields?.stripeSubscriptionStatus !== "canceled",
    usageResetsAt: nextMonthStart(now).toISOString(),
    usage,
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

async function recordUsage(env: PremiumEnv, userId: string, feature: PremiumFeature, store: MeterStore, counted: boolean, now: Date): Promise<void> {
  try {
    await withDb(env, (db) =>
      db.collection(AI_USAGE).insertOne({
        userId,
        feature,
        month: monthKey(now),
        counted,
        calls: store.calls,
        costUsd: Math.round(store.costUsd * 1e6) / 1e6,
        at: now.toISOString(),
      }),
    );
  } catch (err) {
    console.error("[uiu-api] ai_usage record error:", err instanceof Error ? err.message : String(err));
  }
}

/** "counted" = uses a monthly allowance; failed / "please paste manually" results only log cost. */
async function outcome(c: Context): Promise<"counted" | "cost_only"> {
  if (c.res.status >= 300) return "cost_only";
  try {
    const body = (await c.res.clone().json()) as { ok?: unknown; data?: { needsManualPaste?: unknown } };
    if (body?.ok === false || body?.data?.needsManualPaste) return "cost_only";
    return "counted";
  } catch {
    return "counted";
  }
}

/**
 * Put after requireUser + guestForbidden. Enforced: free → 402 premium_required, at limit →
 * 429 limit_reached. Always: a successful request that made ≥1 OpenRouter call is recorded.
 */
export function premiumGate(feature: PremiumFeature): MiddlewareHandler<{ Bindings: PremiumEnv }> {
  return async (c, next) => {
    if (c.get("isGuest")) return next();
    const userId = c.get("clerkUserId");
    const now = new Date();
    const enforced = c.env.PREMIUM_ENFORCE === "true";

    if (enforced) {
      const limit = PREMIUM_LIMITS[feature];
      const { fields, used } = await withDb(c.env, async (db) => ({
        fields: await loadPlanFields(db, userId, true, now),
        used: limit === null ? 0 : await db.collection(AI_USAGE).countDocuments({ userId, feature, month: monthKey(now), counted: true }),
      }));
      if (planKind(fields, userId, c.env, now) === "free") {
        return c.json({ ok: false, error: { code: "premium_required", message: "This is a Premium feature" } }, 402);
      }
      if (limit !== null && used >= limit) {
        return c.json(
          {
            ok: false,
            error: {
              code: "limit_reached",
              message: `You've used all ${limit} this month. It resets on ${nextMonthStart(now).toISOString().slice(0, 10)}.`,
            },
            data: { feature, limit, used, resetsAt: nextMonthStart(now).toISOString() },
          },
          429,
        );
      }
    }

    const store: MeterStore = { calls: 0, costUsd: 0 };
    await meter.run(store, () => next());
    if (store.calls > 0) {
      const work = recordUsage(c.env, userId, feature, store, (await outcome(c)) === "counted", now);
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        await work;
      }
    }
  };
}
