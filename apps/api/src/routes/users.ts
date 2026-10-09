/**
 * HANDOFF_auth-subscription-front-page.md Milestone 1 — `users` collection. One document
 * per Clerk identity, created lazily the first time a signed-in user is seen.
 *
 * cc_prompt_milestone1_followup_fixes.md gap 1: apps/api has its own public workers.dev URL,
 * so `/sync` can't just trust a clerkUserId typed into the request body — requireClerkAuth
 * verifies the real session JWT against Clerk's JWKS first, and the handler below checks the
 * body's clerkUserId against the verified token's sub rather than trusting it outright.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, UiuUser } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { requireClerkAuth, type ClerkAuthEnv } from "../clerkAuth";

export const usersRouter = new Hono<{ Bindings: DbEnv & ClerkAuthEnv & { CLERK_SECRET_KEY?: string } }>();

/** M2: only tokens minted by our own origins may sync (the web app on useitup.uk / its workers.dev preview). */
function azpAllowed(azp: string | undefined): boolean {
  if (!azp) return false;
  try {
    const host = new URL(azp).hostname;
    return host === "useitup.uk" || host === "www.useitup.uk" || /^uiu-web(\.[a-z0-9-]+)?\.workers\.dev$/.test(host);
  } catch {
    return false;
  }
}

/** Email comes from the verified token if it carries one, else Clerk's Backend API — never from the request body. */
async function verifiedEmail(c: { env: { CLERK_SECRET_KEY?: string }; var: { clerkUserId: string; clerkTokenEmail: string | undefined } }): Promise<string | null> {
  if (c.var.clerkTokenEmail) return c.var.clerkTokenEmail;
  const secret = c.env.CLERK_SECRET_KEY;
  if (!secret) return null;
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(c.var.clerkUserId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { primary_email_address_id?: string; email_addresses?: { id: string; email_address: string }[] };
  const primary = user.email_addresses?.find((e) => e.id === user.primary_email_address_id) ?? user.email_addresses?.[0];
  return primary?.email_address ?? null;
}

function toUser(doc: Document): UiuUser {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    clerkUserId: doc.clerkUserId as string,
    email: doc.email as string,
    createdAt: doc.createdAt as string,
    subscriptionStatus: (doc.subscriptionStatus as UiuUser["subscriptionStatus"]) ?? "free",
  };
}

/** Get-or-create by clerkUserId. Called once per session bootstrap from apps/web. */
usersRouter.post("/sync", requireClerkAuth, async (c) => {
  const payload = await c.req.json().catch(() => null);
  const clerkUserId = payload?.clerkUserId as string | undefined;
  if (typeof clerkUserId !== "string") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "clerkUserId is required" } };
    return c.json(body, 400);
  }
  if (!azpAllowed(c.var.clerkAzp)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "forbidden", message: "token origin not allowed" } };
    return c.json(body, 403);
  }
  if (clerkUserId !== c.var.clerkUserId) {
    const body: ApiResponse<never> = { ok: false, error: { code: "forbidden", message: "clerkUserId does not match verified session" } };
    return c.json(body, 403);
  }

  try {
    const existingUser = await withDb(c.env, (db) => db.collection("users").findOne({ clerkUserId }));
    const email = existingUser ? null : await verifiedEmail(c);
    if (!existingUser && !email) {
      const body: ApiResponse<never> = { ok: false, error: { code: "email_unavailable", message: "Could not determine the verified email" } };
      return c.json(body, 502);
    }
    const result = await withDb(c.env, async (db) => {
      const existing = existingUser ?? (await db.collection("users").findOne({ clerkUserId }));
      if (existing) return existing;
      const doc = {
        clerkUserId,
        email: email as string,
        createdAt: new Date().toISOString(),
        subscriptionStatus: "free" as const,
      };
      const inserted = await db.collection("users").insertOne(doc);
      return { ...doc, _id: inserted.insertedId };
    });

    const body: ApiResponse<UiuUser> = { ok: true, data: toUser(result) };
    return c.json(body, 200);
  } catch (err) {
    console.error("[uiu-api] users/sync error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to sync user" } };
    return c.json(body, 502);
  }
});
