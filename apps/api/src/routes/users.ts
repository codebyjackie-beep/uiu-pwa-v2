/**
 * HANDOFF_auth-subscription-front-page.md Milestone 1 — `users` collection. One document
 * per Clerk identity, created lazily the first time a signed-in user is seen. No auth
 * middleware here: the caller (apps/web) already resolved+verified the Clerk session and
 * passes clerkUserId/email as trusted input over the internal service binding.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, UiuUser } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const usersRouter = new Hono<{ Bindings: DbEnv }>();

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
usersRouter.post("/sync", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const clerkUserId = payload?.clerkUserId as string | undefined;
  const email = payload?.email as string | undefined;
  if (typeof clerkUserId !== "string" || typeof email !== "string") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "clerkUserId and email are required" } };
    return c.json(body, 400);
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
