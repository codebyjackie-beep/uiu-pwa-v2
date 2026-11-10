/**
 * OpenRouter chat-completions call with timeout, retry and model fallback.
 *
 * - Retries only retryable failures: HTTP 429/500/502/503/504/529, network errors, timeouts.
 *   400/401/402/403 etc. are returned as-is (no retry, no fallback — a different model won't fix them).
 * - Exponential backoff with jitter; honours `retry-after` (capped, Workers requests are short-lived).
 * - After the primary model (OPENROUTER_MODEL) is exhausted, one pass on OPENROUTER_FALLBACK_MODEL
 *   (default DeepSeek). Only for TEXT calls — vision/receipt models are not interchangeable.
 * - Returns the final Response (callers keep their own `res.ok` handling). Never logs keys or prompts.
 */
export interface OpenRouterChatEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODEL?: string;
}

export const DEFAULT_FALLBACK_MODEL = "deepseek/deepseek-chat";
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export interface ChatOptions {
  timeoutMs?: number;
  /** Extra tries per model after the first (default 2 on primary, 1 on fallback). */
  primaryRetries?: number;
  fallbackRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onFallback?: (info: { from: string; to: string; reason: string }) => void;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5000);
  return Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
}

async function tryModel(
  env: OpenRouterChatEnv,
  model: string,
  body: Record<string, unknown>,
  retries: number,
  o: Required<Pick<ChatOptions, "timeoutMs" | "fetchImpl" | "sleep">>,
): Promise<{ res?: Response; retryable: boolean; reason: string }> {
  let reason = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfter: string | null = null;
    try {
      const res = await o.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      if (!RETRYABLE.has(res.status)) return { res, retryable: false, reason: `status ${res.status}` };
      reason = `status ${res.status}`;
      retryAfter = res.headers.get("retry-after");
      if (attempt === retries) return { res, retryable: true, reason };
    } catch (err) {
      reason = err instanceof Error && err.name ? `network/${err.name}` : "network";
      if (attempt === retries) return { retryable: true, reason };
    }
    await o.sleep(backoffMs(attempt, retryAfter));
  }
  return { retryable: true, reason };
}

/** `body` is the usual chat body WITHOUT `model` (the helper sets it per attempt). */
export async function openrouterChat(
  env: OpenRouterChatEnv,
  body: Record<string, unknown>,
  opts: ChatOptions = {},
): Promise<Response> {
  const o = {
    timeoutMs: opts.timeoutMs ?? 45_000,
    fetchImpl: opts.fetchImpl ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init)),
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const primary = await tryModel(env, env.OPENROUTER_MODEL, body, opts.primaryRetries ?? 2, o);
  if (!primary.retryable && primary.res) return primary.res;

  const fallbackModel = env.OPENROUTER_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
  if (fallbackModel === env.OPENROUTER_MODEL) {
    if (primary.res) return primary.res;
    throw new Error(`OpenRouter ${primary.reason}`);
  }
  opts.onFallback?.({ from: env.OPENROUTER_MODEL, to: fallbackModel, reason: primary.reason });
  console.warn(`[openrouter] fallback ${env.OPENROUTER_MODEL} -> ${fallbackModel} (${primary.reason})`);
  const fb = await tryModel(env, fallbackModel, body, opts.fallbackRetries ?? 1, o);
  if (fb.res) return fb.res;
  if (primary.res) return primary.res;
  throw new Error(`OpenRouter ${fb.reason}`);
}
