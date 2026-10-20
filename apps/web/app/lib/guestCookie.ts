/** Guest mode (claude/plan_guest_mode.md): the httpOnly cookie that carries the API's guest token. */
export const GUEST_COOKIE = "uiu_guest";
export const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Issue time encoded in the token's guest id (`guest_<issuedAt base36>_<hex>.<sig>`), or null when malformed. */
export function guestTokenIssuedAt(token: string | undefined): number | null {
  const m = token ? /^guest_([0-9a-z]{6,12})_[0-9a-f]{16}\./.exec(token) : null;
  return m ? parseInt(m[1]!, 36) : null;
}
