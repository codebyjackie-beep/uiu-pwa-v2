"use client";

import { useState } from "react";
import type { MealSlot } from "@uiu/shared";
import { useGuestGate } from "./GuestGate";
import { addRecipeToTodaysPlan } from "../lib/todaysPlan";

const SLOTS: { value: MealSlot; label: string }[] = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" },
];

/**
 * "Add to today's plan" with a meal picker (Jackie 2026-11-05: Recipes "Uses what's in your fridge" cards + recipe
 * detail). Same plan logic as Meal Planner "What should I eat?" (lib/todaysPlan). Guests get the sign-up sheet.
 */
export function AddToTodayButton({ recipeId, defaultSlot = "dinner" }: { recipeId: string; defaultSlot?: MealSlot }) {
  const { requireAccount } = useGuestGate();
  const [slot, setSlot] = useState<MealSlot>(defaultSlot);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    if (!requireAccount()) return;
    setBusy(true);
    setMessage(null);
    const result = await addRecipeToTodaysPlan(recipeId, slot);
    setBusy(false);
    if ("error" in result) setMessage(result.error);
    else setAdded(true);
  }

  return (
    <div className="add-to-today">
      <div className="add-to-today__row">
        <select
          className="tonight-suggestion__select add-to-today__select"
          value={slot}
          onChange={(e) => {
            setSlot(e.target.value as MealSlot);
            setAdded(false);
          }}
          aria-label="Meal"
          disabled={busy}
        >
          {SLOTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button type="button" className="wizard-secondary-button tonight-suggestion__add add-to-today__button" onClick={add} disabled={busy || added}>
          {busy ? "Adding…" : added ? "Added ✓" : "Add to today's plan"}
        </button>
      </div>
      {message ? (
        <p className="tonight-suggestion__status" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
