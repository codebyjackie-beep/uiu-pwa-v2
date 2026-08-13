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
  /** Set by ingredientTextGuard() when a write path's ingredient lines look like an
   * unparsed label/blob rather than a real recipe (see HANDOFF_recipe-import-french-label-bug-execute.md).
   * Already present as a bare field (no type) on themealdb_import.cjs docs; added here so
   * TS write paths (adminRecipeDrafts/adminRecipes) can set it too. */
  needs_review?: boolean;
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
  /** CoFID lookup (HANDOFF_recipe-expansion.md Part A). Present on 247/741 docs — verified against production Atlas 2026-07-31; the rest have no matched CoFID row yet. */
  nutrition_per_100g?: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
  };
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
// Meal plan  (collection: meal_plans — one document per planned meal slot,
// grouped under a meal_plan_sets "Plan card" — see
// HANDOFF_meal-planner-multi-plan-library.md. Up to 4 plan cards, at most one
// isActive:true; only the active plan drives Home/Fridge/tonight-suggestion.)
// ---------------------------------------------------------------------------

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

export interface MealPlanEntry {
  _id: ObjectIdHex;
  /** FK to meal_plan_sets._id — which Plan card this entry belongs to. */
  planId: ObjectIdHex;
  /** Position within the plan's own 7-day grid, 1=Mon...7=Sun — not tied to a
   * real calendar date (a plan card has no start date). */
  dayIndex: number;
  mealSlot: MealSlot;
  recipeId: ObjectIdHex;
  /** Always 1 unless the client explicitly overrides it — the app has no per-meal
   * headcount setting, so cost/calories are never scaled by this (they're stored
   * and displayed as the recipe's own per-serving values). */
  servings: number;
  createdAt: ISODate;
}

/** MealPlanEntry joined with the fields the board needs to render a card, without the full Recipe. */
export interface MealPlanEntryView {
  _id: ObjectIdHex;
  planId: ObjectIdHex;
  dayIndex: number;
  mealSlot: MealSlot;
  recipeId: ObjectIdHex;
  servings: number;
  recipe: {
    title: string;
    imageUrl: string;
    calories: number | null;
    costPerServing: number | null;
    /** Added for Meal Planner V2 Overview macro totals (HANDOFF_meal-planner-plan-v2.md §2.1). */
    protein: number | null;
    carbs: number | null;
    fat: number | null;
    prepTimeMinutes: number;
    cookTimeMinutes: number;
    /** Lowercased raw ingredient names, for the plan card's distinct-ITEMS count (§1). */
    ingredientNames: string[];
    /** Trimmed from recipe_cost.lines, for the Meals tab's per-ingredient price breakdown (§2.2). Empty when no cost doc yet. */
    costLines: RecipeDetailCostLine[];
  };
}

export interface MealPlanDaySummary {
  dayIndex: number;
  totalCost: number;
  totalCalories: number;
  entries: MealPlanEntryView[];
}

/** collection: meal_plan_sets — one document per Plan card, max 4 total, at most one isActive:true. */
export interface MealPlanSet {
  _id: ObjectIdHex;
  name: string;
  isActive: boolean;
  createdAt: ISODate;
}

/** GET /api/meal-plan-sets list item — aggregated live from meal_plans, no separate cache fields. */
export interface MealPlanSetSummary {
  _id: ObjectIdHex;
  name: string;
  isActive: boolean;
  createdAt: ISODate;
  weekTotalCost: number;
  weekTotalMeals: number;
  weekTotalCalories: number;
  weekTotalProtein: number;
  weekTotalCarbs: number;
  weekTotalFat: number;
  previewByDay: { dayIndex: number; recipeTitle: string }[];
}

/** GET /api/meal-plan-sets/:id — one card's full 7-day board. */
export interface MealPlanSetDetail {
  _id: ObjectIdHex;
  name: string;
  isActive: boolean;
  days: MealPlanDaySummary[];
  weekTotalCost: number;
  weekTotalCalories: number;
}

export const MEAL_PLAN_SET_LIMIT = 4;

// ---------------------------------------------------------------------------
// AI meal plan generator  (HANDOFF_ai-meal-plan-generator.md Part A)
//
// V1 scope: reads existing recipes/recipe_cost/nutrition, never recomputes cost
// or nutrition. Output is a preview only — nothing is written to meal_plans
// until the caller (Part B UI) confirms and posts each entry individually via
// the existing POST /api/meal-plan route.
// ---------------------------------------------------------------------------

