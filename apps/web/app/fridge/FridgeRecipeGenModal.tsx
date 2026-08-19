"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiResponse, FridgeStockItem } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

interface GeneratedRecipe {
  title: string;
  description: string;
  ingredients: { name: string; quantity: number; unit: string }[];
  steps: string[];
  tags: string[];
  mealType?: string;
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
}

type Step = "select" | "loading" | "review" | "saved";

interface FridgeRecipeGenModalProps {
  items: FridgeStockItem[];
  onClose: () => void;
}

export function FridgeRecipeGenModal({ items, onClose }: FridgeRecipeGenModalProps) {
  const [step, setStep] = useState<Step>("select");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((i) => i._id)));
  const [error, setError] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<GeneratedRecipe | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    const ingredientNames = items.filter((i) => checked.has(i._id)).map((i) => i.ingredientName);
    if (ingredientNames.length === 0) return;
    setError(null);
    setStep("loading");
    const { parsed } = await fetchJson<GeneratedRecipe>("/api/recipes/generate-from-fridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ingredientNames }),
    });
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Generation failed, please try again.");
      setStep("select");
      return;
    }
    setRecipe(parsed.data);
    setStep("review");
  }

  async function saveRecipe() {
    if (!recipe || saving) return;
    setSaving(true);
    setError(null);
    const { parsed } = await fetchJson<{ recipeId: string }>("/api/recipes/save-fridge-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recipe),
    });
    setSaving(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Save failed, please try again.");
      return;
    }
    setSavedRecipeId(parsed.data.recipeId);
    setStep("saved");
  }

  return (
    <div className="meal-planner-modal-overlay" onClick={onClose}>
      <div className="meal-planner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meal-planner-modal__header">
          <h3 className="meal-planner-modal__title">Cook with what I have</h3>
          <button type="button" className="meal-planner-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="meal-planner-modal__body recipe-import-form">
          {step === "select" ? (
            <>
              <p className="admin-drafts-page__sub">
                Pick which fridge items to use — AI will generate a new recipe built around them.
              </p>
              {items.length === 0 ? (
                <p className="admin-drafts-page__sub">Your fridge is empty — add some items first.</p>
              ) : (
                <div className="fridge-genmodal__list">
                  {items.map((item) => (
                    <label key={item._id} className="fridge-genmodal__row">
                      <input type="checkbox" checked={checked.has(item._id)} onChange={() => toggle(item._id)} />
                      {item.ingredientName}
                    </label>
                  ))}
                </div>
              )}
              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button type="button" className="wizard-primary-button" disabled={checked.size === 0} onClick={() => void generate()}>
                Generate
              </button>
            </>
          ) : null}

          {step === "loading" ? <p className="admin-drafts-page__sub">Generating a recipe…</p> : null}

          {step === "review" && recipe ? (
            <>
              <h4>{recipe.title}</h4>
              {recipe.description ? <p className="admin-drafts-page__sub">{recipe.description}</p> : null}
              <p className="admin-drafts-page__sub">
                {recipe.mealType ? `${recipe.mealType[0].toUpperCase()}${recipe.mealType.slice(1)} · ` : ""}
                Serves {recipe.servings} · Prep {recipe.prepTimeMinutes}m · Cook {recipe.cookTimeMinutes}m
              </p>

              <p className="admin-drafts-page__sub">Ingredients</p>
              <ul>
                {recipe.ingredients.map((ing, i) => (
                  <li key={i}>
                    {ing.quantity} {ing.unit} {ing.name}
                  </li>
                ))}
              </ul>

              <p className="admin-drafts-page__sub">Steps</p>
              <ol>
                {recipe.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>

              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <div className="fridge-scan-review__actions">
                <button type="button" className="wizard-primary-button" disabled={saving} onClick={() => void saveRecipe()}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button type="button" disabled={saving} onClick={onClose}>
                  Discard
                </button>
              </div>
            </>
          ) : null}

          {step === "saved" ? (
            <>
              <p className="admin-drafts-page__sub">Saved! Added to your recipes.</p>
              <div className="fridge-scan-review__actions">
                {savedRecipeId ? (
                  <Link href={`/recipes/${savedRecipeId}`} className="wizard-primary-button" onClick={onClose}>
                    View recipe
                  </Link>
                ) : null}
                <button type="button" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
