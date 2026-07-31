/**
 * Daily recipe draft agent (HANDOFF_daily-recipe-draft-agent.md + gap-aware
 * addendum). Cloudflare Cron Trigger job: fetches inspiration, has OpenRouter
 * write an original recipe, computes a cost/nutrition preview, and inserts
 * into `recipe_drafts` as status:"pending". NEVER writes to `recipes` or
 * `recipe_cost` — those are only touched by the admin approve route.
 */
import type { Document } from "mongodb";
import type { CanonicalIngredient, CanonicalPriceCacheEntry, GapMatrixCell, GapTarget, MealSlot, Recipe, RecipeDraft, RecipeIngredient } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { buildPool } from "../services/mealPlanGenerator";
import {
  buildIdeaSpecs,
  computeGapMatrix,
  fetchExistingTitles,
  isTooSimilarTitle,
  readDraftState,
  selectPriorityGapTargets,
  writeDraftState,
  type IdeaSpec,
} from "../services/recipeDraftGenerator";
import { fetchSpoonacularIdeas, type SpoonacularEnv } from "../services/spoonacular";
import { draftRecipe, type OpenRouterEnv } from "../services/openrouter";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";

export interface DailyRecipeDraftEnv extends DbEnv, SpoonacularEnv, OpenRouterEnv {}

export interface DailyRecipeDraftSummary {
  dryRun: boolean;
  gapMatrix: GapMatrixCell[];
  priorityTargets: GapMatrixCell[];
  draftedTargets: GapTarget[];
  created: number;
  skippedDuplicates: number;
  drafts: Array<{ title: string; sourceInspiration: string; gapTarget?: GapTarget }>;
}

function ideaQuery(spec: IdeaSpec): { query: string; diet?: string; cuisine?: string } {
  if (spec.kind === "gap") {
    return { query: `${spec.slot} ${spec.dietary}`.trim(), diet: spec.dietary.replace(/-/g, " ") };
  }
  return { query: `${spec.cuisine} ${spec.diet}`.trim(), diet: spec.diet, cuisine: spec.cuisine };
}

