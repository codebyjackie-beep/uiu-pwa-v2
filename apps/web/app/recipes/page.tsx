import type { RecipeListItem, RecipeListPage } from "@uiu/shared";
import { apiGet } from "../lib/api";
import RecipesBrowser from "./RecipesBrowser";

export const metadata = { title: "Recipes · UseItUp" };

// Page size per API call (the API caps `limit` at 250). The full set is assembled by paging
// through `total`, so the client-side filter UI below keeps working as the library grows —
// don't turn this into a bigger hard-coded "fetch everything" number.
const PAGE_SIZE = 250;

async function fetchAllRecipes(): Promise<{ items: RecipeListItem[]; total: number } | null> {
  const first = await apiGet<RecipeListPage>(`/api/recipes?limit=${PAGE_SIZE}&page=1`);
  if (!first.ok) return null;

  const { total } = first.data;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) =>
      apiGet<RecipeListPage>(`/api/recipes?limit=${PAGE_SIZE}&page=${i + 2}`),
    ),
  );
  if (rest.some((r) => !r.ok)) return null;

  const seen = new Set<string>();
  const items: RecipeListItem[] = [];
  for (const page of [first, ...rest]) {
    if (!page.ok) continue;
    for (const item of page.data.items) {
      if (seen.has(item._id)) continue;
      seen.add(item._id);
      items.push(item);
    }
  }
  return { items, total };
}

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

  const { items, total } = all;

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
