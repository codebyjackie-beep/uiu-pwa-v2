/**
 * Admin API for recipe_drafts review (HANDOFF_daily-recipe-draft-agent.md Part C).
 * X-Admin-Token protected, same convention as /api/admin/recompute-costs.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import { ingredientTextGuard, type ApiResponse, type CanonicalIngredient, type CanonicalPriceCacheEntry, type Recipe, type RecipeCost, type RecipeCostLine, type RecipeDraft, type RecipeDraftStatus } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { dailyRecipeDraft, type DailyRecipeDraftEnv, type DailyRecipeDraftSummary } from "../jobs/dailyRecipeDraft";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";

export const adminRecipeDraftsRouter = new Hono<{ Bindings: DailyRecipeDraftEnv & PexelsEnv & { ADMIN_TOKEN: string } }>();

function checkAdminToken(token: string | undefined, expected: string): boolean {
  return !!token && token === expected;
}

const VALID_STATUSES: RecipeDraftStatus[] = ["pending", "approved", "rejected"];

/** Editable fields only — status/createdAt/sourceInspiration/gapTarget/costPreview are internal
 * generation-time records and stay off-limits (HANDOFF_recipe-drafts-admin-ui.md). */
const EDITABLE_FIELDS = ["title", "description", "ingredients", "steps", "tags", "servings", "prepTimeMinutes", "cookTimeMinutes"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type RecipeDraftPatch = Partial<Pick<RecipeDraft, EditableField>>;

function toRecipeDraft(doc: Document): RecipeDraft {
  return { ...(doc as unknown as RecipeDraft), _id: (doc._id as ObjectIdType).toString() };
}

/** `?status=` optional, defaults to "pending" (backward-compatible with the pre-existing behaviour). Pass "all" for every status. */
adminRecipeDraftsRouter.get("/", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const statusParam = c.req.query("status") ?? "pending";
  if (statusParam !== "all" && !VALID_STATUSES.includes(statusParam as RecipeDraftStatus)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: `status must be one of: all, ${VALID_STATUSES.join(", ")}` } };
    return c.json(body, 400);
  }
  const filter = statusParam === "all" ? {} : { status: statusParam };
  try {
    const docs = await withDb(c.env, (db) => db.collection("recipe_drafts").find(filter).sort({ createdAt: -1 }).toArray());
    const body: ApiResponse<RecipeDraft[]> = { ok: true, data: docs.map(toRecipeDraft) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch recipe_drafts" } };
    return c.json(body, 502);
  }
});

/** Edit a still-pending draft's content. Rejects (404/409) once the draft has been approved/rejected — those are final. */
adminRecipeDraftsRouter.patch("/:id", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid draft id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }

  const patch: RecipeDraftPatch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (payload as Record<string, unknown>)) {
      (patch as Record<string, unknown>)[field] = (payload as Record<string, unknown>)[field];
    }
  }
  if (Object.keys(patch).length === 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: `No editable fields in body — allowed: ${EDITABLE_FIELDS.join(", ")}` } };
    return c.json(body, 400);
  }

  try {
    const result = await withDb(c.env, async (db) => {
      const existing = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(id) });
      if (!existing) return { notFound: true as const };
      if (existing.status !== "pending") return { alreadyDecided: true as const };

      await db.collection("recipe_drafts").updateOne({ _id: new ObjectId(id) }, { $set: patch as unknown as Document });
      const updated = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(id) });
      return { doc: updated! };
    });

    if ("notFound" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Draft not found" } };
      return c.json(body, 404);
    }
    if ("alreadyDecided" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "conflict", message: "Draft is not pending" } };
      return c.json(body, 409);
    }
    const body: ApiResponse<RecipeDraft> = { ok: true, data: toRecipeDraft(result.doc) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update draft" } };
    return c.json(body, 502);
  }
});

/** Manual trigger — mirrors /api/admin/recompute-costs: dry-run by default, ?write=true to actually insert/advance rotation state. */
/**
 * HANDOFF_recipe-drafts-admin-gram-display.md — read-only, on-the-fly cost
 * line breakdown for a single draft. `costPreview` on the draft doc only
 * stores aggregate totals (basket/perServing/adjustedCoveragePct), not the
 * per-line normValue/normUnit the review screen needs, and drafts are never
 * persisted into `recipe_cost` (that collection is for approved recipes
 * only). Recomputing costRecipe() for one draft is cheap (buildAliasIndex
 * over ~735 canonical_ingredients docs, no recipes-collection scan) —
 * nothing is written back to `recipe_drafts` or any other collection.
 */
adminRecipeDraftsRouter.get("/:id/cost-lines", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid draft id" } };
    return c.json(body, 400);
  }
  try {
    const result = await withDb(c.env, async (db) => {
      const draft = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(id) });
      if (!draft) return { notFound: true as const };

      const ingredientsCol = db.collection<Document>("canonical_ingredients");
      const priceCol = db.collection<Document>("canonical_price_cache");
      const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
      const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
      const allPriceDocs = (await priceCol.find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
      const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));
      const quarantinedNames = new Set(
        allIngredientDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()),
      );
      const index = await buildAliasIndex(ingredientsCol);
      const resolveFn = (rawName: string) => resolve(rawName, index);

      const cost = costRecipe(draft as unknown as Recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      return { lines: cost.lines };
    });

    if ("notFound" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Draft not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<RecipeCostLine[]> = { ok: true, data: result.lines as unknown as RecipeCostLine[] };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts cost-lines error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to compute cost lines" } };
    return c.json(body, 502);
  }
});

