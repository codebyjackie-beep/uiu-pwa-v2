import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";

/**
 * HANDOFF_auth-subscription-front-page.md Milestone 1 followup (cc_prompt_milestone1_followup_fixes.md,
 * gap 1). apps/api has its own public *.workers.dev URL — it's not actually locked down to
 * "only apps/web can call it" — so `/api/users/sync` can't just trust a clerkUserId the caller
 * typed into the request body. This verifies the real Clerk session JWT (sent as
 * `Authorization: Bearer <token>` by apps/web) against Clerk's JWKS, and the route handler then
 * checks the body's clerkUserId against the verified token's `sub` rather than trusting it outright.
 */

const CLERK_PUBLISHABLE_KEY_PATTERN = /^pk_(test|live)_([A-Za-z0-9+/=]+)$/;

function clerkIssuerFromPublishableKey(publishableKey: string): string {
  const match = CLERK_PUBLISHABLE_KEY_PATTERN.exec(publishableKey);
  const encoded = match?.[2];
  if (!encoded) {
    throw new Error("Malformed CLERK_PUBLISHABLE_KEY");
  }
  // Clerk publishable keys are "pk_<env>_" + base64(`${frontendApiDomain}$`).
  const decoded = atob(encoded).replace(/\$$/, "");
  return `https://${decoded}`;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedIssuer: string | undefined;

function jwksFor(publishableKey: string) {
  const issuer = clerkIssuerFromPublishableKey(publishableKey);
  if (!cachedJwks || cachedIssuer !== issuer) {
    cachedJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    cachedIssuer = issuer;
  }
  return { jwks: cachedJwks, issuer };
}

export interface ClerkAuthEnv {
  CLERK_PUBLISHABLE_KEY: string;
}

declare module "hono" {
  interface ContextVariableMap {
    clerkUserId: string;
  }
}

/** Verifies the bearer session token and sets `c.var.clerkUserId` to the verified sub. 401s otherwise. */
export const requireClerkAuth: MiddlewareHandler<{ Bindings: ClerkAuthEnv }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  if (!token) {
    return c.json({ ok: false, error: { code: "unauthorized", message: "Missing bearer token" } }, 401);
  }

  try {
    const { jwks, issuer } = jwksFor(c.env.CLERK_PUBLISHABLE_KEY);
    const { payload } = await jwtVerify(token, jwks, { issuer });
    if (typeof payload.sub !== "string") {
      return c.json({ ok: false, error: { code: "unauthorized", message: "Token missing sub" } }, 401);
    }
    c.set("clerkUserId", payload.sub);
  } catch (err) {
    console.error("[uiu-api] Clerk token verification failed:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "unauthorized", message: "Invalid or expired token" } }, 401);
  }

  await next();
};
