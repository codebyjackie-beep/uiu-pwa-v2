import type { Metadata } from "next";
import { fetchAllRecipes } from "../lib/publicRecipes";
import { Suspense } from "react";
import RecipesBrowser from "./RecipesBrowser";
import { pickRandom, RANDOM_BROWSE_SIZE, toBrowseRecipe } from "../lib/recipeBrowse";
import { FridgeMatches } from "./FridgeMatches";
import { RecipeHubNav } from "./RecipeHubList";
import { hubNavGroups } from "../lib/recipeHubRegistry";
import { toHubRecipes } from "../lib/hubPricing";

export const metadata: Metadata = {
  title: "Recipes with Cost Per Serving · UseItUp",
  description:
    "Browse recipes priced at UK supermarkets. See the cost per serving before you shop, filter by meal type and diet, and use up what’s already in your fridge.",
};

export default async function RecipesPage() {
  const all = await fetchAllRecipes();

  if (!all) {
    return (
      <div className="recipes-page">
        <div className="recipes-page__header">
          <h1>Recipes</h1>
          <p>Couldn&apos;t load recipes right now — please try again shortly.</p>
        </div>
      </div>
    );
  }

  const { total } = all;
  const items = all.items.map(toBrowseRecipe);
  // Picked per request on the server so the first paint already shows the final 10 (see RecipesBrowser).
  const initialRandom = pickRandom(items, RANDOM_BROWSE_SIZE);

  return (
    <div className="recipes-page">
      <div className="recipes-page__header">
        <h1>Recipes</h1>
        <p>{total} recipes</p>
      </div>

      {/* Only renders for /recipes?cook=soon (Home "Cook with these"); client-side so the cached list above is untouched. */}
      <Suspense fallback={null}>
        <FridgeMatches />
      </Suspense>

      <RecipesBrowser items={items} initialRandom={initialRandom} />

      {/* Crawlable links to the SEO hub pages (ingredient / price); hidden when no hub is live. */}
      <RecipeHubNav groups={hubNavGroups(toHubRecipes(all.items))} />
    </div>
  );
}
