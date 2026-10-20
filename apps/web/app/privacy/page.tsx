import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy policy · UseItUp" };

/** cc_prompt_meal_grid_profile.md Part PP — public privacy policy (Google Auth Platform branding needs the link).
 * Processors listed are the ones the code actually calls with user data (checked 2026-10-20). */
const LAST_UPDATED = "20 October 2026";

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <h1>Privacy policy</h1>
      <p className="privacy-page__updated">Last updated {LAST_UPDATED}</p>

      <h2>Who we are</h2>
      <p>
        UseItUp (useitup.uk) is a meal planning and food-waste app run from Edinburgh, UK. If you have any question about your data, email{" "}
        <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a>.
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
      </ul>

      <h2>Using UseItUp as a guest</h2>
      <p>
        You can use UseItUp without an account. What you add as a guest is linked to a random guest ID kept in a cookie on
        your device, is not saved to an account, and is deleted automatically after 7 days. If you sign up for a new
        account within that time, it is moved into your account.
      </p>

      <h2>How we use it</h2>
      <p>Only to run the features you use. We do not sell your data, and we do not use advertising trackers.</p>

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
          <strong>OpenRouter</strong> — routes AI requests to the model providers (including Google Gemini for photos). Used for photo
          analysis, recipe import and the nutrition coach.
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
        within 30 days.
      </p>

      <h2>Your rights</h2>
      <p>
        Under UK GDPR you can ask to see, correct, delete or export your data. Email <a href="mailto:useitup.uk@gmail.com">useitup.uk@gmail.com</a>{" "}
        and we will reply within one month. You can also complain to the Information Commissioner&apos;s Office (ico.org.uk).
      </p>

      <h2>Cookies</h2>
      <p>
        We only use the cookies needed to keep you signed in (set by Clerk) and, if you use the app as a guest, one cookie
        holding your temporary guest ID. There are no analytics or advertising cookies.
      </p>

      <h2>Amazon links</h2>
      <p>
        Some kitchen product links (Kitchen Picks) are Amazon affiliate links. As an Amazon Associate we earn from qualifying purchases. Amazon
        handles anything you do on its site under its own privacy notice.
      </p>

      <p className="privacy-page__back">
        <Link href="/">Back to UseItUp</Link>
      </p>
    </main>
  );
}
