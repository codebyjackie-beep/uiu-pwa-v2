/**
 * HANDOFF_recipe-social-import.md §2 — social-link recipe import. No ADMIN_TOKEN,
 * same convention as fridgeStock.ts (user-facing, single-user app).
 */
import { Hono } from "hono";
import type { Db, Document } from "mongodb";
import type { ApiResponse, CanonicalIngredient, CanonicalPriceCacheEntry, Recipe, RecipeCost, RecipeCostLine, RecipeDraft, RecipeIngredient, RecipeListItemCost } from "@uiu/shared";
import { getMongoModule, withDb, type DbEnv } from "../db";
import type { OpenRouterEnv } from "../services/openrouter";
import { detectPlatform, parseRecipeFromText, tryJsonLdRecipe, tryOembedCaption, tryPinterestTargetLink, type OembedEnv } from "../services/recipeImport";
import { extractRecipeFromPhotos, extractRecipeFromVideo, type OpenRouterVisionEnv } from "../services/openrouterVision";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";
import { computeRecipeNutrition } from "../services/nutritionGrams";

type RecipeImportEnv = DbEnv & OpenRouterEnv & OembedEnv & OpenRouterVisionEnv & PexelsEnv;

export const recipeImportRouter = new Hono<{ Bindings: RecipeImportEnv }>();

type ImportedRecipe = {
  title: string;
  description: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  mealType?: string;
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
};

/**
 * What the import endpoints return to the client (owner decision 2026-10-27: imports are private to the
 * user). Nothing is written to the DB here — the user reviews/edits this in the form, then Save posts it
 * to POST /manual, which stores the private recipe.
 */
export type ImportedDraft = ImportedRecipe & {
  sourceUrl: string | null;
  sourcePlatform: string | null;
  importMethod: RecipeDraft["importMethod"];
};

/** Pure: shapes a parsed recipe into the client draft. No DB, no Pexels, no cost. */
function toDraft(
  recipe: ImportedRecipe,
  sourceUrl: string | undefined,
  sourcePlatform: RecipeDraft["sourcePlatform"],
  importMethod: RecipeDraft["importMethod"],
): ImportedDraft {
  return {
    title: recipe.title,
    description: recipe.description,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    tags: recipe.tags,
    mealType: recipe.mealType,
    servings: recipe.servings,
    prepTimeMinutes: recipe.prepTimeMinutes,
    cookTimeMinutes: recipe.cookTimeMinutes,
    sourceUrl: sourceUrl ?? null,
    sourcePlatform: sourcePlatform ?? null,
    importMethod,
  };
}

recipeImportRouter.post("/from-url", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const url = payload?.url as string | undefined;
  if (typeof url !== "string" || !url.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "url is required" } };
    return c.json(body, 400);
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(url.trim()).toString();
  } catch {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "url is not a valid URL" } };
    return c.json(body, 400);
  }

  const platform = detectPlatform(normalizedUrl);

  try {
    // Tier 1 — try the URL itself.
    let jsonLd = await tryJsonLdRecipe(normalizedUrl);

    // Pinterest pins often link out to the real recipe blog — if Tier 1 on the pin
    // itself fails, try the target link it points to (HANDOFF §0).
    if (!jsonLd && platform === "pinterest") {
      const targetLink = await tryPinterestTargetLink(normalizedUrl);
      if (targetLink) jsonLd = await tryJsonLdRecipe(targetLink);
    }

    if (jsonLd) {
      const draft = toDraft(jsonLd, normalizedUrl, platform, "jsonld");
      const body: ApiResponse<{ draft: ImportedDraft }> = { ok: true, data: { draft } };
      return c.json(body);
    }

    // Tier 2 — platform oEmbed/API caption, then LLM parse.
    const caption = await tryOembedCaption(normalizedUrl, platform ?? "", c.env);
    if (caption) {
      const parsed = await parseRecipeFromText(c.env, caption.text);
      if (parsed) {
        const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
        const draft = toDraft({ ...parsed, ingredients }, normalizedUrl, platform, "oembed-caption");
        const body: ApiResponse<{ draft: ImportedDraft }> = { ok: true, data: { draft } };
        return c.json(body);
      }
    }

    // Both tiers failed — not an error, front-end falls to the manual-paste textarea.
    const body: ApiResponse<{ needsManualPaste: true; platform: RecipeDraft["sourcePlatform"] }> = {
      ok: true,
      data: { needsManualPaste: true, platform },
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-url error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from URL" } };
    return c.json(body, 502);
  }
});

