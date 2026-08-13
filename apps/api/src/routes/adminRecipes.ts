/**
 * Admin API for editing already-live `recipes` (as opposed to recipe_drafts).
 * X-Admin-Token protected, same convention as adminRecipeDrafts.ts.
 *
 * Deliberately separate from the drafts approve flow: that flow does `recipes.insertOne(...)`,
 * assigning a NEW _id, which would break existing meal_plans/recipe_cost recipeId references
 * for any of the 200 live recipes routed through it. This router only ever does `updateOne`
 * against an existing _id — the _id itself is never read from the request body or changed.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import { ingredientTextGuard, type ApiResponse, type Recipe } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";

export const adminRecipesRouter = new Hono<{ Bindings: DbEnv & { ADMIN_TOKEN: string } & PexelsEnv }>();

function checkAdminToken(token: string | undefined, expected: string): boolean {
  return !!token && token === expected;
}

/** Same field set the recipe-drafts edit form exposes, minus fields that don't apply to a
 * live recipe (status/createdAt/sourceInspiration/gapTarget/costPreview are draft-only). */
const EDITABLE_FIELDS = ["title", "description", "ingredients", "steps", "tags", "servings", "prepTimeMinutes", "cookTimeMinutes"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type RecipePatch = Partial<Pick<Recipe, EditableField>>;

function toRecipe(doc: Document): Recipe {
  return {
    ...(doc as unknown as Recipe),
    _id: (doc._id as ObjectIdType).toString(),
    userId: doc.userId ? (doc.userId as ObjectIdType).toString() : null,
    collectionIds: Array.isArray(doc.collectionIds) ? doc.collectionIds.map((id: ObjectIdType) => id.toString()) : [],
  };
}

/** List, for the admin/recipes picker page. Deliberately minimal — title/tags/id only,
 * same underlying collection the public /api/recipes list reads. */
adminRecipesRouter.get("/", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const docs = await withDb(c.env, (db) =>
      db.collection("recipes").find({}, { projection: { title: 1, tags: 1, createdAt: 1, imageUrl: 1 } }).sort({ title: 1 }).toArray(),
    );
    const body: ApiResponse<Array<{ _id: string; title: string; tags: string[]; createdAt?: string; imageUrl?: string }>> = {
      ok: true,
      data: docs.map((d) => ({
        _id: (d._id as ObjectIdType).toString(),
        title: d.title as string,
        tags: (d.tags as string[]) ?? [],
        createdAt: d.createdAt as string | undefined,
        imageUrl: d.imageUrl as string | undefined,
      })),
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] admin-recipes list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipes" } };
    return c.json(body, 502);
  }
});

adminRecipesRouter.get("/:id", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
    console.error("[uiu-api] admin-recipes get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipe" } };
    return c.json(body, 502);
  }
});

/** Edit a live recipe's content in place. Always `updateOne` against the existing _id —
 * never insertOne, never touches _id — so meal_plans/recipe_cost recipeId references stay valid. */
adminRecipesRouter.patch("/:id", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid recipe id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }

  const patch: RecipePatch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (payload as Record<string, unknown>)) {
      (patch as Record<string, unknown>)[field] = (payload as Record<string, unknown>)[field];
    }
  }
  if (Object.keys(patch).length === 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: `No editable fields in body — allowed: ${EDITABLE_FIELDS.join(", ")}` } };
    return c.json(body, 400);
  }

  // HANDOFF_recipe-import-french-label-bug-execute.md decision 2: an edit that leaves a
  // recipe's ingredient list looking like an unparsed label blob (>=3 consecutive
  // quantity=0/unit='' lines) gets flagged needs_review — doesn't block the edit (this is
  // an admin editing an already-live recipe deliberately), just surfaces it for follow-up.
  const guardFlag = patch.ingredients ? ingredientTextGuard(patch.ingredients) : null;

  try {
    const result = await withDb(c.env, async (db) => {
      const existing = await db.collection("recipes").findOne({ _id: new ObjectId(id) });
      if (!existing) return { notFound: true as const };

      await db.collection("recipes").updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            ...(patch as unknown as Document),
            ...(guardFlag?.suspicious ? { needs_review: true } : {}),
            updatedAt: new Date().toISOString(),
          },
        },
      );
      const updated = await db.collection("recipes").findOne({ _id: new ObjectId(id) });
      return { doc: updated! };
    });

    if ("notFound" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<Recipe> = { ok: true, data: toRecipe(result.doc) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] admin-recipes patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update recipe" } };
    return c.json(body, 502);
  }
});

interface BackfillOutcome {
  id: string;
  title: string;
  outcome: "found" | "not_found" | "skipped";
  imageUrl?: string;
}

interface BackfillSummary {
  dryRun: boolean;
  totalMissing: number;
  found: number;
  notFound: number;
  skipped: number;
  results: BackfillOutcome[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HANDOFF_recipe-image-backfill.md §2 — one-off backfill for approved recipes with no
 * imageUrl (mostly pre-dating aa594e5, the Pexels launch commit). Same dry-run/write
 * convention as /api/admin/recompute-costs. No retry-with-different-keyword on a miss (V1). */
adminRecipesRouter.post("/backfill-images", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const write = c.req.query("write") === "true";
  const skipIds = new Set(
    (c.req.query("skipIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const { ObjectId } = await getMongoModule();

  try {
    const missing = await withDb(c.env, (db) =>
      db
        .collection("recipes")
        .find({ $or: [{ imageUrl: "" }, { imageUrl: { $exists: false } }, { imageUrl: null }] })
        .project({ title: 1 })
        .toArray(),
    );

    const results: BackfillOutcome[] = [];
    for (const doc of missing) {
      const id = (doc._id as ObjectIdType).toString();
      const title = doc.title as string;

      // Caller-vetted rejection (e.g. a Pexels match confirmed unrelated to the dish) —
      // never write imageUrl for this id, regardless of what the search returns.
      if (skipIds.has(id)) {
        results.push({ id, title, outcome: "skipped" });
        continue;
      }

      const imageUrl = await findRecipePhoto(c.env, title);
      if (imageUrl) {
        results.push({ id, title, outcome: "found", imageUrl });
        if (write) {
          await withDb(c.env, (db) =>
            db.collection("recipes").updateOne({ _id: new ObjectId(id) }, { $set: { imageUrl, updatedAt: new Date().toISOString() } }),
          );
        }
      } else {
        results.push({ id, title, outcome: "not_found" });
      }
      // Pexels free tier rate limit — same lesson as the daily-recipe-draft cron's
      // "Too many subrequests" incident, stay well under it with a small delay.
      await sleep(250);
    }

    const summary: BackfillSummary = {
      dryRun: !write,
      totalMissing: missing.length,
      found: results.filter((r) => r.outcome === "found").length,
      notFound: results.filter((r) => r.outcome === "not_found").length,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      results,
    };
    const body: ApiResponse<BackfillSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] admin-recipes backfill-images error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to backfill recipe images" } };
    return c.json(body, 502);
  }
});
