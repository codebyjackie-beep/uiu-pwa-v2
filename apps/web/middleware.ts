import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { GUEST_COOKIE, GUEST_TTL_MS, guestTokenIssuedAt } from "./app/lib/guestCookie";

/**
 * HANDOFF_auth-subscription-front-page.md Milestone 1. "/" is deliberately public here —
 * app/page.tsx itself decides signed-out -> redirect to /how-it-works vs signed-in -> Home
 * dashboard, so a signed-out visitor never hits a bare login wall. Everything else (the 5
 * other tabs) is gated; a signed-out hit redirects to /sign-in.
 *
 * `/api/(.*)` stays public at the middleware layer on purpose: the route handlers proxy to
 * apps/api, which does the real gating (requireClerkAuth, userId from the token `sub`) as of M2 —
 * the API workers.dev URL is public, so the web layer alone could never be the gate.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/how-it-works",
  "/privacy",
  // cc_prompt_guest_browse.md Part B — guests may browse Recipes (list, detail, cook mode).
  // /recipes/share-target stays gated: isShareTarget below overrides this.
  "/recipes",
  "/recipes/:id",
  "/recipes/:id/cook",
  // Guest mode (claude/plan_guest_mode.md): every app tab is open to guests; Premium is gated in apps/api.
  "/meal-planner(.*)",
  "/fridge(.*)",
  "/shop(.*)",
  "/health(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/public-shop(.*)",
  "/shop-affiliate(.*)",
  "/manifest.webmanifest",
  "/api/(.*)",
]);

const isShareTarget = createRouteMatcher(["/recipes/share-target(.*)"]);

/** App pages where a signed-out visitor gets a guest token (not "/" — a first visit there is the welcome page). */
const isGuestAppPage = createRouteMatcher(["/meal-planner(.*)", "/fridge(.*)", "/shop(.*)", "/health(.*)", "/recipes(.*)"]);

async function mintGuest(): Promise<string | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const e = env as unknown as { API?: { fetch(u: string, i?: RequestInit): Promise<Response> }; API_BASE_URL?: string };
    const base = e.API_BASE_URL ?? process.env.API_BASE_URL;
    if (!base) return null;
    const url = `${base}/api/guest/session`;
    const res = e.API ? await e.API.fetch(url, { method: "POST" }) : await fetch(url, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { token?: string } } | null;
    return body?.ok && body.data?.token ? body.data.token : null;
  } catch (err) {
    console.error("[uiu-web] guest mint failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req) || isShareTarget(req)) {
    await auth.protect();
    return;
  }
  if (!isGuestAppPage(req)) return;
  const { userId } = await auth();
  if (userId) return;
  const existing = req.cookies.get(GUEST_COOKIE)?.value;
  const issued = guestTokenIssuedAt(existing);
  // Re-mint an hour before the API stops accepting the token (7 days).
  if (existing && issued !== null && Date.now() - issued < GUEST_TTL_MS - 3_600_000) return;
  const token = await mintGuest();
  if (!token) return;
  // Make the new cookie visible to this same request's server components, and set it on the browser.
  const headers = new Headers(req.headers);
  const others = (req.headers.get("cookie") ?? "").split(/;\s*/).filter((c) => c && !c.startsWith(`${GUEST_COOKIE}=`));
  headers.set("cookie", [...others, `${GUEST_COOKIE}=${token}`].join("; "));
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(GUEST_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: Math.floor(GUEST_TTL_MS / 1000) });
  return res;
});

export const config = {
  matcher: [
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};
