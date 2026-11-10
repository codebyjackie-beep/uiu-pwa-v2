/**
 * POST /api/admin/ig-publish — publish a Bella publish pack to @useitup.uk via the Instagram Graph API.
 *
 * Safety model:
 *   - X-Admin-Token (requireAdmin).
 *   - Dry-run is the DEFAULT: validates, returns the Graph calls that would be made, calls nothing.
 *   - A real publish needs BOTH body `write: true` AND IG_AUTOMATION_PAUSED unset/"false".
 *   - Identical content already published in the last 24h is refused (409) — no accidental double posts.
 *   - Every request writes an `ig_publish_audit` record (never the token, no health data).
 *
 * Media URLs: Instagram's servers download the media from a public HTTPS URL. Today the API can
 * only host PNGs it rendered itself (services/igMediaStore.ts -> /api/ig-media/<id>.png, stored in
 * Mongo). There is NO upload route and NO video hosting (R2 is not enabled on the Cloudflare
 * account), so Bella's mp4/jpg files on Jackie's PC cannot be published until a public host exists
 * (enable R2 + upload route, or any public HTTPS host). Note IG's docs say image_url must be JPEG.
 *
 * Scheduling: the Instagram Graph API has no scheduled-publish parameter, so none is offered.
 * The caller (AI Office / cron) invokes this endpoint at the desired time.
 */
import { Hono } from "hono";
import type { ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { requireAdmin } from "../adminAuth";
import { accountFor, type PublishEnv } from "../jobs/igContentAgent";
import { buildGraphPlan, contentHash, executePublish, GraphError, pausedRefusal, validatePublishRequest } from "../services/igPublish";

type Bindings = DbEnv & {
  ADMIN_TOKEN: string;
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_AUTOMATION_PAUSED?: string;
};

export const adminIgPublishRouter = new Hono<{ Bindings: Bindings }>();
adminIgPublishRouter.use("*", requireAdmin);

const AUDIT = "ig_publish_audit";
const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

function fail(c: { json: (b: unknown, s: number) => Response }, status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  const body: ApiResponse<never> & { details?: unknown } = { ok: false, error: { code, message }, ...(extra ? { details: extra } : {}) };
  return c.json(body, status);
}

adminIgPublishRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const v = validatePublishRequest(payload);
  if (!v.ok) return fail(c, 400, "invalid_payload", "Invalid publish request", { errors: v.errors });
  const req = v.value;

  const account = accountFor(c.env as unknown as PublishEnv, "uiu");
  const plan = buildGraphPlan(req, account.igUserId);
  const hash = await contentHash(req);
  const pausedReason = pausedRefusal(c.env.IG_AUTOMATION_PAUSED);
  const auditBase = {
    type: req.type,
    captionLength: req.caption.length,
    caption: req.caption,
    mediaUrls: req.type === "image" ? [req.imageUrl] : req.type === "carousel" ? req.imageUrls : [req.videoUrl, ...(req.coverUrl ? [req.coverUrl] : [])],
    hasFirstComment: !!req.firstComment,
    igUserId: account.igUserId,
    contentHash: hash,
    createdAt: new Date().toISOString(),
  };

  // ---- dry-run (default) ----
  if (!req.write) {
    let auditId: string | null = null;
    try {
      const res = await withDb(c.env, (db) => db.collection(AUDIT).insertOne({ ...auditBase, dryRun: true, status: "dry_run", wouldRefuse: pausedReason }));
      auditId = String(res.insertedId);
    } catch (err) {
      console.error("[uiu-api] ig-publish dry-run audit failed:", err instanceof Error ? err.message : String(err));
    }
    const body: ApiResponse<unknown> = {
      ok: true,
      data: { dryRun: true, wouldRefuseRealPublish: pausedReason, graphCalls: plan, auditId, note: "No Graph API call made. Send write:true to publish for real." },
    };
    return c.json(body);
  }

  // ---- real publish ----
  if (pausedReason) {
    await withDb(c.env, (db) => db.collection(AUDIT).insertOne({ ...auditBase, dryRun: false, status: "refused_paused" })).catch(() => undefined);
    return fail(c, 403, "ig_automation_paused", pausedReason);
  }
  if (!c.env.IG_TOKEN_UIU || !c.env.IG_ID_UIU) return fail(c, 500, "ig_not_configured", "IG_TOKEN_UIU / IG_ID_UIU missing");

  let auditId: unknown;
  try {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const dup = await withDb(c.env, (db) => db.collection(AUDIT).findOne({ contentHash: hash, status: { $in: ["published", "publishing"] }, createdAt: { $gte: since } }));
    if (dup) return fail(c, 409, "duplicate_publish", "Identical content was published (or is publishing) in the last 24h", { auditId: String(dup._id), mediaId: dup.mediaId ?? null });
    auditId = (await withDb(c.env, (db) => db.collection(AUDIT).insertOne({ ...auditBase, dryRun: false, status: "publishing" }))).insertedId;
  } catch (err) {
    console.error("[uiu-api] ig-publish audit start failed:", err instanceof Error ? err.message : String(err));
    return fail(c, 502, "db_error", "Could not write audit record; refusing to publish without one");
  }

  try {
    const result = await executePublish(account, req);
    await withDb(c.env, (db) =>
      db.collection(AUDIT).updateOne({ _id: auditId as never }, { $set: { status: "published", mediaId: result.mediaId, commentId: result.commentId ?? null, commentError: result.commentError ?? null, finishedAt: new Date().toISOString() } }),
    ).catch(() => undefined);
    const body: ApiResponse<unknown> = { ok: true, data: { dryRun: false, ...result, auditId: String(auditId) } };
    return c.json(body);
  } catch (err) {
    // GraphError messages are already token-redacted.
    const message = err instanceof Error ? err.message : String(err);
    await withDb(c.env, (db) => db.collection(AUDIT).updateOne({ _id: auditId as never }, { $set: { status: "failed", error: message.slice(0, 500), finishedAt: new Date().toISOString() } })).catch(() => undefined);
    console.error("[uiu-api] ig-publish failed:", message);
    return fail(c, err instanceof GraphError && err.status >= 400 && err.status < 500 ? 400 : 502, "graph_error", message, { auditId: String(auditId) });
  }
});
