/**
 * Tests for IG scheduling validation, media sniffing, Graph error classification and the read-only diagnostics.
 * Run: npx tsx apps/api/test/igScheduling.test.ts   (no network, no Mongo)
 */
import { classifyGraphError, parsePublishAt, validatePublishRequest } from "../src/services/igPublish";
import { checkUpload, sniffMedia } from "../src/services/igUploadedMedia";
import { runIgDiagnostics } from "../src/services/igDiagnostics";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, c: boolean) => eq(name, c, true);

// ---- publishAt ----
const NOW = Date.parse("2026-11-15T12:00:00Z");
eq("18:00Z ok", parsePublishAt("2026-11-16T18:00:00Z", NOW), { ok: true, iso: "2026-11-16T18:00:00.000Z" });
eq("offset normalised", parsePublishAt("2026-11-16T19:00:00+01:00", NOW), { ok: true, iso: "2026-11-16T18:00:00.000Z" });
ok("naive time rejected", !parsePublishAt("2026-11-16T18:00:00", NOW).ok);
ok("not on the hour rejected", !parsePublishAt("2026-11-16T18:30:00Z", NOW).ok);
ok("past rejected", !parsePublishAt("2026-11-15T11:00:00Z", NOW).ok);
ok(">30d rejected", !parsePublishAt("2026-12-30T18:00:00Z", NOW).ok);
ok("non-string rejected", !parsePublishAt(12345, NOW).ok);
const img = { type: "image", caption: "hi", imageUrl: "https://x.com/a.jpg", publishAt: "2026-11-16T18:00:00Z" };
const v = validatePublishRequest(img, NOW);
ok("request with publishAt valid", v.ok && v.value.publishAt === "2026-11-16T18:00:00.000Z");
ok("request with bad publishAt invalid", !validatePublishRequest({ ...img, publishAt: "tomorrow 6pm" }, NOW).ok);

// ---- media sniffing ----
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const mov = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
eq("jpeg", sniffMedia(jpeg)?.ext, "jpg");
eq("png not IG compatible", sniffMedia(png)?.igCompatible, false);
eq("mp4", sniffMedia(mp4)?.ext, "mp4");
eq("mov", sniffMedia(mov)?.ext, "mov");
eq("html rejected", sniffMedia(new TextEncoder().encode("<html>")), null);
eq("empty rejected", checkUpload(new Uint8Array(0)).ok, false);
const bigImg = new Uint8Array(8 * 1024 * 1024 + 1);
bigImg.set(jpeg);
const big = checkUpload(bigImg);
ok("oversize image 413", !big.ok && big.status === 413 && big.code === "media_too_large");
const bigVid = new Uint8Array(15 * 1024 * 1024 + 1);
bigVid.set(mp4);
ok("oversize video 413", (() => { const r = checkUpload(bigVid); return !r.ok && r.status === 413; })());
ok("exe-as-jpg header lies, bytes decide", (() => { const r = checkUpload(new TextEncoder().encode("MZ......")); return !r.ok && r.status === 415; })());

// ---- graph error classification ----
eq("190 auth", classifyGraphError('{"error":{"code":190,"message":"x"}}'), { kind: "auth", graphCode: 190 });
eq("200 permission", classifyGraphError('{"error":{"code":200}}'), { kind: "permission", graphCode: 200 });
eq("4 rate", classifyGraphError('{"error":{"code":4}}'), { kind: "rate_limit", graphCode: 4 });
eq("9004 media", classifyGraphError('{"error":{"code":9004}}'), { kind: "media", graphCode: 9004 });
eq("junk unknown", classifyGraphError("<html>"), { kind: "unknown" });

// ---- diagnostics: read-only + never leaks the token ----
const TOKEN = "EAAB_SECRET_TOKEN_123";
const calls: Array<{ method: string; url: string }> = [];
const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
  const url = String(input);
  calls.push({ method: init?.method ?? "GET", url });
  if (url.includes("/debug_token")) return new Response(JSON.stringify({ data: { is_valid: true, type: "SYSTEM_USER", expires_at: 0, scopes: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"] } }));
  if (url.includes("content_publishing_limit")) return new Response(JSON.stringify({ data: [{ quota_usage: 0 }] }));
  if (url.includes("/me/permissions")) return new Response(JSON.stringify({ error: { code: 100, message: `bad ${TOKEN}` } }), { status: 400 });
  return new Response(JSON.stringify({ id: "1784", username: "useitup.uk" }));
}) as typeof fetch;
const d = await runIgDiagnostics("1784", TOKEN, fakeFetch);
eq("verdict yes", d.canPublishVerdict, "yes");
eq("never expires", d.neverExpires, true);
ok("only GET", calls.every((c) => c.method === "GET"));
ok("token not in output", !JSON.stringify(d).includes(TOKEN));
const d2 = await runIgDiagnostics("1784", TOKEN, (async (u: URL | string) => (String(u).includes("/debug_token") ? new Response(JSON.stringify({ data: { is_valid: true, scopes: ["instagram_basic"] } })) : new Response("{}"))) as typeof fetch);
eq("missing publish scope => no", d2.canPublishVerdict, "no");
eq("unconfigured", (await runIgDiagnostics("1784", undefined, fakeFetch)).configured, false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("igScheduling tests passed");
