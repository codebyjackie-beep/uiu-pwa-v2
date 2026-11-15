/**
 * Tests for the structured notify helpers in services/cloudNotify.ts.
 * Run: npx tsx apps/api/test/adminNotify.test.ts
 * Telegram is mocked (globalThis.fetch) and Mongo is an in-memory fake that enforces the unique
 * titleHash index — nothing leaves the process.
 */
import type { Db } from "mongodb";
import { formatNotifyText, notifyStructured, validateNotifyRequest, NOTIFY_DEDUPE_MS, NOTIFY_LOG_TTL_SECONDS } from "../src/services/cloudNotify";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, c: boolean) => eq(name, c, true);
const valid = (raw: unknown) => validateNotifyRequest(raw).ok;

const J = "https://claude.ai/artifact/abc123#office";

// --- title ---
ok("title only", valid({ title: "AFF-002 final" }));
ok("title 100", valid({ title: "a".repeat(100) }));
ok("title 101", !valid({ title: "a".repeat(101) }));
ok("title empty", !valid({ title: "   " }));
ok("title number", !valid({ title: 5 }));
ok("title missing", !valid({ body: "x" }));
ok("not object", !valid("hi"));
ok("array", !valid([]));
ok("null", !valid(null));

// --- body ---
ok("body 400", valid({ title: "t", body: "b".repeat(400) }));
ok("body 401", !valid({ title: "t", body: "b".repeat(401) }));
ok("body number", !valid({ title: "t", body: 1 }));
ok("body null", !valid({ title: "t", body: null }));

// --- url ---
ok("jarvis url", valid({ title: "t", url: J }));
ok("http", !valid({ title: "t", url: "http://claude.ai/artifact/x" }));
ok("lookalike host", !valid({ title: "t", url: "https://claude.ai.evil.com/x" }));
ok("prefix in query", !valid({ title: "t", url: "https://evil.com/?https://claude.ai/" }));
ok("newline", !valid({ title: "t", url: "https://claude.ai/x\nhttps://evil.com" }));
ok("space", !valid({ title: "t", url: "https://claude.ai/x y" }));
ok("bare host no slash", !valid({ title: "t", url: "https://claude.ai" }));
ok("url number", !valid({ title: "t", url: 1 }));
ok("url too long", !valid({ title: "t", url: "https://claude.ai/" + "a".repeat(600) }));

// --- format (plain text) ---
eq("format all", formatNotifyText({ title: "T", body: "B", url: J }), `T\n\nB\n\n${J}`);
eq("format title only", formatNotifyText({ title: "T" }), "T");
const trimmed = validateNotifyRequest({ title: "  T  ", body: "  " });
eq("trim + drop empty body", trimmed.ok && trimmed.value, { title: "T" });

// --- fake Mongo: unique titleHash, upsert semantics like the real driver ---
type Doc = Record<string, any>;
const tick = () => new Promise((r) => setTimeout(r, 0));
function matches(d: Doc, q: Doc): boolean {
  return Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date) && "$lt" in v) return d[k] < v.$lt;
    return d[k] === v;
  });
}
function fakeDb() {
  const log: Doc[] = [];
  const indexes: Doc[] = [];
  const hooks = { failMessageIdWrite: false };
  const dup = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const collections: Record<string, any> = {
    cloud_notify_config: { findOne: async () => ({ _id: "chat", chatId: 1 }) },
    cloud_notify_log: {
      createIndex: async (key: Doc, opts: Doc) => void indexes.push({ key, opts }),
      findOne: async (q: Doc) => log.find((d) => matches(d, q)) ?? null,
      deleteOne: async (q: Doc) => {
        const i = log.findIndex((d) => matches(d, q));
        if (i >= 0) log.splice(i, 1);
      },
      updateOne: async (q: Doc, u: Doc, o: Doc = {}) => {
        await tick(); // let concurrent callers interleave
        if (hooks.failMessageIdWrite && u.$set?.messageId !== undefined) throw new Error("write failed");
        const d = log.find((x) => matches(x, q));
        if (d) {
          Object.assign(d, u.$set ?? {});
          for (const k of Object.keys(u.$unset ?? {})) delete d[k];
          return;
        }
        if (!o.upsert) return;
        const doc = { ...u.$set };
        if (log.some((x) => x.titleHash === doc.titleHash)) throw dup(); // unique index
        log.push(doc);
      },
    },
  };
  return { db: { collection: (n: string) => collections[n] } as unknown as Db, log, indexes, hooks };
}

