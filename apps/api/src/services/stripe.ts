/**
 * Milestone 3 Phase B (Jackie 2026-10-28) — Stripe Checkout, Billing Portal and webhook helpers.
 *
 * No Stripe SDK: this is a Worker, and the official SDK is heavy for a handful of calls. Everything
 * is plain `fetch` against https://api.stripe.com/v1 with form-encoded bodies, plus a Web Crypto
 * HMAC check for webhook signatures.
 *
 * Secrets (never committed, never logged):
 *   STRIPE_SECRET_KEY      sk_test_… until launch, then sk_live_… (wrangler secret put).
 *   STRIPE_WEBHOOK_SECRET  whsec_… from the Stripe webhook endpoint (wrangler secret put).
 * Vars (non-secret, apps/api/wrangler.toml):
 *   STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY  price_… ids (test ids now, live ids at launch).
 *   WEB_BASE_URL                                where Checkout / Portal send the user back to.
 */

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;
  WEB_BASE_URL?: string;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// REST helper
// ---------------------------------------------------------------------------

/** Stripe wants nested params as `a[b][0]=c`. Flattens plain objects / arrays into that shape. */
export function flattenParams(input: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") out.push(...flattenParams(item as Record<string, unknown>, `${name}[${i}]`));
        else out.push([`${name}[${i}]`, String(item)]);
      });
    } else if (typeof value === "object") {
      out.push(...flattenParams(value as Record<string, unknown>, name));
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

async function stripeRequest<T>(env: StripeEnv, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>): Promise<T> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("Stripe is not configured", 503);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${key}` },
  };
  if (params && method === "POST") {
    init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
    init.body = new URLSearchParams(flattenParams(params)).toString();
  }
  const res = await fetch(`${STRIPE_API}${path}`, init);
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) {
    // Stripe's error message is safe to log (no secrets); the key itself never appears in it.
    throw new StripeError(json.error?.message ?? `Stripe ${res.status}`, res.status);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type BillingInterval = "month" | "year";

export function priceIdFor(env: StripeEnv, interval: BillingInterval): string | null {
  const id = interval === "month" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_YEARLY;
  return id && id.startsWith("price_") ? id : null;
}

// ---------------------------------------------------------------------------
// Checkout + Portal
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  userId: string;
  priceId: string;
  email?: string | null;
  /** Existing Stripe customer, if this user has subscribed before. */
  customerId?: string | null;
  webBaseUrl: string;
}

export async function createCheckoutSession(env: StripeEnv, input: CheckoutInput): Promise<string> {
  const session = await stripeRequest<{ url?: string | null }>(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }],
    client_reference_id: input.userId,
    metadata: { clerkUserId: input.userId },
    subscription_data: { metadata: { clerkUserId: input.userId } },
    customer: input.customerId ?? undefined,
    customer_email: input.customerId ? undefined : input.email ?? undefined,
    success_url: `${input.webBaseUrl}/premium?checkout=success`,
    cancel_url: `${input.webBaseUrl}/premium?checkout=cancelled`,
  });
  if (!session.url) throw new StripeError("Stripe returned no checkout URL", 502);
  return session.url;
}

export async function createPortalSession(env: StripeEnv, customerId: string, webBaseUrl: string): Promise<string> {
  const portal = await stripeRequest<{ url?: string }>(env, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: `${webBaseUrl}/premium`,
  });
  if (!portal.url) throw new StripeError("Stripe returned no portal URL", 502);
  return portal.url;
}

/**
 * Cancel a subscription immediately, no refund (account deleted). Already gone / already cancelled = success.
 * Other errors throw, so the caller can fail the webhook and let the sender retry before any data is deleted.
 */
export async function cancelSubscriptionNow(env: StripeEnv, subscriptionId: string): Promise<"cancelled" | "already_gone"> {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) throw new StripeError("bad subscription id", 400);
  try {
    await stripeRequest(env, "DELETE", `/subscriptions/${subscriptionId}`);
    return "cancelled";
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return "already_gone";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Webhook signature (https://docs.stripe.com/webhooks#verify-manually)
// ---------------------------------------------------------------------------

function hexOf(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only if the Stripe-Signature header matches the raw body and is within the tolerance window. */
export async function verifyWebhookSignature(rawBody: string, header: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return signatures.some((sig) => constantTimeEqual(sig, mac));
}

// ---------------------------------------------------------------------------
// Subscription → premiumUntil
// ---------------------------------------------------------------------------

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  metadata?: Record<string, string>;
  /** true / a cancel_at date = the user cancelled and the subscription ends at the period end. */
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  /** Pre-2025 API versions. */
  current_period_end?: number;
  /** Newer API versions moved the period onto each item. */
  items?: { data?: { current_period_end?: number }[] };
}

/** Subscription statuses that grant Premium access until the period end. */
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function periodEndIso(sub: StripeSubscription): string | null {
  const seconds = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
}

export function isAccessGranting(sub: StripeSubscription): boolean {
  return ACTIVE_STATUSES.has(sub.status);
}

/** Sanity-check a webhook body before trusting it (it is already signature-verified). */
export function parseEvent(rawBody: string): { id: string; type: string; data: { object: Record<string, unknown> } } | null {
  try {
    const ev = JSON.parse(rawBody) as { id?: unknown; type?: unknown; data?: { object?: unknown } };
    if (typeof ev.id !== "string" || typeof ev.type !== "string" || !ev.data || typeof ev.data.object !== "object" || ev.data.object === null) return null;
    return { id: ev.id, type: ev.type, data: { object: ev.data.object as Record<string, unknown> } };
  } catch {
    return null;
  }
}
