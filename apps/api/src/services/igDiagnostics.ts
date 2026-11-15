/**
 * READ-ONLY Instagram token/account diagnostics for GET /api/admin/ig-publish/diagnostics.
 * Only GET requests to graph.facebook.com. Never returns or logs the token (all text is redacted),
 * never POSTs, never creates a media container.
 */
import { GRAPH_VERSION } from "./igPublish";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PUBLISH_SCOPES = ["instagram_content_publish", "instagram_business_content_publish"];
const BASIC_SCOPES = ["instagram_basic", "instagram_business_basic"];

export interface ProbeResult {
  probe: string;
  httpStatus: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

function redact(text: string, token: string): string {
  return text.split(token).join("[redacted]").slice(0, 300);
}

async function probe(name: string, path: string, query: Record<string, string>, token: string, f: typeof fetch): Promise<ProbeResult> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  try {
    const res = await f(url);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null */
    }
    if (!res.ok) {
      const msg = (json as { error?: { message?: string; code?: number } } | null)?.error;
      return { probe: name, httpStatus: res.status, ok: false, error: redact(msg ? `code ${msg.code}: ${msg.message}` : text, token) };
    }
    return { probe: name, httpStatus: res.status, ok: true, data: json };
  } catch (err) {
    return { probe: name, httpStatus: 0, ok: false, error: redact(err instanceof Error ? err.message : String(err), token) };
  }
}

export interface IgDiagnostics {
  configured: boolean;
  igUserId: string;
  scopes: string[] | null;
  tokenValid: boolean | null;
  tokenType: string | null;
  neverExpires: boolean | null;
  expiresAt: string | null;
  hasPublishScope: boolean | null;
  hasBasicScope: boolean | null;
  canPublishVerdict: "yes" | "no" | "unknown";
  reasons: string[];
  probes: ProbeResult[];
}

export async function runIgDiagnostics(igUserId: string, token: string | undefined, f: typeof fetch = fetch): Promise<IgDiagnostics> {
  const base: IgDiagnostics = {
    configured: !!token && !!igUserId,
    igUserId,
    scopes: null,
    tokenValid: null,
    tokenType: null,
    neverExpires: null,
    expiresAt: null,
    hasPublishScope: null,
    hasBasicScope: null,
    canPublishVerdict: "unknown",
    reasons: [],
    probes: [],
  };
  if (!token || !igUserId) {
    base.reasons.push("IG_TOKEN_UIU / IG_ID_UIU missing on the Worker");
    return base;
  }
  const dbg = await probe("debug_token", "/debug_token", { input_token: token }, token, f);
  const acct = await probe("ig_account", `/${igUserId}`, { fields: "id,username,media_count" }, token, f);
  const limit = await probe("content_publishing_limit", `/${igUserId}/content_publishing_limit`, { fields: "quota_usage,config" }, token, f);
  const perms = await probe("me_permissions", "/me/permissions", {}, token, f);
  base.probes = [dbg, acct, limit, perms];

  const d = (dbg.data as { data?: { is_valid?: boolean; type?: string; scopes?: string[]; expires_at?: number; data_access_expires_at?: number } } | undefined)?.data;
  if (dbg.ok && d) {
    base.tokenValid = d.is_valid ?? null;
    base.tokenType = d.type ?? null;
    base.scopes = d.scopes ?? null;
    base.neverExpires = d.expires_at === 0;
    base.expiresAt = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null;
  }
  // /me/permissions is a fallback source of granted scopes (user tokens).
  if (!base.scopes && perms.ok) {
    const rows = (perms.data as { data?: Array<{ permission?: string; status?: string }> } | undefined)?.data;
    if (rows) base.scopes = rows.filter((r) => r.status === "granted").map((r) => String(r.permission));
  }
  if (base.scopes) {
    base.hasPublishScope = base.scopes.some((s) => PUBLISH_SCOPES.includes(s));
    base.hasBasicScope = base.scopes.some((s) => BASIC_SCOPES.includes(s));
    if (!base.hasPublishScope) base.reasons.push("token lacks instagram_content_publish (publishing will fail)");
    if (!base.hasBasicScope) base.reasons.push("token lacks instagram_basic");
  } else {
    base.reasons.push("could not read token scopes (debug_token and /me/permissions both failed)");
  }
  if (base.tokenValid === false) base.reasons.push("debug_token says the token is NOT valid");
  if (!acct.ok) base.reasons.push(`token cannot read IG account ${igUserId}: ${acct.error ?? acct.httpStatus}`);
  if (!limit.ok) base.reasons.push(`content_publishing_limit failed (publish permission/account link suspect): ${limit.error ?? limit.httpStatus}`);

  const tokenBad = (base.tokenValid as boolean | null) === false;
  const publishMissing = base.scopes !== null && (base.hasPublishScope as boolean | null) !== true;
  if (publishMissing || tokenBad || !acct.ok) base.canPublishVerdict = "no";
  else if ((base.hasPublishScope as boolean | null) === true && acct.ok && limit.ok) base.canPublishVerdict = "yes";
  else base.canPublishVerdict = "unknown";
  return base;
}
