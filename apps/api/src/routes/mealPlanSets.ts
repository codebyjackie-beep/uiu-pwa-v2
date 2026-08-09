import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, MealPlanDaySummary, MealPlanGeneratorInput, MealPlanSetDetail, MealPlanSetSummary } from "@uiu/shared";
import { MEAL_PLAN_SET_LIMIT } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { loadEntryViewsForPlan } from "./mealPlan";
import { generateMealPlan } from "../services/mealPlanGenerator";

/**
 * Same defaults MealPlanWizard.tsx (HANDOFF_ai-meal-plan-generator.md Part B)
 * pre-fills on load — "Build a plan for me" reuses the Part A generator
 * headlessly with these, skipping the 9-question wizard UI entirely rather
 * than asking anything.
 */
const AUTO_FILL_INPUT: MealPlanGeneratorInput = {
  lengthDays: 7,
  weeklyBudgetGBP: 40,
  mealSlots: ["breakfast", "lunch", "dinner"],
  variation: "medium",
  cuisines: [],
  dietary: [],
  allergens: [],
  excludeKeywords: [],
};

export const mealPlanSetsRouter = new Hono<{ Bindings: DbEnv }>();

type SummaryEntry = {
  dayIndex: number;
  recipe: {
    title: string;
    costPerServing: number | null;
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
  };
};

function toSummary(setDoc: Document, entries: SummaryEntry[]): MealPlanSetSummary {
  const previewByDay = [...new Map(entries.map((e) => [e.dayIndex, e])).values()]
    .sort((a, b) => a.dayIndex - b.dayIndex)
    .slice(0, 3)
    .map((e) => ({ dayIndex: e.dayIndex, recipeTitle: e.recipe.title }));

  return {
    _id: (setDoc._id as ObjectIdType).toString(),
    name: setDoc.name as string,
    isActive: setDoc.isActive as boolean,
    createdAt: setDoc.createdAt as string,
    weekTotalCost: entries.reduce((sum, e) => sum + (e.recipe.costPerServing ?? 0), 0),
    weekTotalMeals: entries.length,
    weekTotalCalories: entries.reduce((sum, e) => sum + (e.recipe.calories ?? 0), 0),
    weekTotalProtein: entries.reduce((sum, e) => sum + (e.recipe.protein ?? 0), 0),
    weekTotalCarbs: entries.reduce((sum, e) => sum + (e.recipe.carbs ?? 0), 0),
    weekTotalFat: entries.reduce((sum, e) => sum + (e.recipe.fat ?? 0), 0),
    previewByDay,
  };
}

// GET /api/meal-plan-sets — up to 4 plan cards for the library grid.
mealPlanSetsRouter.get("/", async (c) => {
  try {
    const data = await withDb(c.env, async (db) => {
      const { ObjectId } = await getMongoModule();
      const setDocs = await db.collection("meal_plan_sets").find({}).sort({ createdAt: 1 }).toArray();
      const summaries: MealPlanSetSummary[] = [];
      for (const setDoc of setDocs) {
        const entries = await loadEntryViewsForPlan(db, ObjectId, setDoc._id as InstanceType<typeof ObjectId>);
        summaries.push(toSummary(setDoc, entries));
      }
      return summaries;
    });
    const body: ApiResponse<MealPlanSetSummary[]> = { ok: true, data };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan-sets list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch plan cards" } };
    return c.json(body, 502);
  }
});

// POST /api/meal-plan-sets — build a new plan card. Default: auto-filled with 7 days of
// recipes (HANDOFF_meal-planner-multi-plan-library.md gap, fixed 2026-08-09), reusing the
// Part A generator headlessly (AUTO_FILL_INPUT) instead of asking anything, same as
// "Build a plan for me" always has. `skipGenerate: true` creates an empty card instead —
// used by MealPlanWizard.tsx's confirm step (fixed 2026-08-09, see
// summaries/2026-08-09_wizard-confirm-new-card.md) to reserve a planId, then fill it with
// the wizard's own picks via POST /api/meal-plan's planId+dayIndex path, instead of the
// old date-based fallback that overwrote whichever plan was active. Rejects once 4 already exist.
mealPlanSetsRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const name = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
  const skipGenerate = payload?.skipGenerate === true;

  try {
    const { ObjectId } = await getMongoModule();

    const count = await withDb(c.env, (db) => db.collection("meal_plan_sets").countDocuments({}));
    if (count >= MEAL_PLAN_SET_LIMIT) {
      const body: ApiResponse<never> = {
        ok: false,
        error: { code: "plan_limit_reached", message: `Already have ${MEAL_PLAN_SET_LIMIT} plans — delete one before building another.` },
      };
      return c.json(body, 409);
    }

    const generated = skipGenerate ? null : await generateMealPlan(c.env, AUTO_FILL_INPUT);

    const result = await withDb(c.env, async (db) => {
      const now = new Date().toISOString();
      const setDoc = {
        name: name ?? `Weekly Plan ${count + 1}`,
        isActive: false,
        createdAt: now,
      };
      const insertedSet = await db.collection("meal_plan_sets").insertOne(setDoc);
      const planId = insertedSet.insertedId;

      if (generated) {
        const entryDocs = generated.days.flatMap((day, i) =>
          day.entries.map((entry) => ({
            planId,
            dayIndex: i + 1,
            mealSlot: entry.mealSlot,
            recipeId: new ObjectId(entry.recipeId),
            servings: 1,
            createdAt: now,
          })),
        );
        if (entryDocs.length > 0) await db.collection("meal_plans").insertMany(entryDocs);
      }

      const entries = await loadEntryViewsForPlan(db, ObjectId, planId);
      return toSummary({ ...setDoc, _id: planId }, entries);
    });

    const body: ApiResponse<MealPlanSetSummary> = { ok: true, data: result };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] meal-plan-sets create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to create plan card" } };
    return c.json(body, 502);
  }
});

