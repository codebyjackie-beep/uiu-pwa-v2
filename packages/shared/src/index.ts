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
//
// Field presence audited 2026-07-24 across all 197 live documents (see
// apps/api/_audit_recipes.mjs, not committed). Required = present on 197/197 docs;
// optional = present on a subset. Nested ingredients[] audited across all 2043 line items.
// ---------------------------------------------------------------------------

export interface RecipeIngredient {
  /** As written in the source recipe, e.g. "diced tomatoes" — present on all 2043/2043 items. */
  name: string;
  quantity: number;
  unit: string;
  /** Present on 71/2043 items only. */
  notes?: string;
  /**
   * Resolved canonical ingredient name, when matched by the cost engine — NOT a field on the
   * raw document (0/2043); populated at read time by joining against canonical_ingredients.
   */
  canonicalName?: string;
}

export interface RecipeNutrition {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Present on 126/197 recipes. */
  fiber?: number;
  /** Present on 3/197 recipes. */
  sugar?: number;
  /** Present on 3/197 recipes. */
  sodium?: number;
}

export interface Recipe {
  _id: ObjectIdHex;
  title: string;
  description: string;
  isPublic: boolean;
  /** null for system/public recipes; set for user-authored drafts. */
  userId: ObjectIdHex | null;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  imageUrl: string;
  nutrition: RecipeNutrition;
  source: string;
  sourcePlatform: string | null;
  collectionIds: ObjectIdHex[];
  isFavorite: boolean;
  viewCount: number;
  favoriteCount: number;
  __v: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Present on 161/197 recipes. */
  sourceUrl?: string;
  /** Present on 159/197 recipes. */
  cacheKey?: string;
  /** Present on 99/197 recipes. */
  cuisineType?: string | null;
  /** Present on 44/197 recipes. */
  enrichmentAttempted?: boolean;
  /** Present on 44/197 recipes. */
  nutritionAttempted?: boolean;
  /** Present on 37/197 recipes. */
  mealType?: string;
  /** Present on 22/197 recipes. */
  imageAttempted?: boolean;
  /** Present on 22/197 recipes. */
  isDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical ingredients  (collection: canonical_ingredients — 741 docs)
//
// Field presence audited 2026-07-24 across all 741 live documents. Field is
// `canonical_name` (snake_case) — do not confuse with the camelCase name used elsewhere
// in this file for other collections (those are unaudited as of this pass).
// ---------------------------------------------------------------------------

export interface CanonicalIngredient {
  _id: ObjectIdHex;
  /** Unique key — enforced by unique index `canonical_name_1`. */
  canonical_name: string;
  aliases: string[];
  display_unit: string;
  is_combo: boolean;
  is_priceable: boolean;
  pantry_staple: boolean;
  per_item_g: number | null;
  recipe_count: number;
  reference_pack: unknown | null;
  source: string;
  type: string;
  updated_at: ISODate;
  /** Present on 737/741 docs. */
  density_cup?: number | null;
  /** Present on 106/741 docs (quarantine workflow from the 2026-07 canonical merge). */
  quarantine?: boolean;
  /** Present on 106/741 docs. */
  quarantined_at?: ISODate;
  /** Present on 106/741 docs. */
  quarantined_reason?: string;
  /** Present on 26/741 docs. */
  needs_review?: boolean;
  /** Present on 17/741 docs. */
  known_gap?: boolean;
  /** Present on 16/741 docs. */
  known_gap_reason?: string;
  /** Present on 10/741 docs. */
  is_pantry?: boolean;
  /** Present on 9/741 docs. */
  query_alias?: string;
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
