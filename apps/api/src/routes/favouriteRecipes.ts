/**
 * HANDOFF_meal-planner-plan-v2.md §2.2 #3 — favourite_recipes CRUD. Independent of
 * Recipe.isFavorite/favoriteCount (unused legacy fields, deliberately not reused — see
 * handoff). No auth, same convention as meal_plans/fridge_stock (not an admin surface).
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, FavouriteRecipe } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";

export const favouriteRecipesRouter = new Hono<{ Bindings: DbEnv }>();

function toFavourite(doc: Document): FavouriteRecipe {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    recipeId: (doc.recipeId as ObjectIdType).toString(),
    addedAt: doc.addedAt as string,
  };
}

favouriteRecipesRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) => db.collection("favourite_recipes").find({}).toArray());
    const body: ApiResponse<FavouriteRecipe[]> = { ok: true, data: docs.map(toFavourite) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] favourite-recipes list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch favourite_recipes" } };
    return c.json(body, 502);
  }
});

favouriteRecipesRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const recipeId = payload?.recipeId as string | undefined;
  if (typeof recipeId !== "string") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "recipeId is required" } };
    return c.json(body, 400);
  }

  try {
    const { ObjectId } = await getMongoModule();
    if (!ObjectId.isValid(recipeId)) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid recipeId" } };
      return c.json(body, 400);
    }

    const result = await withDb(c.env, async (db) => {
      const existing = await db.collection("favourite_recipes").findOne({ recipeId: new ObjectId(recipeId) });
      if (existing) return existing;
      const doc = { recipeId: new ObjectId(recipeId), addedAt: new Date().toISOString() };
      const inserted = await db.collection("favourite_recipes").insertOne(doc);
      return { ...doc, _id: inserted.insertedId };
    });

    const body: ApiResponse<FavouriteRecipe> = { ok: true, data: toFavourite(result) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] favourite-recipes create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to add favourite" } };
    return c.json(body, 502);
  }
});

favouriteRecipesRouter.delete("/:recipeId", async (c) => {
  const { ObjectId } = await getMongoModule();
  const recipeId = c.req.param("recipeId");
  if (!ObjectId.isValid(recipeId)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid recipeId" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("favourite_recipes").deleteOne({ recipeId: new ObjectId(recipeId) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Favourite not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] favourite-recipes delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to remove favourite" } };
    return c.json(body, 502);
  }
});
