/**
 * Tests for services/igPublish.ts. Run: npx tsx apps/api/test/igPublish.test.ts
 * Graph API is fully mocked (fetchFn) — nothing here ever reaches graph.facebook.com.
 */
import { buildGraphPlan, checkPublicUrl, contentHash, executePublish, pausedRefusal, validatePublishRequest, type IgPublishRequest } from "../src/services/igPublish";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, c: boolean) => eq(name, c, true);

// --- pause flag ---
eq("paused undefined allows", pausedRefusal(undefined), null);
eq("paused 'false' allows", pausedRefusal("false"), null);
ok("paused 'true' refuses", pausedRefusal("true") !== null);
ok("paused junk refuses", pausedRefusal("yes") !== null);

// --- url checks ---
eq("https ok", checkPublicUrl("https://cdn.example.com/a.jpg", "u"), null);
ok("http refused", checkPublicUrl("http://cdn.example.com/a.jpg", "u") !== null);
ok("localhost refused", checkPublicUrl("https://localhost/a.jpg", "u") !== null);
ok("ip refused", checkPublicUrl("https://10.0.0.1/a.jpg", "u") !== null);
ok("creds refused", checkPublicUrl("https://a:b@x.com/a.jpg", "u") !== null);

// --- validation ---
const img = { type: "image", caption: "hi #a", imageUrl: "https://x.com/a.jpg" };
const v1 = validatePublishRequest(img);
ok("image valid", v1.ok);
eq("write defaults false", v1.ok && v1.value.write, false);
eq("write true only when true", validatePublishRequest({ ...img, write: true }).ok && (validatePublishRequest({ ...img, write: true }) as { value: IgPublishRequest }).value.write, true);
ok("write string rejected", !validatePublishRequest({ ...img, write: "true" }).ok);
ok("scheduledAt rejected", !validatePublishRequest({ ...img, scheduledAt: "2026-11-12T18:00:00Z" }).ok);
ok("missing caption", !validatePublishRequest({ ...img, caption: "  " }).ok);
ok("caption too long", !validatePublishRequest({ ...img, caption: "a".repeat(2201) }).ok);
ok("31 hashtags", !validatePublishRequest({ ...img, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }).ok);
ok("image with videoUrl rejected", !validatePublishRequest({ ...img, videoUrl: "https://x.com/v.mp4" }).ok);
const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://x.com/${i}.jpg`);
ok("carousel 1 item", !validatePublishRequest({ type: "carousel", caption: "c", imageUrls: urls(1) }).ok);
ok("carousel 2 items", validatePublishRequest({ type: "carousel", caption: "c", imageUrls: urls(2) }).ok);
ok("carousel 10 items", validatePublishRequest({ type: "carousel", caption: "c", imageUrls: urls(10) }).ok);
ok("carousel 11 items", !validatePublishRequest({ type: "carousel", caption: "c", imageUrls: urls(11) }).ok);
ok("reel needs videoUrl", !validatePublishRequest({ type: "reel", caption: "c" }).ok);
ok("reel ok with cover", validatePublishRequest({ type: "reel", caption: "c", videoUrl: "https://x.com/v.mp4", coverUrl: "https://x.com/c.jpg" }).ok);
ok("bad type", !validatePublishRequest({ type: "story", caption: "c" }).ok);
ok("null body", !validatePublishRequest(null).ok);

// --- plan (dry-run content) never has a token ---
const reel = (validatePublishRequest({ type: "reel", caption: "c", videoUrl: "https://x.com/v.mp4", firstComment: "fc" }) as { value: IgPublishRequest }).value;
const plan = buildGraphPlan(reel, "123");
eq("reel plan steps", plan.map((p) => p.step), ["create_container", "media_publish", "first_comment"]);
eq("reel media_type", plan[0]!.params.media_type, "REELS");
ok("plan has no access_token", !JSON.stringify(plan).includes("access_token"));
const car = (validatePublishRequest({ type: "carousel", caption: "c", imageUrls: urls(3) }) as { value: IgPublishRequest }).value;
eq("carousel plan steps", buildGraphPlan(car, "1").map((p) => p.step), ["create_child_1", "create_child_2", "create_child_3", "create_carousel_container", "media_publish"]);

// --- hash ---
eq("hash stable", await contentHash(car), await contentHash({ ...car, write: true }));
ok("hash differs", (await contentHash(car)) !== (await contentHash({ ...car, caption: "d" })));

// --- execute with mocked Graph ---
const TOKEN = "SECRET_TOKEN_123";
function mockFetch(log: string[], opts: { failComment?: boolean; failCreate?: boolean } = {}): typeof fetch {
  let n = 0;
  return (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    log.push(`${method} ${u.pathname}${[...u.searchParams.keys()].filter((k) => k !== "access_token").map((k) => `|${k}=${u.searchParams.get(k)}`).join("")}`);
    if (u.searchParams.get("access_token") !== TOKEN) return new Response("bad token", { status: 401 });
    if (method === "GET") return new Response(JSON.stringify({ status_code: "FINISHED" }));
    if (opts.failCreate && u.pathname.endsWith("/media")) return new Response(`oops ${TOKEN}`, { status: 400 });
    if (opts.failComment && u.pathname.endsWith("/comments")) return new Response("no perm", { status: 403 });
    return new Response(JSON.stringify({ id: `id${++n}` }));
  }) as typeof fetch;
}
const acct = { igUserId: "999", accessToken: TOKEN };
const noSleep = async () => {};

let log: string[] = [];
const r1 = await executePublish(acct, car, { fetchFn: mockFetch(log), sleep: noSleep });
eq("carousel mediaId", r1.mediaId, "id5");
eq("carousel call order", log.filter((l) => l.startsWith("POST")).map((l) => l.split("|")[0]), ["POST /v21.0/999/media", "POST /v21.0/999/media", "POST /v21.0/999/media", "POST /v21.0/999/media", "POST /v21.0/999/media_publish"]);
ok("carousel parent uses children", log.some((l) => l.includes("media_type=CAROUSEL") && l.includes("children=id1,id2,id3")));

log = [];
const r2 = await executePublish(acct, reel, { fetchFn: mockFetch(log), sleep: noSleep });
ok("reel published + comment", r2.mediaId === "id2" && r2.commentId === "id3");
ok("reel params", log[0]!.includes("media_type=REELS") && log[0]!.includes("share_to_feed=true"));

log = [];
const r3 = await executePublish(acct, reel, { fetchFn: mockFetch(log, { failComment: true }), sleep: noSleep });
ok("comment failure is non-fatal", r3.mediaId === "id2" && !!r3.commentError && !r3.commentId);

try {
  await executePublish(acct, reel, { fetchFn: mockFetch([], { failCreate: true }), sleep: noSleep });
  ok("create failure throws", false);
} catch (e) {
  ok("error message redacts token", !(e as Error).message.includes(TOKEN));
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("igPublish tests: all passed");
