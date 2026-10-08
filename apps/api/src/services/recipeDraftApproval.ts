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
import { findRecipePhoto, type PexelsEnv } from "./pexels";

export type ApproveDraftResult =
  | { notFound: true }
  | { alreadyDecided: true }
  | { insertedId: string };

export interface TriageTag {
  batchId: string;
  reasons: string[];
}

/** Identical to adminRecipeDrafts.ts's old inline POST /:id/approve body. `triage`, when passed,
 * tags the new `recipes` doc with autoApprovedBatchId and the draft with a `triage` record —
 * absent for a plain human-click approve (keeps that path's docs untagged, as before). */
export async function approveRecipeDraft(
  db: Db,
  env: PexelsEnv,
  draftId: string,
  triage?: TriageTag,
): Promise<ApproveDraftResult> {
  const { ObjectId } = await getMongoModule();
  const draft = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(draftId) });
  if (!draft) return { notFound: true };
  if (draft.status !== "pending") return { alreadyDecided: true };

  const now = new Date().toISOString();
  const draftImageUrl = draft.imageUrl as string | null | undefined;
  const imageUrl = draftImageUrl ? draftImageUrl : await findRecipePhoto(env, draft.title as string).catch(() => null);
  const guardResult = ingredientTextGuard(draft.ingredients as { quantity: number; unit: string; name: string }[]);
  const recipeDoc: Omit<Recipe, "_id"> = {
    title: draft.title as string,
    description: (draft.description as string) ?? "",
    isPublic: !guardResult.suspicious,
    needs_review: guardResult.suspicious || undefined,
    userId: null,
    ingredients: draft.ingredients as Recipe["ingredients"],
    steps: draft.steps as string[],
    tags: draft.tags as string[],
    servings: draft.servings as number,
    prepTimeMinutes: draft.prepTimeMinutes as number,
    cookTimeMinutes: draft.cookTimeMinutes as number,
    imageUrl: imageUrl ?? "",
    nutrition: draft.nutrition as Recipe["nutrition"],
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
