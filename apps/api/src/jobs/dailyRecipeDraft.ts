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
  findTitleMatch,
  finalizeDraftQueue,
  readDraftState,
  savePendingQueue,
  selectPriorityGapTargets,
  type DraftQueue,
  type IdeaSpec,
} from "../services/recipeDraftGenerator";
import { fetchSpoonacularIdeas, type SpoonacularEnv } from "../services/spoonacular";
import { draftRecipe, type OpenRouterEnv } from "../services/openrouter";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";
import { findRecipePhoto, type PexelsEnv } from "../services/pexels";

export interface DailyRecipeDraftEnv extends DbEnv, SpoonacularEnv, OpenRouterEnv, PexelsEnv {}

export interface DailyRecipeDraftSummary {
  dryRun: boolean;
  gapMatrix: GapMatrixCell[];
  priorityTargets: GapMatrixCell[];
  draftedTargets: GapTarget[];
  created: number;
  skippedDuplicates: number;
  drafts: Array<{ title: string; sourceInspiration: string; gapTarget?: GapTarget }>;
  /** Batching status (see BATCH_SIZE below) — each invocation only attempts a slice of the day's 20 specs to stay well under Cloudflare's per-invocation subrequest cap. */
  batch: { attempted: number; remainingAfterThisRun: number; queueDate: string; alreadyCompletedToday: boolean };
}

/**
 * How many idea specs a single invocation attempts. Cloudflare enforces a
 * per-invocation subrequest cap (observed live 2026-08-04: exactly 50,
 * "Too many subrequests by single Worker invocation" fired 50 times when all
 * 20 specs + their retries ran in one go). Each spec can burn up to
 * MAX_ATTEMPTS * 2 subrequests (1 Spoonacular fetch, occasionally doubled by
 * its own 429 retry, + 1 OpenRouter draft call), plus a handful of Mongo
 * queries shared across the whole invocation — so BATCH_SIZE=3 with
 * MAX_ATTEMPTS=3 caps a single run at roughly 3*(3*2)=18 idea/draft
 * subrequests, leaving comfortable headroom under 50. The remaining specs
 * stay queued in `recipe_draft_state` and are picked up by the next cron
 * fire (wrangler.toml now fires this job several times a day instead of
 * once) until the day's 20 are done, then rotation state commits once.
 */
const BATCH_SIZE = 3;

function ideaQuery(spec: IdeaSpec): { query: string; diet?: string; cuisine?: string } {
  if (spec.kind === "gap") {
    return { query: `${spec.slot} ${spec.dietary}`.trim(), diet: spec.dietary.replace(/-/g, " ") };
  }
  return { query: `${spec.cuisine} ${spec.diet}`.trim(), diet: spec.diet, cuisine: spec.cuisine };
}

export async function dailyRecipeDraft(env: DailyRecipeDraftEnv, dryRun = false): Promise<DailyRecipeDraftSummary> {
  const today = new Date().toISOString().slice(0, 10);
  const pool = await buildPool(env);
  const gapMatrix = computeGapMatrix(pool);
  const priorityTargets = selectPriorityGapTargets(gapMatrix, 5);

  const state = await readDraftState(env);

  // Live 2026-08-04: 20 specs in one invocation reliably blew Cloudflare's
  // per-invocation subrequest cap (50/50 "Too many subrequests" failures).
  // A day's specs are now built once and drained BATCH_SIZE-at-a-time across
  // however many cron fires it takes — resume an in-progress queue for today
  // if one exists, otherwise build a fresh one (or no-op if today's already done).
  let queue: DraftQueue;
  if (!dryRun && state.completedDate === today) {
    return {
      dryRun,
      gapMatrix,
      priorityTargets,
      draftedTargets: [],
      created: 0,
      skippedDuplicates: 0,
      drafts: [],
      batch: { attempted: 0, remainingAfterThisRun: 0, queueDate: today, alreadyCompletedToday: true },
    };
  } else if (!dryRun && state.queue && state.queue.date === today && state.queue.specs.length > 0) {
    queue = state.queue;
  } else {
    const built = buildIdeaSpecs(priorityTargets, state);
    queue = {
      date: today,
      specs: built.specs,
      draftedTargets: built.draftedTargets,
      nextCuisineIndex: built.nextState.lastCuisineIndex,
      nextDietIndex: built.nextState.lastDietIndex,
    };
  }

  // dryRun previews always run the full first batch of a fresh queue (never
  // resumes/persists) so a manual `?write=false` check still shows a
  // representative slice, same as before this batching change.
  const specs = queue.specs.slice(0, BATCH_SIZE);
  const remainingAfterThisRun = queue.specs.slice(BATCH_SIZE);
  const draftedTargets = queue.draftedTargets;

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
    // niche gap combos, not an attempt-count problem. Reverted 5->3 on
    // 2026-08-05 as part of the subrequest-cap fix (each attempt costs up to
    // 2 subrequests; 3 attempts * BATCH_SIZE(3) keeps a single invocation
    // well under Cloudflare's 50 subrequest cap — see BATCH_SIZE comment).
    let idea: { title: string; summary: string } | null = null;
    let drafted: Awaited<ReturnType<typeof draftRecipe>> | null = null;

    const MAX_ATTEMPTS = 3;
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
          const match = findTitleMatch(candidate.title, usedTitlesThisRun);
          if (!match) {
            idea = candidate;
            break;
          }
          console.log("[uiu-api] dedup skip (idea):", JSON.stringify({ candidate: candidate.title, matchedTitle: match.matchedTitle, rule: match.rule }));
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
        const draftedMatch = findTitleMatch(candidate.title, usedTitlesThisRun);
        if (draftedMatch) {
          console.log("[uiu-api] dedup skip (drafted):", JSON.stringify({ candidate: candidate.title, matchedTitle: draftedMatch.matchedTitle, rule: draftedMatch.rule }));
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

    // Fetch the photo at creation time (HANDOFF_recipe-image-gaps.md §2) — lets the review
    // UI show an image before approve, and lets approve reuse it instead of re-calling Pexels.
    const imageUrl = await findRecipePhoto(env, drafted.title).catch(() => null);

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
      imageUrl,
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
    if (remainingAfterThisRun.length > 0) {
      await savePendingQueue(env, { ...queue, specs: remainingAfterThisRun });
    } else {
      await finalizeDraftQueue(
        env,
        { lastCuisineIndex: queue.nextCuisineIndex, lastDietIndex: queue.nextDietIndex },
        { date: today, targets: draftedTargets },
      );
    }
  }

  return {
    dryRun,
    gapMatrix,
    priorityTargets,
    draftedTargets,
    created: drafts.length,
    skippedDuplicates,
    drafts: summaryDrafts,
    batch: { attempted: specs.length, remainingAfterThisRun: remainingAfterThisRun.length, queueDate: today, alreadyCompletedToday: false },
  };
}
