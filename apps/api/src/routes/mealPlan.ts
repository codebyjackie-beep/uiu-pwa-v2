import { Hono } from "hono";
import type { Db, Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  ApiResponse,
  GeneratedMealPlan,
  MealPlanEntry,
  MealPlanEntryView,
  MealPlanGeneratorInput,
  MealPlanVariation,
  MealSlot,
  RecipeDetailCostLine,
  UkAllergen,
} from "@uiu/shared";
import { UK_ALLERGENS } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { buildPool, generateMealPlan } from "../services/mealPlanGenerator";

export const mealPlanRouter = new Hono<{ Bindings: DbEnv }>();

const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const VARIATIONS: MealPlanVariation[] = ["low", "medium", "high"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | undefined): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

/** Mon=1...Sun=7, matching apps/web/app/lib/dates.ts's WEEKDAY_LABELS order. */
function isoWeekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
}

/** Same trimming as recipes.ts's toDetailCost, duplicated here (small, route-local) so the
 * Meals tab ingredient breakdown (HANDOFF_meal-planner-plan-v2.md §2.2) doesn't need a
 * per-entry extra fetch of GET /api/recipes/:id. */
function toCostLines(costDoc: Document | undefined): RecipeDetailCostLine[] {
  if (!costDoc) return [];
  return ((costDoc.lines as Document[]) ?? []).map((line) => ({
    rawName: line.rawName as string,
    quantity: line.quantity as number,
    rawUnit: line.rawUnit as string,
    priceable: line.priceable as boolean,
    lineCost: line.lineCost as number | undefined,
    store: line.store as string | undefined,
    productTitle: line.productTitle as string | null | undefined,
    canonicalName: line.canonical_name as string | undefined,
    normValue: line.normValue as number | undefined,
    normUnit: line.normUnit as "g" | "ml" | "pc" | undefined,
  }));
}

export function toEntryView(doc: Document, recipeById: Map<string, Document>, costByRecipeId: Map<string, Document>): MealPlanEntryView {
  const recipeId = (doc.recipeId as ObjectIdType).toString();
  const recipe = recipeById.get(recipeId);
  const cost = costByRecipeId.get(recipeId);
  const nutrition = recipe?.nutrition as Document | undefined;
  const ingredients = Array.isArray(recipe?.ingredients) ? (recipe!.ingredients as Document[]) : [];
  return {
    _id: (doc._id as ObjectIdType).toString(),
    planId: (doc.planId as ObjectIdType).toString(),
    dayIndex: doc.dayIndex as number,
    mealSlot: doc.mealSlot as MealSlot,
    recipeId,
    servings: doc.servings as number,
    recipe: {
      title: (recipe?.title as string) ?? "Recipe unavailable",
      imageUrl: (recipe?.imageUrl as string) ?? "",
      calories: recipe ? Math.round((nutrition?.calories as number) ?? 0) : null,
      costPerServing: cost ? (cost.perServing as number) : null,
      protein: (nutrition?.protein as number | undefined) ?? null,
      carbs: (nutrition?.carbs as number | undefined) ?? null,
      fat: (nutrition?.fat as number | undefined) ?? null,
      prepTimeMinutes: (recipe?.prepTimeMinutes as number | undefined) ?? 0,
      cookTimeMinutes: (recipe?.cookTimeMinutes as number | undefined) ?? 0,
      ingredientNames: ingredients.map((i) => String(i.name ?? "").trim().toLowerCase()).filter(Boolean),
      costLines: toCostLines(cost),
    },
  };
}

/** Joins a plan's meal_plans entries against recipes/recipe_cost in two batched queries.
 * Shared by mealPlanSets.ts (per-card board) so the recipe/cost join logic lives in one place. */
export async function loadEntryViewsForPlan(db: Db, ObjectId: Awaited<ReturnType<typeof getMongoModule>>["ObjectId"], planId: InstanceType<typeof ObjectId>): Promise<MealPlanEntryView[]> {
  const entryDocs = await db
    .collection("meal_plans")
    .find({ planId })
    .sort({ dayIndex: 1, mealSlot: 1 })
    .toArray();

  const recipeIds = [...new Set(entryDocs.map((d) => (d.recipeId as ObjectIdType).toString()))].map(
    (id) => new ObjectId(id),
  );
  const [recipeDocs, costDocs] = await Promise.all([
    recipeIds.length ? db.collection("recipes").find({ _id: { $in: recipeIds } }).toArray() : [],
    recipeIds.length ? db.collection("recipe_cost").find({ recipeId: { $in: recipeIds } }).toArray() : [],
  ]);
  const recipeById = new Map(recipeDocs.map((d) => [(d._id as ObjectIdType).toString(), d]));
  const costByRecipeId = new Map(costDocs.map((d) => [(d.recipeId as ObjectIdType).toString(), d]));

  return entryDocs.map((d) => toEntryView(d, recipeById, costByRecipeId));
}

