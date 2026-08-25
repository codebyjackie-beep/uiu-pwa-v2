/** Public (no auth) — serves branded PNGs stored by services/igMediaStore.ts. Instagram's
 * media_publish and shop.useitup.uk's public page both need a plain public URL. */
import { Hono } from "hono";
import type { DbEnv } from "../db";
import { getBrandedImage } from "../services/igMediaStore";

export const igMediaRouter = new Hono<{ Bindings: DbEnv }>();

igMediaRouter.get("/:id", async (c) => {
  const id = c.req.param("id").replace(/\.png$/i, "");
  const png = await getBrandedImage(c.env, id);
  if (!png) return c.notFound();
  return new Response(png as unknown as BodyInit, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
});
