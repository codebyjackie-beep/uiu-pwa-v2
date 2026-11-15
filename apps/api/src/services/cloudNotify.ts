/**
 * Cloud-session notifications to Jackie over a dedicated Telegram bot (separate from the app's alert bot).
 * Token: Worker secret CLOUD_NOTIFY_BOT_TOKEN (set by Jackie in Cloudflare; never logged or returned).
 * Chat id: saved once by /setup from the bot's getUpdates (Jackie sends the bot a message first) into
 * `cloud_notify_config` { _id: "chat" }, so no second secret is needed.
 */
import type { Db } from "mongodb";

export interface CloudNotifyEnv {
  CLOUD_NOTIFY_BOT_TOKEN?: string;
}

export class NotifyError extends Error {}

const CONFIG = "cloud_notify_config";

function token(env: CloudNotifyEnv): string {
  if (!env.CLOUD_NOTIFY_BOT_TOKEN) throw new NotifyError("CLOUD_NOTIFY_BOT_TOKEN is not set on uiu-api");
  return env.CLOUD_NOTIFY_BOT_TOKEN;
}

async function tg(env: CloudNotifyEnv, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token(env)}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json?.ok) throw new NotifyError(`Telegram ${method} failed: ${res.status} ${String(json?.description ?? "").slice(0, 120)}`);
  return json.result;
}

/** Reads the bot's recent updates and saves the chat id when exactly one private chat has messaged it. */
export async function setupChat(env: CloudNotifyEnv, db: Db) {
  const me = await tg(env, "getMe");
  const updates = (await tg(env, "getUpdates")) as any[];
  const chats = new Map<number, { id: number; firstName?: string; username?: string }>();
  for (const u of updates) {
    const chat = u.message?.chat;
    if (chat?.type === "private") chats.set(chat.id, { id: chat.id, firstName: chat.first_name, username: chat.username });
  }
  const list = [...chats.values()];
  if (list.length !== 1) return { bot: me.username, saved: false, privateChats: list.length, hint: list.length ? "more than one person messaged the bot" : "send the bot any message first, then retry" };
  await db.collection(CONFIG).updateOne({ _id: "chat" as never }, { $set: { chatId: list[0]!.id, savedAt: new Date() } }, { upsert: true });
  return { bot: me.username, saved: true, privateChats: 1, firstName: list[0]!.firstName ?? null };
}

export async function notify(env: CloudNotifyEnv, db: Db, text: string) {
  const cfg = await db.collection(CONFIG).findOne({ _id: "chat" as never });
  if (!cfg?.chatId) throw new NotifyError("no chat saved yet — run POST /api/admin/notify/setup");
  const msg = await tg(env, "sendMessage", { chat_id: cfg.chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
  return { sent: true, messageId: msg.message_id };
}

// ---------------------------------------------------------------------------
// Structured AI Office notifications (2026-11-15): { title, body?, url? } -> plain-text message.
// Telegram only pings Jackie; approval still happens on the Jarvis page (no buttons here).

export const NOTIFY_TITLE_MAX = 100;
export const NOTIFY_BODY_MAX = 400;
export const NOTIFY_URL_MAX = 500;
export const NOTIFY_DEDUPE_MS = 5 * 60 * 1000;
const URL_PREFIX = "https://claude.ai/";
const LOG = "cloud_notify_log";

export interface NotifyRequest {
  title: string;
  body?: string;
  url?: string;
}

type Validation = { ok: true; value: NotifyRequest } | { ok: false; message: string };

/** Strict validation — wrong types are rejected, never coerced. */
export function validateNotifyRequest(raw: unknown): Validation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string") return { ok: false, message: "title must be a string" };
  const title = r.title.trim();
  if (!title) return { ok: false, message: "title is required" };
  if (title.length > NOTIFY_TITLE_MAX) return { ok: false, message: `title must be <= ${NOTIFY_TITLE_MAX} chars` };
  const out: NotifyRequest = { title };
  if (r.body !== undefined) {
    if (typeof r.body !== "string") return { ok: false, message: "body must be a string" };
    const body = r.body.trim();
    if (body.length > NOTIFY_BODY_MAX) return { ok: false, message: `body must be <= ${NOTIFY_BODY_MAX} chars` };
    if (body) out.body = body;
  }
  if (r.url !== undefined) {
    if (typeof r.url !== "string") return { ok: false, message: "url must be a string" };
    const url = r.url;
    if (url.length > NOTIFY_URL_MAX) return { ok: false, message: `url must be <= ${NOTIFY_URL_MAX} chars` };
    if (!url.startsWith(URL_PREFIX) || /\s/.test(url)) return { ok: false, message: `url must start with ${URL_PREFIX}` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: "url is not a valid URL" };
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "claude.ai" || parsed.username || parsed.password || parsed.port) {
      return { ok: false, message: `url must start with ${URL_PREFIX}` };
    }
    out.url = url;
  }
  return { ok: true, value: out };
}

/** Plain text (no parse_mode): title, blank line, body, blank line, url. */
export function formatNotifyText(req: NotifyRequest): string {
  return [req.title, req.body, req.url].filter((x): x is string => !!x).join("\n\n");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Sends a structured notification unless the same title was sent in the last 5 minutes.
 * Only a hash of the title is stored (same idea as igPublish's contentHash audit); the record is
 * written after a successful send, so a failed send can be retried straight away.
 */
export async function notifyStructured(env: CloudNotifyEnv, db: Db, req: NotifyRequest, now: Date = new Date()) {
  const titleHash = await sha256Hex(req.title);
  const since = new Date(now.getTime() - NOTIFY_DEDUPE_MS);
  const recent = await db.collection(LOG).findOne({ titleHash, sentAt: { $gte: since } });
  if (recent) return { sent: false, deduped: true, lastSentAt: (recent.sentAt as Date).toISOString() };
  const out = await notify(env, db, formatNotifyText(req));
  await db.collection(LOG).insertOne({ titleHash, sentAt: now, messageId: out.messageId });
  return { ...out, deduped: false };
}
