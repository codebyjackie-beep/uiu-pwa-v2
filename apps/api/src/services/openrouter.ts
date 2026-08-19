/**
 * OpenRouter recipe drafting (HANDOFF_daily-recipe-draft-agent.md Part B).
 * Model-agnostic — OPENROUTER_MODEL is a wrangler.toml [vars] entry, not
 * hardcoded, so Jackie can change model without touching code/secrets.
 */
export interface OpenRouterEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
}

export interface DraftRecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface DraftedRecipe {
  title: string;
  description: string;
  ingredients: DraftRecipeIngredient[];
  steps: string[];
  tags: string[];
  mealType?: string;
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
}

export interface DraftPromptInput {
  dishIdea: string;
  cuisineHint?: string;
  dietHint?: string;
  canonicalNames: string[];
  /** Set only for gap-target drafts — must be explicitly enforced in both the instructions and the required tags[]. */
  gapConstraint?: { slot: string; dietary: string };
}

function buildPrompt(input: DraftPromptInput): string {
  const lines: string[] = [];
  lines.push(
    `Write one wholly original recipe inspired by the dish idea "${input.dishIdea}". ` +
      `Do not copy, translate, or closely paraphrase any reference text — write it fresh.`,
  );
  if (input.cuisineHint) lines.push(`Cuisine direction: ${input.cuisineHint}.`);
  if (input.dietHint) lines.push(`Dietary direction: ${input.dietHint}.`);
  if (input.gapConstraint) {
    lines.push(
      `This recipe MUST be ${input.gapConstraint.slot}-appropriate and MUST naturally satisfy the ` +
        `"${input.gapConstraint.dietary}" dietary requirement. Its tags[] array MUST include both ` +
        `"${input.gapConstraint.slot}" and "${input.gapConstraint.dietary}" as literal strings — this is ` +
        `mandatory, not optional, since downstream matching depends on these exact tag strings being present.`,
    );
  }
  lines.push(
    `Every ingredient name in ingredients[] MUST be chosen from this exact canonical ingredient name list ` +
      `(use the names verbatim, do not invent new ingredient names, do not add descriptors to them): ` +
      `${input.canonicalNames.join(", ")}.`,
  );
  lines.push(
    `Before outputting, cross-check every dietary tag against the actual ingredients[] you just wrote — ` +
      `do not guess. Only include "vegetarian" if no meat/poultry/fish ingredient is present. Only include ` +
      `"vegan" if no animal product (meat/fish/dairy/egg/honey) is present at all. Only include ` +
      `"gluten-free" if no wheat/flour/pasta/bread/barley/rye/oats(non-GF) ingredient is present. Only ` +
      `include "dairy-free" if no milk/cheese/butter/cream/yoghurt ingredient is present. If you are not ` +
      `certain a dietary tag is accurate, leave it out rather than including it speculatively — a missing ` +
      `tag is far less harmful than a wrong one, since these tags directly drive Meal Planner's dietary ` +
      `filtering.`,
  );
  lines.push(
    `Also ensure "mealType" is exactly one of: breakfast, lunch, dinner, snack, dessert — no other ` +
      `value. In tags[], besides mealType/dietary tags, include AT LEAST 5-8 additional specific and ` +
      `useful tags covering multiple angles — cuisine origin (e.g. "greek", "sichuan"), cooking method ` +
      `(e.g. "sheet-pan", "one-pot", "no-bake"), standout ingredients (e.g. "feta", "chickpea"), ` +
      `texture/mood (e.g. "creamy", "spicy", "comfort-food"), and occasion (e.g. "weeknight", ` +
      `"meal-prep", "date-night") where genuinely applicable — the goal is to maximize how findable this ` +
      `recipe is via tag search, so err on the side of more specific tags rather than fewer. Avoid only ` +
      `generic filler tags like "easy" or "dinner" that duplicate mealType or add no searchable ` +
      `information — those can still appear, but should not be the ONLY other tags.`,
  );
  lines.push(
    `Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape: ` +
      `{"title": string, "description": string, "ingredients": [{"name": string, "quantity": number, "unit": string}], ` +
      `"steps": [string], "tags": [string], "mealType": string, "servings": number, "prepTimeMinutes": number, "cookTimeMinutes": number}.`,
  );
  return lines.join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  return JSON.parse(candidate);
}

export async function draftRecipe(env: OpenRouterEnv, input: DraftPromptInput): Promise<DraftedRecipe> {
  const prompt = buildPrompt(input);
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
  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter response had no message content");

  const parsed = extractJson(content) as Partial<DraftedRecipe>;
  if (!parsed.title || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error("OpenRouter response did not match the expected Recipe shape");
  }
  return {
    title: parsed.title,
    description: parsed.description ?? "",
    ingredients: parsed.ingredients as DraftRecipeIngredient[],
    steps: parsed.steps,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    mealType: parsed.mealType,
    servings: parsed.servings ?? 2,
    prepTimeMinutes: parsed.prepTimeMinutes ?? 0,
    cookTimeMinutes: parsed.cookTimeMinutes ?? 0,
  };
}
