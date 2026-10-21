import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { GUEST_COOKIE } from "./lib/guestCookie";
import { formatTotalWithIncomplete, type MealPlanSetDetail, type MealPlanSetSummary, type RecipeListPage } from "@uiu/shared";
import { apiGet, apiPost } from "./lib/api";
import { dayIndexLabel, todayDayIndex } from "./lib/dates";
import { InstallButton } from "./InstallButton";
import { OnboardingOverlay } from "./OnboardingOverlay";

// The Recipes hint is filled in at render time from the live recipe total (see Home()).
type ImpactBucket = { items: number; valueGbp: number };
type ImpactMonth = { month: { used: ImpactBucket; wasted: ImpactBucket } };

const QUICK_ACTIONS = [
  { href: "/recipes", label: "Browse Recipes", hint: "", modifier: "recipes" },
  { href: "/fridge", label: "Scan Fridge", hint: "Track what you've got", modifier: "fridge" },
  { href: "/shop", label: "Shopping List", hint: "Compare supermarket prices", modifier: "shop" },
  { href: "/health", label: "Log Health", hint: "Macros, weight, BMI", modifier: "health" },
] as const;

export const dynamic = "force-dynamic";

/** Whole days from today (UK date) to the expiry date; negative = already past. */
function daysLeft(expiresAt: string): number {
  const toDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((toDay(new Date(expiresAt)) - toDay(new Date())) / 864e5);
}
function whenLabel(days: number): string {
  if (days < 0) return "Expired";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export default async function Home() {
  const { userId, getToken } = await auth();
  // Guest mode: a signed-out first visit is the welcome page; a guest who has already used the app (guest cookie) gets Home.
  const isGuest = !userId;
  if (isGuest && !(await cookies()).get(GUEST_COOKIE)) redirect("/how-it-works");

  const user = isGuest ? null : await currentUser();
  if (user) {
    const email = user.primaryEmailAddress?.emailAddress ?? "";
    if (email) {
      // Get-or-create in the `users` collection (HANDOFF_auth-subscription-front-page.md
      // Milestone 1). Idempotent (findOne-then-insert on the backend) — fine to call on
      // every Home load rather than only wiring a Clerk webhook for this milestone. Awaited
      // (not fire-and-forget) because Workers can suspend background work after the response
      // is sent — see apps/api/src/db.ts's per-request client note for the same reasoning.
      //
      // cc_prompt_milestone1_followup_fixes.md gap 1 — the session JWT is forwarded so
      // apps/api can independently verify it (apps/api/src/clerkAuth.ts) rather than trusting
      // clerkUserId as plain request-body input.
      const token = await getToken();
      await apiPost("/api/users/sync", { clerkUserId: userId, email }, token ? { Authorization: `Bearer ${token}` } : undefined);
    }
  }

  const [setsRes, recipeCountRes, expiringRes] = await Promise.all([
    apiGet<MealPlanSetSummary[]>("/api/meal-plan-sets"),
    apiGet<RecipeListPage>("/api/recipes?limit=1"),
    // Use-it-up (research_rminder_competitors.md #1): fridge items expiring within 3 days.
    apiGet<{ _id: string; ingredientName: string; expiresAt: string }[]>("/api/fridge-stock/expiring?days=3"),
  ]);
  const expiring = expiringRes.ok ? expiringRes.data.slice(0, 5) : [];
  // No hard-coded fallback number: if the total can't be fetched, drop the count entirely.
  const recipesHint = recipeCountRes.ok
    ? `${recipeCountRes.data.total} recipes with UK supermarket prices`
    : "Recipes with UK supermarket prices";
  const activeSummary = setsRes.ok ? setsRes.data.find((s) => s.isActive) : undefined;

  const detailRes = activeSummary
    ? await apiGet<MealPlanSetDetail>(`/api/meal-plan-sets/${activeSummary._id}`)
    : null;
  const activeDetail = detailRes?.ok ? detailRes.data : null;

  const totalMeals = activeDetail ? activeDetail.days.reduce((sum, day) => sum + day.entries.length, 0) : 0;
  const hasPlan = !!activeDetail && totalMeals > 0;
  const avgCostPerDay = activeDetail ? activeDetail.weekTotalCost / 7 : 0;

  const impactRes = await apiGet<ImpactMonth>("/api/fridge-stock/impact");
  const month = impactRes.ok ? impactRes.data.month : null;
  const hasImpact = !!month && month.used.items + month.wasted.items > 0;

  const now = new Date();
  const ukHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(now));
  const dateLine = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(now);
  const firstName = user?.firstName?.trim();
  const greeting = isGuest
    ? "Welcome"
    : firstName
      ? `Good ${ukHour < 12 ? "morning" : ukHour < 18 ? "afternoon" : "evening"}, ${firstName}`
      : "Welcome back";
  const expiredCount = expiring.filter((i) => daysLeft(i.expiresAt) < 0).length;
  const today = todayDayIndex();
  const plannedDays = new Set(activeDetail ? activeDetail.days.filter((d) => d.entries.length > 0).map((d) => d.dayIndex) : []);

  return (
    <div className="home-page">
      <OnboardingOverlay />
      <section className="home-hero">
        <p className="home-hero__date">{dateLine}</p>
        <h1 className="home-hero__title">{greeting}</h1>
        <InstallButton />
      </section>

      {expiring.length ? (
        <section className="use-soon-card" aria-label="Use it up soon">
          <div className="use-soon-card__head">
            <h2 className="use-soon-card__title">Use it up soon</h2>
            {expiredCount > 0 && <span className="use-soon-card__badge">{expiredCount} expired</span>}
          </div>
          <ul className="use-soon-card__list">
            {expiring.map((item) => {
              const days = daysLeft(item.expiresAt);
              return (
                <li key={item._id} className="use-soon-card__pill">
                  {item.ingredientName}
                  {days >= 0 && <span className="use-soon-card__when"> · {whenLabel(days)}</span>}
                </li>
              );
            })}
          </ul>
          <Link href="/fridge" className="use-soon-card__link">
            Cook with these
          </Link>
        </section>
      ) : null}

      <section className="home-week-card" aria-label="This week">
        <div className="home-week-card__head">
          <h2 className="home-week-card__title">This week</h2>
          <Link href="/meal-planner" className="home-week-card__more">
            {hasPlan ? "Open plan" : "Start planning"}
          </Link>
        </div>
        {hasPlan && activeDetail ? (
          <>
            <ol className="home-week-card__days">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <li
                  key={d}
                  className={[
                    "home-week-card__day",
                    plannedDays.has(d) ? "home-week-card__day--planned" : "",
                    d === today ? "home-week-card__day--today" : "",
                  ].join(" ")}
                >
                  <span>{dayIndexLabel(d)}</span>
                  <span className="home-week-card__dot" aria-label={plannedDays.has(d) ? "meals planned" : "nothing planned"} />
                </li>
              ))}
            </ol>
            <div className="home-week-card__foot">
              <div>
                <p className="home-week-card__label">
                  {activeDetail.name} · {totalMeals} meal{totalMeals === 1 ? "" : "s"} · est. basket
                </p>
                <p className="home-week-card__cost">{formatTotalWithIncomplete(activeDetail.weekTotalCost, activeDetail.weekCostIncomplete)}</p>
                <p className="home-week-card__label">{formatTotalWithIncomplete(avgCostPerDay, activeDetail.weekCostIncomplete)} a day</p>
              </div>
              <Link href="/shop" className="home-week-card__cta">
                Shopping list
              </Link>
            </div>
          </>
        ) : (
          <p className="home-week-card__empty">No active meal plan yet. Build one and its cost and shopping list show up here.</p>
        )}
      </section>

      {hasImpact && month ? (
        <section className="home-impact" aria-label="Your impact this month">
          <Link href="/fridge" className="home-impact__tile">
            <span className="home-impact__label">Used this month</span>
            <span className="home-impact__num home-impact__num--used">£{month.used.valueGbp.toFixed(2)}</span>
            <span className="home-impact__label">{month.used.items} item{month.used.items === 1 ? "" : "s"} used up</span>
          </Link>
          <Link href="/fridge" className="home-impact__tile">
            <span className="home-impact__label">Binned this month</span>
            <span className="home-impact__num home-impact__num--wasted">£{month.wasted.valueGbp.toFixed(2)}</span>
            <span className="home-impact__label">{month.wasted.items} item{month.wasted.items === 1 ? "" : "s"}</span>
          </Link>
        </section>
      ) : null}

      <section>
        <h2 className="home-section__label">Quick actions</h2>
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
              <span className="home-quick-action__label">{action.label}</span>
              <span className="home-quick-action__hint">{action.modifier === "recipes" ? recipesHint : action.hint}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
