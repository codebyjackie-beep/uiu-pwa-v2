/**
 * Tests for processDuePosts (claim / paused / missed / duplicate / failure) against an in-memory fake Mongo.
 * Run: npx tsx apps/api/test/igQueue.test.ts   (no network, no Mongo)
 */
import { contentHash, GraphError, type IgPublishRequest } from "../src/services/igPublish";
import { processDuePosts, QUEUE, type QueueEnv } from "../src/services/igPublishQueue";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

type Doc = Record<string, any>;
function makeDb(seed: Record<string, Doc[]> = {}) {
  const cols: Record<string, Doc[]> = { [QUEUE]: [], ig_publish_audit: [], ...seed };
  let n = 0;
  const match = (d: Doc, f: Doc): boolean =>
    Object.entries(f).every(([k, v]) => {
      if (v && typeof v === "object" && "$in" in v) return v.$in.includes(d[k]);
      if (v && typeof v === "object" && "$lte" in v) return d[k] <= v.$lte;
      if (v && typeof v === "object" && "$gte" in v) return d[k] >= v.$gte;
      return d[k] === v;
    });
  const col = (name: string) => ({
    findOne: async (f: Doc) => cols[name]!.find((d) => match(d, f)) ?? null,
    insertOne: async (d: Doc) => {
      const _id = `id${++n}`;
      cols[name]!.push({ _id, ...d });
      return { insertedId: _id };
    },
    updateOne: async (f: Doc, u: Doc) => {
      const d = cols[name]!.find((x) => match(x, f));
      if (d) Object.assign(d, u.$set);
      return { modifiedCount: d ? 1 : 0 };
    },
    findOneAndUpdate: async (f: Doc, u: Doc) => {
      const d = cols[name]!.filter((x) => match(x, f)).sort((a, b) => String(a.publishAt).localeCompare(String(b.publishAt)))[0];
      if (!d) return null;
      Object.assign(d, u.$set);
      return d;
    },
  });
  const withDb = (async (_env: unknown, fn: (db: any) => Promise<unknown>) => fn({ collection: col })) as never;
  return { cols, withDb };
}

const NOW = Date.parse("2026-11-16T18:00:30Z");
const env: QueueEnv = { MONGODB_URI: "x", MONGODB_DB: "x", IG_TOKEN_UIU: "tok", IG_ID_UIU: "123", IG_AUTOMATION_PAUSED: "false" } as QueueEnv;
const req: IgPublishRequest = { type: "image", caption: "hello", imageUrl: "https://x.com/a.jpg", write: true } as IgPublishRequest;
const job = (publishAt: string, extra: Doc = {}) => ({ _id: `j-${publishAt}`, req, publishAt, status: "scheduled", contentHash: "h", ...extra });

let published = 0;
const okPublish = (async () => {
  published++;
  return { mediaId: "m1", commentId: null };
}) as never;

async function main() {
  // 1) happy path + fired twice => published once
  {
    published = 0;
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T18:00:00.000Z")] });
    const s1 = await processDuePosts(env, NOW, { publish: okPublish, withDb });
    const s2 = await processDuePosts(env, NOW + 1000, { publish: okPublish, withDb });
    eq("published once", published, 1);
    eq("first run summary", [s1.due, s1.published], [1, 1]);
    eq("second run nothing due", s2.due, 0);
    eq("job published", cols[QUEUE]![0]!.status, "published");
    eq("audit written+published", [cols.ig_publish_audit!.length, cols.ig_publish_audit![0]!.status], [1, "published"]);
  }
  // 2) paused => refused_paused, nothing published
  {
    published = 0;
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T18:00:00.000Z")] });
    const s = await processDuePosts({ ...env, IG_AUTOMATION_PAUSED: "true" }, NOW, { publish: okPublish, withDb });
    eq("paused: not published", published, 0);
    eq("paused: status", [s.paused, s.refusedPaused, cols[QUEUE]![0]!.status, cols[QUEUE]![0]!.error?.code], [true, 1, "refused_paused", "ig_automation_paused"]);
  }
  // 3) overdue >2h => missed
  {
    published = 0;
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T15:00:00.000Z")] });
    const s = await processDuePosts(env, NOW, { publish: okPublish, withDb });
    eq("missed: not published", published, 0);
    eq("missed: status", [s.missed, cols[QUEUE]![0]!.status, cols[QUEUE]![0]!.error?.code], [1, "missed", "missed_window"]);
  }
  // 4) not yet due => untouched
  {
    published = 0;
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T19:00:00.000Z")] });
    const s = await processDuePosts(env, NOW, { publish: okPublish, withDb });
    eq("future: untouched", [s.due, published, cols[QUEUE]![0]!.status], [0, 0, "scheduled"]);
  }
  // 5) audit already has the same content published in last 24h => failed duplicate_publish
  {
    published = 0;
    const hash = await contentHash(req);
    const { cols, withDb } = makeDb({
      [QUEUE]: [job("2026-11-16T18:00:00.000Z")],
      ig_publish_audit: [{ _id: "a0", contentHash: hash, status: "published", createdAt: "2026-11-16T10:00:00.000Z" }],
    });
    const s = await processDuePosts(env, NOW, { publish: okPublish, withDb });
    eq("dup: not published", published, 0);
    eq("dup: status", [s.failed, cols[QUEUE]![0]!.status, cols[QUEUE]![0]!.error?.code], [1, "failed", "duplicate_publish"]);
  }
  // 6) Graph failure => failed, classified, not retried
  {
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T18:00:00.000Z")] });
    let calls = 0;
    const boom = (async () => {
      calls++;
      throw new GraphError("Invalid OAuth access token", 400, "auth", 190);
    }) as never;
    await processDuePosts(env, NOW, { publish: boom, withDb });
    await processDuePosts(env, NOW + 1000, { publish: boom, withDb });
    const j = cols[QUEUE]![0]!;
    eq("graph fail: called once (no retry)", calls, 1);
    eq("graph fail: error", [j.status, j.error?.code, j.error?.kind, j.error?.graphCode, j.error?.retryable], ["failed", "graph_error", "auth", 190, false]);
    eq("graph fail: audit failed", cols.ig_publish_audit![0]!.status, "failed");
  }
  // 7) missing token => failed ig_not_configured
  {
    published = 0;
    const { cols, withDb } = makeDb({ [QUEUE]: [job("2026-11-16T18:00:00.000Z")] });
    await processDuePosts({ ...env, IG_TOKEN_UIU: undefined } as QueueEnv, NOW, { publish: okPublish, withDb });
    eq("no token: failed", [published, cols[QUEUE]![0]!.status, cols[QUEUE]![0]!.error?.code], [0, "failed", "ig_not_configured"]);
  }
  // 8) MAX_PER_FIRE caps a single run to 3
  {
    published = 0;
    const jobs = [0, 1, 2, 3, 4].map((i) => job("2026-11-16T18:00:00.000Z", { _id: `m${i}`, contentHash: `h${i}`, req: { ...req, caption: `c${i}` } }));
    const { cols, withDb } = makeDb({ [QUEUE]: jobs });
    const s = await processDuePosts(env, NOW, { publish: okPublish, withDb });
    eq("cap 3 per fire", [s.due, published, cols[QUEUE]!.filter((j) => j.status === "scheduled").length], [3, 3, 2]);
  }
  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("igQueue tests passed");
}
main();
