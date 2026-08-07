"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiResponse, MealSlot, MealSuggestion, MealSuggestionsResponse } from "@uiu/shared";

const MEAL_TYPE_OPTIONS: { value: MealSlot; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

/** "What should I eat tonight?" — instant, single-meal, fridge-aware suggestion
 * widget (HANDOFF_tonight-suggestion.md). Purely additive to the existing week
 * board below it: no shared state, its own fetch, its own optional "add to
 * today's plan" action via the existing POST /api/meal-plan route. */
export function TonightSuggestion() {
  const [mealType, setMealType] = useState<MealSlot>("dinner");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<MealSuggestion[] | null>(null);
  const [error, setError] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  async function fetchSuggestions() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/meal-suggestions?mealType=${mealType}`);
      const parsed = (await res.json()) as ApiResponse<MealSuggestionsResponse>;
      if (parsed.ok) setSuggestions(parsed.data.suggestions);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function addToToday(recipeId: string) {
    setAddingId(recipeId);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch("/api/meal-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today, mealSlot: mealType, recipeId }),
      });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) setAddedIds((prev) => new Set(prev).add(recipeId));
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="tonight-suggestion">
      <h2 className="tonight-suggestion__heading">What should I eat?</h2>
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

      {suggestions && suggestions.length > 0 ? (
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
                    <span className="recipe-card__price">{s.cost ? formatCost(s.cost.basket) : "—"}</span>
                    {s.calories != null ? <span>{Math.round(s.calories)} cal</span> : null}
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
                {addedIds.has(s.recipeId) ? "Added ✓" : "Add to today's plan"}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