/**
 * Resolves the write target for a new entry. Preferred path: explicit `planId`+`dayIndex`
 * (MealPlannerBoard's "+Add" picker, TonightSuggestion — both plan-card-aware now). Legacy
 * fallback: a bare `date` (still sent by MealPlanWizard.tsx's confirm step, deferred to
 * HANDOFF_ai-meal-plan-generator.md's own handoff per HANDOFF_meal-planner-multi-plan-library.md
 * §2 — not touched in this pass) resolves against whichever plan is currently active, using the
 * date's weekday as dayIndex, so the wizard keeps working unmodified against the new schema.
 */
async function resolveWriteTarget(
  db: Db,
  ObjectIdCtor: Awaited<ReturnType<typeof getMongoModule>>["ObjectId"],
  payload: Record<string, unknown> | null,
): Promise<{ planId: InstanceType<typeof ObjectIdCtor>; dayIndex: number } | "bad_request" | "no_active_plan"> {
  const rawPlanId = payload?.planId as string | undefined;
  const rawDayIndex = payload?.dayIndex as number | undefined;
  if (typeof rawPlanId === "string" && typeof rawDayIndex === "number") {
    if (!ObjectIdCtor.isValid(rawPlanId) || rawDayIndex < 1 || rawDayIndex > 7) return "bad_request";
    return { planId: new ObjectIdCtor(rawPlanId), dayIndex: rawDayIndex };
  }

  const date = payload?.date as string | undefined;
  if (!isValidDate(date)) return "bad_request";
  const active = await db.collection("meal_plan_sets").findOne({ isActive: true });
  if (!active) return "no_active_plan";
  return { planId: active._id as InstanceType<typeof ObjectIdCtor>, dayIndex: isoWeekdayOf(date) };
}

mealPlanRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const mealSlot = payload?.mealSlot as string | undefined;
  const recipeId = payload?.recipeId as string | undefined;

  if (!mealSlot || !MEAL_SLOTS.includes(mealSlot as MealSlot) || typeof recipeId !== "string") {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: "mealSlot and recipeId are required (plus planId+dayIndex, or a legacy date)" },
    };
    return c.json(body, 400);
  }

  try {
    const { ObjectId } = await getMongoModule();
    if (!ObjectId.isValid(recipeId)) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid recipeId" } };
      return c.json(body, 400);
    }

    const result = await withDb(c.env, async (db) => {
      const target = await resolveWriteTarget(db, ObjectId, payload);
      if (target === "bad_request" || target === "no_active_plan") return target;

      const recipe = await db.collection("recipes").findOne({ _id: new ObjectId(recipeId) });
      if (!recipe) return null;

      const now = new Date().toISOString();
      const doc = {
        planId: target.planId,
        dayIndex: target.dayIndex,
        mealSlot,
        recipeId: new ObjectId(recipeId),
        // Always 1 — a meal-plan entry is one planned portion of this recipe for this
        // slot, not "how many servings the recipe yields" (recipe.servings). The app
        // has no per-meal headcount setting, so cost/calories are never scaled by it.
        servings: typeof payload?.servings === "number" && payload.servings > 0 ? payload.servings : 1,
        createdAt: now,
      };
      const inserted = await db.collection("meal_plans").insertOne(doc);
      const costDoc = await db.collection("recipe_cost").findOne({ recipeId: recipe._id });
      return toEntryView({ ...doc, _id: inserted.insertedId }, new Map([[recipeId, recipe]]), costDoc ? new Map([[recipeId, costDoc]]) : new Map());
    });

    if (result === "bad_request") {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "planId+dayIndex (1-7) or a valid date is required" } };
      return c.json(body, 400);
    }
    if (result === "no_active_plan") {
      const body: ApiResponse<never> = { ok: false, error: { code: "no_active_plan", message: "No active plan to add this meal to" } };
      return c.json(body, 409);
    }
    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }

    const body: ApiResponse<MealPlanEntry & { recipe: MealPlanEntryView["recipe"] }> = { ok: true, data: result as never };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] meal-plan create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to add meal plan entry" } };
    return c.json(body, 502);
  }
});

/**
 * Refresh icon (HANDOFF_meal-planner-plan-v2.md §2.2 #1) — swaps this slot's recipe for
 * another eligible one for the same mealSlot, reusing buildPool's slot-eligibility logic
 * (mealPlanGenerator.ts) rather than a new algorithm. No cost/calorie target to score
 * against for a single-slot refresh, so selection among eligible candidates (excluding the
 * current recipe) is a plain random pick, not chooseBest's weighted scoring — that scoring
 * exists to balance a whole week against a budget, which doesn't apply here.
 */
