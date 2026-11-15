/**
 * Admin-only media host for Instagram publishing.
 *   POST   /api/admin/ig-media?write=true[&label=..]   raw file bytes in the body -> {id, url, ...}
 *   GET    /api/admin/ig-media                         list (no bytes)
 *   DELETE /api/admin/ig-media/:id?write=true
 * Default is DRY-RUN: without ?write=true the body is validated (type via magic bytes, size) and nothing is stored.
 * See services/igUploadedMedia.ts for limits, expiry and why this is Mongo-backed.
 */
import { Hono } from "hono";
import type { ApiResponse } from "@uiu/shared";
import type { DbEnv } from "../db";
import { requireAdmin } from "../adminAuth";
import { checkUpload, deleteUploadedMedia, listUploadedMedia, storeUploadedMedia, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, MEDIA_TTL_DAYS } from "../services/igUploadedMedia";

type Bindings = DbEnv & { ADMIN_TOKEN: string; PUBLIC_API_BASE_URL?: string };
export const adminIgMediaRouter = new Hono<{ Bindings: Bindings }>();
adminIgMediaRouter.use("*", requireAdmin);

const err = (code: string, message: string): ApiResponse<never> => ({ ok: false, error: { code, message } });
const base = (env: Bindings) => env.PUBLIC_API_BASE_URL ?? "https://uiu-api.codeby-jackie.workers.dev";

adminIgMediaRouter.post("/", async (c) => {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > VIDEO_MAX_BYTES) return c.json(err("media_too_large", `Body is ${declared} bytes; max ${VIDEO_MAX_BYTES} (video) / ${IMAGE_MAX_BYTES} (image) on the current host. Larger videos need R2 enabled.`), 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const check = checkUpload(bytes);
  if (!check.ok) return c.json(err(check.code, check.message), check.status);
  if (c.req.query("write") !== "true") {
    return c.json({ ok: true, data: { dryRun: true, wouldStore: { kind: check.media.kind, contentType: check.media.contentType, bytes: bytes.length, igCompatible: check.media.igCompatible, note: check.media.note ?? null, expiresInDays: MEDIA_TTL_DAYS } } } satisfies ApiResponse<unknown>);
  }
  try {
    const stored = await storeUploadedMedia(c.env, base(c.env), bytes, check.media, c.req.query("label") || undefined);
    return c.json({ ok: true, data: { dryRun: false, ...stored } } satisfies ApiResponse<unknown>);
  } catch (e) {
    console.error("[uiu-api] ig-media store failed:", e instanceof Error ? e.message : String(e));
    return c.json(err("db_error", "Could not store the media"), 502);
  }
});

adminIgMediaRouter.get("/", async (c) => {
  try {
    return c.json({ ok: true, data: { files: await listUploadedMedia(c.env, base(c.env)) } } satisfies ApiResponse<unknown>);
  } catch {
    return c.json(err("db_error", "Could not list media"), 502);
  }
});

adminIgMediaRouter.delete("/:id", async (c) => {
  if (c.req.query("write") !== "true") return c.json({ ok: true, data: { dryRun: true, note: "Add ?write=true to delete" } } satisfies ApiResponse<unknown>);
  const n = await deleteUploadedMedia(c.env, c.req.param("id")).catch(() => -1);
  if (n < 0) return c.json(err("db_error", "Delete failed"), 502);
  return c.json({ ok: true, data: { deleted: n } } satisfies ApiResponse<unknown>);
});
