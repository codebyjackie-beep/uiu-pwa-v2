"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ApiResponse, ShoppingListCheckResult, ShoppingListFromIngredientResponse } from "@uiu/shared";
import { useGuestGate } from "../../components/GuestGate";

export interface AddToListIngredient {
  /** Display name, also what gets written to the list. */
  name: string;
  canonicalName?: string;
}

type Flag = "fridge" | "pantry" | "list";

interface Row {
  ingredient: AddToListIngredient;
  flag: Flag | null;
  /** Part 0b — the fridge item that matched, shown as "In your fridge (Garlic)". */
  fridgeMatch?: string;
  checked: boolean;
}

const FLAG_LABEL: Record<Flag, string> = {
  fridge: "In your fridge",
  pantry: "Pantry",
  list: "Already on list",
};

/** Priority when an ingredient matches more than one: already queued beats fridge beats pantry. */
function flagFor(r: ShoppingListCheckResult | undefined): Flag | null {
  if (!r) return null;
  if (r.onList) return "list";
  if (r.inFridge) return "fridge";
  if (r.pantry) return "pantry";
  return null;
}

/**
 * cc_prompt_guest_browse.md Part D2 — the "Add to shopping list" bottom sheet. Controlled: the caller owns
 * `open` (Recipe detail's button, the Meal Planner's "Create shopping list"). Everything is ticked except what the
 * user already has (fridge / pantry) or has already queued. Adding calls from-ingredient one by one, no quantities.
 * The toast lives here so it outlives the sheet closing.
 */
export function AddToListSheet({ open, ingredients, onClose }: { open: boolean; ingredients: AddToListIngredient[]; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const ingredientsRef = useRef(ingredients);
  ingredientsRef.current = ingredients;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setRows(null);
    (async () => {
      const list = ingredientsRef.current;
      let results: ShoppingListCheckResult[] = [];
      try {
        const res = await fetch("/api/shopping-list/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ingredients: list.map((i) => ({ ingredientName: i.name, canonicalName: i.canonicalName })) }),
        });
        const parsed = (await res.json().catch(() => null)) as ApiResponse<{ results: ShoppingListCheckResult[] }> | null;
        if (parsed?.ok) results = parsed.data.results;
      } catch {
        // No flags — fall back to everything ticked; from-ingredient still dedupes server-side.
      }
      if (cancelled) return;
      setRows(
        list.map((ingredient, i) => {
          const flag = flagFor(results[i]);
          return { ingredient, flag, fridgeMatch: flag === "fridge" ? results[i]?.fridgeMatch : undefined, checked: flag === null };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleRow(index: number) {
    setRows((prev) => prev && prev.map((r, i) => (i === index ? { ...r, checked: !r.checked } : r)));
  }

  const selected = rows ? rows.filter((r) => r.checked) : [];

  async function addSelected() {
    if (adding || selected.length === 0) return;
    setAdding(true);
    setError(null);
    let added = 0;
    let failed = 0;
    for (const row of selected) {
      try {
        const res = await fetch("/api/shopping-list/from-ingredient", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ingredientName: row.ingredient.name, canonicalName: row.ingredient.canonicalName }),
        });
        const parsed = (await res.json().catch(() => null)) as ApiResponse<ShoppingListFromIngredientResponse> | null;
        if (!parsed?.ok) failed += 1;
        else if (!parsed.data.merged) added += 1;
      } catch {
        failed += 1;
      }
    }
    setAdding(false);
    if (failed > 0 && added === 0) {
      setError("Couldn't add to your shopping list. Please try again.");
      return;
    }
    onClose();
    setToast(`${added} item${added === 1 ? "" : "s"} added to your shopping list${failed > 0 ? ` (${failed} failed)` : ""}`);
  }

  return (
    <>
      {open ? (
        <div className="meal-planner-modal-overlay" onClick={() => !adding && onClose()}>
          <div className="meal-planner-modal add-to-list-sheet" role="dialog" aria-modal="true" aria-labelledby="add-to-list-title" onClick={(e) => e.stopPropagation()}>
            <div className="meal-planner-modal__header">
              <h3 id="add-to-list-title" className="meal-planner-modal__title">
                Add to shopping list
              </h3>
              <button type="button" className="meal-planner-modal__close" aria-label="Close" onClick={onClose} disabled={adding}>
                ×
              </button>
            </div>
            <div className="meal-planner-modal__body">
              {rows === null ? (
                <p className="add-to-list-sheet__status">Checking your fridge and list…</p>
              ) : (
                <ul className="add-to-list-sheet__list">
                  {rows.map((row, i) => (
                    <li key={i}>
                      <label className="add-to-list-sheet__row">
                        <input type="checkbox" checked={row.checked} disabled={adding} onChange={() => toggleRow(i)} />
                        <span className="add-to-list-sheet__name">{row.ingredient.name}</span>
                        {row.flag ? <span className={`add-to-list-sheet__flag add-to-list-sheet__flag--${row.flag}`}>{row.flag === "fridge" && row.fridgeMatch ? `${FLAG_LABEL.fridge} (${row.fridgeMatch})` : FLAG_LABEL[row.flag]}</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {error ? <p className="add-to-list-sheet__error">{error}</p> : null}
              <button type="button" className="wizard-primary-button add-to-list-sheet__submit" disabled={rows === null || adding || selected.length === 0} onClick={() => void addSelected()}>
                {adding ? "Adding…" : `Add ${selected.length} item${selected.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="add-to-list-toast" role="status">
          <span>{toast}</span>
          <Link href="/shop" className="add-to-list-toast__link">
            View list
          </Link>
        </div>
      ) : null}
    </>
  );
}

/** Recipe detail's "Add to shopping list" button beside the Ingredients heading. Guests get the sign-up sheet. */
export function RecipeAddToList({ ingredients }: { ingredients: AddToListIngredient[] }) {
  const { requireAuth } = useGuestGate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="recipe-detail__add-to-list"
        onClick={() => {
          if (requireAuth()) setOpen(true);
        }}
      >
        Add to shopping list
      </button>
      <AddToListSheet open={open} ingredients={ingredients} onClose={() => setOpen(false)} />
    </>
  );
}
