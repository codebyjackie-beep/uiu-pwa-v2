/**
 * AI same-dish check (Jackie 2026-11-06). The token rules in findNearDuplicateRecipe (G1) let 159 renamed duplicates
 * go public in the 10-08 / 10-29 triage batches — e.g. 8 prawn biryanis, 13 spinach frittatas — because the AI
 * rewrites title and garnish each time (title/ingredient overlap often only 0.1–0.4). So before a recipe goes
 * public we shortlist the 8 most similar public recipes (rankSimilarRecipes: on that duplicate set the real original
 * was in the top 8 for 159/159) and ask the model whether the candidate is the same dish as one of them.
 *
 * No OPENROUTER_API_KEY → skipped (returns null). Any API / parse failure THROWS: callers keep the draft pending
 * rather than publish something unchecked.
 */
import { rankSimilarRecipes, recipeSimilarityScores, type NearDuplicateMatch, type SimilarityRecipe } from "@uiu/shared";
import type { OpenRouterEnv } from "./openrouter";
import { compatibleMainProteins } from "./mainProtein";

export const SAME_DISH_SHORTLIST = 8;

export class SameDishCheckError extends Error {}

function describe(r: SimilarityRecipe): string {
  const ings = r.ingredientNames.filter(Boolean).slice(0, 20).join(", ");
  return `${r.title} — ingredients: ${ings}`;
}

function buildPrompt(candidate: SimilarityRecipe, shortlist: SimilarityRecipe[]): string {
  return [
    "You keep a recipe library free of duplicates.",
    "A DUPLICATE is the same dish as an existing recipe: same core ingredients and same cooking method / format, even if",
    "the name, garnish, spices, sauce flavour or one or two minor ingredients differ (e.g. two prawn biryanis, two spinach",
    "frittatas, two guacamoles, two mushroom crepes).",
    "NOT a duplicate: a different format (soup vs stir-fry, salad vs bake, bowl vs sandwich) or a different main protein /",
    "main vegetable / main carb that changes what the dish is.",
    "Main protein rule: if one recipe has a main protein (meat, fish, seafood, tofu, paneer, eggs as the base) that the other",
    "does not have, they are NOT duplicates (salmon frittata vs spinach frittata = NOT a duplicate; chicken curry vs",
    "chickpea curry = NOT a duplicate). Same for the main carb base (sweet potato gnocchi vs chickpea gnocchi = NOT a duplicate).",
    "When unsure, answer null.",
    "",
    `CANDIDATE: ${describe(candidate)}`,
    "",
    "EXISTING:",
    ...shortlist.map((r, i) => `${i + 1}. ${describe(r)}`),
    "",
    'Reply with JSON only: {"match": <number of the EXISTING recipe that is the same dish, or null>, "reason": "<12 words max>"}',
  ].join("\n");
}

/** Same-dish match among the public corpus, or null. Throws SameDishCheckError if the model call fails. */
export async function findSameDishLLM(
  env: Partial<OpenRouterEnv>,
  candidate: SimilarityRecipe,
  corpus: SimilarityRecipe[],
): Promise<(NearDuplicateMatch & { reason: string }) | null> {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) return null;
  // Hard rule (services/mainProtein.ts): recipes whose main proteins clearly differ are never the same dish, so those recipes never reach the model.
  const sameProtein = corpus.filter((r) => compatibleMainProteins(candidate, r));
  const shortlist = rankSimilarRecipes(candidate, sameProtein, SAME_DISH_SHORTLIST);
  if (shortlist.length === 0) return null;

  let content: string | undefined;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: buildPrompt(candidate, shortlist) }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new SameDishCheckError(`OpenRouter ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = json.choices?.[0]?.message?.content;
  } catch (err) {
    throw err instanceof SameDishCheckError ? err : new SameDishCheckError(err instanceof Error ? err.message : String(err));
  }
  if (!content) throw new SameDishCheckError("empty model reply");

  const m = content.match(/\{[\s\S]*\}/);
  let parsed: { match?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(m ? m[0] : content) as { match?: unknown; reason?: unknown };
  } catch {
    throw new SameDishCheckError("model reply was not JSON");
  }
  const idx = typeof parsed.match === "number" ? parsed.match : typeof parsed.match === "string" ? Number(parsed.match) : null;
  if (idx === null || !Number.isInteger(idx) || idx < 1 || idx > shortlist.length) return null;
  const hit = shortlist[idx - 1]!;
  const s = recipeSimilarityScores(candidate, hit);
  return {
    title: hit.title,
    rule: "same_dish",
    titleJaccard: +s.titleJaccard.toFixed(2),
    ingredientJaccard: +s.ingredientJaccard.toFixed(2),
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : "",
  };
}
