import type { MealPlanSetSummary } from "@uiu/shared";
import { apiGet } from "../lib/api";
import { MealPlannerView } from "./MealPlannerView";

export const metadata = { title: "Meal Planner · UseItUp" };

export default async function MealPlannerPage() {
  const res = await apiGet<MealPlanSetSummary[]>("/api/meal-plan-sets");

  if (!res.ok) {
    return (
      <div className="meal-planner-page">
        <div className="meal-planner-page__header">
          <h1>Meal Planner</h1>
          <p>Couldn&apos;t load your meal plans right now — please try again shortly.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="meal-planner-page">
      <div className="meal-planner-page__header">
        <h1>Meal Planner</h1>
      </div>

      <MealPlannerView initialSets={res.data} />
    </div>
  );
}
