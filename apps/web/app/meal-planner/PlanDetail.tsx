"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiResponse, MealPlanDaySummary, ShoppingListFromIngredientResponse } from "@uiu/shared";
import { dayLabel } from "../lib/dates";
import { MealPlannerBoard } from "./MealPlannerBoard";

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

type Tab = "overview" | "meals" | "shopping" | "shared";

interface AggregatedIngredient {
  key: string;
  displayName: string;
  canonicalName?: string;
  rawName: string;
  store?: string;
  totalCost: number;
  occurrences: number;
  priceable: boolean;
}

/** Client-side aggregate of every meal-plan entry's costLines, keyed by canonicalName
 * (fallback rawName). Reused by both the Shopping tab (full list) and Shared tab
 * (occurrences >= 2 filter) — no backend aggregation endpoint needed. */
function aggregateIngredients(days: MealPlanDaySummary[]): AggregatedIngredient[] {
  const byKey = new Map<string, AggregatedIngredient>();
  for (const day of days) {
    for (const entry of day.entries) {
      for (const line of entry.recipe.costLines) {
        const key = line.canonicalName ?? line.rawName;
        const existing = byKey.get(key);
        if (existing) {
          existing.occurrences += 1;
          if (line.priceable && line.lineCost != null) existing.totalCost += line.lineCost;
          if (!existing.store && line.priceable && line.store) existing.store = line.store;
          if (line.priceable) existing.priceable = true;
        } else {
          byKey.set(key, {
            key,
            displayName: line.canonicalName ?? line.rawName,
            canonicalName: line.canonicalName,
            rawName: line.rawName,
            store: line.priceable ? line.store : undefined,
            totalCost: line.priceable && line.lineCost != null ? line.lineCost : 0,
            occurrences: 1,
            priceable: line.priceable,
          });
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.totalCost - a.totalCost);
}

interface Props {
  weekDates: string[];
  days: MealPlanDaySummary[];
  weekTotalCost: number;
  weekTotalCalories: number;
  mealsCount: number;
  itemsCount: number;
  mondayKey: string;
  sunday: string;
  prevWeekKey: string;
  nextWeekKey: string;
  onBack: () => void;
}

export function PlanDetail({
  weekDates,
  days,
  weekTotalCost,
  weekTotalCalories,
  mealsCount,
  itemsCount,
  mondayKey,
  sunday,
  prevWeekKey,
  nextWeekKey,
  onBack,
}: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [itemStatus, setItemStatus] = useState<Map<string, "pending" | "merged" | "added">>(() => new Map());

  const aggregated = aggregateIngredients(days);
  const sharedItems = aggregated.filter((item) => item.occurrences >= 2);

  async function addToShop(item: AggregatedIngredient) {
    setItemStatus((prev) => new Map(prev).set(item.key, "pending"));
    try {
      const res = await fetch("/api/shopping-list/from-ingredient", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredientName: item.rawName, canonicalName: item.canonicalName }),
      });
      const parsed = (await res.json()) as ApiResponse<ShoppingListFromIngredientResponse>;
      setItemStatus((prev) => new Map(prev).set(item.key, parsed.ok && parsed.data.merged ? "merged" : "added"));
    } catch {
      setItemStatus((prev) => {
        const next = new Map(prev);
        next.delete(item.key);
        return next;
      });
    }
  }

  const totalProtein = sumMacro(days, "protein");
  const totalCarbs = sumMacro(days, "carbs");
  const totalFat = sumMacro(days, "fat");
  const totalCookMinutes = days.reduce(
    (sum, d) => sum + d.entries.reduce((s, e) => s + e.recipe.prepTimeMinutes + e.recipe.cookTimeMinutes, 0),
    0,
  );

  return (
    <div className="meal-planner-board-view">
      <div className="meal-planner-modal__header">
        <h2 className="meal-planner-modal__title">Meal Plan</h2>
        <button type="button" className="meal-planner-modal__close" onClick={onBack} aria-label="Close">
          ×
        </button>
      </div>

      <div className="meal-planner-modal__body">
      <div className="meal-planner-tabs">
        <button
          type="button"
          className={`meal-planner-tab${tab === "overview" ? " meal-planner-tab--active" : ""}`}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={`meal-planner-tab${tab === "meals" ? " meal-planner-tab--active" : ""}`}
          onClick={() => setTab("meals")}
        >
          Meals
        </button>
        <button
          type="button"
          className={`meal-planner-tab${tab === "shopping" ? " meal-planner-tab--active" : ""}`}
          onClick={() => setTab("shopping")}
        >
          Shopping
        </button>
        <button
          type="button"
          className={`meal-planner-tab${tab === "shared" ? " meal-planner-tab--active" : ""}`}
          onClick={() => setTab("shared")}
        >
          Shared
        </button>
      </div>

      {tab === "overview" ? (
        <div className="meal-planner-overview">
          <div className="meal-planner-overview__grid">
            <OverviewStat label="Total cost" value={formatCost(weekTotalCost)} />
            <OverviewStat label="Meals" value={String(mealsCount)} />
            <OverviewStat label="Calories" value={`${Math.round(weekTotalCalories)}`} />
            <OverviewStat label="Cook time" value={`${Math.round(totalCookMinutes)} min`} />
            <OverviewStat label="Protein" value={`${Math.round(totalProtein)} g`} />
            <OverviewStat label="Carbs" value={`${Math.round(totalCarbs)} g`} />
            <OverviewStat label="Fat" value={`${Math.round(totalFat)} g`} />
            <OverviewStat label="Items" value={String(itemsCount)} />
          </div>
        </div>
      ) : null}

      {tab === "meals" ? (
        <div className="meal-planner-meals">
          <div className="meal-planner-page__nav">
            <Link href={`/meal-planner?week=${prevWeekKey}`}>← Prev week</Link>
            <span>
              {dayLabel(mondayKey, 0)} – {dayLabel(sunday, 6)}
            </span>
            <Link href={`/meal-planner?week=${nextWeekKey}`}>Next week →</Link>
          </div>
          <MealPlannerBoard weekDates={weekDates} days={days} weekTotalCost={weekTotalCost} />
        </div>
      ) : null}

      {tab === "shopping" ? (
        <div className="meal-planner-shopping">
          {aggregated.length === 0 ? (
            <p>No ingredients yet — add meals to this week's plan first.</p>
          ) : (
            <div className="meal-planner-cost-breakdown">
              {aggregated.map((item) => {
                const status = itemStatus.get(item.key);
                return (
                  <div
                    key={item.key}
                    className={`meal-planner-cost-breakdown__row${status === "merged" || status === "added" ? " meal-planner-cost-breakdown__row--done" : ""}`}
                  >
                    <span className="meal-planner-cost-breakdown__name">
                      {item.displayName}
                      <span className="meal-planner-cost-breakdown__meta">
                        x{item.occurrences} · {item.store ?? "—"}
                      </span>
                    </span>
                    <span className="meal-planner-cost-breakdown__right">
                      <span>{item.priceable ? formatCost(item.totalCost) : "—"}</span>
                      <button
                        type="button"
                        className="meal-planner-cost-breakdown__add"
                        disabled={status === "pending" || status === "merged" || status === "added"}
                        onClick={() => addToShop(item)}
                        aria-label={`Add ${item.displayName} to Shop list`}
                      >
                        {status === "merged" ? "✓ In Fridge" : status === "added" ? "✓ Added" : "+"}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <Link href="/shop" className="wizard-primary-button">
            Go to Shop
          </Link>
        </div>
      ) : null}

      {tab === "shared" ? (
        <div className="meal-planner-shopping">
          {sharedItems.length === 0 ? (
            <p>Nothing shared across meals this week yet.</p>
          ) : (
            <div className="meal-planner-cost-breakdown">
              {sharedItems.map((item) => (
                <div key={item.key} className="meal-planner-cost-breakdown__row">
                  <span className="meal-planner-cost-breakdown__name">
                    {item.displayName}
                    <span className="meal-planner-cost-breakdown__meta">
                      Used in {item.occurrences} meals · x{item.occurrences} portions · {item.store ?? "—"}
                    </span>
                  </span>
                  <span>{item.priceable ? formatCost(item.totalCost) : "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      </div>
    </div>
  );
}

function OverviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="meal-planner-overview__stat">
      <span className="meal-planner-overview__value">{value}</span>
      <span className="meal-planner-overview__label">{label}</span>
    </div>
  );
}

function sumMacro(days: MealPlanDaySummary[], macro: "protein" | "carbs" | "fat"): number {
  return days.reduce(
    (sum, d) => sum + d.entries.reduce((s, e) => s + (e.recipe[macro] ?? 0), 0),
    0,
  );
}
