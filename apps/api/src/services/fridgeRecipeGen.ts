/**
 * HANDOFF_fridge-ai-recipe-generator.md §1 — generate a wholly new recipe from a
 * user-picked subset of fridge_stock item names. Reuses the same OpenRouter
 * stack/model as draftRecipe()/parseRecipeFromText() (OPENROUTER_API_KEY,
 * OPENROUTER_MODEL) — no new key. Returns null (not throw) on any failure so
 * the caller can respond with a friendly "generation failed, try again"
 * instead of a 500, same convention as parseRecipeFromText().
 */
import type { DraftedRecipe, OpenRouterEnv } from "./openrouter";

const MIN_INGREDIENTS = 2;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  return JSON.parse(candidate);
}

export async function generateRecipeFromFridge(env: OpenRouterEnv, ingredientNames: string[]): Promise<DraftedRecipe | null> {
  try {
    const prompt =
      `You are a recipe generation assistant. The user currently has the following ingredients ` +
      `(in their fridge):\n${ingredientNames.map((n) => `- ${n}`).join("\n")}\n\n` +
      `Generate one recipe that uses these ingredients as the main components (you can assume the ` +
      `user has basic pantry staples like salt, sugar, oil, pepper, and water — not every selected ` +
      `ingredient has to be used, but try to use most of them). ` +
      `Output: title, description, meal type (one of breakfast/lunch/dinner/snack/dessert), servings, ` +
      `prep time, cook time, ingredients (each with quantity + unit), steps.\n\n` +
      `Before outputting, cross-check every dietary tag against the actual ingredients[] you just wrote — ` +
      `do not guess. Only include "vegetarian" if no meat/poultry/fish ingredient is present. Only include ` +
      `"vegan" if no animal product (meat/fish/dairy/egg/honey) is present at all. Only include ` +
      `"gluten-free" if no wheat/flour/pasta/bread/barley/rye/oats(non-GF) ingredient is present. Only ` +
      `include "dairy-free" if no milk/cheese/butter/cream/yoghurt ingredient is present. If you are not ` +
      `certain a dietary tag is accurate, leave it out rather than including it speculatively — a missing ` +
      `tag is far less harmful than a wrong one, since these tags directly drive Meal Planner's dietary ` +
      `filtering.\n\n` +
      `Also ensure "mealType" is exactly one of: breakfast, lunch, dinner, snack, dessert — no other ` +
      `value. In tags[], besides mealType/dietary tags, include AT LEAST 5-8 additional specific and ` +
      `useful tags covering multiple angles — cuisine origin (e.g. "greek", "sichuan"), cooking method ` +
      `(e.g. "sheet-pan", "one-pot", "no-bake"), standout ingredients (e.g. "feta", "chickpea"), ` +
      `texture/mood (e.g. "creamy", "spicy", "comfort-food"), and occasion (e.g. "weeknight", ` +
      `"meal-prep", "date-night") where genuinely applicable — the goal is to maximize how findable this ` +
      `recipe is via tag search, so err on the side of more specific tags rather than fewer. Avoid only ` +
      `generic filler tags like "easy" or "dinner" that duplicate mealType or add no searchable ` +
      `information — those can still appear, but should not be the ONLY other tags.\n\n` +
      `Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape: ` +
      `{"title": string, "description": string, "ingredients": [{"name": string, "quantity": number, "unit": string}], ` +
      `"steps": [string], "tags": [string], "mealType": string, "servings": number, "prepTimeMinutes": number, "cookTimeMinutes": number}.`;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = extractJson(content) as Partial<DraftedRecipe>;
    if (!parsed.title || !Array.isArray(parsed.ingredients) || parsed.ingredients.length < MIN_INGREDIENTS || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    return {
      title: parsed.title,
      description: parsed.description ?? "",
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      mealType: parsed.mealType,
      servings: parsed.servings ?? 2,
      prepTimeMinutes: parsed.prepTimeMinutes ?? 0,
      cookTimeMinutes: parsed.cookTimeMinutes ?? 0,
    };
  } catch (err) {
    console.error("[uiu-api] generateRecipeFromFridge failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
