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
