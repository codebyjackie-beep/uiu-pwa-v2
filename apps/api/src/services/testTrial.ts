/**
 * Move a TEST account's trial end date (M3 B4 / B5 / B1 real-phone tests) — added 2026-10-30 because the cloud Atlas
 * connection is read-only and editing `users.trialEndsAt` in the Atlas UI by hand is slow and error-prone.
 *
 * Touches ONLY `users.trialEndsAt`, for exactly one `clerkUserId`. Refuses users that have `premiumUntil` (a paying / Stripe
 * user) or a `stripeCustomerId`. Dry run unless `write`; returns the previous value so it can be put back.
 * Pass either `inDays` (e.g. 3 → banner shows; -1 → trial ended, paywall shows once) or an explicit ISO `trialEndsAt`.
 */
import type { Db, Document } from "mongodb";

export class TestTrialInputError extends Error {}

const DAY_MS = 86_400_000;

export async function setTestTrialEnd(db: Db, body: { clerkUserId?: unknown; inDays?: unknown; trialEndsAt?: unknown } | null, write: boolean, now = new Date()) {
  const clerkUserId = typeof body?.clerkUserId === "string" ? body.clerkUserId.trim() : "";
  if (!/^user_[A-Za-z0-9]{10,60}$/.test(clerkUserId)) throw new TestTrialInputError("clerkUserId must be a Clerk user id (user_...)");

  let next: string;
  if (typeof body?.inDays === "number" && Number.isFinite(body.inDays)) {
    if (body.inDays < -30 || body.inDays > 30) throw new TestTrialInputError("inDays must be between -30 and 30");
    next = new Date(now.getTime() + body.inDays * DAY_MS).toISOString();
  } else if (typeof body?.trialEndsAt === "string" && !Number.isNaN(Date.parse(body.trialEndsAt))) {
    const t = Date.parse(body.trialEndsAt);
    if (t < now.getTime() - 30 * DAY_MS || t > now.getTime() + 30 * DAY_MS) throw new TestTrialInputError("trialEndsAt must be within 30 days of now");
    next = new Date(t).toISOString();
  } else {
    throw new TestTrialInputError("pass inDays (number) or trialEndsAt (ISO string)");
  }

  const users = db.collection<Document>("users");
  const doc = await users.findOne({ clerkUserId }, { projection: { email: 1, trialEndsAt: 1, trialStartedAt: 1, premiumUntil: 1, stripeCustomerId: 1 } });
  if (!doc) throw new TestTrialInputError(`no users doc for ${clerkUserId}`);
  if (doc.premiumUntil || doc.stripeCustomerId) throw new TestTrialInputError("refusing: this user has premiumUntil / a Stripe customer (not a trial-only test account)");

  const before = typeof doc.trialEndsAt === "string" ? doc.trialEndsAt : null;
  if (write) await users.updateOne({ clerkUserId }, { $set: { trialEndsAt: next } });
  return {
    write,
    clerkUserId,
    email: typeof doc.email === "string" ? doc.email : null,
    before,
    after: next,
    /** POST { clerkUserId, trialEndsAt: <before> } to put it back */
    restoreWith: { clerkUserId, trialEndsAt: before },
  };
}

/**
 * One-off reconcile (2026-10-30): a user whose Stripe subscription is `canceled` but whose `premiumUntil` is still in the
 * future (left over from before billing.ts cut access on `customer.subscription.deleted`). Sets premiumUntil to now.
 * One clerkUserId per call; dry run unless `write`; returns the previous value.
 */
export async function endCanceledAccess(db: Db, body: { clerkUserId?: unknown } | null, write: boolean, now = new Date()) {
  const clerkUserId = typeof body?.clerkUserId === "string" ? body.clerkUserId.trim() : "";
  if (!/^user_[A-Za-z0-9]{10,60}$/.test(clerkUserId)) throw new TestTrialInputError("clerkUserId must be a Clerk user id (user_...)");
  const users = db.collection<Document>("users");
  const doc = await users.findOne({ clerkUserId }, { projection: { email: 1, premiumUntil: 1, stripeSubscriptionStatus: 1, stripeSubscriptionId: 1 } });
  if (!doc) throw new TestTrialInputError(`no users doc for ${clerkUserId}`);
  if (doc.stripeSubscriptionStatus !== "canceled") throw new TestTrialInputError(`refusing: stripeSubscriptionStatus is "${String(doc.stripeSubscriptionStatus ?? "none")}", not "canceled"`);
  const before = typeof doc.premiumUntil === "string" ? doc.premiumUntil : null;
  const nowIso = now.toISOString();
  if (!before || before <= nowIso) return { write, clerkUserId, email: doc.email ?? null, changed: false, reason: "premiumUntil already in the past or unset", before };
  if (write) await users.updateOne({ clerkUserId, stripeSubscriptionStatus: "canceled" }, { $set: { premiumUntil: nowIso } });
  return { write, clerkUserId, email: doc.email ?? null, changed: write, wouldChange: !write, before, after: nowIso, restoreWith: { premiumUntil: before } };
}