/** How aggressively the generator avoids repeating the same recipe across the plan. */
export type MealPlanVariation = "low" | "medium" | "high";

/**
 * UK FSA 14 allergens. Matching is keyword-based against ingredient names
 * (see ALLERGEN_KEYWORDS in mealPlanGenerator.ts) — NOT a medical-grade
 * check. `canonical_ingredients` has no allergen field (audited 2026-07-29,
 * 0/741 docs), so this is deliberately best-effort for V1.
 */
export const UK_ALLERGENS = [
  "celery",
  "cereals_gluten",
  "crustaceans",
  "eggs",
  "fish",
  "lupin",
  "milk",
  "molluscs",
  "mustard",
  "tree_nuts",
  "peanuts",
  "sesame",
  "soybeans",
  "sulphites",
] as const;
export type UkAllergen = (typeof UK_ALLERGENS)[number];

export interface MealPlanGeneratorInput {
  /** Number of days to generate (1 for a day, 7 for a week, 28-31 for a month). */
  lengthDays: number;
  /** Budget expressed as "per week", scaled internally to lengthDays. */
  weeklyBudgetGBP: number;
  mealSlots: MealSlot[];
  variation: MealPlanVariation;
  /** Free-text cuisine keywords matched against tags/cuisineType. Empty = no preference. */
  cuisines: string[];
  /** Keys into DIETARY_FILTERS (mealPlanGenerator.ts) e.g. "vegetarian", "high-protein". */
  dietary: string[];
  allergens: UkAllergen[];
  /** Free-text dislikes (e.g. "garlic", "onion", "spicy"), matched the same way as allergens. */
  excludeKeywords: string[];
  /** V1: recorded but not used to filter/sort — see handoff "未包" section. */
  marketPriority?: string;
  /** Computed client-side from the wizard's body-goal step, used once and never stored. */
  calorieTargetPerDay?: number;
  /** YYYY-MM-DD; defaults to today (UTC) when omitted. */
  startDate?: string;
}

export interface GeneratedMealSlotEntry {
  mealSlot: MealSlot;
  recipeId: ObjectIdHex;
  title: string;
  imageUrl: string;
  servings: number;
  calories: number | null;
  costPerServing: number | null;
}

export interface GeneratedMealPlanDay {
  date: string;
  entries: GeneratedMealSlotEntry[];
  totalCost: number;
  totalCalories: number;
}

export interface GeneratedMealPlanSummary {
  totalMeals: number;
  totalCost: number;
  avgCaloriesPerDay: number;
  /** Total budget for the requested lengthDays (weeklyBudgetGBP scaled), not the weekly figure. */
  budgetGBP: number;
  lengthDays: number;
  /** True if the cuisine preference had to be dropped for at least one slot (pool would've been empty). */
  cuisineFilterRelaxed: boolean;
  /**
   * True if at least one slot's filtered candidate pool was so small the
   * generator had to repeat a recipe already used earlier the same day
   * (see selectMealPlan's same-day dedup rule in mealPlanGenerator.ts).
   */
  poolTooSmallWarning: boolean;
}

export interface GeneratedMealPlan {
  days: GeneratedMealPlanDay[];
  summary: GeneratedMealPlanSummary;
}

// ---------------------------------------------------------------------------
// Health  (HANDOFF_health-tab-v1.md — collections: user_health_profiles,
// weight_logs, meal_logs, nutrition_coach_history. All secret-tier per
// CLAUDE.md §4: at-rest encrypted (Atlas native), never logged to
// console/error output. V1 is single-user, no auth.)
// ---------------------------------------------------------------------------

export type HealthGoal = "lose" | "maintain" | "gain";

/** One doc total in V1 (single user). Manually editable at any time — not a
 * one-shot onboarding step. */
export interface UserHealthProfile {
  heightCm: number;
  weightKg: number;
  goal: HealthGoal;
  targetWeightKg: number;
  updatedAt: ISODate;
}

/** Historical timeline, separate from UserHealthProfile.weightKg (which is
 * just "latest known weight" for quick reads elsewhere). */
export interface WeightLogEntry {
  _id: ObjectIdHex;
  weightKg: number;
  loggedAt: ISODate;
}

export type MealLogSource = "photo" | "barcode" | "manual";

