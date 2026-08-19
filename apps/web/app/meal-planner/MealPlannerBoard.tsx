"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  ApiResponse,
  FavouriteRecipe,
  MealPlanDaySummary,
  MealSlot,
  RecipeListItem,
  RecipeListPage,
} from "@uiu/shared";
import { dayIndexLabel, todayDayIndex } from "../lib/dates";
import { costPendingLabel, mealTypeBadge } from "../lib/recipeDisplay";

function formatRecipePrice(cost: RecipeListItem["cost"]) {
  if (!cost || cost.basket <= 0) return null;
  return `£${cost.basket.toFixed(2)}`;
}

const DAY_INDEXES = [1, 2, 3, 4, 5, 6, 7];
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
  planId: string;
  days: MealPlanDaySummary[];
  weekTotalCost: number;
  onChanged: () => void;
}

export function MealPlannerBoard({ planId, days, weekTotalCost, onChanged }: Props) {
  const [picker, setPicker] = useState<{ dayIndex: number; slot: MealSlot } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecipeListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set([todayDayIndex()]));
  const [favouriteIds, setFavouriteIds] = useState<Set<string>>(() => new Set());
  const [duplicateQuery, setDuplicateQuery] = useState<string | null>(null);

  const dayByIndex = new Map(days.map((d) => [d.dayIndex, d]));
  const averageDayCost = weekTotalCost / 7;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/favourite-recipes");
      const parsed = (await res.json()) as ApiResponse<FavouriteRecipe[]>;
      if (!cancelled && parsed.ok) setFavouriteIds(new Set(parsed.data.map((f) => f.recipeId)));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleDay(dayIndex: number) {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayIndex)) next.delete(dayIndex);
      else next.add(dayIndex);
      return next;
    });
  }

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
        body: JSON.stringify({ planId, dayIndex: picker.dayIndex, mealSlot: picker.slot, recipeId }),
      });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) {
        setPicker(null);
        setQuery("");
        onChanged();
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
      if (parsed.ok) onChanged();
    } finally {
      setPendingId(null);
    }
  }

  async function refreshMeal(entryId: string) {
    setPendingId(entryId);
    try {
      const res = await fetch(`/api/meal-plan/${entryId}/refresh`, { method: "POST" });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) onChanged();
    } finally {
      setPendingId(null);
    }
  }

  function duplicateMeal(title: string) {
    setDuplicateQuery(title);
  }

  function openPicker(dayIndex: number, slot: MealSlot) {
    setPicker({ dayIndex, slot });
    if (duplicateQuery) {
      setQuery(duplicateQuery);
      setDuplicateQuery(null);
    }
  }

  async function toggleFavourite(recipeId: string) {
    const isFav = favouriteIds.has(recipeId);
    setFavouriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
    if (isFav) {
      await fetch(`/api/favourite-recipes/${recipeId}`, { method: "DELETE" });
    } else {
      await fetch("/api/favourite-recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipeId }),
      });
    }
  }

  return (
    <div className="meal-planner-board">
      {DAY_INDEXES.map((dayIndex) => {
        const summary = dayByIndex.get(dayIndex);
        const entriesBySlot = new Map((summary?.entries ?? []).map((e) => [e.mealSlot, e]));

        const expanded = expandedDays.has(dayIndex);
        const aboveAverage = !!summary && averageDayCost > 0 && summary.totalCost > averageDayCost;

        return (
          <div key={dayIndex} className="meal-planner-day">
            <button
              type="button"
              className="meal-planner-day__header"
              onClick={() => toggleDay(dayIndex)}
              aria-expanded={expanded}
            >
              <span className="meal-planner-day__label">Day {dayIndex} · {dayIndexLabel(dayIndex)}</span>
              <span className="meal-planner-day__header-right">
                {summary ? (
                  <span className={`meal-planner-day__totals${aboveAverage ? " meal-planner-day__totals--high" : ""}`}>
                    {aboveAverage ? <span className="meal-planner-day__flag">Above average</span> : null}
                    {formatCost(summary.totalCost)} · {Math.round(summary.totalCalories)} cal
                  </span>
                ) : null}
                <span className={`meal-planner-day__chevron${expanded ? " meal-planner-day__chevron--open" : ""}`}>▾</span>
              </span>
            </button>

            {expanded ? (
              <div className="meal-planner-slots">
                {MEAL_SLOTS.map((slot) => {
                  const entry = entriesBySlot.get(slot);
                  return (
                    <div key={slot} className="meal-planner-slot">
                      <span className="meal-planner-slot__label">{SLOT_LABEL[slot]}</span>
                      {entry ? (
                        <div className="meal-planner-slot__card-wrap">
                          <Link href={`/recipes/${entry.recipeId}`} className="recipe-card meal-planner-slot__card">
                            {entry.recipe.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img className="recipe-card__image" src={entry.recipe.imageUrl} alt="" />
                            ) : (
                              <div className="recipe-card__image" />
                            )}
                            <div className="recipe-card__body">
                              <div className="recipe-card__header">
                                <p className="recipe-card__title">{entry.recipe.title}</p>
                                <button
                                  type="button"
                                  className="meal-planner-slot__remove"
                                  disabled={pendingId === entry._id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    removeMeal(entry._id);
                                  }}
                                  aria-label={`Remove ${entry.recipe.title}`}
                                >
                                  ×
                                </button>
                              </div>
                              <div className="recipe-card__macros">
                                <span className="recipe-card__price">
                                  {entry.recipe.costPerServing != null ? formatCost(entry.recipe.costPerServing) : "—"}
                                </span>
                                {entry.recipe.calories != null ? (
                                  <span>{Math.round(entry.recipe.calories)} cal</span>
                                ) : null}
                              </div>
                            </div>
                          </Link>
                          <div className="meal-planner-slot__icons">
                            <button
                              type="button"
                              className="meal-planner-slot__icon"
                              disabled={pendingId === entry._id}
                              onClick={() => refreshMeal(entry._id)}
                              aria-label={`Refresh ${entry.recipe.title}`}
                              title="Swap for another recipe"
                            >
                              ⟳
                            </button>
                            <button
                              type="button"
                              className="meal-planner-slot__icon"
                              onClick={() => duplicateMeal(entry.recipe.title)}
                              aria-label={`Duplicate ${entry.recipe.title}`}
                              title="Add this recipe to another slot"
                            >
                              ⧉
                            </button>
                            <button
                              type="button"
                              className={`meal-planner-slot__icon${favouriteIds.has(entry.recipeId) ? " meal-planner-slot__icon--active" : ""}`}
                              onClick={() => toggleFavourite(entry.recipeId)}
                              aria-label={`Favourite ${entry.recipe.title}`}
                              title="Favourite"
                            >
                              {favouriteIds.has(entry.recipeId) ? "♥" : "♡"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" className="meal-planner-slot__add" onClick={() => openPicker(dayIndex, slot)}>
                          + Add
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      {picker ? (
        <div className="meal-picker-overlay" role="dialog" aria-modal="true">
          <div className="meal-picker">
            <div className="meal-picker__header">
              <h2>
                Add to {SLOT_LABEL[picker.slot]} · {dayIndexLabel(picker.dayIndex)}
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
              {results.map((recipe) => {
                const mealBadge = mealTypeBadge(recipe);
                const price = formatRecipePrice(recipe.cost);
                return (
                  <button
                    key={recipe._id}
                    type="button"
                    className="recipe-card meal-picker__result"
                    disabled={pendingId === recipe._id}
                    onClick={() => addMeal(recipe._id)}
                  >
                    {recipe.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="recipe-card__image" src={recipe.imageUrl} alt="" />
                    ) : (
                      <div className="recipe-card__image" />
                    )}
                    <div className="recipe-card__body">
                      <div className="recipe-card__header">
                        {mealBadge ? <span className="badge">{mealBadge}</span> : <span />}
                        {price ? (
                          <span className="recipe-card__price">{price}</span>
                        ) : (
                          <span className="recipe-card__price recipe-card__price--pending">{costPendingLabel(recipe)}</span>
                        )}
                      </div>
                      <p className="recipe-card__title">{recipe.title}</p>
                      <div className="recipe-card__macros">
                        <span>{Math.round(recipe.nutrition.calories)} cal</span>
                        <span>{recipe.ingredientCount} items</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