mealPlanRouter.post("/:id/refresh", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid meal plan entry id" } };
    return c.json(body, 400);
  }

  try {
    const result = await withDb(c.env, async (db) => {
      const entryDoc = await db.collection("meal_plans").findOne({ _id: new ObjectId(id) });
      if (!entryDoc) return null;

      const pool = await buildPool(c.env);
      const currentRecipeId = (entryDoc.recipeId as ObjectIdType).toString();
      const slot = entryDoc.mealSlot as MealSlot;
      const slotPool = pool.filter((r) => r.mealSlots.has(slot));
      const otherCandidates = slotPool.filter((r) => r.id !== currentRecipeId);
      const candidates = otherCandidates.length > 0 ? otherCandidates : slotPool;
      if (candidates.length === 0) return "no_candidates" as const;

      const chosen = candidates[Math.floor(Math.random() * candidates.length)]!;
      const chosenObjectId = new ObjectId(chosen.id);
      await db.collection("meal_plans").updateOne({ _id: entryDoc._id }, { $set: { recipeId: chosenObjectId } });

      const [recipe, costDoc] = await Promise.all([
        db.collection("recipes").findOne({ _id: chosenObjectId }),
        db.collection("recipe_cost").findOne({ recipeId: chosenObjectId }),
      ]);
      return toEntryView(
        { ...entryDoc, recipeId: chosenObjectId },
        recipe ? new Map([[chosen.id, recipe]]) : new Map(),
        costDoc ? new Map([[chosen.id, costDoc]]) : new Map(),
      );
    });

    if (result === null) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Meal plan entry not found" } };
      return c.json(body, 404);
    }
    if (result === "no_candidates") {
      const body: ApiResponse<never> = { ok: false, error: { code: "no_candidates", message: "No other eligible recipe for this slot" } };
      return c.json(body, 409);
    }

    const body: ApiResponse<MealPlanEntryView> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan refresh error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to refresh meal plan entry" } };
    return c.json(body, 502);
  }
});

/**
 * Wizard-driven preview (HANDOFF_ai-meal-plan-generator.md Part B). Read-only —
 * builds a candidate plan via the Part A service but writes nothing. The
 * wizard UI posts each chosen entry to POST /api/meal-plan individually once
 * the user confirms (existing route above), so this endpoint has no write
 * path of its own.
 */
mealPlanRouter.post("/generate", async (c) => {
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }

  const lengthDays = Number(payload.lengthDays);
  const weeklyBudgetGBP = Number(payload.weeklyBudgetGBP);
  const mealSlots = Array.isArray(payload.mealSlots) ? (payload.mealSlots as unknown[]).filter((s): s is MealSlot => MEAL_SLOTS.includes(s as MealSlot)) : [];
  const variation = VARIATIONS.includes(payload.variation) ? (payload.variation as MealPlanVariation) : null;
  const cuisines = Array.isArray(payload.cuisines) ? (payload.cuisines as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const dietary = Array.isArray(payload.dietary) ? (payload.dietary as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const allergens = Array.isArray(payload.allergens)
    ? (payload.allergens as unknown[]).filter((s): s is UkAllergen => UK_ALLERGENS.includes(s as UkAllergen))
    : [];
  const excludeKeywords = Array.isArray(payload.excludeKeywords) ? (payload.excludeKeywords as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const marketPriority = typeof payload.marketPriority === "string" ? payload.marketPriority : undefined;
  const calorieTargetPerDay = payload.calorieTargetPerDay != null && Number.isFinite(Number(payload.calorieTargetPerDay)) ? Number(payload.calorieTargetPerDay) : undefined;
  const startDate = isValidDate(payload.startDate) ? payload.startDate : undefined;

  if (!Number.isFinite(lengthDays) || lengthDays < 1 || lengthDays > 31) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "lengthDays must be between 1 and 31" } };
    return c.json(body, 400);
  }
  if (!Number.isFinite(weeklyBudgetGBP) || weeklyBudgetGBP <= 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "weeklyBudgetGBP must be a positive number" } };
    return c.json(body, 400);
  }
  if (mealSlots.length === 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "mealSlots must include at least one of breakfast/lunch/dinner/snack" } };
    return c.json(body, 400);
  }
  if (!variation) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "variation must be one of low/medium/high" } };
    return c.json(body, 400);
  }

  const input: MealPlanGeneratorInput = {
    lengthDays,
    weeklyBudgetGBP,
    mealSlots,
    variation,
    cuisines,
    dietary,
    allergens,
    excludeKeywords,
    marketPriority,
    calorieTargetPerDay,
    startDate,
  };

  try {
    const plan = await generateMealPlan(c.env, input);
    const body: ApiResponse<GeneratedMealPlan> = { ok: true, data: plan };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan generate error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to generate meal plan" } };
    return c.json(body, 502);
  }
});

mealPlanRouter.delete("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid meal plan entry id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("meal_plans").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Meal plan entry not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete meal plan entry" } };
    return c.json(body, 502);
  }
});
