import Link from "next/link";

/** HANDOFF_auth-subscription-front-page.md Milestone 1 — signed-in users need a way back
 * to /how-it-works too (it's not just a signed-out landing page), so this renders on every
 * app-shell page, not only when signed out.
 *
 * cc_prompt_milestone1_followup_fixes_2.md Task 1 — UserButton moved to AccountHeader
 * (top-right on every page); this strip is back to just the "How it works" link. */
export function SiteFooter() {
  return (
    <div className="site-footer">
      <Link href="/how-it-works" className="site-footer__link">
        How it works
      </Link>
    </div>
  );
}
