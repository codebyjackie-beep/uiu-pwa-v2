/**
 * Admin-driven Instagram publishing from a Bella "publish pack" (image / carousel / Reel).
 *
 * - validatePublishRequest(): pure payload validation, no I/O.
 * - buildGraphPlan(): the exact Graph API calls that WOULD be made (token never included) —
 *   this is what dry-run returns.
 * - executePublish(): the real Graph API calls (container -> poll -> media_publish [-> first comment]).
 *
 * Instagram's Content Publishing API has NO scheduling parameter (unlike Facebook Pages'
 * scheduled_publish_time; checked against Meta's Content Publishing guide 2026-11-15), so a future
 * `publishAt` is implemented by us: the request is queued in Mongo (services/igPublishQueue.ts) and
 * the hourly cron publishes it. Media must be fetchable by Instagram from a public HTTPS URL
 * (IG's servers download it) — see routes/adminIgPublish.ts header.
 */
import type { InstagramAccount } from "./instagram";

export const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type IgPostType = "image" | "carousel" | "reel";

export interface IgPublishRequest {
  type: IgPostType;
  caption: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  coverUrl?: string;
  firstComment?: string;
  /** Normalised UTC ISO instant (on the hour). Present => queue for the hourly cron instead of publishing now. */
  publishAt?: string;
  /** Real publish only when exactly `true`. */
  write: boolean;
}

export const CAPTION_MAX = 2200;
export const HASHTAG_MAX = 30;
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
const COMMENT_MAX = 2200;

export type Validation = { ok: true; value: IgPublishRequest } | { ok: false; errors: string[] };