// GET /api/meal-plan-sets/:id — one card's full 7-day board (dayIndex 1-7).
mealPlanSetsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { ObjectId } = await getMongoModule();
    if (!ObjectId.isValid(id)) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid plan id" } };
      return c.json(body, 400);
    }

    const result = await withDb(c.env, async (db) => {
      const setDoc = await db.collection("meal_plan_sets").findOne({ _id: new ObjectId(id) });
      if (!setDoc) return null;

      const entries = await loadEntryViewsForPlan(db, ObjectId, setDoc._id as InstanceType<typeof ObjectId>);
      const dayMap = new Map<number, typeof entries>();
      for (const entry of entries) {
        const list = dayMap.get(entry.dayIndex) ?? [];
        list.push(entry);
        dayMap.set(entry.dayIndex, list);
      }

      const days: MealPlanDaySummary[] = Array.from({ length: 7 }, (_, i) => {
        const dayIndex = i + 1;
        const dayEntries = dayMap.get(dayIndex) ?? [];
        return {
          dayIndex,
          entries: dayEntries,
          totalCost: dayEntries.reduce((sum, e) => sum + (e.recipe.costPerServing ?? 0), 0),
          totalCalories: dayEntries.reduce((sum, e) => sum + (e.recipe.calories ?? 0), 0),
        };
      });

      const detail: MealPlanSetDetail = {
        _id: (setDoc._id as ObjectIdType).toString(),
        name: setDoc.name as string,
        isActive: setDoc.isActive as boolean,
        days,
        weekTotalCost: days.reduce((sum, d) => sum + d.totalCost, 0),
        weekTotalCalories: days.reduce((sum, d) => sum + d.totalCalories, 0),
      };
      return detail;
    });

    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Plan not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<MealPlanSetDetail> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan-sets detail error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch plan" } };
    return c.json(body, 502);
  }
});

// POST /api/meal-plan-sets/:id/activate — makes this the only isActive:true plan.
mealPlanSetsRouter.post("/:id/activate", async (c) => {
  const id = c.req.param("id");
  try {
    const { ObjectId } = await getMongoModule();
    if (!ObjectId.isValid(id)) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid plan id" } };
      return c.json(body, 400);
    }

    const result = await withDb(c.env, async (db) => {
      const objectId = new ObjectId(id);
      const setDoc = await db.collection("meal_plan_sets").findOne({ _id: objectId });
      if (!setDoc) return null;

      await db.collection("meal_plan_sets").updateMany({ _id: { $ne: objectId } }, { $set: { isActive: false } });
      await db.collection("meal_plan_sets").updateOne({ _id: objectId }, { $set: { isActive: true } });
      return true;
    });

    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Plan not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ activated: true }> = { ok: true, data: { activated: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan-sets activate error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to activate plan" } };
    return c.json(body, 502);
  }
});

// DELETE /api/meal-plan-sets/:id — cascades to every meal_plans entry under this plan.
mealPlanSetsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { ObjectId } = await getMongoModule();
    if (!ObjectId.isValid(id)) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid plan id" } };
      return c.json(body, 400);
    }

    const result = await withDb(c.env, async (db) => {
      const objectId = new ObjectId(id);
      const setDoc = await db.collection("meal_plan_sets").findOne({ _id: objectId });
      if (!setDoc) return null;

      await db.collection("meal_plans").deleteMany({ planId: objectId });
      await db.collection("meal_plan_sets").deleteOne({ _id: objectId });
      return { wasActive: setDoc.isActive as boolean };
    });

    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Plan not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true; wasActive: boolean }> = { ok: true, data: { deleted: true, wasActive: result.wasActive } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan-sets delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete plan" } };
    return c.json(body, 502);
  }
});
