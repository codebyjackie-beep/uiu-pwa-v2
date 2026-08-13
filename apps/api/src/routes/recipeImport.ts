/**
 * HANDOFF_recipe-social-import.md §2 — social-link recipe import. No ADMIN_TOKEN,
 * same convention as fridgeStock.ts (user-facing, single-user app).
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse, CanonicalIngredient, CanonicalPriceCacheEntry, Recipe, RecipeCost, RecipeCostLine, RecipeDraft, RecipeIngredient, RecipeListItemCost } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import type { OpenRouterEnv } from "../services/openrouter";
import { detectPlatform, parseRecipeFromText, tryJsonLdRecipe, tryOembedCaption, tryPinterestTargetLink, type OembedEnv } from "../services/recipeImport";
import { extractRecipeFromPhotos, type OpenRouterVisionEnv } from "../services/openrouterVision";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";

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

async function insertDraft(
  c: { env: RecipeImportEnv },
  recipe: ImportedRecipe,
  sourceUrl: string | undefined,
  sourcePlatform: RecipeDraft["sourcePlatform"],
  importMethod: RecipeDraft["importMethod"],
): Promise<string> {
  return withDb(c.env, async (db) => {
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

    let calories = 0, protein = 0, carbs = 0, fat = 0;
    for (const line of cost.lines as unknown as RecipeCostLine[]) {
      if (!line.priceable || line.normUnit !== "g" || !line.canonical_name || !line.normValue) continue;
      const doc = ingredientsMap.get(line.canonical_name);
      const n = doc?.nutrition_per_100g;
      if (!n) continue;
      const factor = line.normValue / 100;
      calories += n.kcal * factor;
      protein += n.protein * factor;
      carbs += n.carbs * factor;
      fat += n.fat * factor;
    }

    const costPreview: RecipeListItemCost | null =
      cost.basket > 0 ? { basket: cost.basket, currency: "GBP", perServing: cost.perServing, adjustedCoveragePct: cost.adjustedCoveragePct } : null;

    const draft: Omit<RecipeDraft, "_id"> = {
      title: recipe.title,
      description: recipe.description,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      tags: recipe.tags,
      mealType: recipe.mealType,
      servings: recipe.servings,
      prepTimeMinutes: recipe.prepTimeMinutes,
      cookTimeMinutes: recipe.cookTimeMinutes,
      nutrition: {
        calories: Math.round(calories),
        protein: Math.round(protein * 10) / 10,
        carbs: Math.round(carbs * 10) / 10,
        fat: Math.round(fat * 10) / 10,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
      sourceInspiration: sourceUrl ?? "",
      costPreview,
      sourceUrl,
      sourcePlatform,
      importMethod,
    };
    const result = await db.collection("recipe_drafts").insertOne(draft as unknown as Document);
    return result.insertedId.toString();
  });
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
      const recipeDraftId = await insertDraft(c, jsonLd, normalizedUrl, platform, "jsonld");
      const body: ApiResponse<{ recipeDraftId: string }> = { ok: true, data: { recipeDraftId } };
      return c.json(body);
    }

    // Tier 2 — platform oEmbed/API caption, then LLM parse.
    const caption = await tryOembedCaption(normalizedUrl, platform ?? "", c.env);
    if (caption) {
      const parsed = await parseRecipeFromText(c.env, caption.text);
      if (parsed) {
        const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
        const recipeDraftId = await insertDraft(c, { ...parsed, ingredients }, normalizedUrl, platform, "oembed-caption");
        const body: ApiResponse<{ recipeDraftId: string }> = { ok: true, data: { recipeDraftId } };
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
    const recipeDraftId = await insertDraft(c, { ...parsed, ingredients }, url, platform, "manual-paste");
    const body: ApiResponse<{ recipeDraftId: string }> = { ok: true, data: { recipeDraftId } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-text error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from text" } };
    return c.json(body, 502);
  }
});

const MAX_PHOTOS = 3;

/**
 * HANDOFF_recipes-page-manual-entry-and-refresh.md §A (corrected 2026-08-12 — see
 * HANDOFF_recipes-page-manual-entry-and-refresh.md §A revision): a hand-typed recipe is
 * final the moment the user hits Save — it never enters recipe_drafts / the admin approve
 * queue. Inserts straight into `recipes` (mirrors adminRecipeDrafts.ts's approve handler:
 * best-effort Pexels image, isPublic true, source "manual_entry") and computes recipe_cost
 * in the same request. No AI/LLM call anywhere in this path.
 */
recipeImportRouter.post("/manual", async (c) => {
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }
  const title = (payload as Record<string, unknown>).title;
  const ingredientsRaw = (payload as Record<string, unknown>).ingredients;
  const stepsRaw = (payload as Record<string, unknown>).steps;
  if (typeof title !== "string" || !title.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "title is required" } };
    return c.json(body, 400);
  }
  if (!Array.isArray(ingredientsRaw) || ingredientsRaw.length === 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "ingredients (at least 1) is required" } };
    return c.json(body, 400);
  }
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || !stepsRaw.every((s) => typeof s === "string" && s.trim())) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "steps (at least 1 non-empty) is required" } };
    return c.json(body, 400);
  }
  const ingredients: RecipeIngredient[] = [];
  for (const raw of ingredientsRaw) {
    const name = (raw as Record<string, unknown>)?.name;
    if (typeof name !== "string" || !name.trim()) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Every ingredient needs a non-empty name" } };
      return c.json(body, 400);
    }
    const quantity = Number((raw as Record<string, unknown>).quantity) || 0;
    const unit = typeof (raw as Record<string, unknown>).unit === "string" ? ((raw as Record<string, unknown>).unit as string) : "";
    ingredients.push({ name, quantity, unit });
  }

  const p = payload as Record<string, unknown>;
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

  try {
    const recipeId = await withDb(c.env, async (db) => {
      const now = new Date().toISOString();
      // Best-effort — never fail the save on a Pexels error (same convention as the drafts approve flow).
      const imageUrl = await findRecipePhoto(c.env, recipe.title).catch(() => null);

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

      let calories = 0, protein = 0, carbs = 0, fat = 0;
      for (const line of cost.lines as unknown as RecipeCostLine[]) {
        if (!line.priceable || line.normUnit !== "g" || !line.canonical_name || !line.normValue) continue;
        const doc = ingredientsMap.get(line.canonical_name);
        const n = doc?.nutrition_per_100g;
        if (!n) continue;
        const factor = line.normValue / 100;
        calories += n.kcal * factor;
        protein += n.protein * factor;
        carbs += n.carbs * factor;
        fat += n.fat * factor;
      }

      const recipeDoc: Omit<Recipe, "_id"> = {
        title: recipe.title,
        description: recipe.description,
        isPublic: true,
        userId: null,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        tags: recipe.tags,
        servings: recipe.servings,
        prepTimeMinutes: recipe.prepTimeMinutes,
        cookTimeMinutes: recipe.cookTimeMinutes,
        imageUrl: imageUrl ?? "",
        nutrition: {
          calories: Math.round(calories),
          protein: Math.round(protein * 10) / 10,
          carbs: Math.round(carbs * 10) / 10,
          fat: Math.round(fat * 10) / 10,
        },
        source: "manual_entry",
        sourcePlatform: null,
        sourceUrl: undefined,
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
    const recipeDraftId = await insertDraft(c, { ...parsed, ingredients }, undefined, null, "photo-ocr");
    const body: ApiResponse<{ recipeDraftId: string }> = { ok: true, data: { recipeDraftId } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-import from-photo error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to import recipe from photo" } };
    return c.json(body, 502);
  }
});
