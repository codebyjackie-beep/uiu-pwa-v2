/**
 * Admin-uploaded public media for Instagram publishing (JPEG images, MP4/MOV Reels).
 *
 * Why Mongo and not R2: R2 is not enabled on the Cloudflare account (error 10042, see igMediaStore.ts),
 * and a `[[r2_buckets]]` binding to a missing bucket would break the CI deploy. So bytes live in Mongo
 * as a single Binary doc => hard ceiling 15 MB per file (BSON doc limit is 16 MB). That covers JPEGs
 * (IG's own limit is ~8 MB) and short Reels; bigger videos get a clear `media_too_large` error until
 * R2 is enabled (swap the storage functions, keep the URL shape — callers only see a URL).
 *
 * Safety:
 *   - Upload/list/delete are admin-only (routes/adminIgMedia.ts). Only GET /api/ig-media/u/<id>.<ext> is public.
 *   - Public ids are 128-bit random hex (not ObjectIds, which are time-ordered/guessable). No listing is public.
 *   - File type comes from magic bytes, never from the Content-Type header or file name.
 *   - Every file expires (`expiresAt`, default 35 days = longer than the 30-day schedule horizon): the serve route
 *     404s once expired even before cleanup runs, a TTL index deletes it, and the 09:00 cron also sweeps.
 */
import { withDb, getMongoModule, type DbEnv } from "../db";

export const COLLECTION = "ig_uploaded_media";
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 15 * 1024 * 1024;
export const MEDIA_TTL_DAYS = 35;

export type SniffedMedia = { kind: "image" | "video"; contentType: "image/jpeg" | "image/png" | "video/mp4" | "video/quicktime"; ext: "jpg" | "png" | "mp4" | "mov"; igCompatible: boolean; note?: string };

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "dash"]);

/** Identify the file from its first bytes. Returns null for anything we don't accept. */
export function sniffMedia(b: Uint8Array): SniffedMedia | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", contentType: "image/jpeg", ext: "jpg", igCompatible: true };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { kind: "image", contentType: "image/png", ext: "png", igCompatible: false, note: "Instagram's image_url only officially supports JPEG — convert to JPEG before publishing" };
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (brand === "qt  ") return { kind: "video", contentType: "video/quicktime", ext: "mov", igCompatible: true };
    if (MP4_BRANDS.has(brand)) return { kind: "video", contentType: "video/mp4", ext: "mp4", igCompatible: true };
    return null; // other ISO-BMFF (HEIC/AVIF photos etc.)
  }
  return null;
}

export type UploadCheck = { ok: true; media: SniffedMedia } | { ok: false; status: 400 | 413 | 415; code: string; message: string };

export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, status: 400, code: "empty_body", message: "Request body is empty; send the raw file bytes" };
  const media = sniffMedia(bytes);
  if (!media) return { ok: false, status: 415, code: "unsupported_media", message: "Only JPEG, PNG, MP4 or MOV files are accepted (detected from the file bytes)" };
  const max = media.kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (bytes.length > max) {
    return {
      ok: false,
      status: 413,
      code: "media_too_large",
      message: `${media.kind} is ${bytes.length} bytes; max ${max} bytes on the current host (Mongo). Videos over 15 MB need R2 enabled on the Cloudflare account — Jackie must enable it.`,
    };
  }
  return { ok: true, media };
}

function randomId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function uploadedMediaUrl(baseUrl: string, id: string, ext: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/ig-media/u/${id}.${ext}`;
}

export interface StoredMedia {
  id: string;
  url: string;
  kind: "image" | "video";
  contentType: string;
  bytes: number;
  igCompatible: boolean;
  note?: string;
  expiresAt: string;
}

export async function storeUploadedMedia(env: DbEnv, baseUrl: string, bytes: Uint8Array, media: SniffedMedia, label?: string): Promise<StoredMedia> {
  const { Binary } = await getMongoModule();
  const id = randomId();
  const now = Date.now();
  const expiresAt = new Date(now + MEDIA_TTL_DAYS * 24 * 3600 * 1000);
  await withDb(env, async (db) => {
    const col = db.collection(COLLECTION);
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl_expiresAt" }); // idempotent
    await col.insertOne({
      _id: id as never,
      data: new Binary(bytes),
      kind: media.kind,
      contentType: media.contentType,
      ext: media.ext,
      bytes: bytes.length,
      label: label ? label.slice(0, 80) : null,
      createdAt: new Date(now),
      expiresAt,
    });
  });
  return { id, url: uploadedMediaUrl(baseUrl, id, media.ext), kind: media.kind, contentType: media.contentType, bytes: bytes.length, igCompatible: media.igCompatible, note: media.note, expiresAt: expiresAt.toISOString() };
}

/** Public read. Returns null when missing OR expired (the TTL reaper can lag by a minute or more). */
export async function getUploadedMedia(env: DbEnv, id: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const doc = await withDb(env, (db) => db.collection(COLLECTION).findOne({ _id: id as never }));
  if (!doc) return null;
  if (!(doc.expiresAt instanceof Date) || doc.expiresAt.getTime() <= Date.now()) return null;
  const bin = doc.data as { buffer: Uint8Array };
  return { data: new Uint8Array(bin.buffer), contentType: String(doc.contentType) };
}

export async function listUploadedMedia(env: DbEnv, baseUrl: string): Promise<Array<Omit<StoredMedia, "igCompatible" | "note"> & { label: string | null; createdAt: string }>> {
  const docs = await withDb(env, (db) => db.collection(COLLECTION).find({}, { projection: { data: 0 } }).sort({ createdAt: -1 }).limit(100).toArray());
  return docs.map((d) => ({
    id: String(d._id),
    url: uploadedMediaUrl(baseUrl, String(d._id), String(d.ext)),
    kind: d.kind as "image" | "video",
    contentType: String(d.contentType),
    bytes: Number(d.bytes),
    label: (d.label as string | null) ?? null,
    createdAt: (d.createdAt as Date).toISOString(),
    expiresAt: (d.expiresAt as Date).toISOString(),
  }));
}

export async function deleteUploadedMedia(env: DbEnv, id: string): Promise<number> {
  if (!/^[0-9a-f]{32}$/.test(id)) return 0;
  const r = await withDb(env, (db) => db.collection(COLLECTION).deleteOne({ _id: id as never }));
  return r.deletedCount;
}

/** Belt-and-braces sweep beside the TTL index (09:00 UTC cron). */
export async function purgeExpiredMedia(env: DbEnv): Promise<number> {
  const r = await withDb(env, (db) => db.collection(COLLECTION).deleteMany({ expiresAt: { $lte: new Date() } }));
  return r.deletedCount;
}
