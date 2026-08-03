"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { RecipeListItem } from "@uiu/shared";
import { mealTypeBadge } from "../lib/recipeDisplay";
import {
  classifyMealTypes,
  DIETARY_PREDICATES,
  PRICE_BUCKETS,
  type FilterDietary,
  type FilterMealType,
} from "../lib/recipeFilters";

const MEAL_TYPE_OPTIONS: { key: FilterMealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
  { key: "dessert", label: "Dessert" },
];

const DIETARY_OPTIONS: { key: FilterDietary; label: string }[] = [
  { key: "vegetarian", label: "Vegetarian" },
  { key: "vegan", label: "Vegan" },
  { key: "pescatarian", label: "Pescatarian" },
  { key: "gluten-free", label: "Gluten-Free" },
  { key: "dairy-free", label: "Dairy-Free" },
  { key: "keto", label: "Keto" },
  { key: "paleo", label: "Paleo" },
];

function formatPrice(cost: RecipeListItem["cost"]) {
  if (!cost || cost.basket <= 0) return null;
  return `£${cost.basket.toFixed(2)}`;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

const PAGE_SIZE = 20;

export default function RecipesBrowser({ items }: { items: RecipeListItem[] }) {
  const [search, setSearch] = useState("");
  const [mealTypes, setMealTypes] = useState<FilterMealType[]>([]);
  const [dietary, setDietary] = useState<FilterDietary[]>([]);
  const [priceBuckets, setPriceBuckets] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const hasActiveFilters = search.trim() !== "" || mealTypes.length > 0 || dietary.length > 0 || priceBuckets.length > 0;

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return items.filter((recipe) => {
      if (searchLower && !recipe.title.toLowerCase().includes(searchLower)) return false;

      if (mealTypes.length > 0) {
        const recipeTypes = classifyMealTypes(recipe);
        if (!mealTypes.some((t) => recipeTypes.has(t))) return false;
      }

      if (dietary.length > 0) {
        const tagsLower = recipe.tags.map((t) => t.toLowerCase());
        if (!dietary.some((d) => DIETARY_PREDICATES[d](tagsLower))) return false;
      }

      if (priceBuckets.length > 0) {
        if (!recipe.cost || recipe.cost.basket <= 0) return false;
        const buckets = PRICE_BUCKETS.filter((b) => priceBuckets.includes(b.key));
        if (!buckets.some((b) => b.test(recipe.cost!.basket))) return false;
      }

      return true;
    });
  }, [items, search, mealTypes, dietary, priceBuckets]);

  // No filters active: keep the pre-filter UX unchanged (20/page, Prev/Next) by paging the
  // full unfiltered list client-side. Any filter active: drop paging, show every match plus
  // a "N recipes match" count instead (acceptance criteria, HANDOFF_recipes-page-filters.md).
  const hasNext = hasActiveFilters ? false : page * PAGE_SIZE < items.length;
  const hasPrev = hasActiveFilters ? false : page > 1;
  const visible = hasActiveFilters ? filtered : items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setPage(1);
    setter(value);
  }

  function clearAll() {
    setSearch("");
    setMealTypes([]);
    setDietary([]);
    setPriceBuckets([]);
    setPage(1);
  }

  return (
    <div>
      <div className="recipes-filters">
        <input
          type="text"
          className="recipes-filters__search"
          placeholder="Search recipes by name…"
          value={search}
          onChange={(e) => updateFilter(setSearch, e.target.value)}
        />

        <div className="recipes-filters__group">
          <span className="recipes-filters__group-label">Meal type</span>
          <div className="recipes-filters__chips">
            {MEAL_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`chip${mealTypes.includes(opt.key) ? " chip--active" : ""}`}
                onClick={() => updateFilter(setMealTypes, toggle(mealTypes, opt.key))}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="recipes-filters__group">
          <span className="recipes-filters__group-label">Dietary</span>
          <div className="recipes-filters__chips">
            {DIETARY_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`chip${dietary.includes(opt.key) ? " chip--active" : ""}`}
                onClick={() => updateFilter(setDietary, toggle(dietary, opt.key))}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="recipes-filters__group">
          <span className="recipes-filters__group-label">Price</span>
          <div className="recipes-filters__chips">
            {PRICE_BUCKETS.map((bucket) => (
              <button
                key={bucket.key}
                type="button"
                className={`chip${priceBuckets.includes(bucket.key) ? " chip--active" : ""}`}
                onClick={() => updateFilter(setPriceBuckets, toggle(priceBuckets, bucket.key))}
              >
                {bucket.label}
              </button>
            ))}
          </div>
        </div>

        {hasActiveFilters ? (
          <div className="recipes-filters__status">
            <span>{filtered.length} recipes match</span>
            <button type="button" className="recipes-filters__clear" onClick={clearAll}>
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div className="recipe-list">
        {visible.map((recipe) => {
          const mealBadge = mealTypeBadge(recipe);
          return (
            <Link key={recipe._id} href={`/recipes/${recipe._id}`} className="recipe-card">
              {recipe.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="recipe-card__image" src={recipe.imageUrl} alt="" />
              ) : (
                <div className="recipe-card__image" />
              )}
              <div className="recipe-card__body">
                <div className="recipe-card__header">
                  {mealBadge ? <span className="badge">{mealBadge}</span> : <span />}
                  {formatPrice(recipe.cost) ? (
                    <span className="recipe-card__price">{formatPrice(recipe.cost)}</span>
                  ) : (
                    <span className="recipe-card__price recipe-card__price--pending">calculating…</span>
                  )}
                </div>
                <p className="recipe-card__title">{recipe.title}</p>
                <div className="recipe-card__macros">
                  <span>{Math.round(recipe.nutrition.calories)} cal</span>
                  <span>{recipe.ingredientCount} items</span>
                </div>
              </div>
            </Link>
          );
        })}

        {visible.length === 0 ? <p className="recipes-filters__empty">No recipes match these filters.</p> : null}
      </div>

      {!hasActiveFilters ? (
        <div className="recipes-page__pagination">
          {hasPrev ? (
            <button type="button" onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
          ) : (
            <span aria-disabled="true">← Prev</span>
          )}
          <span>Page {page}</span>
          {hasNext ? (
            <button type="button" onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          ) : (
            <span aria-disabled="true">Next →</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
