/**
 * TEMPORARY admin test for "Upload a video" import (Jackie 2026-10-30: 10-reel test set, 80% bar before launch).
 * Mirrors POST /api/recipe-import/from-video exactly: same size cap, same 3 attempts, same model call. Admin-only, no DB write.
 * Delete this file (and its app.route line in index.ts) once the test is done.
 */
import { Hono } from "hono";
import { requireAdmin } from "../adminAuth";
import { extractRecipeFromVideo, type OpenRouterVisionEnv } from "../services/openrouterVision";

const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
const VIDEO_DATA_URL = /^data:video\/(mp4|quicktime|mov|webm|mpeg);base64,/i;

export const adminVideoImportTestRouter = new Hono<{ Bindings: OpenRouterVisionEnv & { ADMIN_TOKEN: string } }>();

adminVideoImportTestRouter.use("*", requireAdmin);

adminVideoImportTestRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const label = typeof payload?.label === "string" ? payload.label.slice(0, 60) : "";
  const video = payload?.video as unknown;
  if (typeof video !== "string" || !VIDEO_DATA_URL.test(video)) {
    return c.json({ ok: false, error: { code: "bad_request", message: "video must be an mp4, mov, webm or mpeg data URL" } }, 400);
  }
  const base64Length = video.length - video.indexOf(",") - 1;
  const bytes = Math.round(base64Length * 0.75);
  if (bytes > MAX_VIDEO_BYTES) {
    return c.json({ ok: true, data: { label, bytes, tooLarge: true, success: false } });
  }
  const normalized = video.replace(/^data:video\/quicktime;/i, "data:video/mov;");
  const started = Date.now();
  let parsed: Awaited<ReturnType<typeof extractRecipeFromVideo>> = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
    attempts = attempt;
    parsed = await extractRecipeFromVideo(c.env, normalized);
  }
  const ingredients = parsed?.ingredients ?? [];
  const steps = parsed?.steps ?? [];
  const success = Boolean(parsed) && ingredients.length >= 3 && steps.length >= 3 && Boolean(parsed?.title);
  return c.json({
    ok: true,
    data: {
      label,
      bytes,
      tooLarge: false,
      attempts,
      seconds: Math.round((Date.now() - started) / 1000),
      success,
      title: parsed?.title ?? null,
      ingredientCount: ingredients.length,
      stepCount: steps.length,
      ingredients: ingredients.map((i) => `${i.quantity ?? ""} ${i.unit ?? ""} ${i.name}`.replace(/\s+/g, " ").trim()),
      steps: steps.map((s) => (typeof s === "string" ? s : JSON.stringify(s)).slice(0, 160)),
    },
  });
});