recipeImportRouter.post("/from-text", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const text = payload?.text as string | undefined;
  const url = payload?.url as string | undefined;
  const platformRaw = payload?.platform as string | undefined;
  if (typeof text !== "string" || !text.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "text is required" } };
    return c.json(body, 400);
  }
  const VALID_PLATFORMS: RecipeDraft["sourcePlatform"][] = ["tiktok", "instagram", "facebook", "pinterest", "youtube", null];
  const platform = (VALID_PLATFORMS as (string | null | undefined)[]).includes(platformRaw) ? (platformRaw as RecipeDraft["sourcePlatform"]) : null;

  try {
    const parsed = await parseRecipeFromText(c.env, text);
    if (!parsed) {
      const body: ApiResponse<never> = { ok: false, error: { code: "parse_failed", message: "Could not extract a recipe from that text — try adding more detail (ingredients + steps)." } };
      return c.json(body, 422);
    }
    const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
    const draft = toDraft({ ...parsed, ingredients }, url, platform, "manual-paste");
    const body: ApiResponse<{ draft: ImportedDraft }> = { ok: true, data: { draft } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-text error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from text" } };
    return c.json(body, 502);
  }
});

const MAX_PHOTOS = 3;

/**
 * Save a user's recipe: hand-typed, or an import the user reviewed/edited in the form (link / text /
 * photo / video). The recipe is PRIVATE to the signed-in user (owner decision 2026-10-27): isPublic false,
 * owned by `clerkUserId`, and it never enters recipe_drafts or the admin approve queue. Inserts into
 * `recipes` with a best-effort Pexels image and computes recipe_cost in the same request. No AI/LLM call
 * anywhere in this path.
 */
type ParsedRecipeInput =
  | { ok: true; recipe: ImportedRecipe; p: Record<string, unknown> }
  | { ok: false; message: string };

/** Validation shared by POST /manual and PUT /:id (owner edit). */
function parseRecipeInput(payload: unknown): ParsedRecipeInput {
  if (!payload || typeof payload !== "object") return { ok: false, message: "JSON body required" };
  const p = payload as Record<string, unknown>;
  const title = p.title;
  const ingredientsRaw = p.ingredients;
  const stepsRaw = p.steps;
  if (typeof title !== "string" || !title.trim()) return { ok: false, message: "title is required" };
  if (!Array.isArray(ingredientsRaw) || ingredientsRaw.length === 0) return { ok: false, message: "ingredients (at least 1) is required" };
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || !stepsRaw.every((s) => typeof s === "string" && s.trim())) {
    return { ok: false, message: "steps (at least 1 non-empty) is required" };
  }
  const ingredients: RecipeIngredient[] = [];
  for (const raw of ingredientsRaw) {
    const name = (raw as Record<string, unknown>)?.name;
    if (typeof name !== "string" || !name.trim()) return { ok: false, message: "Every ingredient needs a non-empty name" };
    const quantity = Number((raw as Record<string, unknown>).quantity) || 0;
    const unit = typeof (raw as Record<string, unknown>).unit === "string" ? ((raw as Record<string, unknown>).unit as string) : "";
    ingredients.push({ name, quantity, unit });
  }
  const recipe: ImportedRecipe = {
    title: title.trim(),
    description: typeof p.description === "string" ? p.description : "",
    ingredients,
    steps: (stepsRaw as string[]).map((s) => s.trim()),
    tags: Array.isArray(p.tags) ? (p.tags as unknown[]).filter((t) => typeof t === "string") as string[] : [],
    mealType: typeof p.mealType === "string" && p.mealType ? p.mealType : undefined,
    servings: Number(p.servings) || 2,
    prepTimeMinutes: Number(p.prepTimeMinutes) || 0,
    cookTimeMinutes: Number(p.cookTimeMinutes) || 0,
  };
  return { ok: true, recipe, p };
}

