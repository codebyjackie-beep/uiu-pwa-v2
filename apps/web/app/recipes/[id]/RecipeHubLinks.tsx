import { fetchAllRecipes } from "../../lib/publicRecipes";
import { hubLinksForRecipe } from "../../lib/recipeHubRegistry";
import { toHubRecipe, toHubRecipes, type HubSource } from "../../lib/hubPricing";
import { RecipeHubNav } from "../RecipeHubList";

/**
 * "More recipes like this" links on a public recipe page. Reads the cached public list (memory + edge
 * cache, shared with /recipes) and is rendered inside <Suspense>, so a cold cache never delays the recipe itself.
 */
export async function RecipeHubLinks({ recipe }: { recipe: HubSource }) {
  const all = await fetchAllRecipes();
  if (!all) return null;
  const links = hubLinksForRecipe(toHubRecipe(recipe), toHubRecipes(all.items));
  return <RecipeHubNav className="recipe-hubs--detail" groups={[{ title: "More recipes like this", links }]} />;
}
