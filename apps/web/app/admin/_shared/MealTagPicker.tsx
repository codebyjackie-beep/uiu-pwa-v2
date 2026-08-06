"use client";

import { useState } from "react";

/**
 * Keys must stay identical to apps/api/src/services/mealPlanGenerator.ts's
 * MEAL_SLOT_TAGS (meal type) and DIETARY_FILTERS (dietary) — a tag added here
 * has to be recognised by the meal-plan generator / Recipes-page filters
 * (apps/web/app/lib/recipeFilters.ts), which read the same tag strings.
 */
const MEAL_TYPE_KEYS = ["breakfast", "brunch", "lunch", "dinner", "snack", "appetizer"] as const;
const DIETARY_KEYS = ["vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free", "keto", "paleo"] as const;

/** Copied from recipeFilters.ts's DIETARY_PREDICATES — used to detect pre-existing
 * tag variants (e.g. "gluten free" vs "gluten-free") as checked, not just exact key match. */
const DIETARY_PREDICATES: Record<(typeof DIETARY_KEYS)[number], (tagsLower: string[]) => boolean> = {
  vegetarian: (t) => t.some((x) => x.includes("vegetarian")),
  vegan: (t) => t.includes("vegan"),
  pescatarian: (t) => t.some((x) => x.includes("pescatarian")),
  "gluten-free": (t) => t.some((x) => x.includes("gluten free") || x.includes("gluten-free")),
  "dairy-free": (t) => t.some((x) => x.includes("dairy free") || x.includes("dairy-free")),
  keto: (t) => t.some((x) => x.includes("keto")),
  paleo: (t) => t.some((x) => x.includes("paleo") || x.includes("primal")),
};

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export function MealTagPicker({ tags, onChange }: Props) {
  const [freeInput, setFreeInput] = useState("");
  const tagsLower = tags.map((t) => t.toLowerCase());

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
  }
  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function toggleMealType(key: (typeof MEAL_TYPE_KEYS)[number]) {
    if (tagsLower.includes(key)) {
      onChange(tags.filter((t) => t.toLowerCase() !== key));
    } else {
      onChange([...tags, key]);
    }
  }

  function toggleDietary(key: (typeof DIETARY_KEYS)[number]) {
    if (DIETARY_PREDICATES[key](tagsLower)) {
      onChange(tags.filter((t) => !DIETARY_PREDICATES[key]([t.toLowerCase()])));
    } else {
      onChange([...tags, key]);
    }
  }

  const mealTypeKeySet: readonly string[] = MEAL_TYPE_KEYS;
  const freeTags = tags.filter((t) => {
    const low = t.toLowerCase();
    if (mealTypeKeySet.includes(low)) return false;
    if (DIETARY_KEYS.some((k) => DIETARY_PREDICATES[k]([low]))) return false;
    return true;
  });

  return (
    <div className="tag-picker">
      <div className="tag-picker__group">
        <span className="tag-picker__group-label">Meal type</span>
        <div className="admin-drafts-card__chips">
          {MEAL_TYPE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`wizard-chip${tagsLower.includes(k) ? " wizard-chip--selected" : ""}`}
              onClick={() => toggleMealType(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="tag-picker__group">
        <span className="tag-picker__group-label">Dietary</span>
        <div className="admin-drafts-card__chips">
          {DIETARY_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`wizard-chip${DIETARY_PREDICATES[k](tagsLower) ? " wizard-chip--selected" : ""}`}
              onClick={() => toggleDietary(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="tag-picker__group">
        <span className="tag-picker__group-label">其他 tag（cuisine/食材/季節等）</span>
        <div className="admin-drafts-card__chips">
          {freeTags.map((t) => (
            <button key={t} type="button" className="wizard-chip wizard-chip--selected" onClick={() => removeTag(t)}>
              {t} ✕
            </button>
          ))}
        </div>
        <div className="admin-drafts-tag-add">
          <input
            type="text"
            placeholder="加 tag 之後按 Enter"
            value={freeInput}
            onChange={(e) => setFreeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(freeInput);
                setFreeInput("");
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
