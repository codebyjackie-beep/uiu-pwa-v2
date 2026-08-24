/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — main IG Content Agent job:
 * batch draft generation -> Telegram review (Approve/Reject buttons) ->
 * publish to the correct Instagram account on approve, regenerate on reject.
 *
 * Two separate IG accounts, two separate Page Access Tokens (see
 * services/instagram.ts) — draft.targetAccount picks which token/igUserId is
 * used, never inferred, never shared.
 */
import type { Document, ObjectId } from "mongodb";
import { withDb, type DbEnv } from "../db";
import type { OpenRouterEnv } from "../services/openrouter";
import type { SerperEnv } from "../services/serper";
import type { PexelsEnv } from "../services/pexels";
import { searchPhoto } from "../services/pexels";
import { generateOrganicDraft, generateAffiliateDraft, type AffiliateEnv } from "../services/igContentGen";
import { publishImagePost, type InstagramAccount } from "../services/instagram";
import { sendTelegramIgMessage, sendTelegramIgPhoto, editTelegramIgMessage, type TelegramIgEnv } from "../services/telegramIg";

export type TargetAccount = "uiu" | "affiliate";

export interface IgContentDraft {
  _id?: ObjectId;
  targetAccount: TargetAccount;
  caption: string;
  imageUrl: string;
  status: "pending" | "approved" | "rejected" | "publish_failed";
  productName?: string;
  category?: string;
  asin?: string;
  affiliateLink?: string;
  telegramMessageId?: number;
  createdAt: string;
  decidedAt?: string;
  publishedAt?: string;
  publishedMediaId?: string;
  error?: string;
}

export interface IgContentAgentEnv extends DbEnv, OpenRouterEnv, SerperEnv, PexelsEnv, TelegramIgEnv, AffiliateEnv {
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
  /** [vars], not a secret — how many drafts per batch run. */
  IG_CONTENT_BATCH_SIZE?: string;
}

const DRAFTS_COLLECTION = "ig_content_drafts";
const PRODUCTS_COLLECTION = "affiliate_products";
const RECENT_LOOKBACK = 15;

function accountFor(env: IgContentAgentEnv, target: TargetAccount): InstagramAccount {
  return target === "uiu"
    ? { igUserId: env.IG_ID_UIU, accessToken: env.IG_TOKEN_UIU }
    : { igUserId: env.IG_ID_AFFILIATE, accessToken: env.IG_TOKEN_AFFILIATE };
}

function accountLabel(target: TargetAccount): string {
  return target === "uiu" ? "[UIU account]" : "[Affiliate account]";
}

async function recentOrganicSummaries(env: DbEnv): Promise<string[]> {
  return withDb(env, async (db) => {
    const docs = await db
      .collection<Document>(DRAFTS_COLLECTION)
      .find({ targetAccount: "uiu" }, { projection: { caption: 1 }, sort: { createdAt: -1 }, limit: RECENT_LOOKBACK })
      .toArray();
    return docs.map((d) => String(d.caption).slice(0, 60));
  });
}

async function recentProductNames(env: DbEnv): Promise<string[]> {
  return withDb(env, async (db) => {
    const docs = await db
      .collection<Document>(PRODUCTS_COLLECTION)
      .find({}, { projection: { productName: 1 }, sort: { lastUsedAt: -1 }, limit: RECENT_LOOKBACK })
      .toArray();
    return docs.map((d) => String(d.productName));
  });
}

async function recordAffiliateProductUse(env: DbEnv, productName: string, asin: string, affiliateLink: string, category: string): Promise<void> {
  await withDb(env, async (db) => {
    await db
      .collection(PRODUCTS_COLLECTION)
      .updateOne({ asin }, { $set: { productName, asin, affiliateLink, category, lastUsedAt: new Date().toISOString() } }, { upsert: true });
  });
}

async function insertDraft(env: DbEnv, draft: IgContentDraft): Promise<ObjectId> {
  return withDb(env, async (db) => {
    const res = await db.collection(DRAFTS_COLLECTION).insertOne(draft as Document);
    return res.insertedId;
  });
}

async function updateDraft(env: DbEnv, id: ObjectId, patch: Partial<IgContentDraft>): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection(DRAFTS_COLLECTION).updateOne({ _id: id }, { $set: patch });
  });
}

async function getDraft(env: DbEnv, id: ObjectId): Promise<IgContentDraft | null> {
  return withDb(env, async (db) => (await db.collection<Document>(DRAFTS_COLLECTION).findOne({ _id: id })) as IgContentDraft | null);
}

function reviewMessageText(target: TargetAccount, caption: string): string {
  return `${accountLabel(target)}\n\n${caption}`;
}

