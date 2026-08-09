"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiResponse, MealPlanSetSummary } from "@uiu/shared";
import { MEAL_PLAN_SET_LIMIT } from "@uiu/shared";
import { TonightSuggestion } from "./TonightSuggestion";
import { PlanDetail } from "./PlanDetail";

function formatCost(value: number): string {
  return value > 0 ? `£${value.toFixed(2)}` : "£0.00";
}

interface Props {
  initialSets: MealPlanSetSummary[];
}

/** HANDOFF_meal-planner-multi-plan-library.md §3 — up to MEAL_PLAN_SET_LIMIT (4)
 * Plan cards in a grid, each with Activate/Details/Delete. Replaces the single
 * build-card + week-board model from HANDOFF_meal-planner-plan-v2.md. */
export function MealPlannerView({ initialSets }: Props) {
  const [sets, setSets] = useState<MealPlanSetSummary[]>(initialSets);
  const [detailPlanId, setDetailPlanId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  async function refetchSets() {
    const res = await fetch("/api/meal-plan-sets");
    const parsed = (await res.json()) as ApiResponse<MealPlanSetSummary[]>;
    if (parsed.ok) setSets(parsed.data);
  }

  async function buildPlan() {
    setCreating(true);
    setLimitMessage(null);
    try {
      const res = await fetch("/api/meal-plan-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const parsed = (await res.json()) as ApiResponse<MealPlanSetSummary>;
      if (parsed.ok) {
        setSets((prev) => [...prev, parsed.data]);
        setDetailPlanId(parsed.data._id);
      } else if (parsed.error.code === "plan_limit_reached") {
        setLimitMessage(parsed.error.message);
      }
    } finally {
      setCreating(false);
    }
  }

  async function activatePlan(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/meal-plan-sets/${id}/activate`, { method: "POST" });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) await refetchSets();
    } finally {
      setBusyId(null);
    }
  }

  async function deletePlan(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This removes all its meals too.`)) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/meal-plan-sets/${id}`, { method: "DELETE" });
      const parsed = (await res.json()) as ApiResponse<unknown>;
      if (parsed.ok) {
        setSets((prev) => prev.filter((s) => s._id !== id));
        if (detailPlanId === id) setDetailPlanId(null);
      }
    } finally {
      setBusyId(null);
    }
  }

  const atLimit = sets.length >= MEAL_PLAN_SET_LIMIT;

  return (
    <div className="meal-planner-cards">
      <div className="meal-planner-plan-grid">
        {sets.map((set) => (
          <div key={set._id} className="home-summary-card meal-planner-plan-card">
            <div className="meal-planner-plan-card__header">
              <h3 className="meal-planner-plan-card__name">{set.name}</h3>
              {set.isActive ? <span className="meal-planner-plan-card__badge">Active</span> : null}
            </div>

            <div className="meal-planner-stat-row">
              <div className="meal-planner-stat-row__stat">
                <span className="meal-planner-stat-row__value">{formatCost(set.weekTotalCost)}</span>
                <span className="meal-planner-stat-row__label">Cost</span>
              </div>
              <div className="meal-planner-stat-row__stat">
                <span className="meal-planner-stat-row__value">{set.weekTotalMeals}</span>
                <span className="meal-planner-stat-row__label">Meals</span>
              </div>
              <div className="meal-planner-stat-row__stat">
                <span className="meal-planner-stat-row__value">{formatCost(set.weekTotalCost / 7)}</span>
                <span className="meal-planner-stat-row__label">£/day</span>
              </div>
              <div className="meal-planner-stat-row__stat">
                <span className="meal-planner-stat-row__value">{Math.round(set.weekTotalCalories / 7)}</span>
                <span className="meal-planner-stat-row__label">cal/day</span>
              </div>
            </div>

            {set.weekTotalMeals > 0 ? (
              <div className="meal-planner-nutrition">
                <div className="meal-planner-nutrition__chip meal-planner-nutrition__chip--protein">
                  <span className="meal-planner-nutrition__value">{Math.round(set.weekTotalProtein)}g</span>
                  <span className="meal-planner-nutrition__label">Protein</span>
                </div>
                <div className="meal-planner-nutrition__chip meal-planner-nutrition__chip--carbs">
                  <span className="meal-planner-nutrition__value">{Math.round(set.weekTotalCarbs)}g</span>
                  <span className="meal-planner-nutrition__label">Carbs</span>
                </div>
                <div className="meal-planner-nutrition__chip meal-planner-nutrition__chip--fat">
                  <span className="meal-planner-nutrition__value">{Math.round(set.weekTotalFat)}g</span>
                  <span className="meal-planner-nutrition__label">Fat</span>
                </div>
              </div>
            ) : (
              <p className="meal-planner-plan-card__empty">No meals yet.</p>
            )}

            <div className="meal-planner-plan-card__actions">
              {/* Kept mounted (never removed from the DOM) once a plan is active, just
                  visually hidden — an unmount here would shift Details/Delete left into
                  this slot, and a user double-clicking the old Activate spot could land
                  on the now-shifted Delete button. See summaries/2026-08-09_meal-planner-activate-delete-misclick-fix.md. */}
              <button
                type="button"
                className="wizard-primary-button"
                disabled={busyId === set._id}
                onClick={() => activatePlan(set._id)}
                style={set.isActive ? { visibility: "hidden", pointerEvents: "none" } : undefined}
                aria-hidden={set.isActive}
                tabIndex={set.isActive ? -1 : undefined}
              >
                Activate
              </button>
              <button type="button" className="wizard-secondary-button" onClick={() => setDetailPlanId(set._id)}>
                Details
              </button>
              <button
                type="button"
                className="meal-planner-plan-card__delete"
                disabled={busyId === set._id}
                onClick={() => deletePlan(set._id, set.name)}
                aria-label={`Delete ${set.name}`}
                title="Delete plan"
              >
                🗑
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="meal-planner-build-card__actions">
        <button type="button" className="wizard-primary-button" disabled={creating || atLimit} onClick={buildPlan}>
          {creating ? "Building…" : "Build a plan for me"}
        </button>
        <Link href="/meal-planner/generate" className="wizard-secondary-button">
          Generate with AI
        </Link>
      </div>
      {atLimit ? (
        <p className="meal-planner-plan-card__empty">
          You&apos;ve got {MEAL_PLAN_SET_LIMIT} plans already — delete one before building another.
        </p>
      ) : null}
      {limitMessage ? <p className="meal-planner-plan-card__empty">{limitMessage}</p> : null}

      <TonightSuggestion />

      {detailPlanId ? (
        <div className="meal-planner-modal-overlay" onClick={() => setDetailPlanId(null)}>
          <div
            className="meal-planner-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <PlanDetail planId={detailPlanId} onBack={() => setDetailPlanId(null)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