/** Cost + nutrition for a user recipe, computed exactly like the import save (shared by /manual and PUT /:id). */
async function computeCostAndNutrition(db: Db, recipe: ImportedRecipe, now: string) {
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

  const costInput = { ingredients: recipe.ingredients, servings: recipe.servings } as unknown as Recipe;
  const cost = costRecipe(costInput, resolveFn, ingredientsMap, priceMap, quarantinedNames);
  const { nutrition } = computeRecipeNutrition(recipe.ingredients, recipe.servings, resolveFn, ingredientsMap);

  const costFields: Omit<RecipeCost, "_id" | "recipeId"> = {
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
  return { nutrition, costFields };
}

recipeImportRouter.post("/manual", async (c) => {
  const parsedInput = parseRecipeInput(await c.req.json().catch(() => null));
  if (!parsedInput.ok) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: parsedInput.message } };
    return c.json(body, 400);
  }
  const { recipe, p } = parsedInput;
  const sourceUrlRaw = typeof p.sourceUrl === "string" ? p.sourceUrl.trim() : "";
  const sourceUrl = sourceUrlRaw && sourceUrlRaw.length <= 500 && /^https?:\/\//i.test(sourceUrlRaw) ? sourceUrlRaw : undefined;
  const sourcePlatform = typeof p.sourcePlatform === "string" && p.sourcePlatform.trim() && p.sourcePlatform.length <= 40 ? p.sourcePlatform.trim() : null;
  const MANUAL_IMPORT_METHODS = ["jsonld", "oembed-caption", "manual-paste", "photo-ocr", "video-ai"] as const;
  const importMethod = (MANUAL_IMPORT_METHODS as readonly string[]).includes(p.importMethod as string)
    ? (p.importMethod as (typeof MANUAL_IMPORT_METHODS)[number])
    : "manual";

  try {
    const recipeId = await withDb(c.env, async (db) => {
      const now = new Date().toISOString();
      // Best-effort — never fail the save on a Pexels error (same convention as the drafts approve flow).
      const imageUrl = await findRecipePhoto(c.env, recipe.title).catch(() => null);

      const { nutrition, costFields } = await computeCostAndNutrition(db, recipe, now);

      const recipeDoc: Omit<Recipe, "_id"> = {
        title: recipe.title,
        description: recipe.description,
        isPublic: false,
        userId: null,
        clerkUserId: c.var.clerkUserId,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        tags: recipe.tags,
        servings: recipe.servings,
        prepTimeMinutes: recipe.prepTimeMinutes,
        cookTimeMinutes: recipe.cookTimeMinutes,
        imageUrl: imageUrl ?? "",
        nutrition,
        source: importMethod === "manual" ? "manual_entry" : "user_import",
        sourcePlatform,
        sourceUrl,
        importMethod,
        collectionIds: [],
        isFavorite: false,
        viewCount: 0,
        favoriteCount: 0,
        __v: 0,
        createdAt: now,
        updatedAt: now,
        mealType: recipe.mealType,
      };
      const insertResult = await db.collection("recipes").insertOne(recipeDoc as unknown as Document);

      const recipeCostDoc: Omit<RecipeCost, "_id"> = { recipeId: insertResult.insertedId.toString(), ...costFields };
      await db.collection("recipe_cost").insertOne({ ...recipeCostDoc, recipeId: insertResult.insertedId } as unknown as Document);

      return insertResult.insertedId.toString();
    });

    const body: ApiResponse<{ recipeId: string }> = { ok: true, data: { recipeId } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import manual error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to save recipe" } };
    return c.json(body, 502);
  }
});

recipeImportRouter.post("/from-photo", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const images = payload?.images as unknown;
  if (!Array.isArray(images) || images.length === 0 || !images.every((v) => typeof v === "string" && v.trim())) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "images (1-3 data URLs) is required" } };
    return c.json(body, 400);
  }
  if (images.length > MAX_PHOTOS) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: `At most ${MAX_PHOTOS} photos are allowed` } };
    return c.json(body, 400);
  }

  try {
    const parsed = await extractRecipeFromPhotos(c.env, images as string[]);
    if (!parsed) {
      const body: ApiResponse<{ needsManualPaste: true }> = { ok: true, data: { needsManualPaste: true } };
      return c.json(body);
    }
    const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
    const draft = toDraft({ ...parsed, ingredients }, undefined, null, "photo-ocr");
    const body: ApiResponse<{ draft: ImportedDraft }> = { ok: true, data: { draft } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-photo error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from photo" } };
    return c.json(body, 502);
  }
});

// Jackie 2026-10-25 — "Upload a video". Body: { video: data URL (mp4 / mov / webm / mpeg), sourceUrl? }.
// Gemini takes inline media up to ~20 MB per request, so the decoded video is capped at 14 MB (base64 adds a third).
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
const VIDEO_DATA_URL = /^data:video\/(mp4|quicktime|mov|webm|mpeg);base64,/i;

