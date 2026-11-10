import type { Metadata } from "next";
import Link from "next/link";
import { CookieSettingsButton } from "../components/Analytics";

export const metadata: Metadata = { title: "Privacy policy · UseItUp" };

/** cc_prompt_meal_grid_profile.md Part PP — public privacy policy (Google Auth Platform branding needs the link).
 * Processors listed are the ones the code actually calls with user data (checked 2026-10-20). */
const LAST_UPDATED = "10 November 2026";

export default function PrivacyPage() {
  return (
    <div className="privacy-page">
      <h1>Privacy policy</h1>
      <p className="privacy-page__updated">Last updated {LAST_UPDATED}</p>

      <h2>Who we are</h2>
      <p>
        UseItUp (useitup.uk) is a meal planning and food-waste app run from the UK. If you have any question about your data, email{" "}
        <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a>.
      </p>
      <p>
        Postal address: UseItUp, 3F1 Third floor, 3 Hill Street, Edinburgh EH2 3JP, United Kingdom. Postal address only, not open to
        visitors, no returns.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account:</strong> name, email address and profile picture, handled by our sign-in provider Clerk (including when you sign in
          with Google).
        </li>
        <li>
          <strong>What you add to the app:</strong> meal plans, fridge items, shopping list, favourite recipes and recipes you import.
        </li>
        <li>
          <strong>Health information you choose to enter:</strong> your health profile, weight entries, meal logs and conversations with the AI
          nutrition coach.
        </li>
        <li>
          <strong>Photos you upload</strong> (a meal, a receipt or your fridge): sent for analysis, then discarded. We keep the result (for
          example the list of items or the nutrition estimate), not the photo.
        </li>
        <li>
          <strong>Premium subscription:</strong> if you subscribe, your plan status, when your access runs until, and an ID that links your
          account to your Stripe customer record. We never see or store your card details; Stripe takes them directly.
        </li>
        <li>
          <strong>Usage counts:</strong> how many AI requests you make each month, so we can apply Premium limits, and the cost of each request,
          so we can keep the service running.
        </li>
      </ul>

      <h2>Using UseItUp as a guest</h2>
      <p>
        You can use UseItUp without an account. What you add as a guest is linked to a random guest ID kept in a cookie on
        your device, is not saved to an account, and is deleted automatically after 7 days. If you sign up for a new
        account within that time, it is moved into your account.
      </p>

      <h2>How we use it</h2>
      <p>
        To run the features you use and, only if you allow analytics cookies, to understand which pages people use (see Analytics below).
        We do not sell your data, and we do not use advertising trackers.
      </p>

      <h2>Who processes it for us</h2>
      <ul>
        <li>
          <strong>Clerk</strong> — sign-in and account management.
        </li>
        <li>
          <strong>Cloudflare</strong> — hosting the app.
        </li>
        <li>
          <strong>MongoDB Atlas</strong> — our database.
        </li>
        <li>
          <strong>Stripe</strong> — takes Premium payments and manages subscriptions. It receives your email address and the plan you choose,
          and handles your card details itself. Stripe may process data outside the UK and EU under its own safeguards; see{" "}
          <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">stripe.com/privacy</a>.
        </li>
        <li>
          <strong>OpenRouter</strong> — routes AI requests to the model providers (including Google Gemini for photos). Used for photo
          analysis, recipe import and the nutrition coach.
        </li>
        <li>
          <strong>PostHog</strong> — product analytics, only if you accept analytics cookies. Data is stored on its EU servers.
        </li>
        <li>
          <strong>Open Food Facts</strong> — when you scan a barcode, your browser looks the barcode number up there.
        </li>
        <li>
          <strong>Recipe import:</strong> when you import a recipe from a link, we fetch that page, and for TikTok, Pinterest and YouTube links we ask
          that site for the post details. Only the link is sent.
        </li>
      </ul>
      <p>Supermarket prices and recipe photos come from Serper and Pexels; none of your data is sent to them.</p>

      <h2>Where it is stored and for how long</h2>
      <p>
        Your data is stored in the EU (Ireland). We keep it while you have an account. If you ask us to delete your account, we delete your data
        within 30 days, except payment records, which we keep for 6 years to meet UK tax record rules.
      </p>

      <h2>Your rights</h2>
      <p>
        Under UK GDPR you can ask to see, correct, delete or export your data. You can delete your account yourself in Profile → Delete account. Or email <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a>{" "}
        and we will reply within one month. You can also complain to the Information Commissioner&apos;s Office (ico.org.uk).
      </p>

      <h2 id="cookies">Cookies</h2>
      <p>
        These cookies are always on, because the app needs them: the ones that keep you signed in (set by Clerk), one cookie holding
        your temporary guest ID if you use the app as a guest, and <code>uiu_consent</code>, which remembers your cookie choice for 12
        months. When you pay, Stripe&apos;s checkout page sets its own cookies for payment security.
      </p>
      <p>Analytics cookies are only set if you tap Accept on the cookie banner. There are no advertising cookies.</p>

      <h2 id="analytics">Analytics (PostHog)</h2>
      <p>
        If you accept analytics cookies, we use PostHog to see how people use UseItUp, so we can improve it. PostHog stores this data on
        its EU servers. If you reject them, or never choose, PostHog is not loaded at all.
      </p>
      <ul>
        <li>
          <strong>What it collects:</strong> which pages you visit (the page address only, plus any <code>utm_</code> campaign tags in the
          link you came from), when you leave a page, that you signed up, and basic anonymous device details such as browser, operating
          system, screen size and rough location from your IP address. If you are signed in, events are linked to your account ID, not
          your name or email.
        </li>
        <li>
          <strong>What it does not collect:</strong> any health information, anything you type or add in the app, and no screen
          recordings.
        </li>
        <li>
          <strong>Cookies it uses:</strong> <code>ph_phc_…_posthog</code> (a cookie and a matching browser storage entry with a random
          device ID and your visit session), and short-lived browser storage entries starting with <code>ph_</code> or{" "}
          <code>__ph_</code>. We also keep <code>uiu_signup_tracked</code> in browser storage so a sign-up is only counted once.
        </li>
        <li>
          <strong>Changing your mind:</strong> tap Cookie settings below at any time. If you reject, we stop PostHog straight away and
          delete its cookies and browser storage from your device.
        </li>
      </ul>
      <p>
        <CookieSettingsButton />
      </p>

      <h2>Amazon links</h2>
      <p>
        Some kitchen and home product links (Kitchen & Home Picks) are Amazon affiliate links. As an Amazon Associate we earn from qualifying purchases. Amazon
        handles anything you do on its site under its own privacy notice.
      </p>

      <p className="privacy-page__back">
        <Link href="/">Back to UseItUp</Link>
      </p>
    </div>
  );
}
