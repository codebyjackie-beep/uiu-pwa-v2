import type { RecipeDetail, RecipeDetailCostLine } from "@uiu/shared";
import { apiGet } from "../../lib/api";
import {
  costPendingLabel,
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
  const hasCost = recipe.cost && recipe.cost.basket > 0;

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

      <h1 className="recipe-detail__title">{recipe.title}</h1>

      <div className="cost-hero">
        <div className="cost-hero__header">
          <span className="cost-hero__label">Cost per serving</span>
          <span className="cost-hero__servings">
            {recipe.servings} serving{recipe.servings === 1 ? "" : "s"}
          </span>
        </div>
        {hasCost ? (
          <p className="cost-hero__price">£{recipe.cost!.perServing.toFixed(2)}</p>
        ) : (
          <p className="cost-hero__price cost-hero__price--pending">
            {costPendingLabel({ enrichmentAttempted: recipe.enrichmentAttempted, ingredientCount: recipe.ingredients.length })}
          </p>
        )}
        <div className="macro-tiles">
          <div className="macro-tile">
            <span className="macro-tile__value">{Math.round(recipe.nutrition.calories)}</span>
            <span className="macro-tile__label">Cal</span>
          </div>
          <div className="macro-tile">
            <span className="macro-tile__value">{Math.round(recipe.nutrition.protein)}g</span>
            <span className="macro-tile__label">Protein</span>
          </div>
          <div className="macro-tile">
            <span className="macro-tile__value">{Math.round(recipe.nutrition.carbs)}g</span>
            <span className="macro-tile__label">Carbs</span>
          </div>
          <div className="macro-tile">
            <span className="macro-tile__value">{Math.round(recipe.nutrition.fat)}g</span>
            <span className="macro-tile__label">Fat</span>
          </div>
        </div>
      </div>

      <div className="recipe-detail__meta-row">
        <span>{recipe.prepTimeMinutes} min prep</span>
        <span>{recipe.cookTimeMinutes} min cook</span>
      </div>

      {dietBadgeList.length > 0 && (
        <div className="badges badges--dietary">
          {dietBadgeList.map((b) => (
            <span key={b} className="badge badge--dietary">
              {b}
            </span>
          ))}
        </div>
      )}

      <h2>
        Ingredients <span className="recipe-detail__ingredients-note">(makes {recipe.servings} serving{recipe.servings === 1 ? "" : "s"})</span>
      </h2>
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
