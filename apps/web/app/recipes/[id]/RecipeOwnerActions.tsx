"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiResponse, RecipeDetail } from "@uiu/shared";

/**
 * Jackie 2026-11-07 — Edit / Delete on a recipe the user saved themselves (only rendered for non-public recipes,
 * which the API only returns to their owner). Same fields as the manual "Add a recipe" form (SaveFromLinkModal.tsx);
 * Save calls PUT /api/recipe-import/:id, which re-prices the recipe; Delete calls DELETE (refused while the recipe is
 * in one of the user's meal plans).
 */

const MEAL_TYPE_OPTIONS = ["breakfast", "lunch", "dinner", "snack", "dessert"];

type IngredientRow = { name: string; quantity: string; unit: string };

const numToField = (n: number | undefined) => (n ? String(n) : "");

export function RecipeOwnerActions({ recipe }: { recipe: RecipeDetail }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(recipe.title);
  const [description, setDescription] = useState(recipe.description ?? "");
  const [ingredients, setIngredients] = useState<IngredientRow[]>(() =>
    recipe.ingredients.length
      ? recipe.ingredients.map((i) => ({ name: i.name, quantity: numToField(i.quantity), unit: i.unit ?? "" }))
      : [{ name: "", quantity: "", unit: "" }],
  );
  const [steps, setSteps] = useState<string[]>(() => (recipe.steps.length ? [...recipe.steps] : [""]));
  const [tags, setTags] = useState((recipe.tags ?? []).join(", "));
  const [mealType, setMealType] = useState(recipe.mealType ?? "");
  const [servings, setServings] = useState(numToField(recipe.servings));
  const [prepTime, setPrepTime] = useState(numToField(recipe.prepTimeMinutes));
  const [cookTime, setCookTime] = useState(numToField(recipe.cookTimeMinutes));

  const valid = title.trim() !== "" && ingredients.some((r) => r.name.trim() !== "") && steps.some((s) => s.trim() !== "");

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/recipe-import/${recipe._id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        ingredients: ingredients
          .filter((r) => r.name.trim() !== "")
          .map((r) => ({ name: r.name.trim(), quantity: Number(r.quantity) || 0, unit: r.unit.trim() })),
        steps: steps.map((s) => s.trim()).filter((s) => s !== ""),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t !== ""),
        mealType: mealType || undefined,
        servings: servings ? Number(servings) : undefined,
        prepTimeMinutes: prepTime ? Number(prepTime) : 0,
        cookTimeMinutes: cookTime ? Number(cookTime) : 0,
      }),
    });
    const parsed = (await res.json().catch(() => null)) as ApiResponse<{ recipeId: string }> | null;
    setBusy(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function remove() {
    if (busy) return;
    if (!window.confirm(`Delete "${recipe.title}"? This can't be undone.`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/recipe-import/${recipe._id}`, { method: "DELETE" });
    const parsed = (await res.json().catch(() => null)) as ApiResponse<{ deleted: true }> | null;
    setBusy(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    router.push("/recipes");
    router.refresh();
  }

  return (
    <>
      <div className="recipe-owner-actions">
        <span className="recipe-owner-actions__note">Only you can see this recipe</span>
        <button type="button" className="chip" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="chip recipe-owner-actions__delete" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>
      {error && !editing ? <p className="admin-drafts-error">{error}</p> : null}

      {editing ? (
        <div className="meal-planner-modal-overlay" onClick={() => !busy && setEditing(false)}>
          <div className="meal-planner-modal" onClick={(e) => e.stopPropagation()}>
            <div className="meal-planner-modal__header">
              <h3 className="meal-planner-modal__title">Edit recipe</h3>
              <button type="button" className="meal-planner-modal__close" onClick={() => setEditing(false)} aria-label="Close" disabled={busy}>
                ×
              </button>
            </div>
            <div className="meal-planner-modal__body recipe-import-form">
              <p className="admin-drafts-page__sub">Price and nutrition are worked out again when you save.</p>
              <input type="text" placeholder="Title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
              <textarea rows={2} placeholder="Description (optional)" value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} />

              <p className="admin-drafts-page__sub">Ingredients</p>
              {ingredients.map((row, i) => (
                <div key={i} className="manual-recipe-form__row">
                  {(["name", "quantity", "unit"] as const).map((field) => (
                    <input
                      key={field}
                      type="text"
                      placeholder={field === "name" ? "Name" : field === "quantity" ? "Qty" : "Unit"}
                      value={row[field]}
                      disabled={busy}
                      onChange={(e) => {
                        const next = [...ingredients];
                        next[i] = { ...next[i], [field]: e.target.value };
                        setIngredients(next);
                      }}
                    />
                  ))}
                  {ingredients.length > 1 ? (
                    <button
                      type="button"
                      className="manual-recipe-form__remove"
                      disabled={busy}
                      onClick={() => setIngredients(ingredients.filter((_, idx) => idx !== i))}
                      aria-label="Remove ingredient"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="chip" disabled={busy} onClick={() => setIngredients([...ingredients, { name: "", quantity: "", unit: "" }])}>
                + Add ingredient
              </button>

              <p className="admin-drafts-page__sub">Steps</p>
              {steps.map((s, i) => (
                <div key={i} className="manual-recipe-form__row">
                  <textarea
                    rows={2}
                    placeholder={`Step ${i + 1}`}
                    value={s}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...steps];
                      next[i] = e.target.value;
                      setSteps(next);
                    }}
                  />
                  {steps.length > 1 ? (
                    <button
                      type="button"
                      className="manual-recipe-form__remove"
                      disabled={busy}
                      onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}
                      aria-label="Remove step"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="chip" disabled={busy} onClick={() => setSteps([...steps, ""])}>
                + Add step
              </button>

              <input type="text" placeholder="Tags, comma separated (optional)" value={tags} disabled={busy} onChange={(e) => setTags(e.target.value)} />
              <select value={mealType} disabled={busy} onChange={(e) => setMealType(e.target.value)}>
                <option value="">Meal type (optional)</option>
                {MEAL_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt[0].toUpperCase() + opt.slice(1)}
                  </option>
                ))}
              </select>
              <p className="admin-drafts-page__sub">Servings</p>
              <input type="number" aria-label="Servings" placeholder="Servings (default 2)" value={servings} disabled={busy} onChange={(e) => setServings(e.target.value)} />
              <p className="admin-drafts-page__sub">Prep (min)</p>
              <input type="number" aria-label="Prep time in minutes" value={prepTime} disabled={busy} onChange={(e) => setPrepTime(e.target.value)} />
              <p className="admin-drafts-page__sub">Cook (min)</p>
              <input type="number" aria-label="Cook time in minutes" value={cookTime} disabled={busy} onChange={(e) => setCookTime(e.target.value)} />

              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button type="button" className="wizard-primary-button" disabled={busy || !valid} onClick={() => void save()}>
                {busy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
