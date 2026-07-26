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
// Recipe list  (GET /api/recipes response shape — trimmed fields + joined cost)
// ---------------------------------------------------------------------------

/** Cost summary joined from recipe_cost for the list view. Null when not yet computed. */
export interface RecipeListItemCost {
  basket: number;
  currency: "GBP";
  perServing: number;
  /** From RecipeCost.adjustedCoveragePct (post pantry/junk-line exclusion) — NOT the raw RecipeCost.coveragePct. */
  adjustedCoveragePct: number;
}

export interface RecipeListItem {
  _id: ObjectIdHex;
  title: string;
  description: string;
  imageUrl: string;
  cookTimeMinutes: number;
  prepTimeMinutes: number;
  servings: number;
  tags: string[];
  /** Present on 37/197 recipes — falls back to a tags[] match on the client when absent. */
  mealType?: string;
  nutrition: RecipeNutrition;
  cost: RecipeListItemCost | null;
  /** ingredients.length — trimmed count for the list-card meta line, not the full array. */
  ingredientCount: number;
}

export interface RecipeListPage {
  items: RecipeListItem[];
  page: number;
  limit: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Recipe detail  (GET /api/recipes/:id response shape — full Recipe + joined cost)
// ---------------------------------------------------------------------------

/** One priced (or unpriceable) ingredient line for the detail view, trimmed from RecipeCostLine. */
export interface RecipeDetailCostLine {
  rawName: string;
  quantity: number;
  rawUnit: string;
  priceable: boolean;
  /** Present only when priceable. */
  lineCost?: number;
  /** Present only when priceable. */
  store?: string;
  /** Present only when priceable. */
  productTitle?: string | null;
  canonicalName?: string;
  /** Converted value in normUnit — present only when priceable (conversion succeeded). */
  normValue?: number;
  /** g | ml | pc — matches RecipeCostLine.normUnit. Present only when priceable. */
  normUnit?: "g" | "ml" | "pc";
}

export interface RecipeDetailCost extends RecipeListItemCost {
  lines: RecipeDetailCostLine[];
}

export interface RecipeDetail extends Recipe {
  cost: RecipeDetailCost | null;
}

// ---------------------------------------------------------------------------
// Shared small structures used by price cache / recipe cost below.
// ---------------------------------------------------------------------------

/** Pack size, e.g. { qty: 500, unit: "ml" }. */
export interface Pack {
  qty: number;
  unit: string;
}

/** Unit price. unit is "g_or_ml" (metric) or "each" (count); n = listings used to compute it. */
export interface PerUnit {
  value: number;
  unit: "g_or_ml" | "each";
  n: number;
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
  /** Unique key — enforced by unique index `canonical_name_1`. Join key into price cache / recipe lines. */
  canonical_name: string;
  aliases: string[];
  /** Observed values: g(627) ml(94) pc(12) g+pc(6) kg(1) leaf(1). */
  display_unit: string;
  is_combo: boolean;
  is_priceable: boolean;
  pantry_staple: boolean;
  /** Weight per item in grams. Null on 689/741 (93%) — source of the missing_per_item_g cost gap. */
  per_item_g: number | null;
  recipe_count: number;
  reference_pack: Pack | null;
  source: "seed" | "merge" | "manual_fill";
  /** S=solid(622) L=liquid(94) C=count(25). */
  type: "S" | "L" | "C";
  updated_at: ISODate;
  /** Grams per cup. Null on 482/737 — source of the missing_density_cup cost gap. */
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
// Price cache  (collection: canonical_price_cache — 635 docs)
//
// Field presence audited 2026-07-24 across all 635 live documents (uiu-migration
// export, same batch imported into the new cluster). The previous version of this
// type was almost entirely wrong: none of its top-level camelCase fields
// (canonicalName/price/currency/unit/store/productTitle/fetchedAt) exist on the
// real document — the actual shape is nested (see below).
// ---------------------------------------------------------------------------

export interface PriceListing {
  store: string;
  title: string;
  price: number;
  /** Null on 5296/8354 listings (63.4%) — no pack means no unit price can be derived. */
  pack: Pack | null;
  source_of_pack: string;
  per_unit: number | null;
}

export interface CanonicalPriceCacheEntry {
  _id: ObjectIdHex;
  /** snake_case. Joins to canonical_ingredients.canonical_name. */
  canonical_name: string;
  /** Null on 18/635 (2.8%) — no price found at all. */
  cheapest: {
    store: string;
    price: number;
    /** Present on 312/617 (50.6%) of non-null cheapest entries. */
    title?: string;
  } | null;
  /** high(533) price_only(68) none(18) low(16). */
  confidence: "high" | "low" | "none" | "price_only";
  listings: PriceListing[];
  metadata: {
    source: string;
    query_used: string;
    reference_pack_used: Pack | null;
    raw_listing_count: number;
    attempts: number;
    fetched_at: ISODate;
  };
  n_supermarkets: number;
  needs_review: boolean;
  /** Null on 561/635 (88.3%). */
  per_unit_count: PerUnit | null;
  /** Null on 113/635 (17.8%). */
  per_unit_metric: PerUnit | null;
}

// ---------------------------------------------------------------------------
// Recipe cost  (collection: recipe_cost — computed cache / verification baseline)
//
// Field presence audited 2026-07-24 across recipe_cost_NEW.json (197 docs, engine
// output not yet inserted into DB) and recipe_cost.SNAPSHOT.json (214 docs, already
// in DB — new cluster has an empty recipe_cost collection, this type was audited
// from the export files, not a live query). The previous version of this type had
// only 3 fields, and `coverage` was documented as a 0..1 fraction — the real field
// is `coveragePct`, a 0..100 percent (sample values: 60, 75, 66.67).
// ---------------------------------------------------------------------------

export type UnpriceableReason =
  | "no_price_in_cache" // 149
  | "missing_per_item_g_and_count_price" // 139
  | "unit_unconvertible" // 136
  | "missing_density_cup" // 108
  | "unresolved" //  84
  | "known_gap" //  16
  | "unmapped_unit" //  14
  | "no_price_for_bucket"; //   6

export interface RecipeCostLine {
  priceable: boolean;
  rawName: string;
  quantity: number;
  /** May be an empty string. */
  rawUnit: string;
  /** Present on 1959/2043 (95.9%) — absent when name resolution failed. */
  canonical_name?: string;
  isPantry?: boolean;
  /** metric(1143) | count(254). Only present when priceable. */
  bucket?: "metric" | "count";
  normValue?: number;
  /** g(822) | ml(315) | pc(254). */
  normUnit?: "g" | "ml" | "pc";
  perUnit?: number;
  lineCost?: number;
  displayNote?: string | null;
  /** Only present in the NEW engine output, not SNAPSHOT — engine version drift. */
  store?: string;
  /** Same as above, NEW only. */
  productTitle?: string | null;
  /** Only present when priceable is false. */
  reason?: UnpriceableReason;
}

export interface RecipeCost {
  /** Absent on fresh engine output (recipe_cost_NEW.json) — populated once inserted into DB. */
  _id?: ObjectIdHex;
  /** FK to recipes._id. */
  recipeId: ObjectIdHex;
  /** Total basket cost in GBP. */
  basket: number;
  currency: "GBP";
  /** Percent 0..100, NOT a 0..1 fraction. */
  coveragePct: number;
  /** Percent 0..100, after excluding pantry/junk lines. */
  adjustedCoveragePct: number;
  totalLines: number;
  priceableCount: number;
  /** Line counts/totals after excluding pantry/junk lines. */
  adjustedTotal: number;
  adjustedPriceable: number;
  pantryLineCount: number;
  junkLineCount: number;
  perServing: number;
  lines: RecipeCostLine[];
  /** e.g. { unit_unconvertible: 2, missing_density_cup: 1 }. */
  unpriceableReasons: Partial<Record<UnpriceableReason, number>>;
  computedAt: ISODate;
  priceCacheStamp: number;
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
