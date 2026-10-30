/**
 * Erase a user's personal data when their Clerk account is deleted (Jackie 2026-10-30; webhook = routes/clerkWebhook.ts).
 *
 * DELETED  the 11 per-user collections (USERID_COLLECTIONS), private recipes (`recipes.userId`), push subscriptions.
 * KEPT     what UK record-keeping needs (6 years, gov.uk): the `users` doc is cut down to an allowlist — Clerk id, Stripe
 *          customer / subscription ids + status, trial / premium dates, createdAt — plus `deletedAt`. Name, email and every
 *          other field are removed. `ai_usage` (counts + cost only, no content) and `stripe_events` (event id / type) stay.
 * STRIPE   an active subscription is cancelled first (no refund) so a deleted user is never billed again; a Stripe failure
 *          throws before anything is erased, so the sender retries. Stripe keeps its own invoice records.
 *
 * Dry run unless `write`. Idempotent: running it again on an already-erased user deletes nothing more.
 */
import type { Db, Document } from "mongodb";
import { USERID_COLLECTIONS } from "./clerkRemap";
import { cancelSubscriptionNow, type StripeEnv } from "./stripe";

export class UserDeletionInputError extends Error {}

const KEEP_USER_FIELDS = [
  "clerkUserId",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "stripeSubscriptionStatus",
  "stripeCancelAtPeriodEnd",
  "premiumUntil",
  "trialStartedAt",
  "trialEndsAt",
  "createdAt",
  "deletedAt",
] as const;

const ID_RE = /^user_[A-Za-z0-9]{10,60}$/;

export async function eraseUserData(db: Db, env: StripeEnv, clerkUserIdInput: unknown, write: boolean, now = new Date()) {
  const clerkUserId = typeof clerkUserIdInput === "string" ? clerkUserIdInput.trim() : "";
  if (!ID_RE.test(clerkUserId)) throw new UserDeletionInputError("clerkUserId must be a Clerk user id (user_...)");

  const users = db.collection<Document>("users");
  const userDoc = await users.findOne({ clerkUserId });
  const sub = typeof userDoc?.stripeSubscriptionId === "string" ? userDoc.stripeSubscriptionId : null;
  const subActive = !!sub && userDoc?.stripeSubscriptionStatus !== "canceled";

  const targets: { collection: string; filter: Document }[] = [
    ...USERID_COLLECTIONS.map((c) => ({ collection: c, filter: { userId: clerkUserId } })),
    { collection: "recipes", filter: { userId: clerkUserId } },
    { collection: "push_subscriptions", filter: { userId: clerkUserId } },
  ];

  const counts: Record<string, number> = {};
  for (const t of targets) counts[t.collection] = await db.collection(t.collection).countDocuments(t.filter);

  const removedFields = userDoc ? Object.keys(userDoc).filter((k) => k !== "_id" && !(KEEP_USER_FIELDS as readonly string[]).includes(k)) : [];
  const result = {
    write,
    clerkUserId,
    userDocFound: !!userDoc,
    alreadyErased: !!userDoc?.deletedAt,
    stripeSubscription: sub ? { id: sub, status: String(userDoc?.stripeSubscriptionStatus ?? "unknown"), willCancel: subActive } : null,
    stripeResult: null as null | "cancelled" | "already_gone",
    counts,
    userDocFieldsRemoved: removedFields,
    deleted: {} as Record<string, number>,
  };
  if (!write) return result;

  if (subActive && sub) result.stripeResult = await cancelSubscriptionNow(env, sub);

  for (const t of targets) result.deleted[t.collection] = (await db.collection(t.collection).deleteMany(t.filter)).deletedCount ?? 0;

  if (userDoc) {
    const kept: Document = { clerkUserId };
    for (const k of KEEP_USER_FIELDS) if (userDoc[k] !== undefined) kept[k] = userDoc[k];
    kept.deletedAt = userDoc.deletedAt ?? now.toISOString();
    // a cancelled-now subscription must not leave Premium running
    if (result.stripeResult) {
      kept.stripeSubscriptionStatus = "canceled";
      kept.premiumUntil = now.toISOString() < String(userDoc.premiumUntil ?? "") ? now.toISOString() : userDoc.premiumUntil;
    }
    await users.replaceOne({ _id: userDoc._id }, kept);
  }
  return result;
}