/** Builds one draft (organic or affiliate), finds an image, inserts it, and sends it to Telegram for review. Returns null if the slot had to be skipped (e.g. no ASIN found, no image found) — caller should just move on, not retry indefinitely within one batch run. */
async function generateAndSendOne(env: IgContentAgentEnv, target: TargetAccount): Promise<ObjectId | null> {
  let caption: string;
  let imageQuery: string;
  let productName: string | undefined;
  let category: string | undefined;
  let asin: string | undefined;
  let affiliateLink: string | undefined;

  if (target === "uiu") {
    const recents = await recentOrganicSummaries(env);
    const draft = await generateOrganicDraft(env, recents);
    caption = draft.caption;
    imageQuery = draft.imageQuery;
  } else {
    const recents = await recentProductNames(env);
    const draft = await generateAffiliateDraft(env, recents);
    if (!draft) return null; // no ASIN found for the suggested product — skip this slot
    caption = draft.caption;
    imageQuery = draft.imageQuery;
    productName = draft.productName;
    category = draft.category;
    asin = draft.asin;
    affiliateLink = draft.affiliateLink;
    await recordAffiliateProductUse(env, productName, asin, affiliateLink, category);
  }

  const imageUrl = await searchPhoto(env, imageQuery);
  if (!imageUrl) return null; // IG requires a public image URL at publish time — cannot post without one

  const id = await insertDraft(env, {
    targetAccount: target,
    caption,
    imageUrl,
    status: "pending",
    productName,
    category,
    asin,
    affiliateLink,
    createdAt: new Date().toISOString(),
  });

  await sendTelegramIgPhoto(env, imageUrl);
  const messageId = await sendTelegramIgMessage(env, reviewMessageText(target, caption), [
    [
      { text: "✅ Approve", callback_data: `ig:approve:${id.toString()}` },
      { text: "❌ Reject", callback_data: `ig:reject:${id.toString()}` },
    ],
  ]);
  await updateDraft(env, id, { telegramMessageId: messageId });
  return id;
}

export interface BatchSummary {
  requested: number;
  sent: number;
  skipped: number;
}

/** Cron entry point — generates a mixed batch (alternating uiu/affiliate) and sends each to Telegram for review. */
export async function runIgContentBatch(env: IgContentAgentEnv): Promise<BatchSummary> {
  const batchSize = Number(env.IG_CONTENT_BATCH_SIZE) || 6;
  let sent = 0;
  let skipped = 0;
  for (let i = 0; i < batchSize; i++) {
    const target: TargetAccount = i % 2 === 0 ? "uiu" : "affiliate";
    try {
      const id = await generateAndSendOne(env, target);
      if (id) sent++;
      else skipped++;
    } catch (err) {
      console.error(`[uiu-api] igContentAgent generateAndSendOne(${target}) failed:`, err instanceof Error ? err.message : String(err));
      skipped++;
    }
  }
  return { requested: batchSize, sent, skipped };
}

export interface DecisionResult {
  ok: boolean;
  message: string;
}

/** Called from the Telegram webhook when Jackie taps Approve. */
export async function approveDraft(env: IgContentAgentEnv, draftId: ObjectId): Promise<DecisionResult> {
  const draft = await getDraft(env, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status !== "pending") return { ok: false, message: `Already ${draft.status}.` };

  try {
    const account = accountFor(env, draft.targetAccount);
    const { mediaId } = await publishImagePost(account, draft.imageUrl, draft.caption);
    await updateDraft(env, draftId, { status: "approved", decidedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), publishedMediaId: mediaId });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption)}\n\n✅ *Published.*`);
    }
    return { ok: true, message: "Published." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateDraft(env, draftId, { status: "publish_failed", decidedAt: new Date().toISOString(), error: message });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption)}\n\n⚠️ *Publish failed:* ${message}`);
    }
    return { ok: false, message: `Publish failed: ${message}` };
  }
}

/** Called from the Telegram webhook when Jackie taps Reject. Regenerates a replacement for the same account and sends it as a new message. */
export async function rejectDraft(env: IgContentAgentEnv, draftId: ObjectId): Promise<DecisionResult> {
  const draft = await getDraft(env, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status !== "pending") return { ok: false, message: `Already ${draft.status}.` };

  await updateDraft(env, draftId, { status: "rejected", decidedAt: new Date().toISOString() });
  if (draft.telegramMessageId) {
    await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption)}\n\n❌ *Rejected.*`);
  }

  try {
    const replacementId = await generateAndSendOne(env, draft.targetAccount);
    return replacementId ? { ok: true, message: "Rejected. Replacement sent." } : { ok: true, message: "Rejected. No replacement could be generated this time (skipped — no ASIN/image found)." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: true, message: `Rejected. Replacement generation failed: ${message}` };
  }
}
