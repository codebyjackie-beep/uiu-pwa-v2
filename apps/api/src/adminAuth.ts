import type { MiddlewareHandler } from "hono";
import type { ApiResponse } from "@uiu/shared";

/**
 * Single X-Admin-Token gate for every /api/admin/* route.
 *
 * Before this file, the same check was copy-pasted into each admin handler (36 in index.ts,
 * 17 more in routes/admin*.ts) in three slightly different forms. One missed copy = one
 * public admin endpoint. Now:
 *   - index.ts mounts `requireAdmin` once on "/api/admin/*" (covers every admin route), and
 *   - each admin sub-router also mounts it on "*", so it stays protected even if remounted.
 */

export const UNAUTH_ADMIN: ApiResponse<never> = {
  ok: false,
  error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" },
};

/** Constant-time string compare so the token can't be guessed byte-by-byte from response timing. */
export function isAdminToken(token: string | undefined, expected: string | undefined): boolean {
  if (!token || !expected) return false;
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  return diff === 0;
}

export const requireAdmin: MiddlewareHandler<{ Bindings: { ADMIN_TOKEN: string } }> = async (c, next) => {
  if (!isAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    return c.json(UNAUTH_ADMIN, 401);
  }
  await next();
};
