"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  ApiResponse,
  GeneratedMealPlan,
  GeneratedMealPlanDay,
  MealPlanGeneratorInput,
  MealPlanVariation,
  MealSlot,
  UkAllergen,
} from "@uiu/shared";
import { UK_ALLERGENS } from "@uiu/shared";

/**
 * All wizard copy is original — see HANDOFF_ai-meal-plan-generator.md: the
 * step ORDER may follow assets/meal-planner-reference/, but none of its
 * wording, labels, or button text does. Every string below was written for
 * this app.
 */

const LENGTH_OPTIONS: { label: string; sub: string; value: number }[] = [
  { label: "Today", sub: "1 day", value: 1 },
  { label: "This week", sub: "7 days", value: 7 },
  { label: "This month", sub: "30 days", value: 30 },
];

const BUDGET_PRESETS = [20, 30, 40, 60, 80];

const SLOT_OPTIONS: { value: MealSlot; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

const VARIATION_OPTIONS: { value: MealPlanVariation; title: string; body: string }[] = [
  { value: "low", title: "Keep it simple", body: "Reuse the same few recipes so your shopping list stays short." },
  { value: "medium", title: "Mix it up", body: "A balanced spread of recipes with some repeats." },
  { value: "high", title: "Something new each day", body: "Minimal repeats — your shopping list will be longer." },
];

const CUISINE_OPTIONS = [
  "Italian", "Chinese", "Indian", "Mexican", "Thai", "Mediterranean",
  "British", "Japanese", "Middle Eastern", "American", "French", "Vietnamese", "Korean",
];

const DIETARY_OPTIONS: { value: string; label: string }[] = [
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "pescatarian", label: "Pescatarian" },
  { value: "gluten-free", label: "Gluten-free" },
  { value: "dairy-free", label: "Dairy-free" },
  { value: "keto", label: "Keto" },
  { value: "paleo", label: "Paleo" },
  { value: "high-protein", label: "High-protein" },
  { value: "budget", label: "Budget-friendly" },
  { value: "quick", label: "Quick to cook" },
];

const ALLERGEN_LABELS: Record<UkAllergen, string> = {
  celery: "Celery",
  cereals_gluten: "Cereals containing gluten",
  crustaceans: "Crustaceans",
  eggs: "Eggs",
  fish: "Fish",
  lupin: "Lupin",
  milk: "Milk",
  molluscs: "Molluscs",
  mustard: "Mustard",
  tree_nuts: "Tree nuts",
  peanuts: "Peanuts",
  sesame: "Sesame",
  soybeans: "Soybeans",
  sulphites: "Sulphites",
};

// "George at ASDA" deliberately excluded: it's ASDA's clothing/homeware sub-brand, not a food
// aisle — it only shows up in canonical_price_cache via two junk canonical_ingredients entries
// ("iron" -> a steam iron, "each" -> a Toy Story figure), both pre-existing CoFID audit flags,
// not real grocery data. See summaries/2026-07-30_meal-plan-wizard-fixes-raw.md.
const STORE_OPTIONS = [
  "Tesco", "sainsburys.co.uk", "Asda Groceries", "Morrisons.com",
  "Waitrose & Partners", "Ocado", "Iceland", "Aldiss", "Sunshine Co-operative",
];

type Gender = "female" | "male" | "unspecified";
type Goal = "lose" | "maintain" | "gain";

function estimateCalories(gender: Gender, age: number, weightKg: number, heightCm: number, goal: Goal): number {
  const genderOffset = gender === "male" ? 5 : gender === "female" ? -161 : -78;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + genderOffset;
  const tdee = bmr * 1.375; // light-activity assumption — no activity-level question in V1
  const goalAdjustment = goal === "lose" ? -500 : goal === "gain" ? 500 : 0;
  return Math.max(1000, Math.round((tdee + goalAdjustment) / 10) * 10);
}

function formatCost(value: number): string {
  return `£${value.toFixed(2)}`;
}

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const TOTAL_STEPS = 9;

interface CalorieCalc {
  gender: Gender;
  age: string;
  weightKg: string;
  heightCm: string;
  goal: Goal;
}

