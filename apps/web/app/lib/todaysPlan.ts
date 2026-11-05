import type { ApiResponse, MealPlanSetSummary, MealSlot } from "@uiu/shared";
import { todayDayIndex } from "./dates";

/** Jackie 2026-11-05: auto-created plan name — matches the "Add to today's plan" button, distinct from "Weekly Plan N". */
export const TODAYS_PLAN_NAME = "Today's Plan";

/**
 * The plan to add into: the active one, else an existing "Today's Plan" card, else a new empty one (skipGenerate,
 * no AI) — then activated. Returns an error text for the UI instead of throwing.
 */
export async function resolveTodaysPlanId(): Promise<{ planId: string } | { error: string }> {
  const setsRes = await fetch("/api/meal-plan-sets");
  const setsParsed = (await setsRes.json()) as ApiResponse<MealPlanSetSummary[]>;
  if (!setsParsed.ok) return { error: "Couldn't load your plans — please try again." };
  const active = setsParsed.data.find((s) => s.isActive);
  if (active) return { planId: active._id };

  let planId = setsParsed.data.find((s) => s.name === TODAYS_PLAN_NAME)?._id;
  if (!planId) {
    const createRes = await fetch("/api/meal-plan-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: TODAYS_PLAN_NAME, skipGenerate: true }),
    });
    const created = (await createRes.json()) as ApiResponse<MealPlanSetSummary>;
    if (!created.ok) {
      return created.error.code === "plan_limit_reached"
        ? { error: "You already have the maximum number of plans — activate or delete one first." }
        : { error: "Couldn't create a plan — please try again." };
    }
    planId = created.data._id;
  }
  const actRes = await fetch(`/api/meal-plan-sets/${planId}/activate`, { method: "POST" });
  const act = (await actRes.json()) as ApiResponse<unknown>;
  if (!act.ok) return { error: "Couldn't start your plan — please try again." };
  return { planId };
}

/** Adds one recipe to today's slot of the plan above. */
export async function addRecipeToTodaysPlan(recipeId: string, mealSlot: MealSlot): Promise<{ ok: true } | { error: string }> {
  try {
    const plan = await resolveTodaysPlanId();
    if ("error" in plan) return plan;
    const res = await fetch("/api/meal-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.planId, dayIndex: todayDayIndex(), mealSlot, recipeId }),
    });
    const parsed = (await res.json()) as ApiResponse<unknown>;
    return parsed.ok ? { ok: true } : { error: "Couldn't add this recipe — please try again." };
  } catch {
    return { error: "Couldn't add this recipe — please try again." };
  }
}
