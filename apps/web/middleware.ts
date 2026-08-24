import { NextRequest, NextResponse } from "next/server";

/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — shop.useitup.uk is a separate public
 * marketing page (recently-recommended affiliate products), not the in-app Shop tab. Same
 * Worker, same Next.js app — routed by Host header rather than a second deployment.
 * Requires shop.useitup.uk to be attached as a Custom Domain to the uiu-web Worker in the
 * Cloudflare dashboard (not something wrangler.toml/this middleware can do on its own).
 */
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "shop.useitup.uk" && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/public-shop";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/",
};
