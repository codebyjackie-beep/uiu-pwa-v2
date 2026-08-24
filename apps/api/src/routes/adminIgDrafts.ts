/**
 * Read-only admin API for ig_content_drafts (HANDOFF_ig-marketing-affiliate-agent-design.md).
 * X-Admin-Token protected, same convention as /api/admin/recipe-drafts.
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { retryDraft, type IgContentDraft } from "../jobs/igContentAgent";

type VerifyBindings = DbEnv & {
  ADMIN_TOKEN: string;
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
  TELEGRAM_BOT_TOKEN_IG: string;
  TELEGRAM_CHAT_ID_IG: string;
};

export const adminIgDraftsRouter = new Hono<{ Bindings: VerifyBindings }>();

function toIgDraft(doc: Document): Omit<IgContentDraft, "_id"> & { _id: string } {
  return { ...(doc as unknown as IgContentDraft), _id: String(doc._id) };
}

/** `?status=` optional. Pass "all" for every status, omit for the default (all, most recent first). */
/**
 * Cross-checks each approved draft's publishedMediaId against the Instagram
 * Graph API, using the *same* account token the draft claims to belong to
 * (accountFor's mapping, duplicated here) — if targetAccount and the token
 * actually used to publish had ever diverged, this call would 400/403
 * because the wrong token has no permission on that media node.
 */
adminIgDraftsRouter.get("/verify-media", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const docs = await withDb(c.env, (db) =>
      db.collection("ig_content_drafts").find({ status: "approved", publishedMediaId: { $exists: true } }).sort({ createdAt: -1 }).toArray(),
    );
    const results = await Promise.all(
      docs.map(async (doc) => {
        const targetAccount = doc.targetAccount as "uiu" | "affiliate";
        const accessToken = targetAccount === "uiu" ? c.env.IG_TOKEN_UIU : c.env.IG_TOKEN_AFFILIATE;
        const igUserId = targetAccount === "uiu" ? c.env.IG_ID_UIU : c.env.IG_ID_AFFILIATE;
        const mediaId = String(doc.publishedMediaId);
        const url = new URL(`https://graph.facebook.com/v21.0/${mediaId}`);
        url.searchParams.set("fields", "permalink,timestamp,media_product_type");
        url.searchParams.set("access_token", accessToken);
        try {
          const res = await fetch(url);
          const json = (await res.json()) as { permalink?: string; timestamp?: string; error?: { message?: string } };
          return {
            _id: String(doc._id),
            targetAccount,
            igUserIdChecked: igUserId,
            mediaId,
            httpStatus: res.status,
            permalink: json.permalink ?? null,
            igTimestamp: json.timestamp ?? null,
            graphError: json.error?.message ?? null,
          };
        } catch (err) {
          return { _id: String(doc._id), targetAccount, mediaId, httpStatus: 0, permalink: null, igTimestamp: null, graphError: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const body: ApiResponse<typeof results> = { ok: true, data: results };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts verify-media error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to verify media" } };
    return c.json(body, 502);
  }
});

/** Retries a publish_failed draft (e.g. after the 9007-race fix) without waiting for a Telegram tap on a stale message. */
adminIgDraftsRouter.post("/:id/retry", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const { ObjectId } = await getMongoModule();
    const draftId = new ObjectId(c.req.param("id"));
    const result = await retryDraft(c.env, draftId);
    const body: ApiResponse<typeof result> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts retry error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to retry draft" } };
    return c.json(body, 502);
  }
});

adminIgDraftsRouter.get("/", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const statusParam = c.req.query("status");
  const filter = statusParam && statusParam !== "all" ? { status: statusParam } : {};
  try {
    const docs = await withDb(c.env, (db) => db.collection("ig_content_drafts").find(filter).sort({ createdAt: -1 }).limit(30).toArray());
    const body: ApiResponse<Array<Omit<IgContentDraft, "_id"> & { _id: string }>> = { ok: true, data: docs.map(toIgDraft) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch ig_content_drafts" } };
    return c.json(body, 502);
  }
});
