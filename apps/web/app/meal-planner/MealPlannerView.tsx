"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { TonightSuggestion } from "./TonightSuggestion";

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

interface Props {
  weekTotalCost: number;
  weekTotalCalories: number;
  board: ReactNode;
}

/** HANDOFF_meal-planner-card-layout-and-fixes.md §1 — Meal Planner defaults to
 * two cards (build-a-plan + tonight-suggestion); "View plan" switches to the
 * existing nav+board, passed in as a pre-rendered server prop so the board's
 * server-side data fetching stays in page.tsx. */
export function MealPlannerView({ weekTotalCost, weekTotalCalories, board }: Props) {
  const [view, setView] = useState<"cards" | "board">("cards");

  if (view === "board") {
    return (
      <div className="meal-planner-board-view">
        <button type="button" className="meal-planner-back" onClick={() => setView("cards")}>
          ← Back to plans
        </button>
        {board}
      </div>
    );
  }

  return (
    <div className="meal-planner-cards">
      <div className="meal-planner-build-card">
        <div className="meal-planner-summary">
          <div className="meal-planner-summary__stat">
            <span className="meal-planner-summary__value">{formatCost(weekTotalCost)}</span>
            <span className="meal-planner-summary__label">Week cost</span>
            <span className="meal-planner-summary__subtitle">{formatCost(weekTotalCost / 7)} average per day</span>
          </div>
          <div className="meal-planner-summary__stat">
            <span className="meal-planner-summary__value">{Math.round(weekTotalCalories)}</span>
            <span className="meal-planner-summary__label">Week calories</span>
            <span className="meal-planner-summary__subtitle">{Math.round(weekTotalCalories / 7)} average per day</span>
          </div>
        </div>
        <div className="meal-planner-build-card__actions">
          <Link href="/meal-planner/generate" className="wizard-primary-button">
            Build a plan for me
          </Link>
          <button type="button" className="wizard-secondary-button" onClick={() => setView("board")}>
            View plan
          </button>
        </div>
      </div>

      <TonightSuggestion />
    </div>
  );
}
