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
const MATCH_ONLY_TOP_N = 5; // Jackie 2026-11-05: max 5 on /recipes?cook=soon

/** 2026-08-06 handoff: match candidate recipe ingredients against fridge_stock by
 * expiry urgency — closer to expiring scores higher. */
function expiryWeight(expiresAt: string, now: Date): number {
  const days = (new Date(expiresAt).getTime() - now.getTime()) / 86_400_000;
  if (days <= 2) return 3;
  if (days <= 5) return 2;
  return 1;
}

mealSuggestionsRouter.get("/", async (c) => {
  // matchOnly=1 (Jackie 2026-11-05, Home "Cook with these" → /recipes?cook=soon): any meal type, only fridge items
  // expiring within `days` (default 3, same window as the Home card, expired items excluded for food safety), and
  // only recipes that use at least one of them — no random filler.
  const matchOnly = c.req.query("matchOnly") === "1";
  const daysParam = Number(c.req.query("days") ?? "3");
  const windowDays = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 30 ? daysParam : 3;
  const rawMealType = c.req.query("mealType") as MealSlot | undefined;
  const mealType = rawMealType && VALID_MEAL_TYPES.includes(rawMealType) ? rawMealType : undefined;
  if (!mealType && (!matchOnly || rawMealType)) {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: `mealType is required and must be one of ${VALID_MEAL_TYPES.join(", ")}` },
    };
    return c.json(body, 400);
  }

  try {
    const now = new Date();
    const expiresFilter: Record<string, string> = { $gt: now.toISOString() };
    if (matchOnly) expiresFilter.$lte = new Date(now.getTime() + windowDays * 86_400_000).toISOString();
    const [pool, fridgeDocs] = await Promise.all([
      buildPool(c.env),
      withDb(c.env, (db) => db.collection("fridge_stock").find({ userId: c.var.clerkUserId, expiresAt: expiresFilter }).toArray()),
    ]);

    const fridgeItems = fridgeDocs.map((d) => ({
      name: String(d.ingredientName ?? ""),
      expiresAt: String(d.expiresAt ?? now.toISOString()),
    }));

    const candidates = pool.filter(
      (r) => (!mealType || r.mealSlots.has(mealType)) && r.adjustedCoveragePct != null && r.adjustedCoveragePct >= COVERAGE_THRESHOLD,
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
    const ranked = matchOnly ? scored.filter((s) => s.matchedFridgeItems.length > 0) : scored;

    const suggestions: MealSuggestion[] = ranked.slice(0, matchOnly ? MATCH_ONLY_TOP_N : TOP_N).map(({ recipe, fridgeMatchScore, matchedFridgeItems }) => ({
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
      nutritionUnavailable: recipe.nutritionUnavailable,
      fridgeMatchScore,
      matchedFridgeItems,
    }));

    const body: ApiResponse<MealSuggestionsResponse> = { ok: true, data: { mealType: mealType ?? null, suggestions } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-suggestions error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch meal suggestions" } };
    return c.json(body, 502);
  }
});
