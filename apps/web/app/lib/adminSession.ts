import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { NextRequest } from "next/server";

/**
 * Page-scoped admin session for /admin/recipe-drafts. Deliberately separate from the core
 * `ADMIN_TOKEN` (which guards every /api/admin/* route): this password can be rotated or
 * shared for automated testing without touching the token that protects the rest of the
 * admin surface. See HANDOFF_recipe-drafts-admin-login.md.
 */

const COOKIE_NAME = "admin_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface AdminSessionEnv {
  RECIPE_DRAFTS_ADMIN_PASSWORD?: string;
  ADMIN_TOKEN?: string;
}

async function resolveAdminEnv(): Promise<AdminSessionEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as AdminSessionEnv;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return toHex(sig);
}

/** Fixed-length digest comparison so string length never leaks through early-exit `===`. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(candidate: string): Promise<boolean> {
  const env = await resolveAdminEnv();
  const expected = env.RECIPE_DRAFTS_ADMIN_PASSWORD;
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  return constantTimeEqual(a, b);
}

export async function createSessionCookie(): Promise<string> {
  const env = await resolveAdminEnv();
  const secret = env.RECIPE_DRAFTS_ADMIN_PASSWORD ?? "";
  const expires = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, String(expires));
  const value = `${expires}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function verifySessionFromRequest(req: NextRequest | Request): Promise<boolean> {
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return false;
  const [expiresStr, sig] = raw.split(".");
  if (!expiresStr || !sig) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const env = await resolveAdminEnv();
  const secret = env.RECIPE_DRAFTS_ADMIN_PASSWORD ?? "";
  const expected = await hmacHex(secret, expiresStr);
  return constantTimeEqual(expected, sig);
}

export async function getAdminToken(): Promise<string> {
  const env = await resolveAdminEnv();
  return env.ADMIN_TOKEN ?? "";
}
