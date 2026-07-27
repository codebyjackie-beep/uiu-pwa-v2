import Link from "next/link";

const QUICK_ACTIONS = [
  { href: "/recipes", icon: "🍳", label: "Browse Recipes", hint: "214 recipes with real UK prices", modifier: null },
  { href: "/fridge", icon: "🧊", label: "Scan Fridge", hint: "Track what you've got", modifier: "fridge" },
  { href: "/shop", icon: "🛒", label: "Shopping List", hint: "Compare supermarket prices", modifier: "shop" },
  { href: "/health", icon: "❤️", label: "Log Health", hint: "Macros, weight, BMI", modifier: "health" },
] as const;

export default function Home() {
  return (
    <div className="home-page">
      <section className="home-hero">
        <p className="home-hero__eyebrow">UseItUp · v2</p>
        <h1 className="home-hero__title">Welcome back</h1>
        <p className="home-hero__subtitle">
          Plan meals, track your fridge, shop smart, and stay healthy — all in one place.
        </p>
      </section>

      <section>
        <p className="home-section__label">This week&apos;s meal plan</p>
        <div className="home-summary-card">
          <h2 className="home-summary-card__title">No meal plan yet</h2>
          <p className="home-summary-card__body">
            Build a weekly plan to see it summarised here.
          </p>
          <Link href="/meal-planner" className="home-summary-card__cta">
            Start planning →
          </Link>
        </div>
      </section>

      <section>
        <p className="home-section__label">This week&apos;s cost</p>
        <div className="home-summary-card">
          <h2 className="home-summary-card__title">No cost data yet</h2>
          <p className="home-summary-card__body">
            Once you&apos;ve got a meal plan, we&apos;ll total up the cost here.
          </p>
          <Link href="/meal-planner" className="home-summary-card__cta">
            Start planning →
          </Link>
        </div>
      </section>

      <section>
        <p className="home-section__label">Quick actions</p>
        <div className="home-quick-actions">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={
                action.modifier
                  ? `home-quick-action home-quick-action--${action.modifier}`
                  : "home-quick-action"
              }
            >
              <span className="home-quick-action__icon">{action.icon}</span>
              <span className="home-quick-action__label">{action.label}</span>
              <span className="home-quick-action__hint">{action.hint}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
