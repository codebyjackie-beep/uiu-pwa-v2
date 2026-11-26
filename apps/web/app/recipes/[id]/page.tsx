import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import {
  formatCostWithCoverage,
  isStockLikeName,
  STOCK_PRICED_LABEL,
  type RecipeDetail,
  type MealSlot,
  type RecipeDetailCostLine,
} from "@uiu/shared";
import { apiGet } from "../../lib/api";
import { PricesChecked } from "../../components/PricesChecked";
import { RecipeAddToList } from "./RecipeAddToList";
import { RecipeFavouriteButton } from "./RecipeFavouriteButton";
import { RecipeOwnerActions } from "./RecipeOwnerActions";
import { AddToTodayButton } from "../../components/AddToTodayButton";
import {
  costPendingLabel,
  dietaryBadges,
  formatIngredientQuantity,
  formatIngredientStorePrice,
  ingredientName,
  isNutritionUnavailable,
  mealTypeBadge,
  NUTRITION_NOT_AVAILABLE,
} from "../../lib/recipeDisplay";
import { recipeMetaDescription, recipeMetaTitle } from "../../lib/seoMeta";

const DEFAULT_OG_IMAGE = "/og-image.png?v=1";

// One API call per request, shared by generateMetadata and the page.
const getRecipe = cache((id: string) => apiGet<RecipeDetail>(`/api/recipes/${id}`));

/** Same rule as the cost hero below: only a priced basket gets a cost display. */
function costDisplayFor(recipe: RecipeDetail) {
  return recipe.cost && recipe.cost.basket > 0
    ? formatCostWithCoverage(recipe.cost.perServing, recipe.cost.adjustedCoveragePct)
    : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const res = await getRecipe(id);
  if (!res.ok) {
    // Only a definite "no such recipe" is noindexed: 404 (missing / not yours) or 400 (malformed id, never valid).
    // A 5xx / fetch failure is transient — no robots tag, so a blip can't get a real recipe dropped from Google.
    if (res.error.code === "http_404" || res.error.code === "http_400") {
      return { title: "Recipe not found · UseItUp", robots: { index: false, follow: false } };
    }
    return { title: "Recipe · UseItUp" };
  }

  const r = res.data;
  const title = recipeMetaTitle(r.title);
  // Price only when coverage tier is "full" (handled in recipeMetaDescription); partial / unavailable → no £.
  const description = recipeMetaDescription({
    description: r.description,
    servings: r.servings,
    prepTimeMinutes: r.prepTimeMinutes,
    cookTimeMinutes: r.cookTimeMinutes,
    cost: costDisplayFor(r),
  });
  // Prefer the API's own _id over the URL segment (same doc, canonical spelling).
  const url = `/recipes/${r._id || id}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    // The API only returns a non-public recipe to its owner — never index someone's private recipe.
    robots: r.isPublic === false ? { index: false, follow: false } : undefined,
    // openGraph / twitter replace the root objects wholesale, so siteName / locale / images are repeated here.
    openGraph: {
      type: "article",
      siteName: "UseItUp",
      locale: "en_GB",
      title: r.title,
      description,
      url,
      images: r.imageUrl ? [{ url: r.imageUrl, alt: r.title }] : [{ url: DEFAULT_OG_IMAGE, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title: r.title, description, images: [r.imageUrl || DEFAULT_OG_IMAGE] },
  };
}

function lineFor(recipe: RecipeDetail, ingredient: RecipeDetail["ingredients"][number]): RecipeDetailCostLine | undefined {
  return recipe.cost?.lines.find(
    (l) => l.rawName === ingredient.name && l.quantity === ingredient.quantity && l.rawUnit === ingredient.unit,
  );
}

function slotFromBadge(badge: string | null): MealSlot {
  const v = badge?.toLowerCase();
  return v === "breakfast" || v === "lunch" || v === "dinner" || v === "snack" ? v : "dinner";
}

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await getRecipe(id);

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
  const costDisplay = costDisplayFor(recipe);

  return (
    <div className="recipe-detail">
      {recipe.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="recipe-detail__image" src={recipe.imageUrl} alt={recipe.title} />
      ) : (
        <div className="recipe-detail__image" />
      )}

      {mealBadge && (
        <div className="badges" style={{ marginTop: "var(--space)" }}>
          <span className="badge">{mealBadge}</span>
        </div>
      )}

      <div className="recipe-detail__title-row">
        <h1 className="recipe-detail__title">{recipe.title}</h1>
        <RecipeFavouriteButton recipeId={id} />
      </div>

      {/* Jackie 2026-11-07: the API only returns a non-public recipe to its owner, so non-public = "mine". */}
      {recipe.isPublic === false ? <RecipeOwnerActions recipe={recipe} /> : null}

      {/* Jackie 2026-11-05: add straight from the recipe; meal defaults to the recipe's own meal type. */}
      <AddToTodayButton recipeId={id} defaultSlot={slotFromBadge(mealBadge)} />

      {recipe.steps.length > 0 && (
        <Link href={`/recipes/${id}/cook`} className="recipe-detail__cook-cta">
          Start cooking
        </Link>
      )}

      <div className="cost-hero">
        <div className="cost-hero__header">
          <span className="cost-hero__label">Cost per serving</span>
          <span className="cost-hero__servings">
            {recipe.servings} serving{recipe.servings === 1 ? "" : "s"}
          </span>
        </div>
        {hasCost ? (
          <>
            <p
              className={`cost-hero__price${costDisplay!.tier === "unavailable" ? " cost-hero__price--pending" : ""}`}
              title={costDisplay!.note}
            >
              {costDisplay!.text}
            </p>
            {costDisplay!.note ? <p className="cost-hero__note">{costDisplay!.note}</p> : null}
            <PricesChecked stamp={recipe.cost!.priceCacheStamp} />
          </>
        ) : (
          <p className="cost-hero__price cost-hero__price--pending">
            {costPendingLabel({ enrichmentAttempted: recipe.enrichmentAttempted, ingredientCount: recipe.ingredients.length, cost: recipe.cost })}
          </p>
        )}
        {isNutritionUnavailable(recipe) ? (
          <p className="macro-tiles__unavailable">{NUTRITION_NOT_AVAILABLE}</p>
        ) : (
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
        )}
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

      <div className="recipe-detail__ingredients-head">
        <h2>
          Ingredients <span className="recipe-detail__ingredients-note">(makes {recipe.servings} serving{recipe.servings === 1 ? "" : "s"})</span>
        </h2>
        <RecipeAddToList
          ingredients={recipe.ingredients.map((ing) => {
            const line = lineFor(recipe, ing);
            return { name: ingredientName(line, ing.name), canonicalName: line?.canonicalName || undefined };
          })}
        />
      </div>
      <ul className="recipe-detail__ingredients">
        {recipe.ingredients.map((ing, i) => {
          const line = lineFor(recipe, ing);
          const storeLine = formatIngredientStorePrice(line);
          // Stock/broth lines show only the "priced as stock cube" note — the stored cheapest store is for a different product.
          const isStock = !storeLine.unpriceable && isStockLikeName(line?.canonicalName);
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
                    storeLine.pantry
                      ? "recipe-detail__ingredient-store recipe-detail__ingredient-store--pantry"
                      : storeLine.unpriceable
                        ? "recipe-detail__ingredient-store recipe-detail__ingredient-store--unpriceable"
                        : "recipe-detail__ingredient-store"
                  }
                >
                  {isStock ? STOCK_PRICED_LABEL : storeLine.label}
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
