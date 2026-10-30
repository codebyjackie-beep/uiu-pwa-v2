/**
 * Milestone 3 Phase B — Stripe billing endpoints (services/stripe.ts has the Stripe plumbing).
 *
 *   POST /api/billing/checkout  {interval: "month"|"year"} → {url}   signed-in, non-guest
 *   POST /api/billing/portal                               → {url}   signed-in, non-guest
 *   POST /api/billing/webhook                              Stripe → us, signature-verified, no auth
 *
 * Premium access is written ONLY by the webhook, as `users.premiumUntil` (max of what Stripe says).
 * planKind() in services/premium.ts already reads that field, so nothing else changes for the gate.
 * Access is never shortened here: cancelling keeps Premium until the period Stripe already paid for.
 */
import { Hono } from "hono";
import type { ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { guestForbidden, requireUser } from "../clerkAuth";
import {
  StripeError,
  createCheckoutSession,
  createPortalSession,
  isAccessGranting,
  parseEvent,
  periodEndIso,
  priceIdFor,
  verifyWebhookSignature,
  type BillingInterval,
  type StripeEnv,
  type StripeSubscription,
} from "../services/stripe";

type BillingEnv = DbEnv & StripeEnv & { CLERK_SECRET_KEY?: string };

export const billingRouter = new Hono<{ Bindings: BillingEnv }>();

const USERS = "users";
const STRIPE_EVENTS = "stripe_events";

function webBase(env: BillingEnv): string {
  return (env.WEB_BASE_URL ?? "https://useitup.uk").replace(/\/$/, "");
}

type FailStatus = 400 | 404 | 409 | 500 | 502 | 503;

function failure(c: { json: (body: unknown, status: FailStatus) => Response }, status: FailStatus, code: string, message: string) {
  return c.json({ ok: false, error: { code, message } } satisfies ApiResponse<never>, status);
}

function stripeFailure(c: { json: (body: unknown, status: FailStatus) => Response }, err: unknown) {
  if (err instanceof StripeError) {
    console.error("[uiu-api] stripe error:", err.status, err.message);
    return failure(c, err.status >= 500 ? 502 : 400, "stripe_error", "Payment provider error, please try again");
  }
  console.error("[uiu-api] billing error:", err instanceof Error ? err.message : String(err));
  return failure(c, 500, "server_error", "Billing failed");
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

billingRouter.post("/checkout", requireUser, guestForbidden, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { interval?: unknown } | null;
  const interval = body?.interval;
  if (interval !== "month" && interval !== "year") {
    return failure(c, 400, "bad_request", "interval must be month or year");
  }
  const priceId = priceIdFor(c.env, interval as BillingInterval);
  if (!priceId) return failure(c, 503, "not_configured", "Premium pricing is not configured yet");

  const userId = c.get("clerkUserId");
  try {
    const user = await withDb(c.env, (db) =>
      db.collection(USERS).findOne({ clerkUserId: userId }, { projection: { stripeCustomerId: 1, stripeSubscriptionStatus: 1, premiumUntil: 1 } }),
    );
    if (!user) return failure(c, 409, "sync_required", "Sign in again to finish setup");

    const url = await createCheckoutSession(c.env, {
      userId,
      priceId,
      email: c.get("clerkTokenEmail") ?? null,
      customerId: (user.stripeCustomerId as string | undefined) ?? null,
      webBaseUrl: webBase(c.env),
    });
    return c.json({ ok: true, data: { url } } satisfies ApiResponse<{ url: string }>);
  } catch (err) {
    return stripeFailure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Billing portal (change card, cancel)
// ---------------------------------------------------------------------------

billingRouter.post("/portal", requireUser, guestForbidden, async (c) => {
  const userId = c.get("clerkUserId");
  try {
    const user = await withDb(c.env, (db) =>
      db.collection(USERS).findOne({ clerkUserId: userId }, { projection: { stripeCustomerId: 1 } }),
    );
    const customerId = user?.stripeCustomerId as string | undefined;
    if (!customerId) return failure(c, 404, "no_subscription", "No subscription to manage yet");

    const url = await createPortalSession(c.env, customerId, webBase(c.env));
    return c.json({ ok: true, data: { url } } satisfies ApiResponse<{ url: string }>);
  } catch (err) {
    return stripeFailure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** Writes premiumUntil only ever forwards, so a late or replayed event cannot shorten access. */
async function applySubscription(env: BillingEnv, sub: StripeSubscription): Promise<void> {
  const periodEnd = periodEndIso(sub);
  const set: Record<string, unknown> = {
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    stripeSubscriptionStatus: sub.status,
    stripeCancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  };
  const update: Record<string, unknown> = { $set: set };
  if (isAccessGranting(sub) && periodEnd) {
    update.$max = { premiumUntil: periodEnd };
  }
  await withDb(env, async (db) => {
    const users = db.collection(USERS);
    const byCustomer = await users.updateOne({ stripeCustomerId: sub.customer }, update);
    if (byCustomer.matchedCount > 0) return;
    const clerkUserId = sub.metadata?.clerkUserId;
    if (clerkUserId) {
      await users.updateOne({ clerkUserId }, update);
    } else {
      console.error("[uiu-api] stripe subscription with no matching user:", sub.id, sub.status);
    }
  });
}

/**
 * A deleted subscription ends access NOW. premiumUntil otherwise only moves forward, so an immediate cancel (Stripe
 * dashboard, refund, chargeback) used to leave the user Premium until the old period end (M3 B3 test, 2026-10-30).
 * Only the user's CURRENT subscription is cut — an old sub deleted after a re-subscribe must not end the new one.
 * For a normal end-of-period cancel the deleted event arrives at the period end, so this is a no-op.
 */
async function endAccessNow(env: BillingEnv, sub: StripeSubscription): Promise<void> {
  const nowIso = new Date().toISOString();
  await withDb(env, (db) =>
    db.collection(USERS).updateOne({ stripeCustomerId: sub.customer, stripeSubscriptionId: sub.id, premiumUntil: { $gt: nowIso } }, { $set: { premiumUntil: nowIso } }),
  );
}

billingRouter.post("/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ ok: false }, 503);

  const rawBody = await c.req.text();
  const valid = await verifyWebhookSignature(rawBody, c.req.header("Stripe-Signature"), secret);
  if (!valid) return c.json({ ok: false, error: { code: "bad_signature" } }, 400);

  const ev = parseEvent(rawBody);
  if (!ev) return c.json({ ok: false, error: { code: "bad_event" } }, 400);

  try {
    // Idempotency: Stripe retries. Event ids are unique, so a duplicate insert is a no-op.
    const fresh = await withDb(c.env, async (db) => {
      try {
        await db.collection(STRIPE_EVENTS).insertOne({ _id: ev.id as never, type: ev.type, at: new Date().toISOString() } as never);
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return false;
        throw err;
      }
    });
    if (!fresh) return c.json({ ok: true, data: { duplicate: true } });

    switch (ev.type) {
      case "checkout.session.completed": {
        const s = ev.data.object as { mode?: string; client_reference_id?: string; customer?: string };
        if (s.mode === "subscription" && s.client_reference_id && typeof s.customer === "string") {
          await withDb(c.env, (db) =>
            db.collection(USERS).updateOne({ clerkUserId: s.client_reference_id }, { $set: { stripeCustomerId: s.customer } }),
          );
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await applySubscription(c.env, ev.data.object as unknown as StripeSubscription);
        break;
      case "customer.subscription.deleted": {
        const sub = ev.data.object as unknown as StripeSubscription;
        await applySubscription(c.env, sub);
        await endAccessNow(c.env, sub);
        break;
      }
      default:
        break;
    }
    return c.json({ ok: true });
  } catch (err) {
    // 500 → Stripe retries the event later.
    console.error("[uiu-api] stripe webhook error:", ev.type, err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "server_error" } }, 500);
  }
});

