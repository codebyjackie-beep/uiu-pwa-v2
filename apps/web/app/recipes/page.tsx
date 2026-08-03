import type { RecipeListPage } from "@uiu/shared";
import { apiGet } from "../lib/api";
import RecipesBrowser from "./RecipesBrowser";

export const metadata = { title: "Recipes · UseItUp" };

// Full set fetched in one call (198 recipes, well under the API's 250 cap) so the filter
// UI below can search/filter client-side without a round trip per keystroke/chip toggle —
// see HANDOFF_recipes-page-filters.md for why client-side filtering was chosen over
// query-param server-side filtering.
const FETCH_LIMIT = 250;

export default async function RecipesPage() {
  const res = await apiGet<RecipeListPage>(`/api/recipes?limit=${FETCH_LIMIT}`);

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

  return (
    <div className="recipes-page">
      <div className="recipes-page__header">
        <h1>Recipes</h1>
        <p>{total} recipes</p>
      </div>

      <RecipesBrowser items={items} />
    </div>
  );
}
