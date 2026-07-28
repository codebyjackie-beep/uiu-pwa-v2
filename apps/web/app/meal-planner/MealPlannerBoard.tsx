"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiResponse, MealPlanDaySummary, MealSlot, RecipeListItem, RecipeListPage } from "@uiu/shared";
import { dayLabel } from "../lib/dates";

const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

interface Props {
  weekDates: string[];
  days: MealPlanDaySummary[];
}

export function MealPlannerBoard({ weekDates, days }: Props) {
  const router = useRouter();
  const [picker, setPicker] = useState<{ date: string; slot: MealSlot } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecipeListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const dayByDate = new Map(days.map((d) => [d.date, d]));

  useEffect(() => {
    if (!picker) return;
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const qs = query ? `?q=${encodeURIComponent(query)}&limit=8` : "?limit=8";
        const res = await fetch(`/api/recipes${qs}`);
        const parsed = (await res.json()) as ApiResponse<RecipeListPage>;
        if (!cancelled && parsed.ok) setResults(parsed.data.items);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [picker, query]);

  async function addMeal(recipeId: string) {
    if (!picker) return;
    setPendingId(recipeId);
    try {
      const res = await fetch("/api/meal-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: picker.date, mealSlot: picker.slot, recipeId }),
      });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) {
        setPicker(null);
        setQuery("");
        router.refresh();
      }
    } finally {
      setPendingId(null);
    }
  }

  async function removeMeal(entryId: string) {
    setPendingId(entryId);
    try {
      const res = await fetch(`/api/meal-plan/${entryId}`, { method: "DELETE" });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="meal-planner-board">
      {weekDates.map((date, index) => {
        const summary = dayByDate.get(date);
        const entriesBySlot = new Map((summary?.entries ?? []).map((e) => [e.mealSlot, e]));

        return (
          <div key={date} className="meal-planner-day">
            <div className="meal-planner-day__header">
              <span className="meal-planner-day__label">{dayLabel(date, index)}</span>
              {summary ? (
                <span className="meal-planner-day__totals">
                  {formatCost(summary.totalCost)} · {Math.round(summary.totalCalories)} cal
                </span>
              ) : null}
            </div>

            <div className="meal-planner-slots">
              {MEAL_SLOTS.map((slot) => {
                const entry = entriesBySlot.get(slot);
                return (
                  <div key={slot} className="meal-planner-slot">
                    <span className="meal-planner-slot__label">{SLOT_LABEL[slot]}</span>
                    {entry ? (
                      <div className="meal-planner-slot__entry">
                        <span className="meal-planner-slot__title">{entry.recipe.title}</span>
                        <span className="meal-planner-slot__meta">
                          {entry.recipe.costPerServing != null ? formatCost(entry.recipe.costPerServing * entry.servings) : "—"}
                          {entry.recipe.calories != null ? ` · ${Math.round(entry.recipe.calories * entry.servings)} cal` : ""}
                        </span>
                        <button
                          type="button"
                          className="meal-planner-slot__remove"
                          disabled={pendingId === entry._id}
                          onClick={() => removeMeal(entry._id)}
                          aria-label={`Remove ${entry.recipe.title}`}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="meal-planner-slot__add" onClick={() => setPicker({ date, slot })}>
                        + Add
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {picker ? (
        <div className="meal-picker-overlay" role="dialog" aria-modal="true">
          <div className="meal-picker">
            <div className="meal-picker__header">
              <h2>
                Add to {SLOT_LABEL[picker.slot]} · {picker.date}
              </h2>
              <button type="button" className="meal-picker__close" onClick={() => setPicker(null)} aria-label="Close">
                ×
              </button>
            </div>
            <input
              type="text"
              className="meal-picker__search"
              placeholder="Search recipes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="meal-picker__results">
              {searching ? <p className="meal-picker__status">Searching…</p> : null}
              {!searching && results.length === 0 ? <p className="meal-picker__status">No recipes found.</p> : null}
              {results.map((recipe) => (
                <button
                  key={recipe._id}
                  type="button"
                  className="meal-picker__result"
                  disabled={pendingId === recipe._id}
                  onClick={() => addMeal(recipe._id)}
                >
                  <span className="meal-picker__result-title">{recipe.title}</span>
                  <span className="meal-picker__result-meta">
                    {recipe.cost ? formatCost(recipe.cost.basket) : "calculating…"} · {Math.round(recipe.nutrition.calories)} cal
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
