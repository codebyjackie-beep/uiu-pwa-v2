import Link from "next/link";
import type { RecipeListPage } from "@uiu/shared";
import { apiGet } from "../lib/api";
import { mealTypeBadge } from "../lib/recipeDisplay";

export const metadata = { title: "Recipes · UseItUp" };

function formatPrice(cost: RecipeListPage["items"][number]["cost"]) {
  if (!cost || cost.basket <= 0) return null;
  return `£${cost.basket.toFixed(2)}`;
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;
  const limit = 20;

  const res = await apiGet<RecipeListPage>(`/api/recipes?page=${page}&limit=${limit}`);

  if (!res.ok) {
    return (
      <div className="recipes-page">
        <div className="recipes-page__header">
          <h1>Recipes</h1>
          <p>Couldn&apos;t load recipes right now — please try again shortly.</p>
        </div>
      </div>
    );
  }

  const { items, total } = res.data;
  const hasPrev = page > 1;
  const hasNext = page * limit < total;

  return (
    <div className="recipes-page">
      <div className="recipes-page__header">
        <h1>Recipes</h1>
        <p>{total} recipes</p>
      </div>

      <div className="recipe-list">
        {items.map((recipe) => {
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
      </div>

      <div className="recipes-page__pagination">
        {hasPrev ? <Link href={`/recipes?page=${page - 1}`}>← Prev</Link> : <span aria-disabled="true">← Prev</span>}
        <span>Page {page}</span>
        {hasNext ? <Link href={`/recipes?page=${page + 1}`}>Next →</Link> : <span aria-disabled="true">Next →</span>}
      </div>
    </div>
  );
}
