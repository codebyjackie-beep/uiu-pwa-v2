/**
 * Read-only admin API for ig_content_drafts (HANDOFF_ig-marketing-affiliate-agent-design.md).
 * X-Admin-Token protected, same convention as /api/admin/recipe-drafts.
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { retryDraft, rejectDraft, accountFor, type IgContentDraft } from "../jobs/igContentAgent";
import { scrapeProductImage, searchProductImageByAsin } from "../services/serper";

type VerifyBindings = DbEnv & {
  ADMIN_TOKEN: string;
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
  TELEGRAM_BOT_TOKEN_IG: string;
  TELEGRAM_CHAT_ID_IG: string;
  SERPER_API_KEY: string;
  PUBLIC_API_BASE_URL: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  PEXELS_API_KEY: string;
  AMAZON_ASSOCIATE_TAG: string;
  ATLAS_CLOUD_API_KEY: string;
};

export const adminIgDraftsRouter = new Hono<{ Bindings: VerifyBindings }>();

function toIgDraft(doc: Document): Omit<IgContentDraft, "_id"> & { _id: string } {
  return { ...(doc as unknown as IgContentDraft), _id: String(doc._id) };
}

/** `?status=` optional. Pass "all" for every status, omit for the default (all, most recent first). */
/**
 * Cross-checks each approved draft's publishedMediaId against the Instagram
 * Graph API, using the *same* account token the draft claims to belong to
 * (accountFor's mapping, duplicated here) — if targetAccount and the token
 * actually used to publish had ever diverged, this call would 400/403
 * because the wrong token has no permission on that media node.
 */
adminIgDraftsRouter.get("/verify-media", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const docs = await withDb(c.env, (db) =>
      db.collection("ig_content_drafts").find({ status: "approved", publishedMediaId: { $exists: true } }).sort({ createdAt: -1 }).toArray(),
    );
    const results = await Promise.all(
      docs.map(async (doc) => {
        const targetAccount = doc.targetAccount as "uiu" | "affiliate";
        // 2026-08-31 brand merge: accountFor() now always resolves to @useitup.app regardless of
        // targetAccount — reused here (not duplicated) so this check can't drift from publish
        // behavior again. Drafts published before the merge actually went to the old
        // @kura.nook account, so this check will correctly 403/graphError on those historical
        // rows now — that's expected, not a bug, since IG_TOKEN_UIU has no permission on media
        // that was never posted to that account.
        const { accessToken, igUserId } = accountFor(c.env, targetAccount);
        const mediaId = String(doc.publishedMediaId);
        const url = new URL(`https://graph.facebook.com/v21.0/${mediaId}`);
        url.searchParams.set("fields", "permalink,timestamp,media_product_type");
        url.searchParams.set("access_token", accessToken);
        try {
          const res = await fetch(url);
          const json = (await res.json()) as { permalink?: string; timestamp?: string; error?: { message?: string } };
          return {
            _id: String(doc._id),
            targetAccount,
            igUserIdChecked: igUserId,
            mediaId,
            httpStatus: res.status,
            permalink: json.permalink ?? null,
            igTimestamp: json.timestamp ?? null,
            graphError: json.error?.message ?? null,
          };
        } catch (err) {
          return { _id: String(doc._id), targetAccount, mediaId, httpStatus: 0, permalink: null, igTimestamp: null, graphError: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const body: ApiResponse<typeof results> = { ok: true, data: results };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts verify-media error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to verify media" } };
    return c.json(body, 502);
  }
});

/** Retries a publish_failed draft (e.g. after the 9007-race fix) without waiting for a Telegram tap on a stale message. */
adminIgDraftsRouter.post("/:id/retry", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const { ObjectId } = await getMongoModule();
    const draftId = new ObjectId(c.req.param("id"));
    const result = await retryDraft(c.env, draftId);
    const body: ApiResponse<typeof result> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts retry error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to retry draft" } };
    return c.json(body, 502);
  }
});

/** Rejects a pending draft without waiting for a Telegram tap (e.g. a known-bad pre-fix draft still sitting in the review channel). Mirrors the ig:reject webhook path, including regeneration of a replacement. */
adminIgDraftsRouter.post("/:id/reject", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const { ObjectId } = await getMongoModule();
    const draftId = new ObjectId(c.req.param("id"));
    const result = await rejectDraft(c.env, draftId);
    const body: ApiResponse<typeof result> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts reject error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to reject draft" } };
    return c.json(body, 502);
  }
});

/**
 * One-off backfill: affiliate_products rows written before imageUrl was recorded
 * (pre-2026-08-24 fix) have no imageUrl field.
 *
 * 2026-08-28 addendum: `{ force: true }` in the request body re-scrapes EVERY row instead of
 * only the ones missing imageUrl — needed because rows written before the 2026-08-28
 * scrapeProductImage fix (see serper.ts) have an imageUrl that EXISTS but may not match the
 * ASIN (the old keyword-search bug), so the plain `imageUrl: { $exists: false }` filter skips
 * exactly the rows that need fixing. Confirmed live on the public shop page: B0CJ974CT4 kept
 * showing the wrong grinder photo after the code fix because this route never re-touched it.
 *
 * 2026-08-31 addendum: `{ asins: string[] }` scopes force-mode to specific ASINs instead of
 * re-scanning all 40+ rows — used to targetedly repair the 3 rows (B000LCP6EW, B0D4DMRPY6,
 * B06Y4MCKFM) that got a branded/watermarked IG-post PNG written to imageUrl by a since-fixed
 * bug in igContentAgent.ts's recordAffiliateProductUse call, without re-touching already-correct rows.
 */
