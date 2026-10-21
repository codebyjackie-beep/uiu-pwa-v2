"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatCostWithCoverage, formatTotalWithIncomplete, recipePerServingPrice } from "@uiu/shared";
import type {
  ApiResponse,
  FavouriteRecipe,
  MealPlanDaySummary,
  MealSlot,
  RecipeListItem,
  RecipeListPage,
} from "@uiu/shared";
import { CoveragePrice } from "../components/CoveragePrice";
import { dayIndexLabel, todayDayIndex } from "../lib/dates";
import { costPendingLabel, isNutritionUnavailable, mealTypeBadge, NUTRITION_NOT_AVAILABLE } from "../lib/recipeDisplay";

const DAY_INDEXES = [1, 2, 3, 4, 5, 6, 7];
const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};
const SLOT_ICON: Record<MealSlot, string> = {
  breakfast: "🥣",
  lunch: "🥪",
  dinner: "🍽️",
  snack: "🍎",
};

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
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [favouriteIds, setFavouriteIds] = useState<Set<string>>(() => new Set());
  const [duplicateQuery, setDuplicateQuery] = useState<string | null>(null);
  // UI refresh A: day tabs + one day's meals by default; the 7×4 week grid stays one tap away.
  const [view, setView] = useState<"day" | "week">("day");
  const [selectedDay, setSelectedDay] = useState<number>(() => todayDayIndex());

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
      if (parsed.ok) {
        closeEntrySheet();
        onChanged();
      }
    } finally {
      setPendingId(null);
    }
  }

  async function refreshMeal(entryId: string) {
    setPendingId(entryId);
    try {
      const res = await fetch(`/api/meal-plan/${entryId}/refresh`, { method: "POST" });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) {
        closeEntrySheet();
        onChanged();
      }
    } finally {
      setPendingId(null);
    }
  }

  function closeEntrySheet() {
    setActiveEntryId(null);
    setConfirmRemove(false);
  }

  function duplicateMeal(title: string) {
    setDuplicateQuery(title);
    closeEntrySheet();
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

  const activeEntry = activeEntryId ? days.flatMap((d) => d.entries).find((e) => e._id === activeEntryId) ?? null : null;

  return (
    <div className="meal-planner-board">
      {duplicateQuery ? (
        <div className="meal-grid-hint" role="status">
          <span>Tap a + cell to add “{duplicateQuery}”</span>
          <button type="button" className="meal-grid-hint__close" onClick={() => setDuplicateQuery(null)} aria-label="Cancel duplicate">
            ×
          </button>
        </div>
      ) : null}

      <div className="meal-view-toggle" role="group" aria-label="Plan view">
        <button type="button" className={view === "day" ? "meal-view-toggle__btn meal-view-toggle__btn--on" : "meal-view-toggle__btn"} aria-pressed={view === "day"} onClick={() => setView("day")}>
          Day
        </button>
        <button type="button" className={view === "week" ? "meal-view-toggle__btn meal-view-toggle__btn--on" : "meal-view-toggle__btn"} aria-pressed={view === "week"} onClick={() => setView("week")}>
          Week
        </button>
      </div>

      {view === "day" ? (
        <div className="meal-day">
          <div className="meal-day__tabs" role="tablist" aria-label="Day">
            {DAY_INDEXES.map((d) => {
              const count = dayByIndex.get(d)?.entries.length ?? 0;
              return (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={selectedDay === d}
                  className={selectedDay === d ? "meal-day__tab meal-day__tab--on" : "meal-day__tab"}
                  onClick={() => setSelectedDay(d)}
                >
                  <span>{dayIndexLabel(d)}</span>
                  <span className="meal-day__tab-count">{count ? `${count} meal${count === 1 ? "" : "s"}` : "—"}</span>
                </button>
              );
            })}
          </div>
          {(() => {
            const summary = dayByIndex.get(selectedDay);
            const entriesBySlot = new Map((summary?.entries ?? []).map((e) => [e.mealSlot, e]));
            return (
              <>
                <ul className="meal-day__list">
                  {MEAL_SLOTS.map((slot) => {
                    const entry = entriesBySlot.get(slot);
                    if (!entry) {
                      return (
                        <li key={slot}>
                          <button type="button" className="meal-day__add" onClick={() => openPicker(selectedDay, slot)}>
                            + Add {SLOT_LABEL[slot].toLowerCase()}
                          </button>
                        </li>
                      );
                    }
                    const price =
                      entry.recipe.costPerServing != null ? formatCostWithCoverage(entry.recipe.costPerServing, entry.recipe.adjustedCoveragePct) : null;
                    const mins = (entry.recipe.prepTimeMinutes || 0) + (entry.recipe.cookTimeMinutes || 0);
                    return (
                      <li key={slot}>
                        <button type="button" className="meal-day__meal" onClick={() => setActiveEntryId(entry._id)}>
                          {entry.recipe.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="meal-day__img" src={entry.recipe.imageUrl} alt="" />
                          ) : (
                            <span className="meal-day__img" />
                          )}
                          <span className="meal-day__body">
                            <span className="meal-day__slot">{SLOT_LABEL[slot]}</span>
                            <span className="meal-day__title">{entry.recipe.title}</span>
                            <span className="meal-day__meta">
                              {[
                                price == null || price.tier === "unavailable" ? "No price" : price.text,
                                mins ? `${mins} min` : null,
                                entry.recipe.calories != null ? `${Math.round(entry.recipe.calories)} kcal` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {summary ? (
                  <p className="meal-day__total">
                    <span>{dayIndexLabel(selectedDay)} total</span>
                    <span>
                      {formatTotalWithIncomplete(summary.totalCost, summary.costIncomplete)} · {Math.round(summary.totalCalories).toLocaleString("en-GB")} kcal
                    </span>
                  </p>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : null}

      {view === "week" ? (
      <div className="meal-grid" role="grid" aria-label="Meal plan, 7 days by 4 meals">
        <div className="meal-grid__head" role="row">
          <span />
          {MEAL_SLOTS.map((slot) => (
            <span key={slot} className="meal-grid__slot-head" role="columnheader">
              <span aria-hidden="true">{SLOT_ICON[slot]}</span>
              <span>{SLOT_LABEL[slot]}</span>
            </span>
          ))}
        </div>

        {DAY_INDEXES.map((dayIndex) => {
          const summary = dayByIndex.get(dayIndex);
          const entriesBySlot = new Map((summary?.entries ?? []).map((e) => [e.mealSlot, e]));
          const aboveAverage = !!summary && averageDayCost > 0 && summary.totalCost > averageDayCost;

          return (
            <div key={dayIndex} className={`meal-grid__day${aboveAverage ? " meal-grid__day--high" : ""}`} role="row">
              <span className="meal-grid__day-label" role="rowheader">
                Day {dayIndex}
              </span>
              {MEAL_SLOTS.map((slot) => {
                const entry = entriesBySlot.get(slot);
                if (!entry) {
                  return (
                    <button
                      key={slot}
                      type="button"
                      role="gridcell"
                      className="meal-grid__cell meal-grid__cell--empty"
                      onClick={() => openPicker(dayIndex, slot)}
                      aria-label={`Add ${SLOT_LABEL[slot]} on day ${dayIndex}`}
                    >
                      +
                    </button>
                  );
                }
                const price =
                  entry.recipe.costPerServing != null ? formatCostWithCoverage(entry.recipe.costPerServing, entry.recipe.adjustedCoveragePct) : null;
                return (
                  <button
                    key={slot}
                    type="button"
                    role="gridcell"
                    className="meal-grid__cell meal-grid__cell--filled"
                    onClick={() => setActiveEntryId(entry._id)}
                    aria-label={`${entry.recipe.title}, ${SLOT_LABEL[slot]} on day ${dayIndex}`}
                  >
                    <span className="meal-grid__cell-title">{entry.recipe.title}</span>
                    <span className="meal-grid__cell-price">{price == null || price.tier === "unavailable" ? "No price" : price.text}</span>
                  </button>
                );
              })}
              {summary ? (
                <span className={`meal-grid__day-total${aboveAverage ? " meal-grid__day-total--high" : ""}`}>
                  {aboveAverage ? <span className="meal-planner-day__flag">Above average</span> : null}
                  {formatTotalWithIncomplete(summary.totalCost, summary.costIncomplete)} · {Math.round(summary.totalCalories)} cal
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      ) : null}

      {activeEntry ? (
        <div className="meal-planner-modal-overlay" onClick={closeEntrySheet}>
          <div className="meal-planner-modal meal-cell-sheet" role="dialog" aria-modal="true" aria-labelledby="meal-cell-title" onClick={(e) => e.stopPropagation()}>
            <div className="meal-planner-modal__header">
              <h3 id="meal-cell-title" className="meal-planner-modal__title">
                {activeEntry.recipe.title}
              </h3>
              <button type="button" className="meal-planner-modal__close" onClick={closeEntrySheet} aria-label="Close">
                ×
              </button>
            </div>
            <div className="meal-planner-modal__body">
              <p className="meal-cell-sheet__meta">
                {SLOT_LABEL[activeEntry.mealSlot]} · Day {activeEntry.dayIndex} ({dayIndexLabel(activeEntry.dayIndex)})
              </p>
              {confirmRemove ? (
                <div className="meal-cell-sheet__confirm">
                  <p>Remove this meal from the plan?</p>
                  <div className="meal-cell-sheet__confirm-actions">
                    <button type="button" className="wizard-secondary-button" onClick={() => setConfirmRemove(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="wizard-primary-button meal-cell-sheet__danger"
                      disabled={pendingId === activeEntry._id}
                      onClick={() => removeMeal(activeEntry._id)}
                    >
                      Yes, remove
                    </button>
                  </div>
                </div>
              ) : (
                <div className="meal-cell-sheet__actions">
                  <Link href={`/recipes/${activeEntry.recipeId}`} className="meal-cell-sheet__action">
                    View recipe
                  </Link>
                  <button type="button" className="meal-cell-sheet__action" disabled={pendingId === activeEntry._id} onClick={() => refreshMeal(activeEntry._id)}>
                    {pendingId === activeEntry._id ? "Swapping…" : "Swap"}
                  </button>
                  <button type="button" className="meal-cell-sheet__action" onClick={() => duplicateMeal(activeEntry.recipe.title)}>
                    Duplicate
                  </button>
                  <button type="button" className="meal-cell-sheet__action" onClick={() => toggleFavourite(activeEntry.recipeId)}>
                    {favouriteIds.has(activeEntry.recipeId) ? "♥ Favourited" : "♡ Favourite"}
                  </button>
                  <button type="button" className="meal-cell-sheet__action meal-cell-sheet__action--danger" onClick={() => setConfirmRemove(true)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

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
                // Per-serving, same as the Recipes list and the plan cards (never the whole-recipe basket).
                const perServing = recipePerServingPrice(recipe.cost);
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
                        {perServing != null ? (
                          <CoveragePrice
                            value={perServing}
                            coveragePct={recipe.cost!.adjustedCoveragePct}
                            suffix="/ serving"
                            className="recipe-card__price"
                            pendingClassName="recipe-card__price--pending"
                          />
                        ) : (
                          <span className="recipe-card__price recipe-card__price--pending">{costPendingLabel(recipe)}</span>
                        )}
                      </div>
                      <p className="recipe-card__title">{recipe.title}</p>
                      <div className="recipe-card__macros">
                        <span>{isNutritionUnavailable(recipe) ? NUTRITION_NOT_AVAILABLE : `${Math.round(recipe.nutrition.calories)} cal`}</span>
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
