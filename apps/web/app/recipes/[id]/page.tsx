import type { Recipe } from "@uiu/shared";
import { apiGet } from "../../lib/api";

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await apiGet<Recipe>(`/api/recipes/${id}`);

  if (!res.ok) {
    return (
      <div className="recipe-detail">
        <h1 className="recipe-detail__title">Recipe not found</h1>
      </div>
    );
  }

  const recipe = res.data;

  return (
    <div className="recipe-detail">
      {recipe.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="recipe-detail__image" src={recipe.imageUrl} alt="" />
      ) : (
        <div className="recipe-detail__image" />
      )}
      <h1 className="recipe-detail__title">{recipe.title}</h1>
      <p className="recipe-detail__description">{recipe.description}</p>

      <h2>Ingredients</h2>
      <ul>
        {recipe.ingredients.map((ing, i) => (
          <li key={i}>
            {ing.quantity} {ing.unit} {ing.name}
          </li>
        ))}
      </ul>

      <h2>Steps</h2>
      <ol>
        {recipe.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