/** "What was actually eaten" — deliberately separate from MealPlanEntry
 * ("what's planned"), never joined. photoUrl is always null in V1: photos are
 * analyzed in-memory (OpenRouter vision) and discarded, same as the Fridge
 * OCR/scan-fridge flow — no image storage pipeline exists in this app. */
export interface MealLogEntry {
  _id: ObjectIdHex;
  photoUrl: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  description: string;
  loggedAt: ISODate;
  source: MealLogSource;
}

export interface MealLogTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Append-only chat log for the AI Nutrition Coach (Part B, not yet built —
 * type land now so the milestone 1 schema is stable). */
export interface NutritionCoachMessage {
  _id: ObjectIdHex;
  role: "user" | "assistant";
  content: string;
  createdAt: ISODate;
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

// ---------------------------------------------------------------------------
// Recipe drafts  (HANDOFF_daily-recipe-draft-agent.md + gap-aware addendum)
//
// New collection `recipe_drafts` — AI-authored candidates awaiting human
// review. Never a source for /api/recipes until approved (copied into
// `recipes`+`recipe_cost` at that point, see adminRecipeDrafts.ts).
// ---------------------------------------------------------------------------

export type RecipeDraftStatus = "pending" | "approved" | "rejected";

/** Which slot×dietary gap (if any) this draft was generated to fill — shown on the admin review card so Jackie can eyeball tag-correctness before approving. */
export interface GapTarget {
  slot: MealSlot;
  dietary: string;
  countBefore: number;
}

export interface RecipeDraft {
  _id: ObjectIdHex;
  title: string;
  description: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  mealType?: string;
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  nutrition: RecipeNutrition;
  status: RecipeDraftStatus;
  createdAt: ISODate;
  /** Dish name from the Spoonacular inspiration, debug-only — never the full Spoonacular text. */
  sourceInspiration: string;
  /** Present only for the 5/20 daily drafts generated to target a specific pool gap. */
  gapTarget?: GapTarget;
  /** Cost preview computed at draft time (same engine as recipe_cost), so the admin card can show adjustedCoveragePct before approval. */
  costPreview?: RecipeListItemCost | null;
  /** Set only for social-import drafts (HANDOFF_recipe-social-import.md). Null/undefined for AI daily drafts. */
  sourceUrl?: string;
  sourcePlatform?: "tiktok" | "instagram" | "facebook" | "pinterest" | "youtube" | null;
  /** Debug field, mirrors sourceInspiration convention — which tier actually produced this draft. */
  importMethod?: "jsonld" | "oembed-caption" | "manual-paste" | "photo-ocr";
}

/** One cell of the 4 (meal slot) x 10 (DIETARY_FILTERS key) gap matrix. */
// ---------------------------------------------------------------------------
// Fridge stock  (HANDOFF_fridge.md — collection: fridge_stock)
//
// Single-user app, no userId field (same convention as meal_plans/recipe_drafts).
// ---------------------------------------------------------------------------

export type FridgeStockSource = "manual" | "ocr" | "shop-auto" | "photo-scan";

export interface FridgeStockItem {
  _id: ObjectIdHex;
  ingredientName: string;
  canonicalIngredientId: ObjectIdHex | null;
  quantity: number;
  unit: string;
  addedAt: ISODate;
  expiresAt: ISODate;
  expiresAtIsManualOverride: boolean;
  source: FridgeStockSource;
  needsRestock: boolean;
}

export interface GapMatrixCell {
  slot: MealSlot;
  dietary: string;
  count: number;
}

/** Rotation + gap-verification state (collection: recipe_draft_state — single doc). */
export interface RecipeDraftState {
  _id: ObjectIdHex;
  lastCuisineIndex: number;
  lastDietIndex: number;
  gapTargetHistory: Array<{
    date: string;
    targets: GapTarget[];
  }>;
  updatedAt: ISODate;
}

// ---------------------------------------------------------------------------
// Meal suggestions  (HANDOFF_tonight-suggestion.md — GET /api/meal-suggestions)
//
// Instant, single-meal, fridge-aware suggestions. Query-only, never calls AI
// and never writes meal_plans (the caller POSTs to the existing /api/meal-plan
// route itself if the user chooses to add one).
// ---------------------------------------------------------------------------

export interface MealSuggestion {
  recipeId: ObjectIdHex;
  title: string;
  imageUrl: string;
  /** Null only in the (expected-empty) case a >=80%-coverage candidate somehow lacks a cost doc. */
  cost: RecipeListItemCost | null;
  calories: number | null;
  /** Sum of expiry-weighted fridge_stock matches (see HANDOFF for the 3/2/1 weighting). */
  fridgeMatchScore: number;
  /** Fridge item names that matched this recipe's ingredients, for the "uses N items expiring soon" UI hint. */
  matchedFridgeItems: string[];
}

export interface MealSuggestionsResponse {
  mealType: MealSlot;
  suggestions: MealSuggestion[];
}

// ---------------------------------------------------------------------------
// Favourite recipes  (HANDOFF_meal-planner-plan-v2.md §2.2 — collection: favourite_recipes)
//
// Deliberately independent of Recipe.isFavorite/favoriteCount (unused legacy
// fields on the recipe doc itself) — see handoff for why these aren't reused.
// ---------------------------------------------------------------------------

export interface FavouriteRecipe {
  _id: ObjectIdHex;
  recipeId: ObjectIdHex;
  addedAt: ISODate;
}

// ---------------------------------------------------------------------------
// Shop tab V1  (HANDOFF_shop-tab-v1.md)
// ---------------------------------------------------------------------------

/** One fridge_stock item flagged needsRestock, joined with its cheapest price (if resolvable). */
export interface ShopRestockItem {
  fridgeStockId: ObjectIdHex;
  ingredientName: string;
  quantity: number;
  unit: string;
  cheapest: { store: string; price: number } | null;
}

/** Manual, non-canonical shopping list item (collection: shopping_list_items) — e.g. toilet roll,
 * not tied to canonical_ingredients, no price match in V1. */
export interface ShoppingListItem {
  _id: ObjectIdHex;
  text: string;
  checked: boolean;
  addedAt: ISODate;
}

/** HANDOFF_meal-plan-shopping-list-fridge-merge.md §2 — dedupe an aggregated meal-plan
 * ingredient against fridge_stock before adding to shopping_list_items. */
export interface ShoppingListFromIngredientRequest {
  ingredientName: string;
  canonicalName?: string;
}

export type ShoppingListFromIngredientResponse =
  | { merged: true }
  | { merged: false; added: true; item: ShoppingListItem };

export const API_VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// Ingredient text guard  (HANDOFF_recipe-import-french-label-bug-execute.md
// decision 2 — catches the 2026-03-14 open_food_facts bug class: a whole
// product-ingredients-label string comma-split into fake ingredient lines,
// each with quantity:0/unit:''. Deliberately NOT language-based — 2 of the 8
// known-bad recipes were in English, so a French/non-ASCII detector alone
// misses half the class. The "N consecutive quantity=0/unit='' lines" shape
// is what all 8 have in common regardless of language.
//
// Shared (not pipeline-specific) because which future ingestion path will hit
// this is unknown — wired into every current write path that can set
// recipes.isPublic=true or edit a live recipe's ingredients: the Rice draft
// approval flow (adminRecipeDrafts.ts), themealdb_import.cjs, and the admin
// live-recipe editor (adminRecipes.ts).
// ---------------------------------------------------------------------------

export interface IngredientTextGuardLine {
  quantity: number;
  unit: string;
}

export interface IngredientTextGuardResult {
  suspicious: boolean;
  /** Longest run of consecutive quantity===0 && unit==='' lines found. */
  maxConsecutiveZeroQtyRun: number;
  reason?: string;
}

/** Trip threshold: >=3 consecutive zero-qty/no-unit lines. The smallest of the
 * 8 known-bad recipes had 9/9 lines trip this; ordinary recipes with the
 * occasional "salt to taste" (quantity 0, unit '') line don't run 3 in a row. */
export const INGREDIENT_TEXT_GUARD_THRESHOLD = 3;

export function ingredientTextGuard(lines: IngredientTextGuardLine[]): IngredientTextGuardResult {
  let maxRun = 0;
  let currentRun = 0;
  for (const line of lines) {
    if (line.quantity === 0 && line.unit === "") {
      currentRun += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  const suspicious = maxRun >= INGREDIENT_TEXT_GUARD_THRESHOLD;
  return {
    suspicious,
    maxConsecutiveZeroQtyRun: maxRun,
    reason: suspicious
      ? `${maxRun} consecutive ingredient lines with quantity===0 && unit==='' — looks like an unparsed comma-separated ingredients-label blob rather than a real recipe ingredient list.`
      : undefined,
  };
}
