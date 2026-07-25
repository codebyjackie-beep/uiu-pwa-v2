import type { ApiResponse } from "@uiu/shared";

/** Server-side only — never bundled to the client. Falls back to local wrangler dev for `apps/api`. */
function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? "http://127.0.0.1:8787";
}

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${apiBaseUrl()}${path}`, { cache: "no-store" });
  return (await res.json()) as ApiResponse<T>;
}
