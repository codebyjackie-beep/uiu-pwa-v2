"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** HANDOFF_auth-subscription-front-page.md Milestone 1 — signed-in users need a way back
 * to /how-it-works too (it's not just a signed-out landing page), so this renders on every
 * app-shell page, not only when signed out.
 *
 * cc_prompt_milestone1_followup_fixes_2.md Task 1 — UserButton moved to AppHeader
 * (top of every page); this strip is back to just the "How it works" link.
 *
 * cc_prompt_recipe-list-redesign-and-cook-mode.md Part C — hidden on cook mode
 * (/recipes/[id]/cook), which is full-screen. */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname.endsWith("/cook")) return null;

  return (
    <div className="site-footer">
      <Link href="/how-it-works" className="site-footer__link">
        How it works
      </Link>
    </div>
  );
}
