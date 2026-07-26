import type { RecipeDetail, RecipeDetailCostLine } from "@uiu/shared";
import { apiGet } from "../../lib/api";
import { dietBadges, formatIngredientLabel, formatIngredientPrice, mealTypeBadge, stripUsdMentions } from "../../lib/recipeDisplay";

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
  const badges = [mealTypeBadge(recipe), ...dietBadges(recipe)].filter((b): b is string => Boolean(b));
  const totalTime = recipe.cookTimeMinutes + recipe.prepTimeMinutes;

  return (
    <div className="recipe-detail">
      {recipe.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="recipe-detail__image" src={recipe.imageUrl} alt="" />
      ) : (
        <div className="recipe-detail__image" />
      )}

      {badges.length > 0 && (
        <div className="badges" style={{ marginTop: "var(--space)" }}>
          {badges.map((b) => (
            <span key={b} className="badge">
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

      <p className="recipe-detail__description">{stripUsdMentions(recipe.description)}</p>

      <h2>Ingredients</h2>
      <ul className="recipe-detail__ingredients">
        {recipe.ingredients.map((ing, i) => {
          const line = lineFor(recipe, ing);
          const priceLabel = line ? formatIngredientPrice(line) : null;
          return (
            <li key={i}>
              <span className="recipe-detail__ingredient-label">
                {line ? formatIngredientLabel(line) : `${ing.quantity} ${ing.unit} ${ing.name}`}
              </span>
              {priceLabel && <span className="recipe-detail__ingredient-price">{priceLabel}</span>}
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