export async function dailyRecipeDraft(env: DailyRecipeDraftEnv, dryRun = false): Promise<DailyRecipeDraftSummary> {
  const pool = await buildPool(env);
  const gapMatrix = computeGapMatrix(pool);
  const priorityTargets = selectPriorityGapTargets(gapMatrix, 5);

  const state = await readDraftState(env);
  const { specs, nextState, draftedTargets } = buildIdeaSpecs(priorityTargets, state);

  const existingTitles = await fetchExistingTitles(env);
  const usedTitlesThisRun = [...existingTitles];

  const { canonicalNames, aliasIndex, ingredientsMap, priceMap, quarantinedNames } = await withDb(env, async (db) => {
    const ingredientsCol = db.collection<Document>("canonical_ingredients");
    const priceCol = db.collection<Document>("canonical_price_cache");
    const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
    const allPriceDocs = (await priceCol.find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
    return {
      canonicalNames: allIngredientDocs.filter((d) => !d.quarantine).map((d) => d.canonical_name),
      aliasIndex: await buildAliasIndex(ingredientsCol),
      ingredientsMap: new Map(allIngredientDocs.map((d) => [d.canonical_name, d])),
      priceMap: new Map(allPriceDocs.map((d) => [d.canonical_name, d])),
      quarantinedNames: new Set(allIngredientDocs.filter((d) => d.quarantine).map((d) => d.canonical_name.toLowerCase().trim())),
    };
  });
  const resolveFn = (rawName: string) => resolve(rawName, aliasIndex);

  const drafts: RecipeDraft[] = [];
  const summaryDrafts: DailyRecipeDraftSummary["drafts"] = [];
  let skippedDuplicates = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const gapTarget = spec.kind === "gap" ? { slot: spec.slot as MealSlot, dietary: spec.dietary, countBefore: spec.countBefore } : undefined;

    // "Skip too-similar ideas, substitute another" (handoff) — up to
    // MAX_ATTEMPTS attempts per spec, each pulling a fresh Spoonacular batch
    // at a different offset, before this spec's slot in today's 20 is given
    // up on. Observed live 2026-07-31: raising this from 3->5 did not close
    // the gap (16/20 -> 15/20) — the shortfall is corpus/model variance for
    // niche gap combos, not an attempt-count problem.
    let idea: { title: string; summary: string } | null = null;
    let drafted: Awaited<ReturnType<typeof draftRecipe>> | null = null;

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !drafted; attempt++) {
      // Spacing calls out avoids RapidAPI's free-tier per-second throttling
      // (observed live 2026-07-31 as 429s when requests fire back-to-back) —
      // distinct from fetchSpoonacularIdeas' own single-retry-on-429 backoff.
      if (i > 0 || attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));

      idea = null;
      try {
        const q = ideaQuery(spec);
        const ideas = await fetchSpoonacularIdeas(env, { ...q, number: 5, offset: attempt * 5 });
        for (const candidate of ideas) {
          if (!isTooSimilarTitle(candidate.title, usedTitlesThisRun)) {
            idea = candidate;
            break;
          }
        }
        if (!idea && ideas.length > 0 && attempt === MAX_ATTEMPTS - 1) idea = ideas[0]!; // last attempt: best-effort fallback, still logged as a real inspiration
      } catch (err) {
        console.error("[uiu-api] spoonacular fetch failed for spec", JSON.stringify(spec), "attempt", attempt, err instanceof Error ? err.message : String(err));
      }
      if (!idea) continue;

      try {
        const candidate = await draftRecipe(env, {
          dishIdea: idea.title,
          cuisineHint: spec.kind === "rotation" ? spec.cuisine : undefined,
          dietHint: spec.kind === "rotation" ? spec.diet : undefined,
          canonicalNames,
          gapConstraint: spec.kind === "gap" ? { slot: spec.slot, dietary: spec.dietary } : undefined,
        });
        if (isTooSimilarTitle(candidate.title, usedTitlesThisRun)) {
          continue; // substitute another idea next attempt, per handoff
        }
        drafted = candidate;
      } catch (err) {
        console.error("[uiu-api] OpenRouter draft failed for idea", idea.title, "attempt", attempt, err instanceof Error ? err.message : String(err));
      }
    }

    if (!idea || !drafted) {
      skippedDuplicates += 1;
      continue;
    }
    usedTitlesThisRun.push(drafted.title);

    const ingredients: RecipeIngredient[] = drafted.ingredients.map((ing) => ({
      name: ing.name,
      quantity: ing.quantity,
      unit: ing.unit,
    }));

    const costInput = { ingredients, servings: drafted.servings } as unknown as Recipe;
    const cost = costRecipe(costInput, resolveFn, ingredientsMap, priceMap, quarantinedNames);

    let calories = 0, protein = 0, carbs = 0, fat = 0;
    for (const line of cost.lines) {
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

    const draft: RecipeDraft = {
      _id: "",
      title: drafted.title,
      description: drafted.description,
      ingredients,
      steps: drafted.steps,
      tags: drafted.tags,
      mealType: drafted.mealType,
      servings: drafted.servings,
      prepTimeMinutes: drafted.prepTimeMinutes,
      cookTimeMinutes: drafted.cookTimeMinutes,
      nutrition: {
        calories: Math.round(calories),
        protein: Math.round(protein * 10) / 10,
        carbs: Math.round(carbs * 10) / 10,
        fat: Math.round(fat * 10) / 10,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
      sourceInspiration: idea.title,
      gapTarget,
      costPreview: cost.basket > 0
        ? { basket: cost.basket, currency: "GBP", perServing: cost.perServing, adjustedCoveragePct: cost.adjustedCoveragePct }
        : null,
    };
    drafts.push(draft);
    summaryDrafts.push({ title: draft.title, sourceInspiration: draft.sourceInspiration, gapTarget: draft.gapTarget });
  }

  if (!dryRun && drafts.length > 0) {
    await withDb(env, async (db) => {
      await db.collection("recipe_drafts").insertMany(
        drafts.map(({ _id, ...rest }) => rest) as unknown as Document[],
      );
    });
  }
  if (!dryRun) {
    await writeDraftState(env, nextState, { date: new Date().toISOString().slice(0, 10), targets: draftedTargets });
  }

  return {
    dryRun,
    gapMatrix,
    priorityTargets,
    draftedTargets,
    created: drafts.length,
    skippedDuplicates,
    drafts: summaryDrafts,
  };
}
