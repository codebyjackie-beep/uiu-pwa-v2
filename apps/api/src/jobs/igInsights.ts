/**
 * cc_prompt_ig_insights_tracking.md, 2026-09-07 — post-publish performance tracking for the IG
 * Content Agent. Hook-first prompts / CTA / hashtag research / pillar rotation / branded
 * templates were all shipped with zero way to check whether any of it actually moves reach —
 * this job closes that gap by snapshotting each published draft's /insights at 24h and 7d after
 * publish, stored on the same ig_content_drafts doc the pillar/hook/hashtag metadata already
 * lives on (see igContentAgent.ts's IgContentDraft — no join needed).
 */
import type { Document } from "mongodb";
import { withDb } from "../db";
import { getMediaInsights } from "../services/instagram";
import { accountFor, type PublishEnv, type TargetAccount } from "./igContentAgent";

const DRAFTS_COLLECTION = "ig_content_drafts";
const HOURS_24 = 24;
const HOURS_7D = 24 * 7;

export interface InsightsCronSummary {
  checked: number;
  fetched24h: number;
  fetched7d: number;
  errored24h: number;
  errored7d: number;
  skipped: number;
}

interface CandidateDoc {
  _id: unknown;
  targetAccount: TargetAccount;
  publishedAt: string;
  publishedMediaId: string;
  insightsFetched?: { h24?: boolean; d7?: boolean };
}

async function snapshotOne(env: PublishEnv, doc: CandidateDoc, window: "h24" | "d7"): Promise<"fetched" | "errored"> {
  const field = window === "h24" ? "insights24h" : "insights7d";
  const errorField = window === "h24" ? "insightsError24h" : "insightsError7d";
  try {
    const account = accountFor(env, doc.targetAccount);
    const metrics = await getMediaInsights(account, doc.publishedMediaId);
    await withDb(env, async (db) => {
      await db.collection(DRAFTS_COLLECTION).updateOne(
        { _id: doc._id } as unknown as Document,
        {
          $set: {
            [field]: { ...metrics, fetchedAt: new Date().toISOString() },
            [`insightsFetched.${window}`]: true,
          },
          $unset: { [errorField]: "" },
        },
      );
    });
    return "fetched";
  } catch (err) {
    // Expected, not a bug, for media published before the 2026-08-31 brand merge — those media
    // ids belong to the retired @kura.nook account and 403 under the merged @useitup.app token.
    // Mark the window attempted either way so the cron doesn't retry it forever.
    const message = err instanceof Error ? err.message : String(err);
    await withDb(env, async (db) => {
      await db
        .collection(DRAFTS_COLLECTION)
        .updateOne({ _id: doc._id } as unknown as Document, { $set: { [errorField]: message, [`insightsFetched.${window}`]: true } });
    });
    return "errored";
  }
}

/** Manual-trigger entry point (POST /api/admin/ig-insights-cron-run) and the hourly cron
 * (scheduled(), see index.ts). Idempotent within a window — a draft that already has
 * insightsFetched.h24/d7 set is skipped by the query, never re-fetched. */
export async function runInsightsSnapshotCron(env: PublishEnv): Promise<InsightsCronSummary> {
  const docs = await withDb(env, (db) =>
    db
      .collection<Document>(DRAFTS_COLLECTION)
      .find({
        status: "approved",
        publishedAt: { $exists: true },
        publishedMediaId: { $exists: true },
        $or: [{ "insightsFetched.h24": { $ne: true } }, { "insightsFetched.d7": { $ne: true } }],
      })
      .toArray(),
  );

  const summary: InsightsCronSummary = { checked: docs.length, fetched24h: 0, fetched7d: 0, errored24h: 0, errored7d: 0, skipped: 0 };
  const now = new Date();

  for (const raw of docs) {
    const doc = raw as unknown as CandidateDoc;
    const publishedAt = new Date(doc.publishedAt);
    const hoursSince = (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60);
    const fetched = doc.insightsFetched ?? {};

    let touched = false;
    if (hoursSince >= HOURS_24 && !fetched.h24) {
      touched = true;
      const result = await snapshotOne(env, doc, "h24");
      if (result === "fetched") summary.fetched24h++;
      else summary.errored24h++;
    }
    if (hoursSince >= HOURS_7D && !fetched.d7) {
      touched = true;
      const result = await snapshotOne(env, doc, "d7");
      if (result === "fetched") summary.fetched7d++;
      else summary.errored7d++;
    }
    if (!touched) summary.skipped++;
  }

  return summary;
}
