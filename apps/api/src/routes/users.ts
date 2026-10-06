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

export const usersRouter = new Hono<{ Bindings: DbEnv & ClerkAuthEnv }>();

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
  const email = payload?.email as string | undefined;
  if (typeof clerkUserId !== "string" || typeof email !== "string") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "clerkUserId and email are required" } };
    return c.json(body, 400);
  }
  if (clerkUserId !== c.var.clerkUserId) {
    const body: ApiResponse<never> = { ok: false, error: { code: "forbidden", message: "clerkUserId does not match verified session" } };
    return c.json(body, 403);
  }

  try {
    const result = await withDb(c.env, async (db) => {
      const existing = await db.collection("users").findOne({ clerkUserId });
      if (existing) return existing;
      const doc = {
        clerkUserId,
        email,
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
