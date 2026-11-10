/**
 * Tests for services/openrouterChat.ts (mocked fetch). Run with:
 *   npx tsx apps/api/test/openrouterChat.test.ts
 */
import { openrouterChat } from "../src/services/openrouterChat";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

const env = { OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "primary/m" };
const sleep = async () => {};

/** script: array of status numbers or "net" (throws) consumed in order; records the model used each call. */
function mock(script: Array<number | "net">, headers: Record<string, string> = {}) {
  const models: string[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    models.push(JSON.parse(String(init?.body)).model);
    const s = script.shift();
    if (s === undefined) throw new Error("script exhausted");
    if (s === "net") throw new TypeError("network down");
    return new Response("{}", { status: s, headers });
  }) as typeof fetch;
  return { models, fetchImpl };
}

async function main() {
  // 1. success first try
  let m = mock([200]);
  let r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("ok status", r.status, 200);
  eq("ok models", m.models, ["primary/m"]);

  // 2. 429, 429, then 200 on primary (retries stay on primary)
  m = mock([429, 429, 200]);
  r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("retry status", r.status, 200);
  eq("retry models", m.models, ["primary/m", "primary/m", "primary/m"]);

  // 3. primary exhausted by 429 -> DeepSeek fallback succeeds
  m = mock([429, 429, 429, 200]);
  let fell = "";
  r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep, onFallback: (i) => (fell = i.to) });
  eq("fallback status", r.status, 200);
  eq("fallback models", m.models, ["primary/m", "primary/m", "primary/m", "deepseek/deepseek-chat"]);
  eq("fallback callback", fell, "deepseek/deepseek-chat");

  // 4. 503 + network error on primary -> fallback
  m = mock([503, "net", 502, 200]);
  r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("5xx/net -> fallback", [r.status, m.models[3]], [200, "deepseek/deepseek-chat"]);

  // 5. non-retryable (400, 401, 402) returns immediately, no retry, no fallback
  for (const code of [400, 401, 402, 403]) {
    m = mock([code]);
    r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
    eq(`no retry ${code}`, [r.status, m.models.length], [code, 1]);
  }

  // 6. both exhausted -> returns last response (fallback's 429)
  m = mock([429, 429, 429, 429, 429]);
  r = await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("all fail status", r.status, 429);
  eq("all fail count", m.models.length, 5);

  // 7. only network errors everywhere -> throws
  m = mock(["net", "net", "net", "net", "net"]);
  let threw = false;
  try {
    await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep });
  } catch {
    threw = true;
  }
  eq("network exhausted throws", threw, true);

  // 8. retry-after honoured (seconds -> ms, capped 5000)
  const waits: number[] = [];
  m = mock([429, 200], { "retry-after": "2" });
  await openrouterChat(env, {}, { fetchImpl: m.fetchImpl, sleep: async (ms) => void waits.push(ms) });
  eq("retry-after", waits, [2000]);

  // 9. custom fallback model + fallback same as primary skips fallback pass
  m = mock([500, 500, 500, 200]);
  await openrouterChat({ ...env, OPENROUTER_FALLBACK_MODEL: "x/custom" }, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("custom fallback", m.models[3], "x/custom");
  m = mock([500, 500, 500]);
  r = await openrouterChat({ ...env, OPENROUTER_FALLBACK_MODEL: "primary/m" }, {}, { fetchImpl: m.fetchImpl, sleep });
  eq("same fallback skipped", [r.status, m.models.length], [500, 3]);

  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("openrouterChat tests passed");
}
main();