/** Public HTTPS URL only: no credentials, no localhost / private / IP-literal hosts (IG can't fetch those, and it blocks SSRF-ish mistakes). */
export function checkPublicUrl(raw: unknown, label: string): string | null {
  if (typeof raw !== "string" || !raw) return `${label} must be a non-empty string URL`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${label} is not a valid URL`;
  }
  if (u.protocol !== "https:") return `${label} must be https`;
  if (u.username || u.password) return `${label} must not contain credentials`;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return `${label} host is not public`;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return `${label} must use a hostname, not an IP address`;
  if (!h.includes(".")) return `${label} host is not public`;
  return null;
}

export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 3600 * 1000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse `publishAt`: ISO-8601 WITH offset, on a UTC hour boundary (the cron fires at :00), 1 min .. 30 days ahead. */
export function parsePublishAt(raw: unknown, now: number): { ok: true; iso: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !ISO_WITH_OFFSET.test(raw)) return { ok: false, error: 'publishAt must be an ISO-8601 time WITH offset, e.g. "2026-11-16T18:00:00+00:00" or "...Z"' };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { ok: false, error: "publishAt is not a valid time" };
  if (t % 3600000 !== 0) return { ok: false, error: "publishAt must be on a UTC hour boundary (the scheduler fires hourly at :00 UTC; 18:00 UK = 18:00Z in winter / 17:00Z in summer)" };
  if (t < now + 60000) return { ok: false, error: "publishAt must be in the future" };
  if (t > now + MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: "publishAt is more than 30 days ahead" };
  return { ok: true, iso: new Date(t).toISOString() };
}

export function validatePublishRequest(body: unknown, now: number = Date.now()): Validation {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["type", "caption", "imageUrl", "imageUrls", "videoUrl", "coverUrl", "firstComment", "publishAt", "write"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) errors.push(`unknown field "${k}"`);
  let publishAt: string | undefined;
  if (b.publishAt !== undefined) {
    const pa = parsePublishAt(b.publishAt, now);
    if (pa.ok) publishAt = pa.iso;
    else errors.push(pa.error);
  }

  const type = b.type;
  if (type !== "image" && type !== "carousel" && type !== "reel") errors.push('type must be "image", "carousel" or "reel"');

  const caption = b.caption;
  if (typeof caption !== "string" || !caption.trim()) errors.push("caption is required");
  else {
    if (caption.length > CAPTION_MAX) errors.push(`caption exceeds ${CAPTION_MAX} characters`);
    const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    if (tags.length > HASHTAG_MAX) errors.push(`caption has ${tags.length} hashtags (max ${HASHTAG_MAX})`);
  }

  if (b.write !== undefined && typeof b.write !== "boolean") errors.push("write must be a boolean");

  const only = (fields: string[]) => {
    for (const f of ["imageUrl", "imageUrls", "videoUrl", "coverUrl"]) {
      if (!fields.includes(f) && b[f] !== undefined) errors.push(`${f} is not allowed for type "${String(type)}"`);
    }
  };
  if (type === "image") {
    only(["imageUrl"]);
    const e = checkPublicUrl(b.imageUrl, "imageUrl");
    if (e) errors.push(e);
  } else if (type === "carousel") {
    only(["imageUrls"]);
    if (!Array.isArray(b.imageUrls)) errors.push("imageUrls must be an array");
    else {
      if (b.imageUrls.length < CAROUSEL_MIN || b.imageUrls.length > CAROUSEL_MAX) errors.push(`imageUrls must have ${CAROUSEL_MIN}-${CAROUSEL_MAX} items`);
      b.imageUrls.forEach((u, i) => {
        const e = checkPublicUrl(u, `imageUrls[${i}]`);
        if (e) errors.push(e);
      });
    }
  } else if (type === "reel") {
    only(["videoUrl", "coverUrl"]);
    const e = checkPublicUrl(b.videoUrl, "videoUrl");
    if (e) errors.push(e);
    if (b.coverUrl !== undefined) {
      const ce = checkPublicUrl(b.coverUrl, "coverUrl");
      if (ce) errors.push(ce);
    }
  }

  if (b.firstComment !== undefined) {
    if (typeof b.firstComment !== "string" || !b.firstComment.trim()) errors.push("firstComment must be a non-empty string");
    else if (b.firstComment.length > COMMENT_MAX) errors.push(`firstComment exceeds ${COMMENT_MAX} characters`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: type as IgPostType,
      caption: (caption as string).trim(),
      imageUrl: b.imageUrl as string | undefined,
      imageUrls: b.imageUrls as string[] | undefined,
      videoUrl: b.videoUrl as string | undefined,
      coverUrl: b.coverUrl as string | undefined,
      firstComment: typeof b.firstComment === "string" ? b.firstComment.trim() : undefined,
      publishAt,
      write: b.write === true,
    },
  };
}

/** Why a real publish must be refused right now, or null if allowed. Only an unset or "false" flag allows it. */
export function pausedRefusal(flag: string | undefined): string | null {
  if (flag === undefined || flag === "" || flag.toLowerCase() === "false") return null;
  return `IG_AUTOMATION_PAUSED is "${flag}" — publishing is paused. Jackie must unset it (or set "false") before a real publish.`;
}

export interface PlannedCall {
  step: string;
  method: "POST" | "GET";
  path: string;
  params: Record<string, string>;
}

/** The Graph calls a publish would make. `access_token` is deliberately omitted. */
export function buildGraphPlan(req: IgPublishRequest, igUserId: string): PlannedCall[] {
  const media = `/${igUserId}/media`;
  const publish: PlannedCall = { step: "media_publish", method: "POST", path: `/${igUserId}/media_publish`, params: { creation_id: "<container id>" } };
  const comment: PlannedCall[] = req.firstComment ? [{ step: "first_comment", method: "POST", path: "/<published media id>/comments", params: { message: req.firstComment } }] : [];
  if (req.type === "image") {
    return [{ step: "create_container", method: "POST", path: media, params: { image_url: req.imageUrl!, caption: req.caption } }, publish, ...comment];
  }
  if (req.type === "reel") {
    const params: Record<string, string> = { media_type: "REELS", video_url: req.videoUrl!, caption: req.caption, share_to_feed: "true" };
    if (req.coverUrl) params.cover_url = req.coverUrl;
    return [{ step: "create_container", method: "POST", path: media, params }, publish, ...comment];
  }
  const kids: PlannedCall[] = req.imageUrls!.map((u, i) => ({ step: `create_child_${i + 1}`, method: "POST", path: media, params: { image_url: u, is_carousel_item: "true" } }));
  const parent: PlannedCall = {
    step: "create_carousel_container",
    method: "POST",
    path: media,
    params: { media_type: "CAROUSEL", children: "<child ids>", caption: req.caption },
  };
  return [...kids, parent, publish, ...comment];
}

export type GraphErrorKind = "auth" | "permission" | "rate_limit" | "media" | "unknown";

/** Classify a Graph error body so callers (AI Office publisher) can raise needs_jackie with a clear reason. Never retry on any kind. */
export function classifyGraphError(text: string): { kind: GraphErrorKind; graphCode?: number } {
  let code: number | undefined;
  try {
    const j = JSON.parse(text) as { error?: { code?: number } };
    code = typeof j.error?.code === "number" ? j.error.code : undefined;
  } catch {
    /* non-JSON body */
  }
  if (code === undefined) return { kind: "unknown" };
  if (code === 190 || code === 102) return { kind: "auth", graphCode: code };
  if (code === 10 || code === 200 || code === 3) return { kind: "permission", graphCode: code };
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 9) return { kind: "rate_limit", graphCode: code };
  if (code === 9004 || code === 9007 || code === 36000 || code === 36001 || code === 36003) return { kind: "media", graphCode: code };
  return { kind: "unknown", graphCode: code };
}

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly kind: GraphErrorKind = "unknown", readonly graphCode?: number) {
    super(message);
  }
}

function redact(text: string, token: string): string {
  return text.split(token).join("[redacted]").slice(0, 300);
}

export interface PublishDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function graphPost(account: InstagramAccount, path: string, params: Record<string, string>, f: typeof fetch): Promise<{ id: string }> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", account.accessToken);
  const res = await f(url, { method: "POST" });
  const text = await res.text();
  if (!res.ok) {
    const c = classifyGraphError(text);
    throw new GraphError(`Graph ${path} failed: ${res.status} ${redact(text, account.accessToken)}`, res.status, c.kind, c.graphCode);
  }
  let json: { id?: string };
  try {
    json = JSON.parse(text) as { id?: string };
  } catch {
    throw new GraphError(`Graph ${path} returned non-JSON`, res.status);
  }
  if (!json.id) throw new GraphError(`Graph ${path} response had no id`, res.status);
  return { id: json.id };
}

async function waitFinished(account: InstagramAccount, id: string, attempts: number, delayMs: number, f: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<void> {
  const url = new URL(`${GRAPH}/${id}`);
  url.searchParams.set("fields", "status_code");
  url.searchParams.set("access_token", account.accessToken);
  for (let i = 0; i < attempts; i++) {
    const res = await f(url);
    if (res.ok) {
      const j = (await res.json()) as { status_code?: string };
      if (j.status_code === "FINISHED") return;
      if (j.status_code === "ERROR" || j.status_code === "EXPIRED") throw new GraphError(`container ${id} ${j.status_code.toLowerCase()}`, 400);
    }
    await sleep(delayMs);
  }
  throw new GraphError(`container ${id} not FINISHED after ${attempts} polls`, 504);
}

export interface PublishResult {
  mediaId: string;
  commentId?: string;
  commentError?: string;
}

/** REAL Graph calls. Caller must already have enforced write flag + pause flag. */
export async function executePublish(account: InstagramAccount, req: IgPublishRequest, deps: PublishDeps = {}): Promise<PublishResult> {
  const f = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const media = `/${account.igUserId}/media`;
  let containerId: string;

  if (req.type === "image") {
    containerId = (await graphPost(account, media, { image_url: req.imageUrl!, caption: req.caption }, f)).id;
    await waitFinished(account, containerId, 10, 2000, f, sleep);
  } else if (req.type === "reel") {
    const params: Record<string, string> = { media_type: "REELS", video_url: req.videoUrl!, caption: req.caption, share_to_feed: "true" };
    if (req.coverUrl) params.cover_url = req.coverUrl;
    containerId = (await graphPost(account, media, params, f)).id;
    await waitFinished(account, containerId, 30, 3000, f, sleep); // video transcoding is slower than images
  } else {
    const childIds: string[] = [];
    for (const u of req.imageUrls!) {
      const child = await graphPost(account, media, { image_url: u, is_carousel_item: "true" }, f);
      await waitFinished(account, child.id, 10, 2000, f, sleep);
      childIds.push(child.id);
    }
    containerId = (await graphPost(account, media, { media_type: "CAROUSEL", children: childIds.join(","), caption: req.caption }, f)).id;
    await waitFinished(account, containerId, 10, 2000, f, sleep);
  }

  const published = await graphPost(account, `/${account.igUserId}/media_publish`, { creation_id: containerId }, f);
  const result: PublishResult = { mediaId: published.id };
  if (req.firstComment) {
    // Needs instagram_manage_comments. The post is already live, so a failure here is reported, not thrown.
    try {
      result.commentId = (await graphPost(account, `/${published.id}/comments`, { message: req.firstComment }, f)).id;
    } catch (err) {
      result.commentError = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

/** Stable hash of the content (not the token) used to refuse accidental double-publish. */
export async function contentHash(req: IgPublishRequest): Promise<string> {
  const canonical = JSON.stringify([req.type, req.caption, req.imageUrl ?? null, req.imageUrls ?? null, req.videoUrl ?? null, req.coverUrl ?? null]);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}
