"use client";

import { useState } from "react";
import Link from "next/link";
import type { MealPlanDaySummary } from "@uiu/shared";
import { dayLabel } from "../lib/dates";
import { MealPlannerBoard } from "./MealPlannerBoard";

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

type Tab = "overview" | "meals" | "shopping";

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

  const totalProtein = sumMacro(days, "protein");
  const totalCarbs = sumMacro(days, "carbs");
  const totalFat = sumMacro(days, "fat");
  const totalCookMinutes = days.reduce(
    (sum, d) => sum + d.entries.reduce((s, e) => s + e.recipe.prepTimeMinutes + e.recipe.cookTimeMinutes, 0),
    0,
  );

  return (
    <div className="meal-planner-board-view">
      <button type="button" className="meal-planner-back" onClick={onBack}>
        ← Back to plans
      </button>

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
          <p>
            Your shopping list is generated from your Fridge, not from this plan directly. Check what you
            need to restock and compare prices in the Shop tab.
          </p>
          <Link href="/shop" className="wizard-primary-button">
            Go to Shop
          </Link>
        </div>
      ) : null}
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
