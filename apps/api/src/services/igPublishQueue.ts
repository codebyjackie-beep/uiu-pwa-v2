/**
 * Server-side scheduler for Instagram posts. Instagram's API has no scheduling parameter, so a request
 * with `publishAt` is stored in `ig_publish_queue` and published by the hourly cron ("0 * * * *", :00 UTC —
 * 18:00 UK is 18:00Z in winter / 17:00Z in summer; publishAt must be on a UTC hour boundary).
 *
 * Rules:
 *   - Enqueue is refused while IG_AUTOMATION_PAUSED (same gate as a direct publish) and the cron re-checks:
 *     paused at fire time => status "refused_paused" (terminal, needs Jackie), never silently held.
 *   - Atomic claim (scheduled -> publishing) so overlapping fires can never double-post.
 *   - NEVER retried: any failure is terminal with a machine-readable `error` {code, kind, retryable:false};
 *     the AI Office publisher reads it via GET /api/admin/ig-publish/queue/:id and raises needs_jackie.
 *   - A job more than MISSED_AFTER_MS past due (cron outage / unpaused late) becomes "missed", not a late post.
 *   - A job stuck in "publishing" is never auto-retried (could double-post); it is surfaced as-is.
 */
import type { Db, Document } from "mongodb";
import { getMongoModule, withDb, type DbEnv } from "../db";
import type { PublishEnv } from "../jobs/igContentAgent"; // type-only: keeps the cron path (and tests) free of the image/wasm deps
import { contentHash, executePublish, GraphError, pausedRefusal, type IgPublishRequest } from "./igPublish";

export const QUEUE = "ig_publish_queue";
const AUDIT = "ig_publish_audit";
export const MISSED_AFTER_MS = 2 * 3600 * 1000;
export const MAX_PER_FIRE = 3;

export type QueueStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "refused_paused" | "missed";
export type QueueEnv = DbEnv & PublishEnv & { IG_AUTOMATION_PAUSED?: string };

export interface QueueError {
  code: string;
  kind?: string;
  graphCode?: number;
  message: string;
  retryable: false;
}

export function serializeJob(d: Document) {
  return {
    id: String(d._id),
    status: d.status as QueueStatus,
    type: d.req?.type,
    publishAt: d.publishAt as string,
    contentHash: d.contentHash,
    mediaId: d.mediaId ?? null,
    commentError: d.commentError ?? null,
    error: (d.error as QueueError | undefined) ?? null,
    createdAt: d.createdAt,
    startedAt: d.startedAt ?? null,
    finishedAt: d.finishedAt ?? null,
  };
}

export async function enqueuePost(env: DbEnv, req: IgPublishRequest, hash: string): Promise<{ id: string } | { duplicate: Document }> {
  return withDb(env, async (db) => {
    const col = db.collection(QUEUE);
    // DB-level guard: at most one *scheduled* job per contentHash (closes the findOne/insertOne race).
    await col.createIndex({ contentHash: 1 }, { unique: true, partialFilterExpression: { status: "scheduled" }, name: "uniq_scheduled_hash" }).catch(() => undefined);
    const dup = await col.findOne({ contentHash: hash, status: { $in: ["scheduled", "publishing"] } });
    if (dup) return { duplicate: dup };
    const { write: _w, ...stored } = req;
    try {
      const res = await col.insertOne({ req: stored, publishAt: req.publishAt!, status: "scheduled", contentHash: hash, createdAt: new Date().toISOString() });
      return { id: String(res.insertedId) };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const again = await col.findOne({ contentHash: hash, status: "scheduled" });
        if (again) return { duplicate: again };
      }
      throw err;
    }
  });
}

export async function getJob(env: DbEnv, id: string): Promise<Document | null> {
  const { ObjectId } = await getMongoModule();
  let oid;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }
  return withDb(env, (db) => db.collection(QUEUE).findOne({ _id: oid }));
}

export async function listJobs(env: DbEnv, status?: string): Promise<Document[]> {
  return withDb(env, (db) => db.collection(QUEUE).find(status ? { status } : {}).sort({ publishAt: -1 }).limit(100).toArray());
}

/** Cancel only a still-scheduled job. Returns true if it was cancelled. */
export async function cancelJob(env: DbEnv, id: string): Promise<boolean> {
  const { ObjectId } = await getMongoModule();
  let oid;
  try {
    oid = new ObjectId(id);
  } catch {
    return false;
  }
  const r = await withDb(env, (db) => db.collection(QUEUE).updateOne({ _id: oid, status: "scheduled" }, { $set: { status: "cancelled", finishedAt: new Date().toISOString() } }));
  return r.modifiedCount === 1;
}

async function fail(db: Db, id: unknown, status: QueueStatus, error: QueueError): Promise<void> {
  await db.collection(QUEUE).updateOne({ _id: id as never }, { $set: { status, error, finishedAt: new Date().toISOString() } }).catch(() => undefined);
}

export interface QueueRunSummary {
  paused: boolean;
  due: number;
  published: number;
  failed: number;
  missed: number;
  refusedPaused: number;
}