let sends = 0;
let failNext = false;
const sentTexts: string[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  await tick();
  if (failNext) {
    failNext = false;
    return new Response(JSON.stringify({ ok: false, description: "boom" }), { status: 500 });
  }
  sends++;
  const body = JSON.parse(init?.body ?? "{}");
  sentTexts.push(body.text);
  if ("parse_mode" in body) failures++, console.error("FAIL parse_mode must not be set");
  return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }), { status: 200 });
}) as typeof fetch;

const env = { CLOUD_NOTIFY_BOT_TOKEN: "test-token" };
const t0 = new Date("2026-11-15T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const { db, log, indexes, hooks } = fakeDb();

// basic send + record
const r1 = await notifyStructured(env, db, { title: "AFF-002 final", body: "b", url: J }, t0);
eq("first send", { sent: r1.sent, deduped: r1.deduped }, { sent: true, deduped: false });
eq("sent text", sentTexts[0], `AFF-002 final\n\nb\n\n${J}`);
ok("log stores hash not title", log.length === 1 && !JSON.stringify(log[0]).includes("AFF-002"));
eq("messageId recorded", log[0]!.messageId, 1);

// indexes (item 3)
ok("unique titleHash index", indexes.some((i) => i.key.titleHash === 1 && i.opts.unique === true));
ok("TTL sentAt 24h", indexes.some((i) => i.key.sentAt === 1 && i.opts.expireAfterSeconds === NOTIFY_LOG_TTL_SECONDS && NOTIFY_LOG_TTL_SECONDS === 86400));

// window
const r2 = await notifyStructured(env, db, { title: "AFF-002 final" }, at(60_000));
eq("same title within 5 min deduped", { sent: r2.sent, deduped: r2.deduped }, { sent: false, deduped: true });
eq("lastSentAt returned", (r2 as { lastSentAt?: string }).lastSentAt, t0.toISOString());
eq("no extra send", sends, 1);
const r3 = await notifyStructured(env, db, { title: "UIU-006 final" }, at(60_000));
eq("other title sends", r3.sent, true);
const r4 = await notifyStructured(env, db, { title: "AFF-002 final" }, at(NOTIFY_DEDUPE_MS + 1));
eq("after 5 min sends again", r4.sent, true);
eq("still one doc per title", log.filter((d) => d.titleHash === log[0]!.titleHash).length, 1);

// item 1: concurrent same title -> exactly one send
const before = sends;
const conc = await Promise.all(
  Array.from({ length: 5 }, () => notifyStructured(env, db, { title: "race" }, at(10 * 60_000))),
);
eq("concurrent: one sent", conc.filter((r) => r.sent).length, 1);
eq("concurrent: four deduped", conc.filter((r) => r.deduped).length, 4);
eq("concurrent: one Telegram call", sends - before, 1);

// failed send releases the claim -> immediate retry works
failNext = true;
let threw = false;
try {
  await notifyStructured(env, db, { title: "flaky" }, t0);
} catch {
  threw = true;
}
ok("failed send throws", threw);
const r5 = await notifyStructured(env, db, { title: "flaky" }, t0);
eq("failed send released -> retry sends", r5.sent, true);

// item 2: bookkeeping write fails after a successful send -> still sent:true, and still deduped after
hooks.failMessageIdWrite = true;
const sendsB = sends;
let r6: Awaited<ReturnType<typeof notifyStructured>> | null = null;
try {
  r6 = await notifyStructured(env, db, { title: "log-write-fails" }, t0);
} catch {
  r6 = null;
}
hooks.failMessageIdWrite = false;
eq("record write failure -> no throw, sent:true", r6 && { sent: r6.sent, deduped: r6.deduped }, { sent: true, deduped: false });
eq("record write failure -> one send", sends - sendsB, 1);
const r7 = await notifyStructured(env, db, { title: "log-write-fails" }, at(1_000));
eq("record write failure -> claim still dedupes", r7.deduped, true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("adminNotify tests: all passed");
