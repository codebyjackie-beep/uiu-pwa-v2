/**
 * POST /api/webhooks/clerk — Clerk (via Svix) → us. Signature-verified, no other auth.
 * Only `user.deleted` does anything: services/userDeletion.ts erases the user's personal data (keeps billing records).
 * Anything else is acknowledged and ignored. A failure returns 500 so Svix retries (idempotent).
 */
import { Hono } from "hono";
import { withDb } from "../db";
import type { Bindings } from "../bindings";
import { verifySvix } from "../services/svix";
import { eraseUserData } from "../services/userDeletion";

export const clerkWebhookRouter = new Hono<{ Bindings: Bindings & { STRIPE_SECRET_KEY?: string } }>();

clerkWebhookRouter.post("/clerk", async (c) => {
  const secret = c.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return c.json({ ok: false, error: { code: "not_configured" } }, 503);

  const raw = await c.req.text();
  const valid = await verifySvix(
    raw,
    { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") },
    secret,
  );
  if (!valid) return c.json({ ok: false, error: { code: "bad_signature" } }, 400);

  let ev: { type?: unknown; data?: { id?: unknown } } | null = null;
  try {
    ev = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: { code: "bad_event" } }, 400);
  }
  if (ev?.type !== "user.deleted") return c.json({ ok: true, data: { ignored: ev?.type ?? null } });

  const userId = ev.data?.id;
  try {
    const out = await withDb(c.env, (db) => eraseUserData(db, c.env, userId, true));
    // counts only — never log ids' contents, emails or health data
    console.log("[uiu-api] clerk user.deleted erased:", JSON.stringify({ deleted: out.deleted, stripe: out.stripeResult }));
    return c.json({ ok: true, data: { erased: true } });
  } catch (err) {
    console.error("[uiu-api] clerk user.deleted error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "server_error" } }, 500);
  }
});
