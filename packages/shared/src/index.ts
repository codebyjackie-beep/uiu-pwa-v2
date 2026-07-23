/**
 * @uiu/shared — single source of truth for domain types shared by apps/web and apps/api.
 *
 * These mirror the migrated MongoDB Atlas collections (cluster `uiu-pwa-v2`, db `useitup`):
 *   recipes, canonical_ingredients, canonical_price_cache, recipe_cost.
 * Keep field names in sync with the DB; both frontend and backend import from here so the
 * interface never drifts.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** MongoDB ObjectId serialized as a 24-char hex string over HTTP. */
export type ObjectIdHex = string;

/** ISO-8601 timestamp string. */
export type ISODate = string;

// ---------------------------------------------------------------------------
// Recipes  (collection: recipes — 197 curated: 190 public + 7 private)
// ---------------------------------------------------------------------------

export interface RecipeIngredient {
  /** Free-text as written in the recipe, e.g. "2 cups diced tomatoes". */
  raw: string;
  /** Resolved canonical ingredient name, when matched. */
  canonicalName?: string;
  quantity?: number;
  unit?: string;
}

export interface Recipe {
  _id: ObjectIdHex;
  title: string;
  isPublic: boolean;
  /** null for system/public recipes; set for user-authored drafts. */
  userId: ObjectIdHex | null;
  ingredients: RecipeIngredient[];
  steps?: string[];
  tags?: string[];
  servings?: number;
  imageUrl?: string;
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

// ---------------------------------------------------------------------------
// Canonical ingredients  (collection: canonical_ingredients — 741, unique name)
// ---------------------------------------------------------------------------

export interface CanonicalIngredient {
  _id: ObjectIdHex;
  /** Unique key — enforced by unique index `canonical_name_1`. */
  canonicalName: string;
  aliases?: string[];
  category?: string;
}

// ---------------------------------------------------------------------------
// Price cache  (collection: canonical_price_cache — 635, weekly Serper refresh)
// ---------------------------------------------------------------------------

export interface CanonicalPriceCacheEntry {
  _id: ObjectIdHex;
  canonicalName: string;
  /** Unit price in GBP for the normalized unit. */
  price: number;
  currency: "GBP";
  unit: string;
  store?: string;
  productTitle?: string;
  fetchedAt?: ISODate;
}

// ---------------------------------------------------------------------------
// Recipe cost  (collection: recipe_cost — computed cache / verification baseline)
// ---------------------------------------------------------------------------

export interface RecipeCost {
  _id: ObjectIdHex;
  /** FK to recipes._id. */
  recipeId: ObjectIdHex;
  /** Total basket cost in GBP. */
  basket: number;
  /** Fraction of ingredients with a resolved price (0..1). */
  coverage: number;
  computedAt?: ISODate;
}

// ---------------------------------------------------------------------------
// Health  (collection: user_health — encrypted at rest, secret-tier, never logged)
// ---------------------------------------------------------------------------

export interface HealthRecord {
  _id: ObjectIdHex;
  userId: ObjectIdHex;
  heightCm?: number;
  weightKg?: number;
  bmi?: number;
  bodyFatPct?: number;
  macros?: {
    calories?: number;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
  };
  recordedAt: ISODate;
}

// ---------------------------------------------------------------------------
// API envelope  (used by apps/api responses, consumed by apps/web)
// ---------------------------------------------------------------------------

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

export interface HealthCheck {
  status: "ok";
  service: string;
  version: string;
  time: ISODate;
}

export const API_VERSION = "0.1.0" as const;
