/**
 * Shared approve/reject logic for recipe_drafts — extracted from
 * routes/adminRecipeDrafts.ts's POST /:id/approve and /:id/reject
 * (cc_prompt_recipe_drafts_auto_triage.md, 2026-10-08) so the admin route AND
 * scripts/triage_recipe_drafts.cjs (+ its Admin UI bulk-action equivalent) call
 * the exact same insert/cost-recompute logic instead of two copies drifting apart.
 *
 * Takes a plain mongodb `Db` so it works identically from a Hono route (via
 * withDb) and a standalone Node script (via its own MongoClient) — see db.ts's
 * withDb, which does nothing more than open a MongoClient itself.
 */
import type { Db, Document, ObjectId as ObjectIdType } from "mongodb";
import { ingredientTextGuard, type CanonicalIngredient, type CanonicalPriceCacheEntry, type Recipe, type RecipeCost, type RecipeCostLine } from "@uiu/shared";
import { getMongoModule } from "../db";
import { buildAliasIndex, resolve } from "./ingredientResolver";
import { costRecipe } from "./recipeCost";
import { computeRecipeNutrition } from "./nutritionGrams";
import { findRecipePhoto, type PexelsEnv } from "./pexels";
import { findNearDuplicateRecipe, type NearDuplicateMatch } from "@uiu/shared";
import type { OpenRouterEnv } from "./openrouter";
import { findSameDishLLM } from "./sameDish";
import { sanitizeRecipeText, stripRecipePlaceholders } from "./recipeTextSanitize";

export type ApproveDraftResult =
  | { notFound: true }
  | { alreadyDecided: true }
  | { nearDuplicate: NearDuplicateMatch }
  | { insertedId: string };

export interface TriageTag {
  batchId: string;
  reasons: string[];
}

/** Admin "force-approve" record (services/recipeDraftOverride.ts). When passed to approveRecipeDraft,
 * the near-duplicate + AI same-dish checks are skipped and this record is stored on the draft. */
export interface ForceApproveTag {
  by: string;
  note: string;
  at: string;
}

/** Identical to adminRecipeDrafts.ts's old inline POST /:id/approve body. `triage`, when passed,
 * tags the new `recipes` doc with autoApprovedBatchId and the draft with a `triage` record —
 * absent for a plain human-click approve (keeps that path's docs untagged, as before). */
