/**
 * Guest mode (claude/plan_guest_mode.md, Jackie 2026-10-20): signed-out visitors can use every tab; what they add is
 * stored server-side under a temporary `guest_…` user id, deleted after GUEST_TTL_DAYS, and moved into the account
 * when they sign up.
 *
 * Token: `${guestId}.${base64url(HMAC-SHA256(key, guestId))}` — stateless (no DB write to mint one). The HMAC key is
 * derived from ADMIN_TOKEN with a fixed domain label, so no extra secret is needed and the admin token itself never
 * signs anything a client sees.
 * guestId = `guest_<issuedAt ms, base36>_<16 hex>` — the issue time inside the id is what the daily cleanup ages on.
 */
import type { Db, Document } from "mongodb";
import { USERID_COLLECTIONS, SEQUENCE_COLLECTION } from "./clerkRemap";

export const GUEST_TTL_DAYS = 7;
const GUEST_ID_RE = /^guest_([0-9a-z]{6,12})_([0-9a-f]{16})$/;
const enc = new TextEncoder();

let cachedKey: { secret: string; key: CryptoKey } | undefined;
async function hmacKey(adminToken: string): Promise<CryptoKey> {
  if (cachedKey?.secret === adminToken) return cachedKey.key;
  const base = await crypto.subtle.importKey("raw", enc.encode(adminToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, enc.encode("uiu-guest-v1")));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  cachedKey = { secret: adminToken, key };
  return key;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function guestIssuedAt(guestId: string): number | null {
  const m = GUEST_ID_RE.exec(guestId);
  if (!m) return null;
  const t = parseInt(m[1]!, 36);
  return Number.isFinite(t) ? t : null;
}

export function isGuestId(id: string): boolean {
  return GUEST_ID_RE.test(id);
}

export async function mintGuestToken(adminToken: string, now = Date.now()): Promise<{ guestId: string; token: string; expiresAt: string }> {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const guestId = `guest_${now.toString(36)}_${rand}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(adminToken), enc.encode(guestId)));
  return { guestId, token: `${guestId}.${b64url(sig)}`, expiresAt: new Date(now + GUEST_TTL_DAYS * 864e5).toISOString() };
}

/** Returns the guest id when the token is genuine and not older than the TTL, else null. */
export async function verifyGuestToken(adminToken: string, token: string | undefined, now = Date.now()): Promise<string | null> {
  if (!token || !adminToken) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const guestId = token.slice(0, dot);
  const issued = guestIssuedAt(guestId);
  if (issued === null || issued > now + 60_000 || now - issued > GUEST_TTL_DAYS * 864e5) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(adminToken), fromB64url(token.slice(dot + 1)), enc.encode(guestId));
    return ok ? guestId : null;
  } catch {
    return null;
  }
}

/** Per-collection doc counts for one user id (userId field + meal_plan_sequence _id). */
export async function countUserDocs(db: Db, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of USERID_COLLECTIONS) {
    const n = await db.collection(name).countDocuments({ userId });
    if (n) out[name] = n;
  }
  const seq = await db.collection<Document>(SEQUENCE_COLLECTION).countDocuments({ _id: userId as unknown as Document["_id"] });
  if (seq) out[SEQUENCE_COLLECTION] = seq;
  return out;
}

export type ClaimResult = { claimed: boolean; reason?: string; moved: Record<string, number> };

/**
 * Moves a guest's docs to a freshly signed-up account. Only when the account has no per-user data yet (a brand-new
 * sign-up): merging into an existing account would collide with its plans / unique profile, so then nothing is moved
 * and the guest data simply ages out.
 */
export async function claimGuestData(db: Db, guestId: string, userId: string): Promise<ClaimResult> {
  if (!isGuestId(guestId)) return { claimed: false, reason: "bad_guest_id", moved: {} };
  const guestDocs = await countUserDocs(db, guestId);
  if (!Object.keys(guestDocs).length) return { claimed: false, reason: "guest_has_no_data", moved: {} };
  const accountDocs = await countUserDocs(db, userId);
  if (Object.keys(accountDocs).length) return { claimed: false, reason: "account_has_data", moved: {} };

  const moved: Record<string, number> = {};
  const at = new Date();
  for (const name of USERID_COLLECTIONS) {
    const r = await db.collection(name).updateMany({ userId: guestId }, { $set: { userId, claimedFromGuest: guestId, claimedAt: at } });
    if (r.modifiedCount) moved[name] = r.modifiedCount;
  }
  const seq = db.collection<Document>(SEQUENCE_COLLECTION);
  const seqDoc = await seq.findOne({ _id: guestId as unknown as Document["_id"] });
  if (seqDoc) {
    await seq.insertOne({ ...seqDoc, _id: userId as unknown as Document["_id"], claimedFromGuest: guestId, claimedAt: at });
    await seq.deleteOne({ _id: guestId as unknown as Document["_id"] });
    moved[SEQUENCE_COLLECTION] = 1;
  }
  return { claimed: true, moved };
}

export type CleanupResult = { write: boolean; expiredGuests: number; deleted: Record<string, number>; activeGuests: number };

/** Deletes every doc owned by a guest id whose issue time is older than the TTL. */
export async function cleanupExpiredGuests(db: Db, write: boolean, now = Date.now()): Promise<CleanupResult> {
  const cutoff = now - GUEST_TTL_DAYS * 864e5;
  const expired = new Set<string>();
  const active = new Set<string>();
  const sort = (id: unknown) => {
    if (typeof id !== "string") return;
    const t = guestIssuedAt(id);
    if (t === null) return;
    (t < cutoff ? expired : active).add(id);
  };
  for (const name of USERID_COLLECTIONS) {
    for (const id of await db.collection(name).distinct("userId", { userId: { $regex: "^guest_" } })) sort(id);
  }
  const seq = db.collection<Document>(SEQUENCE_COLLECTION);
  for (const d of await seq.find({ _id: { $regex: "^guest_" } as unknown as Document["_id"] }, { projection: { _id: 1 } }).toArray()) sort(d._id);

  const ids = [...expired];
  const deleted: Record<string, number> = {};
  for (const name of USERID_COLLECTIONS) {
    const filter = { userId: { $in: ids } };
    const n = write ? (await db.collection(name).deleteMany(filter)).deletedCount : await db.collection(name).countDocuments(filter);
    if (n) deleted[name] = n;
  }
  const seqFilter = { _id: { $in: ids as unknown as Document["_id"][] } };
  const sn = write ? (await seq.deleteMany(seqFilter)).deletedCount : await seq.countDocuments(seqFilter);
  if (sn) deleted[SEQUENCE_COLLECTION] = sn;
  return { write, expiredGuests: ids.length, deleted, activeGuests: active.size };
}
