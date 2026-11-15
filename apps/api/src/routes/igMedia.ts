/** Public (no auth) — serves branded PNGs stored by services/igMediaStore.ts. Instagram's
 * media_publish and shop.useitup.uk's public page both need a plain public URL. */
import { Hono } from "hono";
import type { DbEnv } from "../db";
import { getBrandedImage } from "../services/igMediaStore";
import { getUploadedMedia } from "../services/igUploadedMedia";

export const igMediaRouter = new Hono<{ Bindings: DbEnv }>();

igMediaRouter.get("/:id", async (c) => {
  const id = c.req.param("id").replace(/\.png$/i, "");
  const png = await getBrandedImage(c.env, id);
  if (!png) return c.notFound();
  return new Response(png as unknown as BodyInit, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
});

// Admin-uploaded JPEG/MP4 for IG publishing (services/igUploadedMedia.ts). Unguessable id, expires, supports Range for video fetchers.
igMediaRouter.get("/u/:file", async (c) => {
  const id = c.req.param("file").replace(/\.(jpg|png|mp4|mov)$/i, "");
  const m = await getUploadedMedia(c.env, id);
  if (!m) return c.notFound();
  const headers: Record<string, string> = { "Content-Type": m.contentType, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600", "X-Robots-Tag": "noindex" };
  const total = m.data.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("Range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    return new Response(m.data.slice(start, end + 1) as unknown as BodyInit, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(m.data as unknown as BodyInit, { headers: { ...headers, "Content-Length": String(total) } });
});
