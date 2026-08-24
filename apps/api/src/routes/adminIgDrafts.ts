/**
 * Read-only admin API for ig_content_drafts (HANDOFF_ig-marketing-affiliate-agent-design.md).
 * X-Admin-Token protected, same convention as /api/admin/recipe-drafts.
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import type { IgContentDraft } from "../jobs/igContentAgent";

export const adminIgDraftsRouter = new Hono<{ Bindings: DbEnv & { ADMIN_TOKEN: string } }>();

function toIgDraft(doc: Document): Omit<IgContentDraft, "_id"> & { _id: string } {
  return { ...(doc as unknown as IgContentDraft), _id: String(doc._id) };
}

/** `?status=` optional. Pass "all" for every status, omit for the default (all, most recent first). */
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
