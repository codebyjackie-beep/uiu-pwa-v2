/**
 * Tests for the structured notify helpers in services/cloudNotify.ts.
 * Run: npx tsx apps/api/test/adminNotify.test.ts
 * Telegram is mocked (globalThis.fetch) and Mongo is an in-memory fake — nothing leaves the process.
 */
import type { Db } from "mongodb";
import { formatNotifyText, notifyStructured, validateNotifyRequest, NOTIFY_DEDUPE_MS } from "../src/services/cloudNotify";

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

// --- dedupe (fake db + mocked fetch) ---
type Doc = Record<string, any>;
function fakeDb(): { db: Db; log: Doc[] } {
  const log: Doc[] = [];
  const collections: Record<string, any> = {
    cloud_notify_config: { findOne: async () => ({ _id: "chat", chatId: 1 }) },
    cloud_notify_log: {
      findOne: async (q: Doc) => log.find((d) => d.titleHash === q.titleHash && d.sentAt >= q.sentAt.$gte) ?? null,
      insertOne: async (d: Doc) => void log.push(d),
    },
  };
  return { db: { collection: (n: string) => collections[n] } as unknown as Db, log };
}

let sends = 0;
let failNext = false;
const sentTexts: string[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
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
const { db, log } = fakeDb();

const r1 = await notifyStructured(env, db, { title: "AFF-002 final", body: "b", url: J }, t0);
eq("first send", { sent: r1.sent, deduped: r1.deduped }, { sent: true, deduped: false });
eq("sent text", sentTexts[0], `AFF-002 final\n\nb\n\n${J}`);
ok("log stores hash not title", log.length === 1 && !JSON.stringify(log[0]).includes("AFF-002"));

const r2 = await notifyStructured(env, db, { title: "AFF-002 final" }, new Date(t0.getTime() + 60_000));
eq("same title within 5 min deduped", { sent: r2.sent, deduped: r2.deduped }, { sent: false, deduped: true });
eq("no extra send", sends, 1);

const r3 = await notifyStructured(env, db, { title: "UIU-006 final" }, new Date(t0.getTime() + 60_000));
eq("other title sends", r3.sent, true);

const r4 = await notifyStructured(env, db, { title: "AFF-002 final" }, new Date(t0.getTime() + NOTIFY_DEDUPE_MS + 1));
eq("after 5 min sends again", r4.sent, true);

failNext = true;
let threw = false;
try {
  await notifyStructured(env, db, { title: "flaky" }, t0);
} catch {
  threw = true;
}
ok("failed send throws", threw);
const r5 = await notifyStructured(env, db, { title: "flaky" }, t0);
eq("failed send not recorded -> retry sends", r5.sent, true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("adminNotify tests: all passed");
