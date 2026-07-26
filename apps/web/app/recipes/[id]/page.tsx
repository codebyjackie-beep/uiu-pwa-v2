import type { RecipeDetail, RecipeDetailCostLine } from "@uiu/shared";
import { apiGet } from "../../lib/api";
import {
  dietaryBadges,
  formatIngredientQuantity,
  formatIngredientStorePrice,
  ingredientName,
  mealTypeBadge,
} from "../../lib/recipeDisplay";

function lineFor(recipe: RecipeDetail, ingredient: RecipeDetail["ingredients"][number]): RecipeDetailCostLine | undefined {
  return recipe.cost?.lines.find(
    (l) => l.rawName === ingredient.name && l.quantity === ingredient.quantity && l.rawUnit === ingredient.unit,
  );
}

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await apiGet<RecipeDetail>(`/api/recipes/${id}`);

  if (!res.ok) {
    return (
      <div className="recipe-detail">
        <h1 className="recipe-detail__title">Recipe not found</h1>
      </div>
    );
  }

  const recipe = res.data;
  const mealBadge = mealTypeBadge(recipe);
  const dietBadgeList = dietaryBadges(recipe);
  const totalTime = recipe.cookTimeMinutes + recipe.prepTimeMinutes;

  return (
    <div className="recipe-detail">
      {recipe.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="recipe-detail__image" src={recipe.imageUrl} alt="" />
      ) : (
        <div className="recipe-detail__image" />
      )}

      {mealBadge && (
        <div className="badges" style={{ marginTop: "var(--space)" }}>
          <span className="badge">{mealBadge}</span>
        </div>
      )}
      {dietBadgeList.length > 0 && (
        <div className="badges badges--dietary">
          {dietBadgeList.map((b) => (
            <span key={b} className="badge badge--dietary">
              {b}
            </span>
          ))}
        </div>
      )}

      <h1 className="recipe-detail__title">{recipe.title}</h1>

      <div className="macro-row">
        <span>{Math.round(recipe.nutrition.calories)} kcal</span>
        <span>{totalTime} min</span>
        <span>{recipe.servings} serves</span>
        <span>
          P{Math.round(recipe.nutrition.protein)} · C{Math.round(recipe.nutrition.carbs)} · F{Math.round(recipe.nutrition.fat)}
        </span>
        {recipe.cost && recipe.cost.basket > 0 ? (
          <span className="price-badge">£{recipe.cost.basket.toFixed(2)} total</span>
        ) : (
          <span className="price-badge price-badge--pending">price calculating…</span>
        )}
      </div>

      <h2>Ingredients</h2>
      <ul className="recipe-detail__ingredients">
        {recipe.ingredients.map((ing, i) => {
          const line = lineFor(recipe, ing);
          const storeLine = formatIngredientStorePrice(line);
          return (
            <li key={i}>
              <div className="recipe-detail__ingredient-row">
                <span className="recipe-detail__ingredient-name">{ingredientName(line, ing.name)}</span>
                <span className="recipe-detail__ingredient-qty">
                  {formatIngredientQuantity(line, { quantity: ing.quantity, unit: ing.unit })}
                </span>
              </div>
              <div className="recipe-detail__ingredient-row">
                <span
                  className={
                    storeLine.unpriceable
                      ? "recipe-detail__ingredient-store recipe-detail__ingredient-store--unpriceable"
                      : "recipe-detail__ingredient-store"
                  }
                >
                  {storeLine.label}
                </span>
                {storeLine.price && <span className="recipe-detail__ingredient-price">{storeLine.price}</span>}
              </div>
            </li>
          );
        })}
      </ul>

      <details className="recipe-detail__instructions">
        <summary>Instructions</summary>
        <ol>
          {recipe.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}
