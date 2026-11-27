/**
 * Tag/mealType classify prompt for the admin backfill-tags-and-images route (routes/adminRecipeDrafts.ts).
 * Moved out of the route so it can be unit-tested; steps go through normalizeRecipeSteps so an old draft
 * with object steps no longer puts "[object Object]" into the prompt.
 */
import { normalizeRecipeSteps } from "./recipeSteps";

/** HANDOFF_recipe-drafts-batch-regenerate.md §1 — same dietary self-check rule as
 * HANDOFF_recipe-draft-tag-accuracy.md §1's draft-generation prompt, applied here as a
 * classify-only pass (existing ingredients/steps are input, never rewritten). */
export function buildTagClassifyPrompt(draft: { title: string; description: string; ingredients: Array<{ name: string; quantity: number; unit: string }>; steps: unknown }): string {
  return (
    `Here is an existing recipe (do NOT rewrite it, only classify it):\n` +
    `Title: ${draft.title}\n` +
    `Description: ${draft.description}\n` +
    `Ingredients: ${draft.ingredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`).join(", ")}\n` +
    `Steps: ${normalizeRecipeSteps(draft.steps).join(" ")}\n\n` +
    `Based ONLY on the above, output corrected tags. Cross-check every dietary tag against the ` +
    `actual ingredients — only include "vegetarian" if no meat/poultry/fish ingredient is present, ` +
    `"vegan" only if no animal product at all, "gluten-free" only if no wheat/flour/pasta/bread/ ` +
    `barley/rye/non-GF-oats ingredient is present, "dairy-free" only if no milk/cheese/butter/cream/ ` +
    `yoghurt ingredient is present. If uncertain, leave the tag out. Ensure "mealType" is exactly one ` +
    `of: breakfast, lunch, dinner, snack, dessert. Besides mealType/dietary tags, include at least ` +
    `5-8 additional specific tags (cuisine, cooking method, standout ingredients, texture/mood, ` +
    `occasion) — avoid only-generic filler like "easy"/"dinner".\n\n` +
    `Respond with ONLY a JSON object: {"tags": [string], "mealType": string}.`
  );
}