export async function approveRecipeDraft(
  db: Db,
  env: PexelsEnv & Partial<OpenRouterEnv>,
  draftId: string,
  triage?: TriageTag,
  force?: ForceApproveTag,
): Promise<ApproveDraftResult> {
  const { ObjectId } = await getMongoModule();
  const draft = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(draftId) });
  if (!draft) return { notFound: true };
  if (draft.status !== "pending") return { alreadyDecided: true };

  // G1: refuse a draft that near-duplicates a public recipe (same rules as the 10-10 Part 11 clean-up).
  // Skipped only for an admin force-approve (a human already judged it is not the same dish).
  if (!force) {
    const publicRecipes = await db.collection("recipes").find({ isPublic: true }, { projection: { title: 1, "ingredients.name": 1 } }).toArray();
    const candidateSim = { title: String(draft.title ?? ""), ingredientNames: ((draft.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")) };
    const publicSim = publicRecipes.map((r) => ({ title: String(r.title ?? ""), ingredientNames: ((r.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")) }));
    const near = findNearDuplicateRecipe(candidateSim, publicSim);
    if (near) return { nearDuplicate: near };
    // AI same-dish check (services/sameDish.ts) — catches renamed duplicates the token rules miss. Throws on API failure.
    const sameDish = await findSameDishLLM(env, candidateSim, publicSim);
    if (sameDish) return { nearDuplicate: sameDish };
  }

  // 2026-11-09: last gate before `recipes` — fixes `_egg_` / `tomatoe` (pending drafts made before the
  // generator fix still carry them). Other `_word_` markup is stripped, logged, and the recipe held for review.
  const sanitized = sanitizeRecipeText({
    title: String(draft.title ?? ""),
    description: (draft.description as string) ?? "",
    ingredients: (draft.ingredients as Recipe["ingredients"]) ?? [],
    steps: (draft.steps as string[]) ?? [],
  });
  const hasUnknownPlaceholder = sanitized.unknownPlaceholders.length > 0;
  const clean = hasUnknownPlaceholder ? stripRecipePlaceholders(sanitized.recipe) : sanitized.recipe;
  if (sanitized.changes.length > 0 || hasUnknownPlaceholder) {
    console.log("[uiu-api] approve text fixed:", JSON.stringify({
      draftId,
      fields: sanitized.changes.map((c) => c.field),
      unknownPlaceholders: sanitized.unknownPlaceholders,
    }));
  }

  const now = new Date().toISOString();
  const draftImageUrl = draft.imageUrl as string | null | undefined;
  const imageUrl = draftImageUrl ? draftImageUrl : await findRecipePhoto(env, clean.title).catch(() => null);

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
  // Nutrition is recomputed here with the shared gram conversion (nutritionGrams.ts) instead of
  // trusting draft.nutrition, which older drafts computed with the ml/pc-blind formula.
  const nutrition = computeRecipeNutrition(
    clean.ingredients,
    draft.servings as number,
    resolveFn,
    ingredientsMap,
  ).nutrition;
  const guardResult = ingredientTextGuard(clean.ingredients as { quantity: number; unit: string; name: string }[]);
  const holdForReview = guardResult.suspicious || hasUnknownPlaceholder;
  const recipeDoc: Omit<Recipe, "_id"> = {
    title: clean.title,
    description: clean.description ?? "",
    isPublic: !holdForReview,
    needs_review: holdForReview || undefined,
    userId: null,
    ingredients: clean.ingredients,
    steps: clean.steps,
    tags: draft.tags as string[],
    servings: draft.servings as number,
    prepTimeMinutes: draft.prepTimeMinutes as number,
    cookTimeMinutes: draft.cookTimeMinutes as number,
    imageUrl: imageUrl ?? "",
    nutrition,
    source: draft.importMethod === "photo-ocr" ? "photo_import"
      : draft.importMethod === "fridge_generated" ? "fridge_generated"
      : draft.sourceUrl ? "social_import"
      : "ai_daily_draft",
    sourcePlatform: (draft.sourcePlatform as Recipe["sourcePlatform"]) ?? null,
    sourceUrl: (draft.sourceUrl as string) ?? undefined,
    collectionIds: [],
    isFavorite: false,
    viewCount: 0,
    favoriteCount: 0,
    __v: 0,
    createdAt: now,
    updatedAt: now,
    mealType: draft.mealType as string | undefined,
    ...(triage ? { autoApprovedBatchId: triage.batchId } : {}),
  };
  const insertResult = await db.collection("recipes").insertOne(recipeDoc as unknown as Document);

  const cost = costRecipe({ ...recipeDoc, _id: insertResult.insertedId } as unknown as Recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);

  const recipeCostDoc: Omit<RecipeCost, "_id"> = {
    recipeId: insertResult.insertedId.toString(),
    basket: cost.basket,
    currency: cost.currency,
    coveragePct: cost.coveragePct,
    adjustedCoveragePct: cost.adjustedCoveragePct,
    totalLines: cost.totalLines,
    priceableCount: cost.priceableCount,
    adjustedTotal: cost.adjustedTotal,
    adjustedPriceable: cost.adjustedPriceable,
    pantryLineCount: cost.pantryLineCount,
    junkLineCount: cost.junkLineCount,
    perServing: cost.perServing,
    lines: cost.lines as unknown as RecipeCostLine[],
    unpriceableReasons: cost.unpriceableReasons,
    computedAt: now,
    priceCacheStamp: 0,
  };
  await db.collection("recipe_cost").insertOne({ ...recipeCostDoc, recipeId: insertResult.insertedId } as unknown as Document);

  await db.collection("recipe_drafts").updateOne(
    { _id: new ObjectId(draftId) },
    {
      $set: {
        status: "approved",
        ...(triage ? { triage: { batchId: triage.batchId, action: "auto_approve" as const, reasons: triage.reasons, at: now } } : {}),
        ...(force ? { forceApproved: { ...force, recipeId: insertResult.insertedId.toString() } } : {}),
      },
    },
  );
  return { insertedId: insertResult.insertedId.toString() };
}

export type RejectDraftResult = { notFound: true } | { ok: true };

/** Identical semantics to adminRecipeDrafts.ts's old inline POST /:id/reject (atomic
 * status:"pending" filter so a concurrent approve/reject can't double-process one draft) —
 * now also accepts an optional `rejectedReason` + `triage` tag for the auto-reject path. */
export async function rejectRecipeDraft(
  db: Db,
  draftId: string,
  opts?: { rejectedReason?: string; triage?: TriageTag },
): Promise<RejectDraftResult> {
  const { ObjectId } = await getMongoModule();
  const now = new Date().toISOString();
  const result = await db.collection("recipe_drafts").updateOne(
    { _id: new ObjectId(draftId) as unknown as ObjectIdType, status: "pending" },
    {
      $set: {
        status: "rejected",
        ...(opts?.rejectedReason ? { rejectedReason: opts.rejectedReason } : {}),
        ...(opts?.triage ? { triage: { batchId: opts.triage.batchId, action: "auto_reject" as const, reasons: opts.triage.reasons, at: now } } : {}),
      },
    },
  );
  if (result.matchedCount === 0) return { notFound: true };
  return { ok: true };
}
