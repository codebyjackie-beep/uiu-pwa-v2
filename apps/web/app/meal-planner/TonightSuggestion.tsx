"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ApiResponse, MealPlanSetSummary, MealSlot, MealSuggestion, MealSuggestionsResponse } from "@uiu/shared";
import { CoveragePrice } from "../components/CoveragePrice";
import { todayDayIndex } from "../lib/dates";
import { isNutritionUnavailable, NUTRITION_NOT_AVAILABLE } from "../lib/recipeDisplay";

const MY_PLAN_NAME = "My Plan";

const MEAL_TYPE_OPTIONS: { value: MealSlot; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

/** "What should I eat tonight?" — instant, single-meal, fridge-aware suggestion
 * widget (HANDOFF_tonight-suggestion.md). Purely additive to the existing week
 * board below it: no shared state, its own fetch, its own optional "add to
 * today's plan" action via the existing POST /api/meal-plan route. */
export function TonightSuggestion() {
  const router = useRouter();
  const [mealType, setMealType] = useState<MealSlot>("dinner");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<MealSuggestion[] | null>(null);
  const [error, setError] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(true);
  // Shown under the card that was tapped, so the user sees why nothing was added.
  const [addMessage, setAddMessage] = useState<{ recipeId: string; text: string } | null>(null);

  async function fetchSuggestions() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/meal-suggestions?mealType=${mealType}`);
      const parsed = (await res.json()) as ApiResponse<MealSuggestionsResponse>;
      if (parsed.ok) {
        setSuggestions(parsed.data.suggestions);
        setExpanded(true);
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  /**
   * The plan to add into. No active plan (Jackie 2026-11-05: "Add to today's plan" looked dead) → reuse an
   * existing "My Plan" card or create an empty one (skipGenerate, no AI), then activate it. Named "My Plan" so it
   * is easy to tell apart from "Build a plan for me" cards ("Weekly Plan N"). Returns an error text instead.
   */
  async function resolvePlanId(): Promise<{ planId: string } | { error: string }> {
    const setsRes = await fetch("/api/meal-plan-sets");
    const setsParsed = (await setsRes.json()) as ApiResponse<MealPlanSetSummary[]>;
    if (!setsParsed.ok) return { error: "Couldn't load your plans — please try again." };
    const active = setsParsed.data.find((s) => s.isActive);
    if (active) return { planId: active._id };

    let planId = setsParsed.data.find((s) => s.name === MY_PLAN_NAME)?._id;
    if (!planId) {
      const createRes = await fetch("/api/meal-plan-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: MY_PLAN_NAME, skipGenerate: true }),
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

  async function addToToday(recipeId: string) {
    setAddingId(recipeId);
    setAddMessage(null);
    try {
      const plan = await resolvePlanId();
      if ("error" in plan) {
        setAddMessage({ recipeId, text: plan.error });
        return;
      }

      const res = await fetch("/api/meal-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, dayIndex: todayDayIndex(), mealSlot: mealType, recipeId }),
      });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) {
        setAddedIds((prev) => new Set(prev).add(recipeId));
        router.refresh();
      } else {
        setAddMessage({ recipeId, text: "Couldn't add this recipe — please try again." });
      }
    } catch {
      setAddMessage({ recipeId, text: "Couldn't add this recipe — please try again." });
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="tonight-suggestion">
      <div className="tonight-suggestion__header-row">
        <h2 className="tonight-suggestion__heading">What should I eat?</h2>
        {suggestions && suggestions.length > 0 ? (
          <button
            type="button"
            className="tonight-suggestion__collapse"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse suggestions" : "Expand suggestions"}
          >
            <span className={`meal-planner-day__chevron${expanded ? " meal-planner-day__chevron--open" : ""}`}>▾</span>
          </button>
        ) : null}
      </div>
      <div className="tonight-suggestion__controls">
        <select
          className="tonight-suggestion__select"
          value={mealType}
          onChange={(e) => setMealType(e.target.value as MealSlot)}
        >
          {MEAL_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button type="button" className="wizard-primary-button" onClick={fetchSuggestions} disabled={loading}>
          {loading ? "Finding recipes…" : "Suggest recipes"}
        </button>
      </div>

      {error ? <p className="tonight-suggestion__status">Couldn&apos;t load suggestions — please try again.</p> : null}
      {suggestions && suggestions.length === 0 ? (
        <p className="tonight-suggestion__status">No recipes found for {mealType} right now.</p>
      ) : null}

      {suggestions && suggestions.length > 0 && expanded ? (
        <div className="tonight-suggestion__grid">
          {suggestions.map((s) => (
            <div key={s.recipeId} className="recipe-card tonight-suggestion__card">
              <Link href={`/recipes/${s.recipeId}`} className="tonight-suggestion__card-link">
                {s.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="recipe-card__image" src={s.imageUrl} alt="" />
                ) : (
                  <div className="recipe-card__image" />
                )}
                <div className="recipe-card__body">
                  <p className="recipe-card__title">{s.title}</p>
                  <div className="recipe-card__macros">
                    {s.cost ? (
                      <CoveragePrice
                        value={s.cost.perServing}
                        coveragePct={s.cost.adjustedCoveragePct}
                        className="recipe-card__price"
                        pendingClassName="recipe-card__price--pending"
                      />
                    ) : (
                      <span className="recipe-card__price">—</span>
                    )}
                    {isNutritionUnavailable(s) ? (
                      <span>{NUTRITION_NOT_AVAILABLE}</span>
                    ) : s.calories != null ? (
                      <span>{Math.round(s.calories)} cal</span>
                    ) : null}
                  </div>
                  {s.matchedFridgeItems.length > 0 ? (
                    <p className="tonight-suggestion__match">
                      Uses {s.matchedFridgeItems.length} item{s.matchedFridgeItems.length > 1 ? "s" : ""} expiring soon
                    </p>
                  ) : null}
                </div>
              </Link>
              <button
                type="button"
                className="wizard-secondary-button tonight-suggestion__add"
                disabled={addingId === s.recipeId || addedIds.has(s.recipeId)}
                onClick={() => addToToday(s.recipeId)}
              >
                {addingId === s.recipeId ? "Adding…" : addedIds.has(s.recipeId) ? "Added ✓" : "Add to today's plan"}
              </button>
              {addMessage?.recipeId === s.recipeId ? (
                <p className="tonight-suggestion__status" role="status">
                  {addMessage.text}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
