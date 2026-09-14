import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { FEATURE_CARDS, HOW_IT_WORKS } from "../lib/onboardingContent";

/**
 * HANDOFF_auth-subscription-front-page.md Milestone 1 — public entry point for signed-out
 * visitors (replaces the standalone-marketing-landing-page idea, decided 2026-09-14).
 * Section layout takes cues from munchapp.ai/en-GB's structure only (hero / feature list /
 * how-it-works cards) — not its colours, and NOT its numeric stat tiles ("60s"/"100%"/
 * "£100+"), same principle as excluding "214 recipes" from the onboarding overlay: no real
 * usage data yet, so no invented numbers. Signed-in users can still reach this page via the
 * footer link (SiteFooter) — it isn't only a signed-out landing page.
 */
export default async function HowItWorksPage() {
  const { userId } = await auth();

  return (
    <div className="how-it-works-page">
      <section className="how-it-works-hero">
        <p className="how-it-works-hero__eyebrow">UseItUp</p>
        <h1 className="how-it-works-hero__title">Everything you need to eat well, in one app</h1>
        <p className="how-it-works-hero__subtitle">
          Real UK supermarket prices, a fridge that knows what you&apos;ve got, and a shopping
          list that fits your budget.
        </p>
        <div className="how-it-works-hero__actions">
          {userId ? (
            <Link href="/" className="wizard-primary-button">
              Go to Home →
            </Link>
          ) : (
            <>
              <Link href="/sign-up" className="wizard-primary-button">
                Sign up free
              </Link>
              <Link href="/sign-in" className="wizard-secondary-button">
                Log in
              </Link>
            </>
          )}
        </div>
      </section>

      <section className="how-it-works-section">
        <h2 className="how-it-works-section__title">Meet UseItUp</h2>
        <ul className="how-it-works-feature-list">
          {FEATURE_CARDS.map((f) => (
            <li className="how-it-works-feature-list__item" key={f.label}>
              <span className="how-it-works-feature-list__icon">{f.icon}</span>
              <div>
                <p className="how-it-works-feature-list__label">{f.label}</p>
                <p className="how-it-works-feature-list__hint">{f.hint}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="how-it-works-section">
        <h2 className="how-it-works-section__title">How UseItUp works</h2>
        <ol className="how-it-works-steps">
          {HOW_IT_WORKS.map((text, i) => (
            <li className="how-it-works-steps__card" key={text}>
              <span className="how-it-works-steps__badge">{i + 1}</span>
              <p className="how-it-works-steps__text">{text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
