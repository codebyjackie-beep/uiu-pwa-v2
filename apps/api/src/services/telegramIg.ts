/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — a SEPARATE Telegram bot
 * from services/telegram.ts (PWA monitor's "UIU Monitor" bot). Design doc is
 * explicit these must not share a bot: alert/monitor messages and content
 * review messages would otherwise mix in one chat. Secrets are named
 * TELEGRAM_BOT_TOKEN_IG / TELEGRAM_CHAT_ID_IG to keep the two pairs distinct.
 */
export interface TelegramIgEnv {
  TELEGRAM_BOT_TOKEN_IG: string;
  TELEGRAM_CHAT_ID_IG: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

function apiUrl(env: TelegramIgEnv, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_IG}/${method}`;
}

async function postTelegram<T>(env: TelegramIgEnv, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiUrl(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Never include the token — it's only in the URL, not in this body/error.
    throw new Error(`Telegram ${method} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface SendMessageResult {
  result: { message_id: number };
}

export async function sendTelegramIgMessage(env: TelegramIgEnv, text: string, buttons?: InlineButton[][]): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID_IG,
    text,
    parse_mode: "Markdown",
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const json = await postTelegram<SendMessageResult>(env, "sendMessage", body);
  return json.result.message_id;
}

/**
 * Photo message, optionally with a caption. Caption is optional and deliberately
 * left unset by callers that need the full caption text separately — Telegram
 * caps photo captions at 1024 chars, which risks truncating the mandatory
 * affiliate disclosure text; the full caption goes out via sendTelegramIgMessage
 * (4096-char limit) instead, with the photo sent bare.
 */
export async function sendTelegramIgPhoto(env: TelegramIgEnv, photoUrl: string, caption?: string, buttons?: InlineButton[][]): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID_IG,
    photo: photoUrl,
    parse_mode: "Markdown",
  };
  if (caption) body.caption = caption;
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const json = await postTelegram<SendMessageResult>(env, "sendPhoto", body);
  return json.result.message_id;
}

export async function editTelegramIgMessage(env: TelegramIgEnv, messageId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID_IG,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await postTelegram(env, "editMessageText", body);
}

export async function answerTelegramIgCallback(env: TelegramIgEnv, callbackQueryId: string, text?: string): Promise<void> {
  await postTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function setTelegramIgWebhook(env: TelegramIgEnv, url: string, secretToken: string): Promise<unknown> {
  return postTelegram(env, "setWebhook", { url, secret_token: secretToken });
}
