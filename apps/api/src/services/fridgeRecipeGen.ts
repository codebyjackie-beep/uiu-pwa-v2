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
