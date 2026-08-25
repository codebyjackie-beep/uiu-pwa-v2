/**
 * Public host for composited branded images (services/brandedImage.ts). Instagram's
 * media_publish needs a public HTTPS URL, and R2 is not enabled on this Cloudflare account
 * yet (confirmed live 2026-08-25: `wrangler r2 bucket list` -> error 10042, "Please enable
 * R2 through the Cloudflare Dashboard" — a manual dashboard step, same category as the
 * shop.useitup.uk Custom Domain gate). Rather than block this feature on that, PNG bytes
 * are stored as Mongo Binary and served back by routes/igMedia.ts — same public-URL result,
 * no new infra dependency. Swap to R2 later if Jackie enables it; callers only see a URL.
 */
import { withDb, getMongoModule, type DbEnv } from "../db";

const COLLECTION = "ig_branded_images";

export async function storeBrandedImage(env: DbEnv, png: Uint8Array): Promise<string> {
  const { Binary, ObjectId } = await getMongoModule();
  const id = new ObjectId();
  await withDb(env, async (db) => {
    await db.collection(COLLECTION).insertOne({ _id: id, png: new Binary(png), contentType: "image/png", createdAt: new Date().toISOString() });
  });
  return id.toString();
}

export async function getBrandedImage(env: DbEnv, id: string): Promise<Uint8Array | null> {
  const { ObjectId, Binary } = await getMongoModule();
  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }
  const doc = await withDb(env, (db) => db.collection(COLLECTION).findOne({ _id: objectId }));
  if (!doc) return null;
  const bin = doc.png as InstanceType<typeof Binary>;
  return new Uint8Array(bin.buffer);
}

export function brandedImageUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/api/ig-media/${id}.png`;
}
