/**
 * HANDOFF_fridge-ai-recipe-generator.md — "cook with what I have" fridge recipe
 * generator. No ADMIN_TOKEN, same convention as fridgeStock.ts/recipeImport.ts
 * (user-facing, single-user app). Two endpoints:
 *   POST /generate-from-fridge — pure LLM call, writes nothing to DB (§1).
 *   POST /save-fridge-draft    — user hit Save on the review screen, inserts
 *                                 into recipe_drafts like the other import
 *                                 tiers (§2.4/§2.5) — importMethod "fridge_generated".
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse, CanonicalIngredient, CanonicalPriceCacheEntry, Recipe, RecipeCostLine, RecipeDraft, RecipeIngredient, RecipeListItemCost } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import type { OpenRouterEnv } from "../services/openrouter";
import { generateRecipeFromFridge } from "../services/fridgeRecipeGen";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";

type FridgeRecipeGenEnv = DbEnv & OpenRouterEnv & PexelsEnv;

export const fridgeRecipeGenRouter = new Hono<{ Bindings: FridgeRecipeGenEnv }>();

type GeneratedRecipe = {
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

fridgeRecipeGenRouter.post("/generate-from-fridge", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const ingredientNames = payload?.ingredientNames as unknown;
  if (!Array.isArray(ingredientNames) || ingredientNames.length === 0 || !ingredientNames.every((v) => typeof v === "string" && v.trim())) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "ingredientNames (at least 1) is required" } };
    return c.json(body, 400);
  }

  try {
    const parsed = await generateRecipeFromFridge(c.env, ingredientNames as string[]);
    if (!parsed) {
      const body: ApiResponse<never> = { ok: false, error: { code: "generate_failed", message: "Could not generate a recipe from those ingredients — try again." } };
      return c.json(body, 422);
    }
    const ingredients: RecipeIngredient[] = parsed.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit }));
    const recipe: GeneratedRecipe = { ...parsed, ingredients };
    const body: ApiResponse<GeneratedRecipe> = { ok: true, data: recipe };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] generate-from-fridge error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to generate recipe from fridge" } };
    return c.json(body, 502);
  }
});

fridgeRecipeGenRouter.post("/save-fridge-draft", async (c) => {
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }
  const p = payload as Record<string, unknown>;
  const title = p.title;
  const ingredientsRaw = p.ingredients;
  const stepsRaw = p.steps;
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

  const recipe: GeneratedRecipe = {
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
    const recipeDraftId = await withDb(c.env, async (db) => {
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

      // Fetch the photo at creation time (HANDOFF_recipe-image-gaps.md §2) — lets the review
      // UI show an image before approve, and lets approve reuse it instead of re-calling Pexels.
      const imageUrl = await findRecipePhoto(c.env, recipe.title).catch(() => null);

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
        sourceInspiration: "",
        costPreview,
        importMethod: "fridge_generated",
        imageUrl,
      };
      const result = await db.collection("recipe_drafts").insertOne(draft as unknown as Document);
      return result.insertedId.toString();
    });

    const body: ApiResponse<{ recipeDraftId: string }> = { ok: true, data: { recipeDraftId } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] save-fridge-draft error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Failed to save recipe draft" } };
    return c.json(body, 502);
  }
});
