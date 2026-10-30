/**
 * Verify a Svix-signed webhook (Clerk sends webhooks through Svix). https://docs.svix.com/receiving/verifying-payloads/how-manual
 * Signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the base64 key after "whsec_".
 * The svix-signature header holds space-separated "v1,<base64>" entries (several during a secret rotation).
 */
const TOLERANCE_SECONDS = 300;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export async function verifySvix(
  rawBody: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = b64encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    return version === "v1" && !!sig && constantTimeEqual(sig, expected);
  });
}
