import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  ApiResponse,
  MealPlanDaySummary,
  MealPlanEntry,
  MealPlanEntryView,
  MealPlanWeekResponse,
  MealSlot,
} from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";

export const mealPlanRouter = new Hono<{ Bindings: DbEnv }>();

const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | undefined): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

function toEntryView(doc: Document, recipeById: Map<string, Document>, costByRecipeId: Map<string, Document>): MealPlanEntryView {
  const recipeId = (doc.recipeId as ObjectIdType).toString();
  const recipe = recipeById.get(recipeId);
  const cost = costByRecipeId.get(recipeId);
  return {
    _id: (doc._id as ObjectIdType).toString(),
    date: doc.date as string,
    mealSlot: doc.mealSlot as MealSlot,
    recipeId,
    servings: doc.servings as number,
    recipe: {
      title: (recipe?.title as string) ?? "Recipe unavailable",
      imageUrl: (recipe?.imageUrl as string) ?? "",
      calories: recipe ? Math.round((recipe.nutrition as Document)?.calories as number) : null,
      costPerServing: cost ? (cost.perServing as number) : null,
    },
  };
}

mealPlanRouter.get("/", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!isValidDate(start) || !isValidDate(end)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "start and end query params must be YYYY-MM-DD" } };
    return c.json(body, 400);
  }

  try {
    const { ObjectId } = await getMongoModule();
    const data = await withDb(c.env, async (db) => {
      const entryDocs = await db
        .collection("meal_plans")
        .find({ date: { $gte: start, $lte: end } })
        .sort({ date: 1, mealSlot: 1 })
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
    });

    const dayMap = new Map<string, MealPlanEntryView[]>();
    for (const entry of data) {
      const list = dayMap.get(entry.date) ?? [];
      list.push(entry);
      dayMap.set(entry.date, list);
    }

    const days: MealPlanDaySummary[] = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({
        date,
        entries,
        totalCost: entries.reduce((sum, e) => sum + (e.recipe.costPerServing ?? 0) * e.servings, 0),
        totalCalories: entries.reduce((sum, e) => sum + (e.recipe.calories ?? 0) * e.servings, 0),
      }));

    const body: ApiResponse<MealPlanWeekResponse> = {
      ok: true,
      data: {
        start,
        end,
        days,
        weekTotalCost: days.reduce((sum, d) => sum + d.totalCost, 0),
        weekTotalCalories: days.reduce((sum, d) => sum + d.totalCalories, 0),
      },
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-plan list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch meal plan" } };
    return c.json(body, 502);
  }
});

mealPlanRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const date = payload?.date as string | undefined;
  const mealSlot = payload?.mealSlot as string | undefined;
  const recipeId = payload?.recipeId as string | undefined;

  if (!isValidDate(date) || !mealSlot || !MEAL_SLOTS.includes(mealSlot as MealSlot) || typeof recipeId !== "string") {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: "date (YYYY-MM-DD), mealSlot, and recipeId are required" },
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
      const recipe = await db.collection("recipes").findOne({ _id: new ObjectId(recipeId) });
      if (!recipe) return null;

      const now = new Date().toISOString();
      const doc = {
        date,
        mealSlot,
        recipeId: new ObjectId(recipeId),
        servings: typeof payload?.servings === "number" && payload.servings > 0 ? payload.servings : (recipe.servings as number),
        createdAt: now,
      };
      const inserted = await db.collection("meal_plans").insertOne(doc);
      const costDoc = await db.collection("recipe_cost").findOne({ recipeId: recipe._id });
      return toEntryView({ ...doc, _id: inserted.insertedId }, new Map([[recipeId, recipe]]), costDoc ? new Map([[recipeId, costDoc]]) : new Map());
    });

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