/** Called by the hourly cron. Never throws for a single job's failure. */
export async function processDuePosts(env: QueueEnv, now: number = Date.now(), deps: { publish?: typeof executePublish; withDb?: typeof withDb } = {}): Promise<QueueRunSummary> {
  const publish = deps.publish ?? executePublish;
  const run = deps.withDb ?? withDb;
  const sum: QueueRunSummary = { paused: false, due: 0, published: 0, failed: 0, missed: 0, refusedPaused: 0 };
  const nowIso = new Date(now).toISOString();
  const pausedReason = pausedRefusal(env.IG_AUTOMATION_PAUSED);
  sum.paused = pausedReason !== null;

  for (let i = 0; i < MAX_PER_FIRE; i++) {
    // Atomic claim: only one fire can move a given job scheduled -> publishing.
    const job = await run(env, (db) =>
      db.collection(QUEUE).findOneAndUpdate({ status: "scheduled", publishAt: { $lte: nowIso } }, { $set: { status: "publishing", startedAt: nowIso } }, { sort: { publishAt: 1 }, returnDocument: "after" }),
    );
    if (!job) break;
    sum.due++;
    const id = job._id;
    const overdue = now - Date.parse(String(job.publishAt)) > MISSED_AFTER_MS;
    if (pausedReason) {
      sum.refusedPaused++;
      await run(env, (db) => fail(db, id, "refused_paused", { code: "ig_automation_paused", message: pausedReason, retryable: false }));
      continue;
    }
    if (overdue) {
      sum.missed++;
      await run(env, (db) => fail(db, id, "missed", { code: "missed_window", message: `publishAt ${String(job.publishAt)} was more than 2h before the scheduler ran; not posted late — reschedule`, retryable: false }));
      continue;
    }
    if (!env.IG_TOKEN_UIU || !env.IG_ID_UIU) {
      sum.failed++;
      await run(env, (db) => fail(db, id, "failed", { code: "ig_not_configured", message: "IG_TOKEN_UIU / IG_ID_UIU missing", retryable: false }));
      continue;
    }
    const req = { ...(job.req as IgPublishRequest), write: true };
    // Same 24h duplicate guard as a direct publish, plus an audit row for every real attempt.
    const hash = await contentHash(req);
    let auditId: unknown;
    try {
      const since = new Date(now - 24 * 3600 * 1000).toISOString();
      const dup = await run(env, (db) => db.collection(AUDIT).findOne({ contentHash: hash, status: { $in: ["published", "publishing"] }, createdAt: { $gte: since } }));
      if (dup) {
        sum.failed++;
        await run(env, (db) => fail(db, id, "failed", { code: "duplicate_publish", message: "Identical content was published (or is publishing) in the last 24h", retryable: false }));
        continue;
      }
      auditId = (
        await run(env, (db) =>
          db.collection(AUDIT).insertOne({
            type: req.type,
            caption: req.caption,
            captionLength: req.caption.length,
            mediaUrls: req.type === "image" ? [req.imageUrl] : req.type === "carousel" ? req.imageUrls : [req.videoUrl, ...(req.coverUrl ? [req.coverUrl] : [])],
            hasFirstComment: !!req.firstComment,
            igUserId: env.IG_ID_UIU,
            contentHash: hash,
            createdAt: nowIso,
            dryRun: false,
            status: "publishing",
            queueId: String(id),
          }),
        )
      ).insertedId;
    } catch (err) {
      sum.failed++;
      console.error("[uiu-api] ig-queue audit failed:", err instanceof Error ? err.message : String(err));
      await run(env, (db) => fail(db, id, "failed", { code: "db_error", message: "Could not write audit record; refusing to publish without one", retryable: false })).catch(() => undefined);
      continue;
    }
    try {
      const result = await publish({ igUserId: env.IG_ID_UIU, accessToken: env.IG_TOKEN_UIU }, req);
      sum.published++;
      const finishedAt = new Date().toISOString();
      await run(env, async (db) => {
        await db.collection(QUEUE).updateOne({ _id: id as never }, { $set: { status: "published", mediaId: result.mediaId, commentId: result.commentId ?? null, commentError: result.commentError ?? null, finishedAt } });
        await db.collection(AUDIT).updateOne({ _id: auditId as never }, { $set: { status: "published", mediaId: result.mediaId, finishedAt } });
      }).catch(() => undefined);
    } catch (err) {
      sum.failed++;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500); // GraphError text is already token-redacted
      const error: QueueError = { code: "graph_error", kind: err instanceof GraphError ? err.kind : "unknown", graphCode: err instanceof GraphError ? err.graphCode : undefined, message, retryable: false };
      console.error("[uiu-api] ig-queue publish failed:", message);
      await run(env, async (db) => {
        await fail(db, id, "failed", error);
        await db.collection(AUDIT).updateOne({ _id: auditId as never }, { $set: { status: "failed", error: message, finishedAt: new Date().toISOString() } });
      }).catch(() => undefined);
    }
  }
  return sum;
}
