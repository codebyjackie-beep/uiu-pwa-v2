import type { ApiResponse } from "@uiu/shared";

/** Server-side only — never bundled to the client. No silent localhost fallback: missing config must be loud. */
function apiBaseUrl(): string {
  const base = process.env.API_BASE_URL;
  if (!base) {
    console.error("[uiu-web] API_BASE_URL is not set — check wrangler.toml [vars] / .env.local");
    throw new Error("API_BASE_URL is not configured");
  }
  return base;
}

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(`${apiBaseUrl()}${path}`, { cache: "no-store" });
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
