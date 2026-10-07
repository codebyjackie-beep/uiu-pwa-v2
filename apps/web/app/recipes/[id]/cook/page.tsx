import { notFound, redirect } from "next/navigation";
import type { RecipeDetail, RecipeDetailCostLine } from "@uiu/shared";
import { apiGet } from "../../../lib/api";
import { formatIngredientQuantity, formatIngredientStorePrice, ingredientName } from "../../../lib/recipeDisplay";
import { CookMode, type CookIngredient } from "./CookMode";

function lineFor(recipe: RecipeDetail, ingredient: RecipeDetail["ingredients"][number]): RecipeDetailCostLine | undefined {
  return recipe.cost?.lines.find(
    (l) => l.rawName === ingredient.name && l.quantity === ingredient.quantity && l.rawUnit === ingredient.unit,
  );
}

/**
 * cc_prompt_recipe-list-redesign-and-cook-mode.md Part C — the "STEP n OF N" label already
 * supplies the number, so strip any leading "Step 1:" / "1." numbering some recipes store
 * inline in the instruction text, plus surrounding whitespace, and drop empty strings.
 */
function cleanStep(raw: string): string {
  return raw.replace(/^\s*(step\s*\d+\s*[:.)-]?|\d+\s*[.)-])\s*/i, "").trim();
}

export default async function CookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await apiGet<RecipeDetail>(`/api/recipes/${id}`);
  if (!res.ok) notFound();

  const recipe = res.data;
  const steps = recipe.steps.map(cleanStep).filter((s) => s.length > 0);
  if (steps.length === 0) redirect(`/recipes/${id}`);

  const ingredients: CookIngredient[] = recipe.ingredients.map((ing, i) => {
    const line = lineFor(recipe, ing);
    const storeLine = formatIngredientStorePrice(line);
    return {
      id: String(i),
      name: ingredientName(line, ing.name),
      quantity: formatIngredientQuantity(line, { quantity: ing.quantity, unit: ing.unit }),
      storeLabel: storeLine.label,
      price: storeLine.price,
      unpriceable: storeLine.unpriceable,
    };
  });

  return (
    <CookMode
      recipeId={id}
      title={recipe.title}
      imageUrl={recipe.imageUrl ?? null}
      steps={steps}
      ingredients={ingredients}
    />
  );
}
