/**
 * HANDOFF_tonight-suggestion.md — instant, single-meal, fridge-aware suggestions.
 * Query-only: reads recipes/recipe_cost/fridge_stock, never calls AI, never writes.
 */
import { Hono } from "hono";
import type { ApiResponse, MealSlot, MealSuggestion, MealSuggestionsResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { buildPool } from "../services/mealPlanGenerator";
import { findTitleMatch } from "../services/recipeDraftGenerator";

export const mealSuggestionsRouter = new Hono<{ Bindings: DbEnv }>();

const VALID_MEAL_TYPES: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
/** Same >=80% "reliable price" threshold as the Recipes page's three-state price badge. */
const COVERAGE_THRESHOLD = 80;
const TOP_N = 5;

/** 2026-08-06 handoff: match candidate recipe ingredients against fridge_stock by
 * expiry urgency — closer to expiring scores higher. */
function expiryWeight(expiresAt: string, now: Date): number {
  const days = (new Date(expiresAt).getTime() - now.getTime()) / 86_400_000;
  if (days <= 2) return 3;
  if (days <= 5) return 2;
  return 1;
}

mealSuggestionsRouter.get("/", async (c) => {
  const mealType = c.req.query("mealType") as MealSlot | undefined;
  if (!mealType || !VALID_MEAL_TYPES.includes(mealType)) {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: `mealType is required and must be one of ${VALID_MEAL_TYPES.join(", ")}` },
    };
    return c.json(body, 400);
  }

  try {
    const now = new Date();
    const [pool, fridgeDocs] = await Promise.all([
      buildPool(c.env),
      withDb(c.env, (db) => db.collection("fridge_stock").find({ expiresAt: { $gt: now.toISOString() } }).toArray()),
    ]);

    const fridgeItems = fridgeDocs.map((d) => ({
      name: String(d.ingredientName ?? ""),
      expiresAt: String(d.expiresAt ?? now.toISOString()),
    }));

    const candidates = pool.filter(
      (r) => r.mealSlots.has(mealType) && r.adjustedCoveragePct != null && r.adjustedCoveragePct >= COVERAGE_THRESHOLD,
    );

    // Name matching reuses recipeDraftGenerator's exact/substring title-dedup rule
    // (HANDOFF instruction: don't invent a new comparison algorithm) applied to a
    // single-candidate list per fridge item instead of the full title set.
    const scored = candidates.map((r) => {
      const matchedFridgeItems: string[] = [];
      let fridgeMatchScore = 0;
      for (const item of fridgeItems) {
        const hit = r.ingredientNames.some((ingredientName) => findTitleMatch(ingredientName, [item.name]) !== null);
        if (hit) {
          matchedFridgeItems.push(item.name);
          fridgeMatchScore += expiryWeight(item.expiresAt, now);
        }
      }
      return { recipe: r, fridgeMatchScore, matchedFridgeItems };
    });

    scored.sort((a, b) => b.fridgeMatchScore - a.fridgeMatchScore || Math.random() - 0.5);

    const suggestions: MealSuggestion[] = scored.slice(0, TOP_N).map(({ recipe, fridgeMatchScore, matchedFridgeItems }) => ({
      recipeId: recipe.id,
      title: recipe.title,
      imageUrl: recipe.imageUrl,
      cost:
        recipe.basket != null
          ? {
              basket: recipe.basket,
              currency: "GBP",
              perServing: recipe.costPerServing ?? 0,
              adjustedCoveragePct: recipe.adjustedCoveragePct ?? 0,
            }
          : null,
      calories: recipe.calories,
      fridgeMatchScore,
      matchedFridgeItems,
    }));

    const body: ApiResponse<MealSuggestionsResponse> = { ok: true, data: { mealType, suggestions } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-suggestions error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch meal suggestions" } };
    return c.json(body, 502);
  }
});
