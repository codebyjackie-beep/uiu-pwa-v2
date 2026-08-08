import type { MealPlanWeekResponse } from "@uiu/shared";
import { apiGet } from "../lib/api";
import { addDays, mondayOf, toDateKey, weekDates } from "../lib/dates";
import { MealPlannerView } from "./MealPlannerView";

export const metadata = { title: "Meal Planner · UseItUp" };

export default async function MealPlannerPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const monday = mondayOf(week);
  const mondayKey = toDateKey(monday);
  const dates = weekDates(mondayKey);
  const sunday = dates[dates.length - 1];

  const res = await apiGet<MealPlanWeekResponse>(`/api/meal-plan?start=${mondayKey}&end=${sunday}`);

  const prevWeekKey = toDateKey(addDays(monday, -7));
  const nextWeekKey = toDateKey(addDays(monday, 7));

  if (!res.ok) {
    return (
      <div className="meal-planner-page">
        <div className="meal-planner-page__header">
          <h1>Meal Planner</h1>
          <p>Couldn&apos;t load your meal plan right now — please try again shortly.</p>
        </div>
      </div>
    );
  }

  const { days, weekTotalCost, weekTotalCalories } = res.data;

  const mealsCount = days.reduce((sum, d) => sum + d.entries.length, 0);
  const itemsCount = new Set(days.flatMap((d) => d.entries.flatMap((e) => e.recipe.ingredientNames))).size;

  return (
    <div className="meal-planner-page">
      <div className="meal-planner-page__header">
        <h1>Meal Planner</h1>
      </div>

      <MealPlannerView
        weekDates={dates}
        days={days}
        weekTotalCost={weekTotalCost}
        weekTotalCalories={weekTotalCalories}
        mealsCount={mealsCount}
        itemsCount={itemsCount}
        mondayKey={mondayKey}
        sunday={sunday}
        prevWeekKey={prevWeekKey}
        nextWeekKey={nextWeekKey}
      />
    </div>
  );
}
