/**
 * schema.org Recipe JSON-LD for the recipe detail page (Google rich results).
 *
 * Rules:
 * - Only for a recipe that was found AND is public (isPublic === true). Anything else → null, no JSON-LD.
 * - Only fields we really store. Never aggregateRating / review / video / nutrition claims; no price
 *   (schema.org Recipe has no fitting property for a per-serving supermarket estimate).
 * - Author is always the UseItUp organisation — user-recipe authors are not shown publicly.
 *
 * Pure (no Next / React / Clerk imports) so the test runs under plain Node via tsx.
 */

export const JSON_LD_SITE_BASE = "https://useitup.uk";

export interface RecipeJsonLdInput {
  _id: string;
  title: string;
  description?: string | null;
  isPublic?: boolean;
  imageUrl?: string | null;
  servings?: number | null;
  prepTimeMinutes?: number | null;
  cookTimeMinutes?: number | null;
  steps?: string[] | null;
  /** Display strings, e.g. "250g Diced tomatoes" — built by the page with the same formatters it renders. */
  ingredientLines?: string[] | null;
}

export type RecipeJsonLd = Record<string, unknown>;

function clean(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function positiveMinutes(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Minutes → ISO-8601 duration ("PT1H30M", "PT45M"). */
export function isoDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h ? `${h}H` : ""}${m || !h ? `${m}M` : ""}`;
}

function publicImageUrl(url: unknown): string | null {
  const u = clean(url);
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null; // relative / malformed — not a real public image URL
  }
}

export function buildRecipeJsonLd(recipe: RecipeJsonLdInput | null | undefined): RecipeJsonLd | null {
  if (!recipe || recipe.isPublic !== true) return null;
  const name = clean(recipe.title);
  const id = clean(recipe._id);
  if (!name || !id) return null;

  const url = `${JSON_LD_SITE_BASE}/recipes/${encodeURIComponent(id)}`;
  const out: RecipeJsonLd = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name,
    url,
    mainEntityOfPage: url,
    author: { "@type": "Organization", name: "UseItUp", url: JSON_LD_SITE_BASE },
  };

  const description = clean(recipe.description);
  if (description) out.description = description;

  const image = publicImageUrl(recipe.imageUrl);
  if (image) out.image = [image];

  const servings = typeof recipe.servings === "number" && Number.isFinite(recipe.servings) && recipe.servings > 0 ? Math.round(recipe.servings) : null;
  if (servings) out.recipeYield = `${servings} serving${servings === 1 ? "" : "s"}`;

  const prep = positiveMinutes(recipe.prepTimeMinutes);
  const cook = positiveMinutes(recipe.cookTimeMinutes);
  if (prep) out.prepTime = isoDuration(prep);
  if (cook) out.cookTime = isoDuration(cook);
  if (prep || cook) out.totalTime = isoDuration((prep ?? 0) + (cook ?? 0));

  const ingredients = (recipe.ingredientLines ?? []).map(clean).filter(Boolean);
  if (ingredients.length) out.recipeIngredient = ingredients;

  const steps = (recipe.steps ?? []).map(clean).filter(Boolean);
  if (steps.length) out.recipeInstructions = steps.map((text) => ({ "@type": "HowToStep", text }));

  return out;
}

/**
 * JSON for a <script type="application/ld+json"> body. `<` is escaped to \u003c (and U+2028/2029
 * for old parsers) so recipe text can never close the script tag; JSON parsers read it back unchanged.
 */
export function serializeJsonLd(data: RecipeJsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