export function MealPlanWizard() {
  const [step, setStep] = useState<Step>(0);
  const [phase, setPhase] = useState<"wizard" | "generating" | "review" | "saving" | "saved" | "error">("wizard");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [lengthDays, setLengthDays] = useState<number>(7);
  const [weeklyBudgetGBP, setWeeklyBudgetGBP] = useState<number | null>(40);
  const [customBudget, setCustomBudget] = useState("");
  const [mealSlots, setMealSlots] = useState<MealSlot[]>(["breakfast", "lunch", "dinner"]);
  const [variation, setVariation] = useState<MealPlanVariation>("medium");
  const [cuisines, setCuisines] = useState<string[]>([]);
  const [dietary, setDietary] = useState<string[]>([]);
  const [allergens, setAllergens] = useState<UkAllergen[]>([]);
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("");
  const [marketPriority, setMarketPriority] = useState<string | undefined>(undefined);
  const [wantsCalorieTarget, setWantsCalorieTarget] = useState(false);
  const [calc, setCalc] = useState<CalorieCalc>({ gender: "unspecified", age: "", weightKg: "", heightCm: "", goal: "maintain" });
  const [calorieTargetPerDay, setCalorieTargetPerDay] = useState<number | undefined>(undefined);

  const [plan, setPlan] = useState<GeneratedMealPlan | null>(null);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [savedCount, setSavedCount] = useState(0);

  const computedCalories = useMemo(() => {
    const age = Number(calc.age);
    const weightKg = Number(calc.weightKg);
    const heightCm = Number(calc.heightCm);
    if (!age || !weightKg || !heightCm) return null;
    return estimateCalories(calc.gender, age, weightKg, heightCm, calc.goal);
  }, [calc]);

  function toggle<T>(list: T[], value: T, setList: (next: T[]) => void) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function canAdvance(): boolean {
    switch (step) {
      case 0:
        return lengthDays > 0;
      case 1:
        return (weeklyBudgetGBP ?? 0) > 0;
      case 2:
        return mealSlots.length > 0;
      default:
        return true;
    }
  }

  function goNext() {
    if (step < TOTAL_STEPS - 1) setStep((step + 1) as Step);
  }
  function goBack() {
    if (step > 0) setStep((step - 1) as Step);
  }

  async function generate() {
    setPhase("generating");
    setErrorMessage(null);
    const excludeKeywords = excludeKeywordsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const finalCalorieTarget = wantsCalorieTarget ? calorieTargetPerDay ?? computedCalories ?? undefined : undefined;

    const input: MealPlanGeneratorInput = {
      lengthDays,
      weeklyBudgetGBP: weeklyBudgetGBP ?? 40,
      mealSlots,
      variation,
      cuisines,
      dietary,
      allergens,
      excludeKeywords,
      marketPriority,
      calorieTargetPerDay: finalCalorieTarget,
    };

    try {
      const res = await fetch("/api/meal-plan/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const parsed = (await res.json()) as ApiResponse<GeneratedMealPlan>;
      if (!parsed.ok) {
        setErrorMessage(parsed.error.message);
        setPhase("error");
        return;
      }
      setPlan(parsed.data);
      setExpandedDates(new Set(parsed.data.days.length ? [parsed.data.days[0]!.date] : []));
      setPhase("review");
    } catch {
      setErrorMessage("Couldn't reach the planner right now — please try again.");
      setPhase("error");
    }
  }

  async function confirmAndSave() {
    if (!plan) return;
    setPhase("saving");
    setSavedCount(0);

    // Reserve a new plan card first (skipGenerate: true — an empty shell, not the
    // auto-fill picks) instead of the old date-based fallback that silently overwrote
    // whichever plan card happened to be isActive. See
    // summaries/2026-08-09_wizard-confirm-new-card.md.
    let planId: string;
    try {
      const setRes = await fetch("/api/meal-plan-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipGenerate: true }),
      });
      const setParsed = (await setRes.json()) as ApiResponse<{ _id: string }>;
      if (!setParsed.ok) {
        setErrorMessage(setParsed.error.message);
        setPhase("error");
        return;
      }
      planId = setParsed.data._id;
    } catch {
      setErrorMessage("Couldn't reach the planner right now — please try again.");
      setPhase("error");
      return;
    }

    let ok = 0;
    for (const [i, day] of plan.days.entries()) {
      const dayIndex = i + 1;
      for (const entry of day.entries) {
        try {
          const res = await fetch("/api/meal-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Don't pass entry.servings through — that's the recipe's own yield count
            // (how many portions the recipe makes), not a per-meal headcount. The app
            // has no such setting, so POST /api/meal-plan always stores/uses 1.
            body: JSON.stringify({ planId, dayIndex, mealSlot: entry.mealSlot, recipeId: entry.recipeId }),
          });
          const parsed = (await res.json()) as ApiResponse<unknown>;
          if (parsed.ok) ok += 1;
        } catch {
          // keep going — best-effort save, final count reflects what actually landed
        }
        setSavedCount((prev) => prev + 1);
      }
    }
    setSavedCount(ok);
    setPhase("saved");
  }

  function toggleDay(date: string) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  if (phase === "review" && plan) {
    return <PlanReview plan={plan} expandedDates={expandedDates} onToggleDay={toggleDay} onConfirm={confirmAndSave} onBack={() => setPhase("wizard")} />;
  }

  if (phase === "saving" || phase === "saved") {
    const totalEntries = plan ? plan.days.reduce((sum, d) => sum + d.entries.length, 0) : 0;
    return (
      <div className="wizard-result">
        <h1>{phase === "saving" ? "Saving your plan…" : "Plan saved"}</h1>
        <p className="wizard-result__body">
          {phase === "saving"
            ? `Adding meals to your calendar (${savedCount}/${totalEntries})…`
            : `${savedCount}/${totalEntries} meals added to your Meal Planner.`}
        </p>
        {phase === "saved" ? (
          <Link href="/meal-planner" className="wizard-primary-button">
            Go to Meal Planner
          </Link>
        ) : null}
      </div>
    );
  }

  if (phase === "generating") {
    return (
      <div className="wizard-result">
        <h1>Building your plan…</h1>
        <p className="wizard-result__body">This only takes a moment.</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="wizard-result">
        <h1>Something went wrong</h1>
        <p className="wizard-result__body">{errorMessage}</p>
        <button type="button" className="wizard-primary-button" onClick={() => setPhase("wizard")}>
          Back to the wizard
        </button>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="wizard__progress">
        <span>
          Step {step + 1} of {TOTAL_STEPS}
        </span>
        <div className="wizard__progress-bar">
          <div className="wizard__progress-fill" style={{ width: `${((step + 1) / TOTAL_STEPS) * 100}%` }} />
        </div>
      </div>

      <div className="wizard__step">
        {step === 0 ? (
          <>
            <h1>How long do you want to plan for?</h1>
            <p className="wizard__sub">Pick a timeframe — you can always generate another plan later.</p>
            <div className="wizard-options">
              {LENGTH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`wizard-option${lengthDays === opt.value ? " wizard-option--selected" : ""}`}
                  onClick={() => setLengthDays(opt.value)}
                >
                  <span className="wizard-option__title">{opt.label}</span>
                  <span className="wizard-option__sub">{opt.sub}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h1>What&apos;s your weekly food budget?</h1>
            <p className="wizard__sub">We&apos;ll spread this across every meal in your plan.</p>
            <div className="wizard-chip-row">
              {BUDGET_PRESETS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`wizard-chip${weeklyBudgetGBP === amount ? " wizard-chip--selected" : ""}`}
                  onClick={() => {
                    setWeeklyBudgetGBP(amount);
                    setCustomBudget("");
                  }}
                >
                  £{amount}
                </button>
              ))}
            </div>
            <label className="wizard-field">
              <span>Or enter your own weekly amount</span>
              <input
                type="number"
                min={1}
                inputMode="decimal"
                placeholder="e.g. 55"
                value={customBudget}
                onChange={(e) => {
                  setCustomBudget(e.target.value);
                  const n = Number(e.target.value);
                  setWeeklyBudgetGBP(Number.isFinite(n) && n > 0 ? n : null);
                }}
              />
            </label>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h1>Which meals do you want planned?</h1>
            <p className="wizard__sub">Pick at least one.</p>
            <div className="wizard-chip-row">
              {SLOT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`wizard-chip${mealSlots.includes(opt.value) ? " wizard-chip--selected" : ""}`}
                  onClick={() => toggle(mealSlots, opt.value, setMealSlots)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h1>How much variety do you want?</h1>
            <p className="wizard__sub">This controls how often the same recipe can repeat across your plan.</p>
            <div className="wizard-options">
              {VARIATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`wizard-option${variation === opt.value ? " wizard-option--selected" : ""}`}
                  onClick={() => setVariation(opt.value)}
                >
                  <span className="wizard-option__title">{opt.title}</span>
                  <span className="wizard-option__sub">{opt.body}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h1>Any cuisines you&apos;re in the mood for?</h1>
            <p className="wizard__sub">Pick as many as you like, or leave this blank for no preference.</p>
            <div className="wizard-chip-row">
              {CUISINE_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`wizard-chip${cuisines.includes(c) ? " wizard-chip--selected" : ""}`}
                  onClick={() => toggle(cuisines, c, setCuisines)}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 5 ? (
          <>
            <h1>Any dietary habits to keep in mind?</h1>
            <p className="wizard__sub">Select all that apply.</p>
            <div className="wizard-chip-row">
              {DIETARY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`wizard-chip${dietary.includes(opt.value) ? " wizard-chip--selected" : ""}`}
                  onClick={() => toggle(dietary, opt.value, setDietary)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 6 ? (
          <>
            <h1>Allergies or foods to avoid?</h1>
            <p className="wizard__disclaimer">
              This filters recipes by ingredient name only — it is not a certified medical check. If you have a
              serious allergy or intolerance, please double-check every ingredient yourself.
            </p>
            <div className="wizard-chip-row">
              {UK_ALLERGENS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`wizard-chip${allergens.includes(a) ? " wizard-chip--selected" : ""}`}
                  onClick={() => toggle(allergens, a, setAllergens)}
                >
                  {ALLERGEN_LABELS[a]}
                </button>
              ))}
            </div>
            <label className="wizard-field">
              <span>Anything else to avoid? (comma-separated, e.g. garlic, onion, spicy)</span>
              <input
                type="text"
                placeholder="garlic, onion, spicy"
                value={excludeKeywordsText}
                onChange={(e) => setExcludeKeywordsText(e.target.value)}
              />
            </label>
          </>
        ) : null}

        {step === 7 ? (
          <>
            <h1>Got a favourite supermarket?</h1>
            <p className="wizard__sub">
              Optional — we&apos;ll remember this for future price comparisons. It doesn&apos;t change which recipes
              get picked yet.
            </p>
            <div className="wizard-chip-row">
              <button
                type="button"
                className={`wizard-chip${marketPriority === undefined ? " wizard-chip--selected" : ""}`}
                onClick={() => setMarketPriority(undefined)}
              >
                No preference
              </button>
              {STORE_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`wizard-chip${marketPriority === s ? " wizard-chip--selected" : ""}`}
                  onClick={() => setMarketPriority(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === 8 ? (
          <>
            <h1>Roughly how many calories a day?</h1>
            <p className="wizard__sub">Optional — used once to help pick meals. Nothing here is saved to your profile.</p>
            <div className="wizard-chip-row">
              <button
                type="button"
                className={`wizard-chip${!wantsCalorieTarget ? " wizard-chip--selected" : ""}`}
                onClick={() => setWantsCalorieTarget(false)}
              >
                Skip this
              </button>
              <button
                type="button"
                className={`wizard-chip${wantsCalorieTarget ? " wizard-chip--selected" : ""}`}
                onClick={() => setWantsCalorieTarget(true)}
              >
                Estimate for me
              </button>
            </div>

            {wantsCalorieTarget ? (
              <div className="wizard-calorie-calc">
                <div className="wizard-field-row">
                  <label className="wizard-field">
                    <span>Sex</span>
                    <select value={calc.gender} onChange={(e) => setCalc({ ...calc, gender: e.target.value as Gender })}>
                      <option value="unspecified">Prefer not to say</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </select>
                  </label>
                  <label className="wizard-field">
                    <span>Age</span>
                    <input type="number" min={1} value={calc.age} onChange={(e) => setCalc({ ...calc, age: e.target.value })} />
                  </label>
                </div>
                <div className="wizard-field-row">
                  <label className="wizard-field">
                    <span>Weight (kg)</span>
                    <input type="number" min={1} value={calc.weightKg} onChange={(e) => setCalc({ ...calc, weightKg: e.target.value })} />
                  </label>
                  <label className="wizard-field">
                    <span>Height (cm)</span>
                    <input type="number" min={1} value={calc.heightCm} onChange={(e) => setCalc({ ...calc, heightCm: e.target.value })} />
                  </label>
                </div>
                <label className="wizard-field">
                  <span>Goal</span>
                  <select value={calc.goal} onChange={(e) => setCalc({ ...calc, goal: e.target.value as Goal })}>
                    <option value="lose">Lose weight</option>
                    <option value="maintain">Maintain weight</option>
                    <option value="gain">Gain weight</option>
                  </select>
                </label>
                {computedCalories ? (
                  <p className="wizard__estimate">
                    Rough target: <strong>{computedCalories} cal/day</strong> — you can adjust it below.
                  </p>
                ) : null}
                <label className="wizard-field">
                  <span>Daily calorie target</span>
                  <input
                    type="number"
                    min={1000}
                    placeholder={computedCalories ? String(computedCalories) : "e.g. 2000"}
                    value={calorieTargetPerDay ?? ""}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setCalorieTargetPerDay(Number.isFinite(n) && n > 0 ? n : undefined);
                    }}
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="wizard__nav">
        {step > 0 ? (
          <button type="button" className="wizard-secondary-button" onClick={goBack}>
            Back
          </button>
        ) : (
          <Link href="/meal-planner" className="wizard-secondary-button">
            Cancel
          </Link>
        )}
        {step < TOTAL_STEPS - 1 ? (
          <button type="button" className="wizard-primary-button" disabled={!canAdvance()} onClick={goNext}>
            Next
          </button>
        ) : (
          <button type="button" className="wizard-primary-button" onClick={generate}>
            Build my plan
          </button>
        )}
      </div>
    </div>
  );
}

function PlanReview({
  plan,
  expandedDates,
  onToggleDay,
  onConfirm,
  onBack,
}: {
  plan: GeneratedMealPlan;
  expandedDates: Set<string>;
  onToggleDay: (date: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="wizard-result">
      <h1>Here&apos;s your plan</h1>
      <div className="meal-planner-summary">
        <div className="meal-planner-summary__stat">
          <span className="meal-planner-summary__value">{plan.summary.totalMeals}</span>
          <span className="meal-planner-summary__label">Meals</span>
        </div>
        <div className="meal-planner-summary__stat">
          <span className="meal-planner-summary__value">{formatCost(plan.summary.totalCost)}</span>
          <span className="meal-planner-summary__label">Total cost</span>
        </div>
        <div className="meal-planner-summary__stat">
          <span className="meal-planner-summary__value">{plan.summary.avgCaloriesPerDay}</span>
          <span className="meal-planner-summary__label">Avg cal/day</span>
        </div>
      </div>
      {plan.summary.cuisineFilterRelaxed ? (
        <p className="wizard__sub">We couldn&apos;t find enough matches for your cuisine choices on some days, so those days include other cuisines too.</p>
      ) : null}
      {plan.summary.poolTooSmallWarning ? (
        <p className="wizard__sub">Your filters left a small pool of recipes to choose from, so some meals repeat more than we&apos;d like on the same day. Loosening a filter should give you more variety.</p>
      ) : null}

      <div className="meal-planner-board">
        {plan.days.map((day: GeneratedMealPlanDay) => {
          const expanded = expandedDates.has(day.date);
          return (
            <div key={day.date} className="meal-planner-day">
              <button type="button" className="meal-planner-day__header" onClick={() => onToggleDay(day.date)} aria-expanded={expanded}>
                <span className="meal-planner-day__label">{day.date}</span>
                <span className="meal-planner-day__header-right">
                  <span className="meal-planner-day__totals">
                    {formatCost(day.totalCost)} · {Math.round(day.totalCalories)} cal
                  </span>
                  <span className={`meal-planner-day__chevron${expanded ? " meal-planner-day__chevron--open" : ""}`}>▾</span>
                </span>
              </button>
              {expanded ? (
                <div className="meal-planner-slots">
                  {day.entries.map((entry) => (
                    <div key={`${day.date}-${entry.mealSlot}`} className="meal-planner-slot">
                      <span className="meal-planner-slot__label">{entry.mealSlot}</span>
                      <div className="recipe-card meal-planner-slot__card">
                        {entry.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className="recipe-card__image" src={entry.imageUrl} alt="" />
                        ) : (
                          <div className="recipe-card__image" />
                        )}
                        <div className="recipe-card__body">
                          <p className="recipe-card__title">{entry.title}</p>
                          <div className="recipe-card__macros">
                            {entry.costPerServing != null ? <span className="recipe-card__price">{formatCost(entry.costPerServing)}</span> : null}
                            {entry.calories != null ? <span>{entry.calories} cal</span> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="wizard__nav">
        <button type="button" className="wizard-secondary-button" onClick={onBack}>
          Start over
        </button>
        <button type="button" className="wizard-primary-button" onClick={onConfirm}>
          Confirm &amp; save to Meal Planner
        </button>
      </div>
    </div>
  );
}
