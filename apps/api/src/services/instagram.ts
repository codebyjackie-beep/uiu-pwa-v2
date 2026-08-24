/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — Instagram Graph API
 * publish (feed image posts only, V1 excludes Stories/Reels). Two accounts,
 * two Page Access Tokens obtained via a Business Manager System User (the
 * "Instagram Business Login" personal flow errored consistently — see
 * handoff for the working System User path if a token ever needs regenerating).
 * Callers must pass the token/IG-user-id pair for the correct account —
 * this module never guesses which account a draft belongs to.
 */
const GRAPH_VERSION = "v21.0";

export interface InstagramAccount {
  igUserId: string;
  accessToken: string;
}

/** Two-step publish: create a media container, then publish it. */
export async function publishImagePost(account: InstagramAccount, imageUrl: string, caption: string): Promise<{ mediaId: string }> {
  const createUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${account.igUserId}/media`);
  createUrl.searchParams.set("image_url", imageUrl);
  createUrl.searchParams.set("caption", caption);
  createUrl.searchParams.set("access_token", account.accessToken);

  const createRes = await fetch(createUrl, { method: "POST" });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Instagram media container failed: ${createRes.status} ${redactToken(body, account.accessToken)}`);
  }
  const createJson = (await createRes.json()) as { id?: string };
  if (!createJson.id) throw new Error("Instagram media container response had no id");

  const publishUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${account.igUserId}/media_publish`);
  publishUrl.searchParams.set("creation_id", createJson.id);
  publishUrl.searchParams.set("access_token", account.accessToken);

  const publishRes = await fetch(publishUrl, { method: "POST" });
  if (!publishRes.ok) {
    const body = await publishRes.text().catch(() => "");
    throw new Error(`Instagram media publish failed: ${publishRes.status} ${redactToken(body, account.accessToken)}`);
  }
  const publishJson = (await publishRes.json()) as { id?: string };
  if (!publishJson.id) throw new Error("Instagram media publish response had no id");
  return { mediaId: publishJson.id };
}

/**
 * Reads token expiry via the Graph API's own debug_token endpoint (app-scoped,
 * needs the token itself as the inspector — standard pattern for a token
 * inspecting itself). Returns null if the token reports no expiry (System
 * User tokens issued as "never expire" behave this way) — treat null as
 * "healthy, nothing to refresh" rather than an error.
 */
export async function getTokenExpiry(accessToken: string): Promise<Date | null> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`);
  url.searchParams.set("input_token", accessToken);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Instagram debug_token failed: ${res.status} ${redactToken(body, accessToken)}`);
  }
  const json = (await res.json()) as { data?: { expires_at?: number } };
  const expiresAt = json.data?.expires_at;
  if (!expiresAt) return null;
  return new Date(expiresAt * 1000);
}

function redactToken(body: string, token: string): string {
  return body.split(token).join("[redacted]").slice(0, 200);
}
