"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ApiResponse, FavouriteRecipe, RecipeListItem } from "@uiu/shared";
import { costPendingLabel, mealTypeBadge } from "../lib/recipeDisplay";
import {
  classifyMealTypes,
  DIETARY_PREDICATES,
  PRICE_BUCKETS,
  type FilterDietary,
  type FilterMealType,
} from "../lib/recipeFilters";
import { SaveFromLinkModal } from "./SaveFromLinkModal";

const RANDOM_BROWSE_SIZE = 10;

/** Fisher-Yates, front-end only (HANDOFF_recipes-page-manual-entry-and-refresh.md §B) —
 * no backend sampling endpoint needed since page.tsx already fetches the full ~250-item set. */
function pickRandom<T>(items: T[], count: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

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

/** prep + cook, cc_prompt_recipe-list-redesign-and-cook-mode.md Part A §1 — 0 means
 * "no time data", not "instant", so the meta row omits it entirely rather than showing "0 min". */
function totalTimeMinutes(recipe: RecipeListItem): number {
  return (recipe.prepTimeMinutes ?? 0) + (recipe.cookTimeMinutes ?? 0);
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function RecipesBrowser({ items }: { items: RecipeListItem[] }) {
  const [search, setSearch] = useState("");
  const [mealTypes, setMealTypes] = useState<FilterMealType[]>([]);
  const [dietary, setDietary] = useState<FilterDietary[]>([]);
  const [priceBuckets, setPriceBuckets] = useState<string[]>([]);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [favouriteIds, setFavouriteIds] = useState<Set<string>>(() => new Set());
  const [saveFromLinkOpen, setSaveFromLinkOpen] = useState(false);
  const [sharePrefill, setSharePrefill] = useState<{ url?: string; text?: string } | null>(null);
  const [randomTen, setRandomTen] = useState<RecipeListItem[]>(() => pickRandom(items, RANDOM_BROWSE_SIZE));
  const [remainingToday, setRemainingToday] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Web Share Target hand-off (HANDOFF_recipe-share-target.md §2) — /recipes/share-target
  // redirects here with ?shareUrl= or ?shareText=; open the modal pre-filled and clean the
  // URL so a page refresh doesn't reopen it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareUrl = params.get("shareUrl");
    const shareText = params.get("shareText");
    if (shareUrl || shareText) {
      setSharePrefill({ url: shareUrl ?? undefined, text: shareText ?? undefined });
      setSaveFromLinkOpen(true);
      params.delete("shareUrl");
      params.delete("shareText");
      const query = params.toString();
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    }
  }, []);

  // Same fetch-on-mount + optimistic toggle pattern as MealPlannerBoard.tsx's favourite
  // heart — independent of Recipe.isFavorite/favoriteCount, see favouriteRecipes.ts header.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/favourite-recipes");
      const parsed = (await res.json().catch(() => null)) as ApiResponse<FavouriteRecipe[]> | null;
      if (!cancelled && parsed?.ok) setFavouriteIds(new Set(parsed.data.map((f) => f.recipeId)));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleFavourite(recipeId: string) {
    const isFav = favouriteIds.has(recipeId);
    setFavouriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
    if (isFav) {
      await fetch(`/api/favourite-recipes/${recipeId}`, { method: "DELETE" });
    } else {
      await fetch("/api/favourite-recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipeId }),
      });
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/recipe-browse/refresh-status")
      .then((r) => r.json())
      .then((parsed: ApiResponse<{ remainingToday: number }>) => {
        if (!cancelled && parsed.ok) setRemainingToday(parsed.data.remainingToday);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function doRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    const res = await fetch("/api/recipe-browse/refresh", { method: "POST" });
    const parsed = (await res.json().catch(() => null)) as ApiResponse<{ remainingToday: number }> | null;
    setRefreshing(false);
    if (!parsed || !parsed.ok) {
      setRefreshError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    setRemainingToday(parsed.data.remainingToday);
    setRandomTen(pickRandom(items, RANDOM_BROWSE_SIZE));
  }

  const hasActiveFilters =
    search.trim() !== "" || mealTypes.length > 0 || dietary.length > 0 || priceBuckets.length > 0 || favouritesOnly;

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return items.filter((recipe) => {
      if (favouritesOnly && !favouriteIds.has(recipe._id)) return false;

      if (searchLower) {
        const titleMatch = recipe.title.toLowerCase().includes(searchLower);
        const tagMatch = recipe.tags.some((t) => t.toLowerCase().includes(searchLower));
        if (!titleMatch && !tagMatch) return false;
      }

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
  }, [items, search, mealTypes, dietary, priceBuckets, favouritesOnly, favouriteIds]);

  // No filters active: random 10 + Refresh (HANDOFF_recipes-page-manual-entry-and-refresh.md
  // §B). Any filter active: unchanged — show every match, no count limit
  // (acceptance criteria, HANDOFF_recipes-page-filters.md, not overridden by §B).
  const visible = hasActiveFilters ? filtered : randomTen;

  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
  }

  function clearAll() {
    setSearch("");
    setMealTypes([]);
    setDietary([]);
    setPriceBuckets([]);
    setFavouritesOnly(false);
  }

  return (
    <div>
      <div className="recipes-page__save-from-link">
        <button type="button" className="wizard-primary-button" onClick={() => setSaveFromLinkOpen(true)}>
          Add a recipe
        </button>
      </div>
      {saveFromLinkOpen ? (
        <SaveFromLinkModal
          onClose={() => {
            setSaveFromLinkOpen(false);
            setSharePrefill(null);
          }}
          initialUrl={sharePrefill?.url}
          initialText={sharePrefill?.text}
        />
      ) : null}

      <div className="recipes-filters">
        <input
          type="text"
          className="recipes-filters__search"
          placeholder="Search recipes by name…"
          value={search}
          onChange={(e) => updateFilter(setSearch, e.target.value)}
        />

        <div className="recipes-filters__group">
          <span className="recipes-filters__group-label">Favourites</span>
          <div className="recipes-filters__chips">
            <button
              type="button"
              className={`chip${favouritesOnly ? " chip--active" : ""}`}
              onClick={() => setFavouritesOnly(!favouritesOnly)}
            >
              ♥ Favourites only
            </button>
          </div>
        </div>

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
          const totalMin = totalTimeMinutes(recipe);
          const isFavourite = favouriteIds.has(recipe._id);
          return (
            <Link key={recipe._id} href={`/recipes/${recipe._id}`} className="recipe-card recipe-card--browse">
              {recipe.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="recipe-card__image" src={recipe.imageUrl} alt="" />
              ) : (
                <div className="recipe-card__image" />
              )}
              <div className="recipe-card__body">
                <div className="recipe-card__header">
                  <p className="recipe-card__title">{recipe.title}</p>
                  {formatPrice(recipe.cost) ? (
                    <span className="recipe-card__price">{formatPrice(recipe.cost)}</span>
                  ) : (
                    <span className="recipe-card__price recipe-card__price--pending">{costPendingLabel(recipe)}</span>
                  )}
                </div>
                {recipe.description ? <p className="recipe-card__description">{recipe.description}</p> : null}
                <div className="recipe-card__meta">
                  {mealBadge ? <span className="badge">{mealBadge}</span> : null}
                  {totalMin > 0 ? <span>⏱ {totalMin} min</span> : null}
                  <span>👥 {recipe.servings}</span>
                </div>
              </div>
              <button
                type="button"
                className={`recipe-card__favourite${isFavourite ? " recipe-card__favourite--active" : ""}`}
                aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
                aria-pressed={isFavourite}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void toggleFavourite(recipe._id);
                }}
              >
                {isFavourite ? "♥" : "♡"}
              </button>
            </Link>
          );
        })}

        {visible.length === 0 ? <p className="recipes-filters__empty">No recipes match these filters.</p> : null}
      </div>

      {!hasActiveFilters ? (
        <div className="recipes-page__pagination">
          <button type="button" disabled={refreshing || remainingToday === 0} onClick={() => void doRefresh()}>
            {refreshing ? "Refreshing…" : "🔀 Refresh"}
          </button>
          <span>
            {refreshError
              ? refreshError
              : remainingToday === 0
                ? "You've used today's 3 refreshes — come back tomorrow"
                : remainingToday === null
                  ? ""
                  : `Refreshes left today: ${remainingToday}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
