/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md §4 — token health check for
 * both Instagram accounts. Monitoring only: alerts via Telegram if a token is
 * close to expiring, naming which account. Deliberately does NOT attempt an
 * automated refresh — these are Page Access Tokens obtained through a
 * Business Manager System User (see HANDOFF for the exact steps), and unlike
 * the standard long-lived-user-token flow, there is no verified API call
 * that refreshes a System User token; Meta's documented path is regenerating
 * it in Business Settings. Claiming an automated refresh here without having
 * confirmed the call actually works would be the kind of unverified
 * assumption this project's CLAUDE.md explicitly rules out — alert and let
 * Jackie regenerate manually instead.
 */
import type { Document } from "mongodb";
import { withDb, type DbEnv } from "../db";
import { getTokenExpiry } from "../services/instagram";
import { sendTelegramIgMessage, type TelegramIgEnv } from "../services/telegramIg";

export interface IgTokenHealthEnv extends DbEnv, TelegramIgEnv {
  IG_TOKEN_UIU: string;
  IG_TOKEN_AFFILIATE: string;
}

const STATE_COLLECTION = "ig_token_health_state";
const WARN_WITHIN_DAYS = 7;

interface StateDoc {
  lastWarnedUiu: string | null;
  lastWarnedAffiliate: string | null;
}

async function readState(env: DbEnv): Promise<StateDoc> {
  return withDb(env, async (db) => {
    const doc = (await db.collection(STATE_COLLECTION).findOne({})) as Document | null;
    return {
      lastWarnedUiu: (doc?.lastWarnedUiu as string) ?? null,
      lastWarnedAffiliate: (doc?.lastWarnedAffiliate as string) ?? null,
    };
  });
}

async function saveState(env: DbEnv, patch: Partial<StateDoc>): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection(STATE_COLLECTION).updateOne({}, { $set: patch }, { upsert: true });
  });
}

async function checkOne(env: IgTokenHealthEnv, label: string, token: string, lastWarned: string | null): Promise<{ warned: boolean; nextLastWarned: string | null }> {
  let expiry: Date | null;
  try {
    expiry = await getTokenExpiry(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramIgMessage(env, `⚠️ *IG token check failed — ${label}*\n\nCould not read token status: ${message}`);
    return { warned: true, nextLastWarned: new Date().toISOString() };
  }
  if (!expiry) return { warned: false, nextLastWarned: lastWarned }; // "never expire" token — nothing to warn about

  const daysLeft = (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  const today = new Date().toISOString().slice(0, 10);
  if (daysLeft <= WARN_WITHIN_DAYS && lastWarned !== today) {
    await sendTelegramIgMessage(
      env,
      `⚠️ *IG token expiring soon — ${label}*\n\nExpires ${expiry.toISOString()} (~${Math.max(0, Math.round(daysLeft))} days). ` +
        `Regenerate via Business Settings → System Users (see HANDOFF_ig-marketing-affiliate-agent-design.md).`,
    );
    return { warned: true, nextLastWarned: today };
  }
  return { warned: false, nextLastWarned: lastWarned };
}

export async function checkIgTokenHealth(env: IgTokenHealthEnv): Promise<void> {
  const state = await readState(env);
  const uiu = await checkOne(env, "UIU account (useitup.app)", env.IG_TOKEN_UIU, state.lastWarnedUiu);
  const affiliate = await checkOne(env, "Affiliate account (kura.nook)", env.IG_TOKEN_AFFILIATE, state.lastWarnedAffiliate);
  if (uiu.warned || affiliate.warned) {
    await saveState(env, { lastWarnedUiu: uiu.nextLastWarned, lastWarnedAffiliate: affiliate.nextLastWarned });
  }
}
