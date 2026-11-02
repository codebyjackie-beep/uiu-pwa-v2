import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms of service · UseItUp" };

/** cc_prompt_terms_page.md — public terms. Content limited to what Jackie confirmed on 2026-10-31
 * (prices, 7-day trial, end-of-period cancellation, 14-day refund, contact, England and Wales). Reuses the privacy-page styles. */
const LAST_UPDATED = "2 November 2026";

export default function TermsPage() {
  return (
    <div className="privacy-page">
      <h1>Terms of service</h1>
      <p className="privacy-page__updated">Last updated {LAST_UPDATED}</p>

      <h2>About UseItUp</h2>
      <p>
        UseItUp (useitup.uk) is a meal planning and food-waste app run from the UK. These terms cover your use of the app and of UseItUp
        Premium. Questions? Email <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a>.
      </p>

      <h2>Your account</h2>
      <p>
        You can browse and try the app as a guest. Guest data is not saved to an account and is deleted after 7 days (see our{" "}
        <Link href="/privacy">privacy policy</Link>). Sign up for a free account to keep your data. Keep your sign-in details to yourself and
        tell us if you think someone else has used your account.
      </p>

      <h2>Free plan, free trial and Premium</h2>
      <ul>
        <li>
          <strong>Free plan:</strong> a free account can use the app without the Premium features.
        </li>
        <li>
          <strong>Free trial:</strong> when you sign up you get 7 days of full Premium. No card is needed. You get one trial per account. When
          the trial ends your account goes back to the free plan and you are not charged.
        </li>
        <li>
          <strong>Premium:</strong> £2.99 per month or £24.99 per year. Some Premium features have monthly usage limits; your limits and
          what you have used are shown on the Premium page.
        </li>
      </ul>

      <h2>Billing</h2>
      <p>
        Payments are taken by Stripe, which handles your card details directly. Premium renews automatically at the end of each billing period
        (monthly or yearly) until you cancel. The price you see on the Premium page when you subscribe is the price you pay.
      </p>

      <h2>Cancelling</h2>
      <p>
        You can cancel at any time from the Premium page (Manage subscription). Cancelling stops the next renewal. You keep Premium until the
        end of the period you have already paid for, then your account goes back to the free plan.
      </p>

      <h2>Refunds</h2>
      <p>
        You can ask for a refund within 14 days of your first payment, and within 14 days of any yearly renewal payment. Monthly renewals are
        not refunded; cancel any time to stop the next one. Email <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a> from the
        address on your account and we will refund that payment. This does not affect your legal rights.
      </p>

      <h2>Food, nutrition and price information</h2>
      <p>
        Recipes, nutrition estimates, costs per serving and supermarket prices are a guide only. Prices change often and may not match what you
        pay in store. The AI features can make mistakes. Nothing in UseItUp is medical or dietary advice; check allergens and food safety yourself, and
        talk to a health professional about your own needs.
      </p>

      <h2>Using the app fairly</h2>
      <p>
        Please do not misuse the service, try to break or overload it, or use it to do anything unlawful. We may suspend an account that does.
      </p>

      <h2>Changes to these terms</h2>
      <p>We may update these terms. The date at the top shows when they last changed.</p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the law of the part of the UK where you live: Scotland, England and Wales, or Northern Ireland.
        If you live outside the UK, the law of England and Wales applies, but this does not remove consumer protections you have
        under the law where you live.
      </p>

      <p className="privacy-page__back">
        <Link href="/">Back to UseItUp</Link>
      </p>
    </div>
  );
}
