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
import type { AtlasCloudEnv } from "../services/atlasCloudImage";
import { generateBackgroundImage } from "../services/atlasCloudImage";
import { generateOrganicDraft, generateAffiliateDraft, generateAffiliateCollageDraft, type AffiliateEnv, type ResolvedCollageProduct } from "../services/igContentGen";
import { renderBrandedImage } from "../services/brandedImage";
import { renderCollageImage } from "../services/collageImage";
import { storeBrandedImage, brandedImageUrl } from "../services/igMediaStore";
import { publishImagePost, type InstagramAccount } from "../services/instagram";
import { sendTelegramIgMessage, sendTelegramIgPhoto, editTelegramIgMessage, type TelegramIgEnv } from "../services/telegramIg";

export type TargetAccount = "uiu" | "affiliate";

export interface CollageProductRef {
  productName: string;
  asin: string;
  affiliateLink: string;
  category: string;
  commissionRate: number;
  rawAmazonCategory: string;
  imageUrl: string;
  benefitLine: string;
}

export interface IgContentDraft {
  _id?: ObjectId;
  targetAccount: TargetAccount;
  /** cc_prompt_multiproduct_collage.md — "collage" is a 9-product grid post, still affiliate
   * content (targetAccount stays "affiliate"), distinguished from a single-product post by this
   * field. Undefined/"single" on every pre-2026-09-01 draft. */
  postType?: "single" | "collage";
  pillar?: string;
  hook?: string;
  hashtags?: string[];
  caption: string;
  /** Background photo (Serper product photo or Pexels stock) before branding. */
  sourceImageUrl?: string;
  /** Branded composite (services/brandedImage.ts) — this is what actually gets published. */
  imageUrl: string;
  status: "pending" | "approved" | "rejected" | "publish_failed";
  productName?: string;
  category?: string;
  /** Amazon Associates UK commission rate (%) for `category` — see services/amazonCategory.ts. Affiliate drafts only. */
  commissionRate?: number;
  /** The real Amazon browse-node text `category` was verified against — audit trail for cc_prompt_commission_rate_filter.md. */
  rawAmazonCategory?: string;
  asin?: string;
  affiliateLink?: string;
  /** Collage drafts only — the 9 resolved products the grid image/caption were built from. */
  collageTheme?: string;
  collageProducts?: CollageProductRef[];
  telegramMessageId?: number;
  createdAt: string;
  decidedAt?: string;
  publishedAt?: string;
  publishedMediaId?: string;
  error?: string;
}

export interface IgContentAgentEnv extends DbEnv, OpenRouterEnv, SerperEnv, PexelsEnv, AtlasCloudEnv, TelegramIgEnv, AffiliateEnv {
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
  /** Public base URL of this Worker (apps/api/wrangler.toml [vars]) — used to build the
   * branded-image URL Instagram/the public shop page fetch. */
  PUBLIC_API_BASE_URL: string;
  /** [vars], not a secret — how many drafts per batch run. */
  IG_CONTENT_BATCH_SIZE?: string;
}

const DRAFTS_COLLECTION = "ig_content_drafts";
const PRODUCTS_COLLECTION = "affiliate_products";
const STATE_COLLECTION = "ig_content_state";
const RECENT_LOOKBACK = 15;

/** HANDOFF addendum 2026-08-25 §4 — UIU account rotates through these 4 pillars in order. */
const UIU_PILLARS = ["recipe", "tip", "waste_reduction", "behind_the_scenes"] as const;

/** cc_prompt_multiproduct_collage.md — collage post themes rotate the same way UIU_PILLARS does,
 * so themes (and therefore the real Amazon categories products land in) visibly cycle rather than
 * drifting back to kitchen-only. Deliberately spans all 7 targeted commission-rate categories. */
const COLLAGE_THEMES = [
  "Kitchen gadgets under £20",
  "Small kitchen appliances beyond the rice cooker",
  "Garden upgrades for a small UK garden",
  "Pet products for a tidy home",
  "Furniture and home organisation hacks",
  "Household tools every home needs",
] as const;

/**
 * Atomic $inc on a singleton state doc — the same pattern recipe_draft_state/
 * pwa_diagnostics_state already use elsewhere in this codebase. Returns the pillar AND the
 * raw counter so callers/tests can verify the counter is actually advancing (a standing
 * requirement to verify rotation actually happens — an earlier rotation bug turned out to
 * be an index that was computed but never persisted).
 */
