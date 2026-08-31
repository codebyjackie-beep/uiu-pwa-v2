import { NextRequest, NextResponse } from "next/server";

/**
 * 2026-08-31 brand merge (Jackie: drop the standalone Kura Nook site) — shop.useitup.uk no
 * longer serves its own page. The Custom Domain attachment isn't torn down (not urgent, see
 * brand merge prompt §5), but every request to it now 301s to the affiliate listing's new home
 * inside the main PWA at useitup.uk/shop-affiliate. /public-shop itself is left in place
 * un-routed rather than deleted, in case anything still links to it directly.
 */
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "shop.useitup.uk") {
    return NextResponse.redirect(new URL("https://useitup.uk/shop-affiliate"), 301);
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/:path*",
};
