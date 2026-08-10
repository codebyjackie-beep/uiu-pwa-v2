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

export async function apiGet<T>(path: string, headers?: Record<string, string>): Promise<ApiResponse<T>> {
  try {
    const env = await resolveEnv();
    const url = `${apiBaseUrl(env)}${path}`;
    const init: RequestInit = { cache: "no-store", headers };
    const res = env.API ? await env.API.fetch(url, init) : await fetch(url, init);
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

async function apiSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  jsonBody?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResponse<T>> {
  try {
    const env = await resolveEnv();
    const url = `${apiBaseUrl(env)}${path}`;
    const init: RequestInit = {
      method,
      headers: { ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    };
    const res = env.API ? await env.API.fetch(url, init) : await fetch(url, init);
    const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
    if (!parsed) {
      console.error("[uiu-web] apiSend non-JSON response:", method, path, res.status);
      return { ok: false, error: { code: `http_${res.status}`, message: "Upstream error" } };
    }
    return parsed;
  } catch (err) {
    console.error("[uiu-web] apiSend failed:", method, path, err instanceof Error ? err.message : String(err));
    return { ok: false, error: { code: "fetch_failed", message: "Upstream unreachable" } };
  }
}

export function apiPost<T>(path: string, jsonBody: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
  return apiSend<T>("POST", path, jsonBody, headers);
}

export function apiPut<T>(path: string, jsonBody: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
  return apiSend<T>("PUT", path, jsonBody, headers);
}

export function apiPatch<T>(path: string, jsonBody: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
  return apiSend<T>("PATCH", path, jsonBody, headers);
}

export function apiDelete<T>(path: string): Promise<ApiResponse<T>> {
  return apiSend<T>("DELETE", path);
}

/** Same as apiSend but forwards a multipart/form-data body (image uploads) — no JSON.stringify,
 * no Content-Type header (fetch sets the multipart boundary itself). */
export async function apiPostForm<T>(path: string, form: FormData): Promise<ApiResponse<T>> {
  try {
    const env = await resolveEnv();
    const url = `${apiBaseUrl(env)}${path}`;
    const init: RequestInit = { method: "POST", body: form };
    const res = env.API ? await env.API.fetch(url, init) : await fetch(url, init);
    const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
    if (!parsed) {
      console.error("[uiu-web] apiPostForm non-JSON response:", path, res.status);
      return { ok: false, error: { code: `http_${res.status}`, message: "Upstream error" } };
    }
    return parsed;
  } catch (err) {
    console.error("[uiu-web] apiPostForm failed:", path, err instanceof Error ? err.message : String(err));
    return { ok: false, error: { code: "fetch_failed", message: "Upstream unreachable" } };
  }
}
