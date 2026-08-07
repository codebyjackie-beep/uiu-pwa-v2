import Link from "next/link";
import type { MealPlanWeekResponse } from "@uiu/shared";
import { apiGet } from "../lib/api";
import { addDays, dayLabel, mondayOf, toDateKey, weekDates } from "../lib/dates";
import { MealPlannerBoard } from "./MealPlannerBoard";
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

  return (
    <div className="meal-planner-page">
      <div className="meal-planner-page__header">
        <h1>Meal Planner</h1>
      </div>

      <MealPlannerView
        weekTotalCost={weekTotalCost}
        weekTotalCalories={weekTotalCalories}
        board={
          <>
            <div className="meal-planner-page__nav">
              <Link href={`/meal-planner?week=${prevWeekKey}`}>← Prev week</Link>
              <span>
                {dayLabel(mondayKey, 0)} – {dayLabel(sunday, 6)}
              </span>
              <Link href={`/meal-planner?week=${nextWeekKey}`}>Next week →</Link>
            </div>
            <MealPlannerBoard weekDates={dates} days={days} />
          </>
        }
      />
    </div>
  );
}
