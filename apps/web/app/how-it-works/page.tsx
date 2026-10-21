import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { HOW_IT_WORKS } from "../lib/onboardingContent";
import { StickySignUpBar } from "./StickySignUpBar";

/**
 * cc_prompt_welcome_page_v2.md — public intro page for signed-out visitors (also reachable
 * from the footer when signed in). Layout takes cues from Mise's intro page only (hero,
 * then one feature per section with a real app screenshot in a phone frame) — UIU tokens,
 * own copy. No numeric stats in page text (09-13 / 09-14 decision: no real usage data yet),
 * and no illustrations: the screenshots are the real app. Copy is British English.
 *
 * The screenshots are cropped captures (status / nav bars removed) in
 * public/images/how-it-works/. Plain <img> with explicit dimensions rather than next/image:
 * they are already pre-sized WebP, and the Workers build has no image-optimisation binding.
 */
const HERO_ID = "how-it-works-hero";

const FEATURES = [
  {
    key: "recipes",
    title: "Recipes with UK supermarket prices",
    subtitle: "See what every dish costs per serving before you shop",
    image: { src: "/images/how-it-works/recipes.webp?v=2", width: 750, height: 1224 },
    alt: "Recipes list filtered to breakfast, each smoothie recipe showing its price per serving",
  },
  {
    key: "fridge",
    title: "Know what's in your fridge",
    subtitle: "Scan a receipt or snap your fridge",
    image: { src: "/images/how-it-works/fridge.webp?v=2", width: 750, height: 1224 },
    alt: "Fridge list of ingredients, each with a quantity and an expiry countdown",
  },
  {
    key: "meal-plan",
    title: "Plan your week",
    subtitle: "Breakfast to dinner, built around your budget",
    image: { src: "/images/how-it-works/meal-plan.webp?v=2", width: 750, height: 1224 },
    alt: "Weekly meal plan showing breakfast, lunch and dinner, each with a price and calories",
  },
  {
    key: "shopping",
    title: "One list for the week",
    subtitle: "Every ingredient from your plan, priced and ready to shop",
    image: { src: "/images/how-it-works/shopping.webp?v=2", width: 750, height: 1224 },
    alt: "Shopping list of ingredients from the plan, each with a price and the shop it comes from",
  },
] as const;

export default async function HowItWorksPage() {
  const { userId } = await auth();

  return (
    <main className="how-it-works-page">
      <section className="hiw-hero" id={HERO_ID}>
        <div className="hiw-hero__inner">
          <p className="hiw-hero__wordmark">UseItUp</p>
          <h1 className="hiw-hero__title">Everything you need to eat well, in one app</h1>
          <p className="hiw-hero__subtitle">
            UK supermarket prices, a fridge that knows what you&apos;ve got, and a shopping list that
            fits your budget.
          </p>
          <div className="hiw-hero__actions">
            {userId ? (
              <Link href="/" className="hiw-btn hiw-btn--primary">
                Go to Home →
              </Link>
            ) : (
              <>
                <Link href="/sign-up" className="hiw-btn hiw-btn--primary">
                  Sign up free
                </Link>
                <Link href="/sign-in" className="hiw-btn hiw-btn--secondary">
                  Log in
                </Link>
                <Link href="/recipes" className="hiw-hero__guest">
                  Continue as guest
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {FEATURES.map((f, i) => {
        const tinted = i % 2 === 0;
        const className = [
          "hiw-feature",
          tinted ? "hiw-feature--tinted" : "",
          i % 2 === 1 ? "hiw-feature--reverse" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <section className={className} key={f.key}>
            <div className="hiw-feature__inner">
              <div className="hiw-feature__text">
                <h2 className="hiw-feature__title">{f.title}</h2>
                <p className="hiw-feature__subtitle">{f.subtitle}</p>
              </div>
              <figure className="hiw-phone">
                <img
                  className="hiw-phone__img"
                  src={f.image.src}
                  width={f.image.width}
                  height={f.image.height}
                  alt={f.alt}
                  loading="lazy"
                  decoding="async"
                />
              </figure>
            </div>
          </section>
        );
      })}

      <section className="hiw-feature hiw-feature--tinted">
        <div className="hiw-feature__inner hiw-feature__inner--stack">
          <h2 className="hiw-feature__title">How UseItUp works</h2>
          <ol className="hiw-steps">
            {HOW_IT_WORKS.map((text) => (
              <li className="hiw-steps__item" key={text}>
                {text}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="hiw-feature">
        <div className="hiw-final__inner">
          <h2 className="hiw-feature__title">Ready to use it up?</h2>
          {userId ? (
            <Link href="/" className="hiw-btn hiw-btn--primary hiw-btn--large">
              Go to Home →
            </Link>
          ) : (
            <>
              <Link href="/sign-up" className="hiw-btn hiw-btn--primary hiw-btn--large">
                Sign up free
              </Link>
              <Link href="/sign-in" className="hiw-final__login">
                Log in
              </Link>
              <Link href="/recipes" className="hiw-final__login hiw-final__guest">
                Continue as guest
              </Link>
            </>
          )}
        </div>
      </section>

      {!userId && <StickySignUpBar heroId={HERO_ID} />}
    </main>
  );
}