async function nextUiuPillar(env: DbEnv): Promise<{ pillar: string; rawIndex: number }> {
  return withDb(env, async (db) => {
    const res = await db
      .collection<Document>(STATE_COLLECTION)
      .findOneAndUpdate({ _id: "pillars" } as unknown as Document, { $inc: { uiuPillarIndex: 1 } }, { upsert: true, returnDocument: "after" });
    const rawIndex = Number(res?.uiuPillarIndex ?? 1);
    const pillar = UIU_PILLARS[(rawIndex - 1) % UIU_PILLARS.length]!;
    return { pillar, rawIndex };
  });
}

/** Same atomic-$inc pattern as nextUiuPillar, separate counter field on the same singleton doc. */
async function nextCollageTheme(env: DbEnv): Promise<string> {
  return withDb(env, async (db) => {
    const res = await db
      .collection<Document>(STATE_COLLECTION)
      .findOneAndUpdate({ _id: "pillars" } as unknown as Document, { $inc: { collageThemeIndex: 1 } }, { upsert: true, returnDocument: "after" });
    const rawIndex = Number(res?.collageThemeIndex ?? 1);
    return COLLAGE_THEMES[(rawIndex - 1) % COLLAGE_THEMES.length]!;
  });
}

async function getLastAffiliateCategory(env: DbEnv): Promise<string | null> {
  return withDb(env, async (db) => {
    const doc = await db.collection<Document>(STATE_COLLECTION).findOne({ _id: "pillars" } as unknown as Document);
    return (doc?.lastAffiliateCategory as string | undefined) ?? null;
  });
}

async function setLastAffiliateCategory(env: DbEnv, category: string): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection(STATE_COLLECTION).updateOne({ _id: "pillars" } as unknown as Document, { $set: { lastAffiliateCategory: category } }, { upsert: true });
  });
}

async function recentHashtags(env: DbEnv): Promise<string[]> {
  return withDb(env, async (db) => {
    const docs = await db
      .collection<Document>(DRAFTS_COLLECTION)
      .find({ hashtags: { $exists: true } }, { projection: { hashtags: 1 }, sort: { createdAt: -1 }, limit: 6 })
      .toArray();
    return docs.flatMap((d) => (Array.isArray(d.hashtags) ? (d.hashtags as string[]) : []));
  });
}

/** Minimal env for publishing/re-publishing an already-generated draft — no LLM/Serper/Pexels needed. */
export type PublishEnv = DbEnv & TelegramIgEnv & {
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
};

/**
 * 2026-08-31 brand merge (Jackie: drop the standalone Kura Nook account) — both targets now
 * publish to the single @useitup.app account. `targetAccount` is kept on the draft purely as a
 * content-type label (organic vs affiliate, still used for pillar/category rotation state and
 * for the Telegram reviewer to see which kind of post this is) — it no longer selects a
 * different IG account/token. IG_TOKEN_AFFILIATE/IG_ID_AFFILIATE stay in the env type (not
 * deleting secrets) but are unused here now.
 */
export function accountFor(env: PublishEnv, _target: TargetAccount): InstagramAccount {
  return { igUserId: env.IG_ID_UIU, accessToken: env.IG_TOKEN_UIU };
}

