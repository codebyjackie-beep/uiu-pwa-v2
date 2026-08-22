/**
 * Telegram Bot API sender for PWA diagnostics alerts/digests
 * (HANDOFF_pwa-diagnostics-monitor.md). Secrets set via `wrangler secret put`
 * — never log the token or chat id.
 */
export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export async function sendTelegram(env: TelegramEnv, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    // Never include the token in the error — only status + a truncated body.
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
