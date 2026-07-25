import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ApiResponse } from "@uiu/shared";

/**
 * Worker-to-Worker fetch over a public workers.dev URL is blocked by Cloudflare's
 * same-zone loop protection (error 1042 / a bare 404 depending on path). The API
 * binding below routes the request over the internal service-binding channel instead.
 */
interface ServiceBindingEnv {
  API?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  API_BASE_URL?: string;
}

async function resolveEnv(): Promise<ServiceBindingEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env as unknown as ServiceBindingEnv;
}

function apiBaseUrl(env: ServiceBindingEnv): string {
  const base = env.API_BASE_URL ?? process.env.API_BASE_URL;
  if (!base) {
    console.error("[uiu-web] API_BASE_URL is not set — check wrangler.toml [vars] / .env.local");
    throw new Error("API_BASE_URL is not configured");
  }
  return base;
}

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const env = await resolveEnv();
    const url = `${apiBaseUrl(env)}${path}`;
    const res = env.API ? await env.API.fetch(url, { cache: "no-store" }) : await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error("[uiu-web] apiGet non-ok response:", path, res.status);
      return { ok: false, error: { code: `http_${res.status}`, message: "Upstream error" } };
    }
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    console.error("[uiu-web] apiGet failed:", path, err instanceof Error ? err.message : String(err));
    return { ok: false, error: { code: "fetch_failed", message: "Upstream unreachable" } };
  }
}