function accountLabel(target: TargetAccount, postType?: "single" | "collage"): string {
  if (target === "uiu") return "[UIU — organic]";
  return postType === "collage" ? "[UIU — affiliate collage]" : "[UIU — affiliate]";
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

/** Renders the hook onto the background photo (+ optional real product photo card for the
 * affiliate 3-layer composite) and stores the PNG (services/igMediaStore.ts) — returns a public URL. */
async function buildBrandedImageUrl(
  env: IgContentAgentEnv,
  target: TargetAccount,
  backgroundImageUrl: string,
  hook: string,
  productImageUrl?: string,
): Promise<string> {
  const png = await renderBrandedImage({ backgroundImageUrl, productImageUrl, hook, account: target });
  const id = await storeBrandedImage(env, png);
  return brandedImageUrl(env.PUBLIC_API_BASE_URL, id);
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

async function recordAffiliateProductUse(
  env: DbEnv,
  productName: string,
  asin: string,
  affiliateLink: string,
  category: string,
  commissionRate: number | undefined,
  rawAmazonCategory: string | undefined,
  sourceImageUrl: string,
): Promise<void> {
  await withDb(env, async (db) => {
    await db
      .collection(PRODUCTS_COLLECTION)
      .updateOne(
        { asin },
        { $set: { productName, asin, affiliateLink, category, commissionRate, rawAmazonCategory, imageUrl: sourceImageUrl, lastUsedAt: new Date().toISOString() } },
        { upsert: true },
      );
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

function reviewMessageText(target: TargetAccount, caption: string, postType?: "single" | "collage"): string {
  return `${accountLabel(target, postType)}\n\n${caption}`;
}

/** Builds one draft (organic or affiliate), finds a background photo, brands it with the hook
 * (services/brandedImage.ts), inserts it, and sends it to Telegram for review. Returns null if
 * the slot had to be skipped (e.g. no ASIN found, no image found) — caller should just move on,
 * not retry indefinitely within one batch run. */
async function generateAndSendOne(env: IgContentAgentEnv, target: TargetAccount): Promise<ObjectId | null> {
  let caption: string;
  let hook: string;
  let hashtags: string[];
  let imageQuery: string;
  let pillar: string | undefined;
  let productName: string | undefined;
  let category: string | undefined;
  let commissionRate: number | undefined;
  let rawAmazonCategory: string | undefined;
  let asin: string | undefined;
  let affiliateLink: string | undefined;
  let productImageUrl: string | undefined;
  let backgroundPrompt: string | undefined;

  const hashtagHistory = await recentHashtags(env);

  if (target === "uiu") {
    const recents = await recentOrganicSummaries(env);
    const { pillar: chosenPillar } = await nextUiuPillar(env);
    pillar = chosenPillar;
    const draft = await generateOrganicDraft(env, recents, hashtagHistory, pillar);
    caption = draft.caption;
    hook = draft.hook;
    hashtags = draft.hashtags;
    imageQuery = draft.imageQuery;
    backgroundPrompt = draft.backgroundPrompt;
  } else {
    const recents = await recentProductNames(env);
    const avoidCategory = await getLastAffiliateCategory(env);
    const draft = await generateAffiliateDraft(env, recents, hashtagHistory, avoidCategory);
    if (!draft) return null; // no ASIN found for the suggested product — skip this slot
    caption = draft.caption;
    hook = draft.hook;
    hashtags = draft.hashtags;
    imageQuery = draft.imageQuery;
    productName = draft.productName;
    category = draft.category;
    commissionRate = draft.commissionRate;
    rawAmazonCategory = draft.rawAmazonCategory;
    asin = draft.asin;
    affiliateLink = draft.affiliateLink;
    productImageUrl = draft.productImageUrl;
    backgroundPrompt = draft.backgroundPrompt;
  }

  // cc_prompt_atlas_cloud_bg.md — AI-generated background scene, tried first for both content
  // types. Never throws (returns null on any failure) so an Atlas Cloud outage/rate-limit can't
  // sink the batch — organic falls back to Pexels below, affiliate falls back to the pre-existing
  // single-layer "product photo as the whole image" look.
  const aiBackgroundUrl = await generateBackgroundImage(env, backgroundPrompt);

  // sourceImageUrl is the "real"/of-record photo: for affiliate this MUST stay the actual
  // product photo (feeds affiliate_products.imageUrl / the shop-affiliate page — never an
  // AI image, see recordAffiliateProductUse's caller note below on the 2026-08-31 bug this
  // guards against). For organic it's simply whichever background ends up used.
  let sourceImageUrl: string | null;
  let renderBackgroundUrl: string;
  let renderProductUrl: string | undefined;

  if (target === "uiu") {
    sourceImageUrl = aiBackgroundUrl ?? (await searchPhoto(env, imageQuery));
    if (!sourceImageUrl) return null; // IG requires a public image URL at publish time — cannot post without one
    renderBackgroundUrl = sourceImageUrl;
  } else {
    // Real listing photo (scraped from the ASIN's own Amazon page, see serper.ts scrapeProductImage) takes priority over the Pexels stock search.
    sourceImageUrl = productImageUrl ?? (await searchPhoto(env, imageQuery));
    if (!sourceImageUrl) return null;
    if (aiBackgroundUrl && productImageUrl) {
      // 3-layer composite: AI background + the real product photo inset on top.
      renderBackgroundUrl = aiBackgroundUrl;
      renderProductUrl = productImageUrl;
    } else {
      // Atlas Cloud failed (or there's no separate product photo to composite) — fall back to
      // the pre-existing single-layer look: the product photo fills the whole frame.
      renderBackgroundUrl = sourceImageUrl;
    }
  }

  let imageUrl: string;
  try {
    imageUrl = await buildBrandedImageUrl(env, target, renderBackgroundUrl, hook, renderProductUrl);
  } catch (err) {
    console.error("[uiu-api] renderBrandedImage failed, falling back to unbranded source photo:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    imageUrl = sourceImageUrl; // still postable — just without the hook overlay
  }

  if (target === "affiliate" && productName && asin && affiliateLink && category) {
    // affiliate_products.imageUrl feeds the /shop-affiliate page — must be the clean scraped
    // product photo, never `imageUrl` (the branded IG-post PNG with hook text + watermark
    // baked in via buildBrandedImageUrl). 2026-08-31: caught 3 rows (B000LCP6EW, B0D4DMRPY6,
    // B06Y4MCKFM) live on shop-affiliate showing an old @kura.nook-watermarked post image
    // because this call used to pass `imageUrl` here.
    await recordAffiliateProductUse(env, productName, asin, affiliateLink, category, commissionRate, rawAmazonCategory, sourceImageUrl);
    await setLastAffiliateCategory(env, category);
  }

  const id = await insertDraft(env, {
    targetAccount: target,
    pillar,
    hook,
    hashtags,
    caption,
    sourceImageUrl,
    imageUrl,
    status: "pending",
    productName,
    category,
    commissionRate,
    rawAmazonCategory,
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

function collageProductRefs(products: ResolvedCollageProduct[]): CollageProductRef[] {
  return products.map((p) => ({
    productName: p.productName,
    asin: p.asin,
    affiliateLink: p.affiliateLink,
    category: p.category,
    commissionRate: p.commissionRate,
    rawAmazonCategory: p.rawAmazonCategory,
    imageUrl: p.imageUrl,
    benefitLine: p.benefitLine,
  }));
}

/**
 * cc_prompt_multiproduct_collage.md — builds one 9-product collage draft (theme -> product
 * ideation+resolution in igContentGen.ts -> grid PNG render -> DB writes -> Telegram review),
 * manual-trigger only for V1 (routes/index.ts's POST /api/admin/ig-content/collage) — deliberately
 * NOT wired into runIgContentBatch's cron interleave below, so the existing 5:1 organic:affiliate
 * cadence and cost are completely unaffected by this new, more expensive post type.
 */
export async function generateAndSendCollage(env: IgContentAgentEnv): Promise<ObjectId | null> {
  const theme = await nextCollageTheme(env);
  const recents = await recentProductNames(env);
  const draft = await generateAffiliateCollageDraft(env, recents, theme);
  if (!draft) return null; // fewer than 9 in-scope products resolved for this theme — skip

  let imageUrl: string;
  try {
    const png = await renderCollageImage({
      headline: draft.headline,
      subtitle: draft.subtitle,
      products: draft.products.map((p) => ({ imageUrl: p.imageUrl, productName: p.productName, benefitLine: p.benefitLine, cutout: p.cutout })),
    });
    console.log(`[uiu-api] igContentAgent: collage PNG for theme "${theme}" is ${png.byteLength} bytes`);
    const id = await storeBrandedImage(env, png);
    imageUrl = brandedImageUrl(env.PUBLIC_API_BASE_URL, id);
  } catch (err) {
    console.error("[uiu-api] renderCollageImage failed — cannot post a collage without its grid image:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return null; // unlike the single-product fallback-to-unbranded-photo, there is no sensible un-composited fallback for a 9-product grid
  }

  for (const p of draft.products) {
    await recordAffiliateProductUse(env, p.productName, p.asin, p.affiliateLink, p.category, p.commissionRate, p.rawAmazonCategory, p.imageUrl);
  }

  const id = await insertDraft(env, {
    targetAccount: "affiliate",
    postType: "collage",
    hashtags: draft.hashtags,
    caption: draft.caption,
    imageUrl,
    status: "pending",
    collageTheme: draft.theme,
    collageProducts: collageProductRefs(draft.products),
    createdAt: new Date().toISOString(),
  });

  await sendTelegramIgPhoto(env, imageUrl);
  const messageId = await sendTelegramIgMessage(env, reviewMessageText("affiliate", draft.caption, "collage"), [
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

/**
 * 2026-08-31 brand merge (Jackie): affiliate content now publishes to @useitup.app alongside
 * organic recipe content, so both content types land in the same IG grid. Jackie's own example
 * ratio ("5條organic先1條affiliate") sets the interleave: every Nth slot is affiliate, the rest
 * organic. With the current IG_CONTENT_BATCH_SIZE=6 that's exactly 5 organic + 1 affiliate per
 * batch; a larger batch size repeats the same 5:1 pattern rather than changing the ratio.
 */
const AFFILIATE_EVERY_N = 6;

/** Cron entry point — generates a batch (organic:affiliate interleaved per AFFILIATE_EVERY_N) and sends each to Telegram for review. */
export async function runIgContentBatch(env: IgContentAgentEnv): Promise<BatchSummary> {
  const batchSize = Number(env.IG_CONTENT_BATCH_SIZE) || 6;
  let sent = 0;
  let skipped = 0;
  for (let i = 0; i < batchSize; i++) {
    const target: TargetAccount = (i + 1) % AFFILIATE_EVERY_N === 0 ? "affiliate" : "uiu";
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
export async function approveDraft(env: PublishEnv, draftId: ObjectId): Promise<DecisionResult> {
  const draft = await getDraft(env, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status !== "pending") return { ok: false, message: `Already ${draft.status}.` };

  try {
    const account = accountFor(env, draft.targetAccount);
    const { mediaId } = await publishImagePost(account, draft.imageUrl, draft.caption);
    await updateDraft(env, draftId, { status: "approved", decidedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), publishedMediaId: mediaId });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption, draft.postType)}\n\n✅ *Published.*`);
    }
    return { ok: true, message: "Published." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateDraft(env, draftId, { status: "publish_failed", decidedAt: new Date().toISOString(), error: message });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(
        env,
        draft.telegramMessageId,
        `${reviewMessageText(draft.targetAccount, draft.caption, draft.postType)}\n\n⚠️ *Publish failed:* ${message}`,
        [[{ text: "🔄 Retry", callback_data: `ig:retry:${draftId.toString()}` }]],
      );
    }
    return { ok: false, message: `Publish failed: ${message}` };
  }
}

/** Called from the Telegram webhook (or the admin retry route) when Jackie retries a publish_failed draft — reuses the same caption/image, no regeneration. */
export async function retryDraft(env: PublishEnv, draftId: ObjectId): Promise<DecisionResult> {
  const draft = await getDraft(env, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status !== "publish_failed") return { ok: false, message: `Not retryable (status: ${draft.status}).` };

  try {
    const account = accountFor(env, draft.targetAccount);
    const { mediaId } = await publishImagePost(account, draft.imageUrl, draft.caption);
    await updateDraft(env, draftId, { status: "approved", decidedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), publishedMediaId: mediaId, error: undefined });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption, draft.postType)}\n\n✅ *Published (retry).*`);
    }
    return { ok: true, message: "Published." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateDraft(env, draftId, { status: "publish_failed", decidedAt: new Date().toISOString(), error: message });
    if (draft.telegramMessageId) {
      await editTelegramIgMessage(
        env,
        draft.telegramMessageId,
        `${reviewMessageText(draft.targetAccount, draft.caption, draft.postType)}\n\n⚠️ *Publish failed again:* ${message}`,
        [[{ text: "🔄 Retry", callback_data: `ig:retry:${draftId.toString()}` }]],
      );
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
    await editTelegramIgMessage(env, draft.telegramMessageId, `${reviewMessageText(draft.targetAccount, draft.caption, draft.postType)}\n\n❌ *Rejected.*`);
  }

  try {
    const replacementId = draft.postType === "collage" ? await generateAndSendCollage(env) : await generateAndSendOne(env, draft.targetAccount);
    return replacementId ? { ok: true, message: "Rejected. Replacement sent." } : { ok: true, message: "Rejected. No replacement could be generated this time (skipped — no ASIN/image found)." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: true, message: `Rejected. Replacement generation failed: ${message}` };
  }
}