adminRecipeDraftsRouter.post("/run", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const write = c.req.query("write") === "true";
  try {
    const summary = await dailyRecipeDraft(c.env, !write);
    const body: ApiResponse<DailyRecipeDraftSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to run dailyRecipeDraft" } };
    return c.json(body, 502);
  }
});

adminRecipeDraftsRouter.post("/:id/approve", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid draft id" } };
    return c.json(body, 400);
  }
  try {
    const result = await withDb(c.env, async (db) => {
      const draft = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(id) });
      if (!draft) return { notFound: true as const };
      if (draft.status !== "pending") return { alreadyDecided: true as const };

      const now = new Date().toISOString();
      // Best-effort — never fail approval on a Pexels error (HANDOFF: graceful fallback).
      const imageUrl = await findRecipePhoto(c.env, draft.title as string).catch(() => null);
      // HANDOFF_recipe-import-french-label-bug-execute.md decision 2: never auto-publish a
      // draft whose ingredient lines look like an unparsed label blob (>=3 consecutive
      // quantity=0/unit='' lines) — flag needs_review instead of setting isPublic true.
      const guardResult = ingredientTextGuard(draft.ingredients as { quantity: number; unit: string }[]);
      const recipeDoc: Omit<Recipe, "_id"> = {
        title: draft.title as string,
        description: (draft.description as string) ?? "",
        isPublic: !guardResult.suspicious,
        needs_review: guardResult.suspicious || undefined,
        userId: null,
        ingredients: draft.ingredients as Recipe["ingredients"],
        steps: draft.steps as string[],
        tags: draft.tags as string[],
        servings: draft.servings as number,
        prepTimeMinutes: draft.prepTimeMinutes as number,
        cookTimeMinutes: draft.cookTimeMinutes as number,
        imageUrl: imageUrl ?? "",
        nutrition: draft.nutrition as Recipe["nutrition"],
        source: draft.importMethod === "photo-ocr" ? "photo_import"
          : draft.sourceUrl ? "social_import"
          : "ai_daily_draft",
        sourcePlatform: (draft.sourcePlatform as Recipe["sourcePlatform"]) ?? null,
        sourceUrl: (draft.sourceUrl as string) ?? undefined,
        collectionIds: [],
        isFavorite: false,
        viewCount: 0,
        favoriteCount: 0,
        __v: 0,
        createdAt: now,
        updatedAt: now,
        mealType: draft.mealType as string | undefined,
      };
      const insertResult = await db.collection("recipes").insertOne(recipeDoc as unknown as Document);

      // HANDOFF_recipe-drafts-approve-fresh-cost.md — recompute live with the
      // real engine against the just-inserted recipe doc, same pattern as
      // GET /:id/cost-lines, instead of copying draft.costPreview's stale
      // aggregate-only numbers (which always wrote lines:[] and zeroed counts).
      const ingredientsCol = db.collection<Document>("canonical_ingredients");
      const priceCol = db.collection<Document>("canonical_price_cache");
      const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
      const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
      const allPriceDocs = (await priceCol.find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
      const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));
      const quarantinedNames = new Set(
        allIngredientDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()),
      );
      const index = await buildAliasIndex(ingredientsCol);
      const resolveFn = (rawName: string) => resolve(rawName, index);
      const cost = costRecipe({ ...recipeDoc, _id: insertResult.insertedId } as unknown as Recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);

      const recipeCostDoc: Omit<RecipeCost, "_id"> = {
        recipeId: insertResult.insertedId.toString(),
        basket: cost.basket,
        currency: cost.currency,
        coveragePct: cost.coveragePct,
        adjustedCoveragePct: cost.adjustedCoveragePct,
        totalLines: cost.totalLines,
        priceableCount: cost.priceableCount,
        adjustedTotal: cost.adjustedTotal,
        adjustedPriceable: cost.adjustedPriceable,
        pantryLineCount: cost.pantryLineCount,
        junkLineCount: cost.junkLineCount,
        perServing: cost.perServing,
        lines: cost.lines as unknown as RecipeCostLine[],
        unpriceableReasons: cost.unpriceableReasons,
        computedAt: now,
        priceCacheStamp: 0,
      };
      await db.collection("recipe_cost").insertOne({ ...recipeCostDoc, recipeId: insertResult.insertedId } as unknown as Document);

      await db.collection("recipe_drafts").updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved" } });
      return { insertedId: insertResult.insertedId.toString() };
    });

    if ("notFound" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Draft not found" } };
      return c.json(body, 404);
    }
    if ("alreadyDecided" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "conflict", message: "Draft is not pending" } };
      return c.json(body, 409);
    }
    const body: ApiResponse<{ recipeId: string }> = { ok: true, data: { recipeId: result.insertedId } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts approve error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to approve draft" } };
    return c.json(body, 502);
  }
});

adminRecipeDraftsRouter.post("/:id/reject", async (c) => {
  if (!checkAdminToken(c.req.header("X-Admin-Token"), c.env.ADMIN_TOKEN)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid draft id" } };
    return c.json(body, 400);
  }
  try {
    const result = await withDb(c.env, (db) =>
      db.collection("recipe_drafts").updateOne({ _id: new ObjectId(id), status: "pending" }, { $set: { status: "rejected" } }),
    );
    if (result.matchedCount === 0) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Draft not found or not pending" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ id: string }> = { ok: true, data: { id } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-drafts reject error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to reject draft" } };
    return c.json(body, 502);
  }
});
