/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md §3 — Telegram webhook for the
 * IG Content Agent's Approve/Reject inline buttons. Separate bot/route from
 * anything PWA-monitor related (telegramIg.ts, not telegram.ts).
 *
 * Auth: Telegram calls this URL directly (no X-Admin-Token from Jackie's side),
 * so it's protected by the X-Telegram-Bot-Api-Secret-Token header instead —
 * Telegram echoes back whatever secret_token was registered via setWebhook
 * (services/telegramIg.ts's setTelegramIgWebhook). Reject anything that
 * doesn't match before touching the body.
 */
import { Hono } from "hono";
import { getMongoModule } from "../db";
import { approveDraft, rejectDraft, type IgContentAgentEnv } from "../jobs/igContentAgent";
import { answerTelegramIgCallback } from "../services/telegramIg";

type Bindings = IgContentAgentEnv & { TELEGRAM_IG_WEBHOOK_SECRET: string };

export const igWebhookRouter = new Hono<{ Bindings: Bindings }>();

interface TelegramCallbackQuery {
  id: string;
  data?: string;
}

interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
}

igWebhookRouter.post("/", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || secret !== c.env.TELEGRAM_IG_WEBHOOK_SECRET) {
    return c.text("unauthorized", 401);
  }

  const update = await c.req.json().catch(() => null) as TelegramUpdate | null;
  const callback = update?.callback_query;
  if (!callback?.data) {
    // Not a callback we care about (e.g. Telegram's own health-check pings) — 200 so it doesn't retry.
    return c.text("ok");
  }

  const match = callback.data.match(/^ig:(approve|reject):([a-f0-9]{24})$/i);
  if (!match) {
    await answerTelegramIgCallback(c.env, callback.id, "Unrecognised action.").catch(() => {});
    return c.text("ok");
  }
  const [, action, draftIdStr] = match as [string, "approve" | "reject", string];

  try {
    const { ObjectId } = await getMongoModule();
    const draftId = new ObjectId(draftIdStr);
    const result = action === "approve" ? await approveDraft(c.env, draftId) : await rejectDraft(c.env, draftId);
    await answerTelegramIgCallback(c.env, callback.id, result.message.slice(0, 200));
  } catch (err) {
    console.error("[uiu-api] igWebhook callback error:", err instanceof Error ? err.message : String(err));
    await answerTelegramIgCallback(c.env, callback.id, "Error processing action.").catch(() => {});
  }
  return c.text("ok");
});
