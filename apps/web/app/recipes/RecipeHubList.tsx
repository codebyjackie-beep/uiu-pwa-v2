import Link from "next/link";
import { recipePath } from "../lib/recipeSlug";
import { recipePerServingPrice, type RecipeListItem } from "@uiu/shared";
import { CoveragePrice } from "../components/CoveragePrice";
import { costPendingLabel, mealTypeBadge } from "../lib/recipeDisplay";
import { cardImageUrl } from "../lib/recipeBrowse";
import type { HubNavGroup } from "../lib/recipeHub";

/**
 * Server-rendered recipe cards for SEO hub pages. Same markup / classes as the /recipes browser cards,
 * minus the favourite button (that needs client state) — so the whole list is in the SSR HTML for crawlers.
 */
export function RecipeHubList({ recipes }: { recipes: RecipeListItem[] }) {
  return (
    <div className="recipe-list">
      {recipes.map((recipe, index) => {
        const mealBadge = mealTypeBadge(recipe);
        const totalMin = (recipe.prepTimeMinutes ?? 0) + (recipe.cookTimeMinutes ?? 0);
        const price = recipePerServingPrice(recipe.cost);
        return (
          <Link key={recipe._id} href={recipePath(recipe._id, recipe.title)} className="recipe-card recipe-card--browse">
            {recipe.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="recipe-card__image"
                src={cardImageUrl(recipe.imageUrl)}
                alt=""
                width={640}
                height={168}
                loading={index < 2 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                decoding="async"
              />
            ) : (
              <div className="recipe-card__image" />
            )}
            <div className="recipe-card__body">
              <div className="recipe-card__header">
                <p className="recipe-card__title">{recipe.title}</p>
                {price != null ? (
                  <CoveragePrice
                    value={price}
                    coveragePct={recipe.cost!.adjustedCoveragePct}
                    suffix="/ serving"
                    className="recipe-card__price"
                    pendingClassName="recipe-card__price--pending"
                  />
                ) : (
                  <span className="recipe-card__price recipe-card__price--pending">{costPendingLabel(recipe)}</span>
                )}
              </div>
              {recipe.description ? <p className="recipe-card__description">{recipe.description}</p> : null}
              <div className="recipe-card__meta">
                {mealBadge ? <span className="badge">{mealBadge}</span> : null}
                {totalMin > 0 ? <span>⏱ {totalMin} min</span> : null}
                <span>👥 {recipe.servings}</span>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** Rows of hub links (chips). Renders nothing when there are no live hubs. */
export function RecipeHubNav({ groups, className }: { groups: HubNavGroup[]; className?: string }) {
  const live = groups.filter((g) => g.links.length > 0);
  if (!live.length) return null;
  return (
    <nav className={`recipe-hubs${className ? ` ${className}` : ""}`} aria-label="Browse recipes by">
      {live.map((g) => (
        <div key={g.title} className="recipe-hubs__group">
          <h2 className="recipe-hubs__title">{g.title}</h2>
          <div className="recipe-hubs__row">
            {g.links.map((l) => (
              <Link key={l.href} href={l.href} className="chip recipe-hubs__chip">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