adminIgDraftsRouter.post("/backfill-product-images", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const payload = await c.req.json().catch(() => null);
    const force = payload?.force === true;
    const asins: string[] | undefined = Array.isArray(payload?.asins) ? payload.asins.map(String) : undefined;
    const filter = asins ? { asin: { $in: asins } } : force ? {} : { imageUrl: { $exists: false } };
    const docs = await withDb(c.env, (db) => db.collection("affiliate_products").find(filter).toArray());
    const results = await Promise.all(
      docs.map(async (doc) => {
        const asin = String(doc.asin);
        // 2026-08-28: scrape the ASIN's own listing page instead of a keyword search — see
        // serper.ts scrapeProductImage's header comment for why (keyword search can't be
        // verified against the ASIN and previously produced a real mismatched-photo bug).
        // 2026-08-30: scrape.serper.dev's markdown extraction is flaky (confirmed live — mostly
        // returns a readability excerpt with no gallery image at all, see searchProductImage
        // ByAsin's header comment) so fall back to an ASIN-verified Google Images search before
        // giving up.
        const found =
          (await scrapeProductImage(c.env, `https://www.amazon.co.uk/dp/${asin}`).catch(() => null)) ??
          (await searchProductImageByAsin(c.env, asin).catch(() => null));
        if (!found) {
          // force mode: clear whatever's stored rather than leave a possibly-stale/wrong
          // imageUrl in place (2026-08-28 — a looser regex once wrote a promo-banner URL here;
          // if a later re-run can't confidently re-derive an image, it must not leave that
          // banner sitting in the DB just because this row wasn't touched).
          if (force || asins) await withDb(c.env, (db) => db.collection("affiliate_products").updateOne({ _id: doc._id }, { $unset: { imageUrl: "", imageSource: "" } }));
          return { asin, updated: false, reason: "no image found" };
        }
        await withDb(c.env, (db) => db.collection("affiliate_products").updateOne({ _id: doc._id }, { $set: { imageUrl: found.imageUrl, imageSource: found.source } }));
        return { asin, updated: true, imageUrl: found.imageUrl, source: found.source };
      }),
    );
    const body: ApiResponse<typeof results> = { ok: true, data: results };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts backfill-product-images error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to backfill product images" } };
    return c.json(body, 502);
  }
});

interface InsightsRow {
  pillar?: string;
  category?: string;
  hook?: string;
  targetAccount: "uiu" | "affiliate";
  insights7d: { reach: number; likes: number; comments: number; saved: number; shares: number };
}

function engagementRate(row: InsightsRow["insights7d"]): number {
  if (row.reach <= 0) return 0;
  return (row.likes + row.comments + row.saved + row.shares) / row.reach;
}

function groupAverage<T extends InsightsRow>(rows: T[], keyOf: (row: T) => string | undefined): Array<{ key: string; count: number; avgReach: number; avgEngagementRate: number }> {
  const buckets = new Map<string, { reachSum: number; engagementSum: number; count: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const bucket = buckets.get(key) ?? { reachSum: 0, engagementSum: 0, count: 0 };
    bucket.reachSum += row.insights7d.reach;
    bucket.engagementSum += engagementRate(row.insights7d);
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([key, b]) => ({ key, count: b.count, avgReach: b.reachSum / b.count, avgEngagementRate: b.engagementSum / b.count }))
    .sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);
}

function hookLengthBucket(hook: string): string {
  if (hook.length < 40) return "short (<40 chars)";
  if (hook.length <= 80) return "medium (40-80 chars)";
  return "long (>80 chars)";
}

/**
 * cc_prompt_ig_insights_tracking.md, 2026-09-07 — read-only aggregate over drafts that already
 * have a 7-day insights snapshot (jobs/igInsights.ts). No self-optimizing logic (V1 explicitly
 * excludes that per the prompt) — just a sorted JSON report for a human to read and decide from.
 */
adminIgDraftsRouter.get("/insights-report", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const docs = await withDb(c.env, (db) => db.collection("ig_content_drafts").find({ insights7d: { $exists: true } }).toArray());
    const rows: InsightsRow[] = docs.map((d) => ({
      pillar: d.pillar as string | undefined,
      category: d.category as string | undefined,
      hook: d.hook as string | undefined,
      targetAccount: d.targetAccount as "uiu" | "affiliate",
      insights7d: d.insights7d as InsightsRow["insights7d"],
    }));

    const byPillar = groupAverage(
      rows.filter((r) => r.targetAccount === "uiu"),
      (r) => r.pillar,
    );
    const byHookLength = groupAverage(
      rows.filter((r) => !!r.hook),
      (r) => hookLengthBucket(r.hook!),
    );
    const byCategory = groupAverage(
      rows.filter((r) => r.targetAccount === "affiliate"),
      (r) => r.category,
    );

    const body: ApiResponse<{ sampleSize: number; byPillar: typeof byPillar; byHookLength: typeof byHookLength; byCategory: typeof byCategory }> = {
      ok: true,
      data: { sampleSize: rows.length, byPillar, byHookLength, byCategory },
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts insights-report error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to build insights report" } };
    return c.json(body, 502);
  }
});

adminIgDraftsRouter.get("/", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const statusParam = c.req.query("status");
  const filter = statusParam && statusParam !== "all" ? { status: statusParam } : {};
  try {
    const docs = await withDb(c.env, (db) => db.collection("ig_content_drafts").find(filter).sort({ createdAt: -1 }).limit(30).toArray());
    const body: ApiResponse<Array<Omit<IgContentDraft, "_id"> & { _id: string }>> = { ok: true, data: docs.map(toIgDraft) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-drafts list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch ig_content_drafts" } };
    return c.json(body, 502);
  }
});
