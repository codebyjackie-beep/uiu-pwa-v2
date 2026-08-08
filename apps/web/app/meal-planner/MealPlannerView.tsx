"use client";

import { useState } from "react";
import Link from "next/link";
import type { MealPlanDaySummary } from "@uiu/shared";
import { TonightSuggestion } from "./TonightSuggestion";
import { PlanDetail } from "./PlanDetail";

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
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
}

/** HANDOFF_meal-planner-plan-v2.md §1 — the plan card shows pill badges +
 * a TOTAL COST/MEALS/ITEMS stat row; "Manage" expands into PlanDetail's
 * Overview/Meals/Shopping tabs. No Shared tab, no multi-plan library, no
 * Pause icon (explicitly out of scope). */
export function MealPlannerView({
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
}: Props) {
  const [view, setView] = useState<"cards" | "detail">("cards");

  if (view === "detail") {
    return (
      <PlanDetail
        weekDates={weekDates}
        days={days}
        weekTotalCost={weekTotalCost}
        weekTotalCalories={weekTotalCalories}
        mealsCount={mealsCount}
        itemsCount={itemsCount}
        mondayKey={mondayKey}
        sunday={sunday}
        prevWeekKey={prevWeekKey}
        nextWeekKey={nextWeekKey}
        onBack={() => setView("cards")}
      />
    );
  }

  return (
    <div className="meal-planner-cards">
      <div className="meal-planner-build-card">
        <div className="meal-planner-pills">
          <span className="meal-planner-pill">7 Days</span>
          <span className="meal-planner-pill">{formatCost(weekTotalCost / 7)}/day</span>
          <span className="meal-planner-pill">{Math.round(weekTotalCalories / 7)} cal/day</span>
        </div>

        <div className="meal-planner-stat-row">
          <div className="meal-planner-stat-row__stat">
            <span className="meal-planner-stat-row__value">{formatCost(weekTotalCost)}</span>
            <span className="meal-planner-stat-row__label">Total cost</span>
          </div>
          <div className="meal-planner-stat-row__stat">
            <span className="meal-planner-stat-row__value">{mealsCount}</span>
            <span className="meal-planner-stat-row__label">Meals</span>
          </div>
          <div className="meal-planner-stat-row__stat">
            <span className="meal-planner-stat-row__value">{itemsCount}</span>
            <span className="meal-planner-stat-row__label">Items</span>
          </div>
        </div>

        <div className="meal-planner-build-card__actions">
          <Link href="/meal-planner/generate" className="wizard-primary-button">
            Build a plan for me
          </Link>
          <button type="button" className="wizard-secondary-button" onClick={() => setView("detail")}>
            Manage
          </button>
        </div>
      </div>

      <TonightSuggestion />
    </div>
  );
}
