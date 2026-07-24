import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, Recipe } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";

export const recipesRouter = new Hono<{ Bindings: DbEnv }>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toRecipe(doc: Document): Recipe {
  return {
    ...(doc as unknown as Recipe),
    _id: (doc._id as ObjectIdType).toString(),
    userId: doc.userId ? (doc.userId as ObjectIdType).toString() : null,
    collectionIds: Array.isArray(doc.collectionIds)
      ? doc.collectionIds.map((id: ObjectIdType) => id.toString())
      : [],
  };
}

recipesRouter.get("/", async (c) => {
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;
  const pageParam = Number(c.req.query("page"));
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const tag = c.req.query("tag");

  const filter: Document = { isPublic: true };
  if (tag) filter.tags = tag;

  try {
    const { items, total } = await withDb(c.env, async (db) => {
      const collection = db.collection("recipes");
      const [docs, count] = await Promise.all([
        collection
          .find(filter)
          .sort({ title: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        collection.countDocuments(filter),
      ]);
      return { items: docs.map(toRecipe), total: count };
    });

    const body: ApiResponse<{ items: Recipe[]; page: number; limit: number; total: number }> = {
      ok: true,
      data: { items, page, limit, total },
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipes list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipes" } };
    return c.json(body, 502);
  }
});

recipesRouter.get("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid recipe id" } };
    return c.json(body, 400);
  }

  try {
    const doc = await withDb(c.env, (db) => db.collection("recipes").findOne({ _id: new ObjectId(id) }));
    if (!doc) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<Recipe> = { ok: true, data: toRecipe(doc) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipe" } };
    return c.json(body, 502);
  }
});
