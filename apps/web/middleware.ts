import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

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
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/public-shop(.*)",
  "/shop-affiliate(.*)",
  "/manifest.webmanifest",
  "/api/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};
