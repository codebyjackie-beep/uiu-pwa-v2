import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  ApiResponse,
  Recipe,
  RecipeDetail,
  RecipeDetailCost,
  RecipeDetailCostLine,
  RecipeListItem,
  RecipeListPage,
} from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { optionalClerkUserId, type ClerkAuthEnv } from "../clerkAuth";

export const recipesRouter = new Hono<{ Bindings: DbEnv & ClerkAuthEnv }>();

const DEFAULT_LIMIT = 20;
// Per-request page cap. Clients that need the whole set (Recipes page) page through using
// `total` rather than relying on this being larger than the collection.
const MAX_LIMIT = 250;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function toDetailCost(costDoc: Document | null, pantryNames: Set<string> = new Set()): RecipeDetailCost | null {
  if (!costDoc || (costDoc.basket as number) <= 0) return null;
  const lines: RecipeDetailCostLine[] = ((costDoc.lines as Document[]) ?? []).map((line) => ({
    rawName: line.rawName as string,
    quantity: line.quantity as number,
    rawUnit: line.rawUnit as string,
    priceable: line.priceable as boolean,
    lineCost: line.lineCost as number | undefined,
    store: line.store as string | undefined,
    productTitle: line.productTitle as string | null | undefined,
    canonicalName: line.canonical_name as string | undefined,
    ...(!line.priceable && typeof line.canonical_name === "string" && pantryNames.has(line.canonical_name) ? { isPantry: true } : {}),
    normValue: line.normValue as number | undefined,
    normUnit: line.normUnit as "g" | "ml" | "pc" | undefined,
  }));
  return {
    basket: costDoc.basket as number,
    currency: "GBP",
    perServing: costDoc.perServing as number,
    adjustedCoveragePct: costDoc.adjustedCoveragePct as number,
    lines,
    priceCacheStamp: typeof costDoc.priceCacheStamp === "number" ? costDoc.priceCacheStamp : 0,
  };
}

function toListItem(doc: Document, cost: RecipeListItem["cost"]): RecipeListItem {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    title: doc.title as string,
    description: doc.description as string,
    imageUrl: doc.imageUrl as string,
    cookTimeMinutes: doc.cookTimeMinutes as number,
    prepTimeMinutes: doc.prepTimeMinutes as number,
    servings: doc.servings as number,
    tags: Array.isArray(doc.tags) ? (doc.tags as string[]) : [],
    mealType: doc.mealType as string | undefined,
    nutrition: doc.nutrition as RecipeListItem["nutrition"],
    cost,
    ingredientCount: Array.isArray(doc.ingredients) ? doc.ingredients.length : 0,
    enrichmentAttempted: doc.enrichmentAttempted as boolean | undefined,
    nutritionUnavailable: doc.nutritionUnavailable as boolean | undefined,
  };
}

recipesRouter.get("/", async (c) => {
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;
  const pageParam = Number(c.req.query("page"));
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const tag = c.req.query("tag");
  const q = c.req.query("q");

  const filter: Document = { isPublic: true };
  if (tag) filter.tags = tag;
  if (q) filter.title = { $regex: escapeRegex(q), $options: "i" };

  try {
    const { items, total } = await withDb(c.env, async (db) => {
      const collection = db.collection("recipes");
      const [docs, count] = await Promise.all([
        collection
          .find(filter)
          // _id tiebreak keeps skip/limit pagination stable when titles collide, so a client
          // paging through the full set never sees a duplicate or skips a row.
          .sort({ title: 1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        collection.countDocuments(filter),
      ]);

      const ids = docs.map((d) => d._id as ObjectIdType);
      const costDocs = ids.length
        ? await db
            .collection("recipe_cost")
            .find({ recipeId: { $in: ids } })
            .toArray()
        : [];
      const costByRecipeId = new Map<string, RecipeListItem["cost"]>();
      for (const costDoc of costDocs) {
        costByRecipeId.set((costDoc.recipeId as ObjectIdType).toString(), {
          basket: costDoc.basket as number,
          currency: "GBP",
          perServing: costDoc.perServing as number,
          adjustedCoveragePct: costDoc.adjustedCoveragePct as number,
        });
      }

      const items = docs.map((d) => toListItem(d, costByRecipeId.get((d._id as ObjectIdType).toString()) ?? null));
      return { items, total: count };
    });

    const body: ApiResponse<RecipeListPage> = {
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
    // Public route: guests read public recipes. A non-public recipe is only returned to its owner
    // (verified Clerk token); everyone else gets the same 404 as a missing id so existence isn't leaked.
    const { doc, costDoc, pantryNames } = await withDb(c.env, async (db) => {
      let doc = await db.collection("recipes").findOne({ _id: new ObjectId(id) });
      if (doc && doc.isPublic !== true) {
        const clerkUserId = await optionalClerkUserId(c);
        let isOwner = false;
        if (clerkUserId) {
          if (doc.clerkUserId === clerkUserId) isOwner = true;
          else if (doc.userId) {
            const user = await db.collection("users").findOne({ clerkUserId }, { projection: { _id: 1 } });
            isOwner = !!user && String(user._id) === String(doc.userId);
          }
        }
        if (!isOwner) doc = null;
      }
      if (!doc) return { doc: null, costDoc: null, pantryNames: new Set<string>() };
      const costDoc = await db.collection("recipe_cost").findOne({ recipeId: doc._id });
      // Display only: which unpriced lines are pantry staples ("Pantry staple" instead of "Price unavailable").
      const unpricedNames = [
        ...new Set(((costDoc?.lines as Document[]) ?? []).filter((l) => !l.priceable && typeof l.canonical_name === "string").map((l) => l.canonical_name as string)),
      ];
      const pantryDocs = unpricedNames.length
        ? await db
            .collection("canonical_ingredients")
            .find({ canonical_name: { $in: unpricedNames }, $or: [{ is_pantry: true }, { pantry_staple: true }] }, { projection: { canonical_name: 1 } })
            .toArray()
        : [];
      return { doc, costDoc, pantryNames: new Set(pantryDocs.map((d) => d.canonical_name as string)) };
    });
    if (!doc) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<RecipeDetail> = { ok: true, data: { ...toRecipe(doc), cost: toDetailCost(costDoc, pantryNames) } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipe" } };
    return c.json(body, 502);
  }
});