recipeImportRouter.post("/from-video", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const video = payload?.video as unknown;
  const sourceUrlRaw = typeof payload?.sourceUrl === "string" ? payload.sourceUrl.trim() : "";
  if (typeof video !== "string" || !VIDEO_DATA_URL.test(video)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "video must be an mp4, mov or webm file" } };
    return c.json(body, 400);
  }
  const base64Length = video.length - video.indexOf(",") - 1;
  if (base64Length * 0.75 > MAX_VIDEO_BYTES) {
    const body: ApiResponse<never> = { ok: false, error: { code: "too_large", message: "Video too large (max 14 MB) — trim it to the cooking part and try again" } };
    return c.json(body, 400);
  }
  let sourceUrl: string | undefined;
  try {
    sourceUrl = sourceUrlRaw ? new URL(sourceUrlRaw).toString() : undefined;
  } catch {
    sourceUrl = undefined;
  }
  // Gemini lists QuickTime as video/mov.
  const normalized = video.replace(/^data:video\/quicktime;/i, "data:video/mov;");

  try {
    // The vision model fails often on video (5xx from the provider, or a reply missing ingredients/steps — tested
    // 2026-10-27: 2 of 3 runs failed on the same reel). Try up to 3 times before asking the user to paste instead.
    let parsed: Awaited<ReturnType<typeof extractRecipeFromVideo>> = null;
    for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
      parsed = await extractRecipeFromVideo(c.env, normalized);
    }
    if (!parsed) {
      const body: ApiResponse<{ needsManualPaste: true }> = { ok: true, data: { needsManualPaste: true } };
      return c.json(body);
    }
    const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
    const draft = toDraft({ ...parsed, ingredients }, sourceUrl, sourceUrl ? detectPlatform(sourceUrl) : null, "video-ai");
    const body: ApiResponse<{ draft: ImportedDraft }> = { ok: true, data: { draft } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-video error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from video" } };
    return c.json(body, 502);
  }
});


/**
 * Jackie 2026-11-07 — a user edits or deletes a recipe they saved (imports + manual saves are private, owned via
 * `clerkUserId`). Public library recipes and other users' recipes get the same 404 as a missing id.
 */
async function findOwnedRecipe(db: Db, id: string, clerkUserId: string) {
  const { ObjectId } = await getMongoModule();
  if (!ObjectId.isValid(id)) return null;
  const doc = await db.collection("recipes").findOne({ _id: new ObjectId(id) });
  if (!doc || doc.isPublic === true || doc.clerkUserId !== clerkUserId) return null;
  return doc;
}

recipeImportRouter.put("/:id", async (c) => {
  const parsedInput = parseRecipeInput(await c.req.json().catch(() => null));
  if (!parsedInput.ok) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: parsedInput.message } };
    return c.json(body, 400);
  }
  const { recipe } = parsedInput;
  try {
    const result = await withDb(c.env, async (db) => {
      const doc = await findOwnedRecipe(db, c.req.param("id"), c.var.clerkUserId);
      if (!doc) return null;
      const now = new Date().toISOString();
      const { nutrition, costFields } = await computeCostAndNutrition(db, recipe, now);
      await db.collection("recipes").updateOne(
        { _id: doc._id },
        {
          $set: {
            title: recipe.title,
            description: recipe.description,
            ingredients: recipe.ingredients,
            steps: recipe.steps,
            tags: recipe.tags,
            servings: recipe.servings,
            prepTimeMinutes: recipe.prepTimeMinutes,
            cookTimeMinutes: recipe.cookTimeMinutes,
            mealType: recipe.mealType,
            nutrition,
            updatedAt: now,
          },
        },
      );
      await db.collection("recipe_cost").updateOne(
        { recipeId: doc._id },
        { $set: { ...costFields, recipeId: doc._id } },
        { upsert: true },
      );
      return { recipeId: String(doc._id) };
    });
    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ recipeId: string }> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import update error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to update recipe" } };
    return c.json(body, 502);
  }
});

recipeImportRouter.delete("/:id", async (c) => {
  try {
    const result = await withDb(c.env, async (db) => {
      const userId = c.var.clerkUserId;
      const doc = await findOwnedRecipe(db, c.req.param("id"), userId);
      if (!doc) return "not_found" as const;
      // A meal plan entry pointing at a deleted recipe would break that plan — ask the user to swap it out first.
      const inPlans = await db.collection("meal_plans").countDocuments({ userId, recipeId: doc._id });
      if (inPlans > 0) return { inPlans } as const;
      await db.collection("recipe_cost").deleteMany({ recipeId: doc._id });
      await db.collection("favourite_recipes").deleteMany({ userId, recipeId: doc._id });
      await db.collection("recipes").deleteOne({ _id: doc._id, clerkUserId: userId });
      return "deleted" as const;
    });
    if (result === "not_found") {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "Recipe not found" } };
      return c.json(body, 404);
    }
    if (result !== "deleted") {
      const n = result.inPlans;
      const body: ApiResponse<never> = {
        ok: false,
        error: { code: "in_use", message: `This recipe is in your meal plan (${n} meal${n === 1 ? "" : "s"}). Swap or remove it there first, then delete it.` },
      };
      return c.json(body, 409);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to delete recipe" } };
    return c.json(body, 502);
  }
});
