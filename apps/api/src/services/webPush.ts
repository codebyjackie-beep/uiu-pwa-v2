/**
 * Use-it-up reminders (research_rminder_competitors.md #1): Web Push to signed-in users whose fridge has items expiring
 * today or tomorrow. Payload-less push (no message encryption needed): the service worker shows a fixed message and
 * opens /fridge. VAPID (RFC 8292) JWT is signed with WebCrypto ES256.
 *   VAPID_PUBLIC_KEY  — wrangler.toml var (base64url uncompressed P-256 point, not secret)
 *   VAPID_PRIVATE_JWK — Worker secret (JSON JWK, set by Jackie). Missing → reminders are a no-op.
 */
import type { Db } from "mongodb";
import { expiringSoon } from "./fridgeImpact";
import { isGuestId } from "./guest";

export interface WebPushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
}

export const PUSH_SUBSCRIPTIONS = "push_subscriptions";
const SUBJECT = "mailto:useitup.uk@gmail.com";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = new TextEncoder();

let cachedKey: { jwk: string; key: CryptoKey } | undefined;
async function signingKey(jwk: string): Promise<CryptoKey> {
  if (cachedKey?.jwk === jwk) return cachedKey.key;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  cachedKey = { jwk, key };
  return key;
}

export async function vapidAuthHeader(env: WebPushEnv, endpoint: string, now = Date.now()): Promise<string> {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) throw new Error("VAPID keys not configured");
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT })));
  const unsigned = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env.VAPID_PRIVATE_JWK), enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export type PushSubscriptionInput = { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

export function validSubscription(s: PushSubscriptionInput | null): s is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) return false;
  try {
    return new URL(s.endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

export async function saveSubscription(db: Db, userId: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await db.collection(PUSH_SUBSCRIPTIONS).updateOne(
    { endpoint: s.endpoint },
    { $set: { userId, endpoint: s.endpoint, keys: s.keys, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}

export async function sendPush(env: WebPushEnv, endpoint: string): Promise<number> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { TTL: "43200", Urgency: "normal", Authorization: await vapidAuthHeader(env, endpoint), "Content-Length": "0" },
  });
  return res.status;
}

export type ReminderRun = { configured: boolean; subscriptions: number; usersWithExpiring: number; sent: number; removed: number; failed: number; dryRun: boolean };

/** Sends one reminder per subscription whose user has fridge items expiring within 1 day. Expired subscriptions (404/410) are removed. */
export async function sendExpiryReminders(env: WebPushEnv, db: Db, dryRun: boolean): Promise<ReminderRun> {
  const out: ReminderRun = { configured: !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY), subscriptions: 0, usersWithExpiring: 0, sent: 0, removed: 0, failed: 0, dryRun };
  const subs = await db.collection(PUSH_SUBSCRIPTIONS).find({}).toArray();
  out.subscriptions = subs.length;
  const due = new Map<string, boolean>();
  for (const s of subs) {
    const userId = String(s.userId);
    if (isGuestId(userId)) continue;
    if (!due.has(userId)) due.set(userId, (await expiringSoon(db, userId, 1)).length > 0);
    if (!due.get(userId)) continue;
    if (dryRun || !out.configured) continue;
    try {
      const status = await sendPush(env, String(s.endpoint));
      if (status === 404 || status === 410) {
        await db.collection(PUSH_SUBSCRIPTIONS).deleteOne({ _id: s._id });
        out.removed += 1;
      } else if (status >= 200 && status < 300) out.sent += 1;
      else out.failed += 1;
    } catch {
      out.failed += 1;
    }
  }
  out.usersWithExpiring = [...due.values()].filter(Boolean).length;
  return out;
}
