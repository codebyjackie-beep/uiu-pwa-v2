/**
 * Auto-triage for pending recipe_drafts, runnable from the Worker (admin UI "Run auto-triage").
 *
 * Same rules as scripts/triage_recipe_drafts.cjs (cc_prompt_recipe_drafts_auto_triage.md,
 * 2026-10-08) — that script needed a local machine with direct DB access; this runs inside
 * uiu-api, which already reaches Atlas. Approve/reject go through the SAME
 * approveRecipeDraft()/rejectRecipeDraft() the per-draft buttons use, tagged with a batchId so
 * rollbackTriageBatch() can undo exactly one run.
 *
 * Flow (admin UI drives it, so no single request has to do all the work):
 *   1. planTriage()        — read-only: counts, reject-reason stats, samples, id lists.
 *   2. applyTriageChunk()  — re-evaluates server-side (never trusts the client's verdict),
 *                            then processes only the given ids (≤ APPLY_CHUNK_MAX per call).
 *   3. rollbackTriageBatch() — dry-run by default; write=true deletes the batch's recipes +
 *                            recipe_cost and returns its drafts to pending.
 */
import type { Db, Document } from "mongodb";
import {
  findNearDuplicateRecipe,
  ingredientNameLooksLikeFragment,
  type SimilarityRecipe,
  type CanonicalIngredient,
  type CanonicalPriceCacheEntry,
  type Recipe,
  type RecipeDraft,
} from "@uiu/shared";
import { getMongoModule } from "../db";
import { buildAliasIndex, resolve } from "./ingredientResolver";
import { costRecipe } from "./recipeCost";
import { computeRecipeNutrition } from "./nutritionGrams";
import { findRecipePhoto, type PexelsEnv } from "./pexels";
import { approveRecipeDraft, rejectRecipeDraft } from "./recipeDraftApproval";

export const SANITY_MAX_AUTO_APPROVE = 600;
export const SANITY_MAX_AUTO_REJECT = 500;
export const APPLY_CHUNK_MAX = 10;
const NUTRITION_COVERAGE_MIN = 0.7;
const SPOONACULAR_DEAD_HOST = "img.spoonacular.com";
const FETCH_TIMEOUT_MS = 8000;
const BATCH_ID_RE = /^triage_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/;
const MALFORMED_TAG_RE = /^mealType\s+/i;

export type TriageVerdict = "approve_candidate" | "reject" | "needs_review" | "pending";

interface Evaluated {
  id: string;
  title: string;
  verdict: TriageVerdict;
  reasons: string[];
  calories: number;
  adjustedCoveragePct: number;
  imageUrl?: string;
  tags?: string[];
  /** needs_review already set by an earlier run — no need to send it through apply again. */
  alreadyFlagged?: boolean;
}

export interface TriagePlan {
  generatedAt: string;
  totalPending: number;
  counts: { approve_candidate: number; reject: number; needs_review: number; pending: number };
  rejectReasonCounts: Record<string, number>;
  sanityGateTripped: boolean;
  samples: Record<TriageVerdict, Array<{ id: string; title: string; calories: number; adjustedCoveragePct: number; reasons: string[] }>>;
  ids: { approve_candidate: string[]; reject: string[]; needs_review: string[] };
  note: string;
}

export function isValidBatchId(id: unknown): id is string {
  return typeof id === "string" && BATCH_ID_RE.test(id);
}

export function newBatchId(now = new Date()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `triage_${now.toISOString().slice(0, 10)}_${hex}`;
}

export function normalizeTitle(title: string | undefined): string {
  return (title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

/** Strips only the known leaked-key shape ("mealType dinner") — same as the script. */
export function cleanTags(tags: unknown): string[] {
  return (Array.isArray(tags) ? tags : []).filter((t): t is string => typeof t === "string" && !MALFORMED_TAG_RE.test(t.trim()));
}

/** Objective reject rules for one draft. Pure, so it is unit-testable without a DB. */
export function rejectReasonsFor(input: {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  steps: number;
  ingredientNames: string[];
  servings: number;
}): string[] {
  const r: string[] = [];
  const { calories, protein, carbs, fat } = input;
  if (calories < 50 || calories > 1500) r.push(`calories_out_of_range:${calories}`);
  const macrosZero = protein === 0 && carbs === 0 && fat === 0;
  if ((macrosZero && calories > 0) || (calories === 0 && !macrosZero)) r.push("macro_calorie_mismatch");
  if (input.steps < 2) r.push(`too_few_steps:${input.steps}`);
  if (input.ingredientNames.length < 3) r.push(`too_few_ingredients:${input.ingredientNames.length}`);
  const frags = input.ingredientNames.filter((n) => ingredientNameLooksLikeFragment(n));
  if (frags.length) r.push(`fragment_ingredient_name:${frags.join("|")}`);
  if (input.servings < 1 || input.servings > 12) r.push(`servings_out_of_range:${input.servings}`);
  return r;
}

/** Approve gate (all must pass), applied only after no reject reason fired. Image is checked later. */
export function passesApproveGate(e: { adjustedCoveragePct: number; calories: number; steps: number; ingredients: number; mealType?: unknown }): boolean {
  return e.adjustedCoveragePct >= 80 && e.calories >= 150 && e.calories <= 1200 && e.steps >= 3 && e.ingredients >= 4 && !!e.mealType;
}

/** Loads every pending draft and evaluates it with the live cost + nutrition engines. */
export async function evaluatePendingDrafts(db: Db): Promise<Evaluated[]> {
  const [pendingDocs, liveRecipes] = await Promise.all([
    db.collection("recipe_drafts").find({ status: "pending" }).toArray(),
    db.collection("recipes").find({}, { projection: { title: 1, isPublic: 1, "ingredients.name": 1 } }).toArray(),
  ]);
  const toSim = (d: Document): SimilarityRecipe => ({
    title: String(d.title ?? ""),
    ingredientNames: ((d.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i?.name ?? "")),
  });
  // Same corpus approveRecipeDraft() checks against (public recipes); approve candidates are added
  // as they are accepted below, so two similar drafts don't both get planned as approve.
  const similarityCorpus: SimilarityRecipe[] = liveRecipes.filter((r) => r.isPublic === true).map(toSim);
  const ingredientsCol = db.collection<Document>("canonical_ingredients");
  const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
  const allPriceDocs = (await db.collection("canonical_price_cache").find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
  const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
  const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));
  const quarantinedNames = new Set(allIngredientDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()));
  const aliasIndex = await buildAliasIndex(ingredientsCol);
  const resolveFn = (raw: string) => resolve(raw, aliasIndex);
  const liveTitles = new Set(liveRecipes.map((r) => normalizeTitle(r.title as string)));

  const rows = pendingDocs.map((doc) => {
    const draft = doc as unknown as RecipeDraft & { _id: { toString(): string }; mealType?: string; imageUrl?: string; createdAt?: string };
    const ingredients = Array.isArray(draft.ingredients) ? draft.ingredients : [];
    const steps = Array.isArray(draft.steps) ? draft.steps : [];
    const cost = costRecipe(draft as unknown as Recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);
    const n = computeRecipeNutrition(ingredients, draft.servings, resolveFn, ingredientsMap).nutrition;
    const calories = n.calories ?? 0;
    const reasons = rejectReasonsFor({
      calories,
      protein: n.protein ?? 0,
      carbs: n.carbs ?? 0,
      fat: n.fat ?? 0,
      steps: steps.length,
      ingredientNames: ingredients.map((i) => (i && i.name) || ""),
      servings: draft.servings ?? 0,
    });
    const normTitle = normalizeTitle(draft.title);
    if (liveTitles.has(normTitle)) reasons.push("duplicate_title_live_recipe");
    return { draft, cost, calories, steps: steps.length, ingredients: ingredients.length, reasons, normTitle, lineCoverage: n.nutritionLineCoverage ?? 0 };
  });

  // Intra-pending duplicate titles: keep the best-covered (then newest), reject the rest.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = groups.get(r.normTitle) ?? [];
    g.push(r);
    groups.set(r.normTitle, g);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ranked = [...g].sort(
      (a, b) => b.cost.adjustedCoveragePct - a.cost.adjustedCoveragePct || String(b.draft.createdAt ?? "").localeCompare(String(a.draft.createdAt ?? "")),
    );
    for (let i = 1; i < ranked.length; i++) ranked[i]!.reasons.push(`duplicate_title_pending:kept:${ranked[0]!.draft._id.toString()}`);
  }

  return rows.map((r) => {
    const base = {
      id: r.draft._id.toString(),
      title: r.draft.title,
      calories: r.calories,
      adjustedCoveragePct: Math.round(r.cost.adjustedCoveragePct * 10) / 10,
      imageUrl: r.draft.imageUrl,
      tags: r.draft.tags,
      alreadyFlagged: (r.draft as unknown as { needs_review?: boolean }).needs_review === true,
    };
    if (r.reasons.length) return { ...base, verdict: "reject" as const, reasons: r.reasons };
    if (r.lineCoverage < NUTRITION_COVERAGE_MIN) return { ...base, verdict: "needs_review" as const, reasons: [`nutritionLineCoverage:${r.lineCoverage}`] };
    if (passesApproveGate({ adjustedCoveragePct: r.cost.adjustedCoveragePct, calories: r.calories, steps: r.steps, ingredients: r.ingredients, mealType: r.draft.mealType })) {
      // Would pass every rule but approveRecipeDraft() would refuse it as a near-duplicate
      // (2026-10-29 run: 117 of 224 stuck in pending this way) -> reject, tagged, rollback-able.
      const sim = toSim(r.draft as unknown as Document);
      const near = findNearDuplicateRecipe(sim, similarityCorpus);
      if (near) {
        return { ...base, verdict: "reject" as const, reasons: [`near_duplicate:${near.rule}:${near.title}`] };
      }
      similarityCorpus.push(sim);
      return { ...base, verdict: "approve_candidate" as const, reasons: ["auto_approve: all rules passed"] };
    }
    return { ...base, verdict: "pending" as const, reasons: [] };
  });
}

export async function planTriage(db: Db): Promise<TriagePlan> {
  const all = await evaluatePendingDrafts(db);
  const by = (v: TriageVerdict) => all.filter((e) => e.verdict === v);
  const rejectReasonCounts: Record<string, number> = {};
  for (const e of by("reject")) for (const r of e.reasons) rejectReasonCounts[r.split(":")[0]!] = (rejectReasonCounts[r.split(":")[0]!] ?? 0) + 1;
  const sample = (v: TriageVerdict) =>
    by(v)
      .slice(0, 10)
      .map(({ id, title, calories, adjustedCoveragePct, reasons }) => ({ id, title, calories, adjustedCoveragePct, reasons }));
  const counts = { approve_candidate: by("approve_candidate").length, reject: by("reject").length, needs_review: by("needs_review").length, pending: by("pending").length };
  return {
    generatedAt: new Date().toISOString(),
    totalPending: all.length,
    counts,
    rejectReasonCounts,
    sanityGateTripped: counts.approve_candidate > SANITY_MAX_AUTO_APPROVE || counts.reject > SANITY_MAX_AUTO_REJECT,
    samples: { approve_candidate: sample("approve_candidate"), reject: sample("reject"), needs_review: sample("needs_review"), pending: sample("pending") },
    ids: {
      approve_candidate: by("approve_candidate").map((e) => e.id),
      reject: by("reject").map((e) => e.id),
      needs_review: by("needs_review").filter((e) => !e.alreadyFlagged).map((e) => e.id),
    },
    note: "approve_candidate still needs a working image at apply time; any without one stays pending.",
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** 200 + image/* content-type; img.spoonacular.com is a known-dead host (2026-10-08) and is never fetched. */
export async function imageLoads(url: unknown): Promise<boolean> {
  if (!url || typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === SPOONACULAR_DEAD_HOST) return false;
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" });
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: "GET" });
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }
    return res.ok && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

export interface ApplyChunkResult {
  batchId: string;
  approved: string[];
  rejected: string[];
  needsReviewMarked: string[];
  stayedPending: Array<{ id: string; reason: string }>;
}

/**
 * Processes ≤ APPLY_CHUNK_MAX draft ids. Re-evaluates every pending draft so the verdict is the
 * server's, not the client's; ids that are no longer pending (already decided, or changed
 * verdict) are reported in stayedPending instead of being touched.
 */
export async function applyTriageChunk(db: Db, env: PexelsEnv, ids: string[], batchId: string): Promise<ApplyChunkResult> {
  const { ObjectId } = await getMongoModule();
  const all = await evaluatePendingDrafts(db);
  const byId = new Map(all.map((e) => [e.id, e]));
  const plan = { approve: all.filter((e) => e.verdict === "approve_candidate").length, reject: all.filter((e) => e.verdict === "reject").length };
  if (plan.approve > SANITY_MAX_AUTO_APPROVE || plan.reject > SANITY_MAX_AUTO_REJECT) {
    throw new Error(`sanity gate: approve=${plan.approve} reject=${plan.reject}`);
  }

  const out: ApplyChunkResult = { batchId, approved: [], rejected: [], needsReviewMarked: [], stayedPending: [] };
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      out.stayedPending.push({ id, reason: "not_pending" });
      continue;
    }
    if (e.verdict === "reject") {
      const r = await rejectRecipeDraft(db, id, { rejectedReason: e.reasons.join("; "), triage: { batchId, reasons: e.reasons } });
      if ("ok" in r) out.rejected.push(id);
      else out.stayedPending.push({ id, reason: "reject_failed" });
    } else if (e.verdict === "needs_review") {
      await db.collection("recipe_drafts").updateOne(
        { _id: new ObjectId(id), status: "pending" },
        { $set: { needs_review: true, needsReviewReason: e.reasons[0], needsReviewBatch: batchId } },
      );
      out.needsReviewMarked.push(id);
    } else if (e.verdict === "approve_candidate") {
      let imageUrl = e.imageUrl;
      let ok = await imageLoads(imageUrl);
      if (!ok) {
        const fallback = await findRecipePhoto(env, e.title).catch(() => null);
        if (fallback && (await imageLoads(fallback))) {
          ok = true;
          imageUrl = fallback;
        }
      }
      if (!ok) {
        out.stayedPending.push({ id, reason: "no_working_image" });
        continue;
      }
      const set: Record<string, unknown> = { tags: cleanTags(e.tags) };
      if (imageUrl !== e.imageUrl) set.imageUrl = imageUrl;
      await db.collection("recipe_drafts").updateOne({ _id: new ObjectId(id), status: "pending" }, { $set: set });
      const r = await approveRecipeDraft(db, env, id, { batchId, reasons: e.reasons });
      if ("insertedId" in r) out.approved.push(id);
      else if ("nearDuplicate" in r) {
        const reasons = [`near_duplicate:${r.nearDuplicate.rule}:${r.nearDuplicate.title}`];
        const rr = await rejectRecipeDraft(db, id, { rejectedReason: reasons.join("; "), triage: { batchId, reasons } });
        if ("ok" in rr) out.rejected.push(id);
        else out.stayedPending.push({ id, reason: "near_duplicate" });
      } else out.stayedPending.push({ id, reason: "alreadyDecided" in r ? "already_decided" : "not_found" });
    } else {
      out.stayedPending.push({ id, reason: "rules_not_met" });
    }
  }
  return out;
}

export interface RollbackResult {
  batchId: string;
  write: boolean;
  recipes: number;
  recipeCosts: number;
  drafts: number;
  needsReview: number;
  warning?: string;
  after?: { recipesStillTagged: number; draftsStillTagged: number };
}

/** Port of scripts/rollback_recipe_drafts_triage.cjs. write=false only counts. */
export async function rollbackTriageBatch(db: Db, batchId: string, write: boolean): Promise<RollbackResult> {
  const recipes = await db.collection("recipes").find({ autoApprovedBatchId: batchId }, { projection: { _id: 1 } }).toArray();
  const recipeIds = recipes.map((r) => r._id);
  const costFilter = { recipeId: { $in: [...recipeIds, ...recipeIds.map((x) => x.toString())] } };
  const [recipeCosts, drafts, approvedDrafts, needsReview] = await Promise.all([
    recipeIds.length ? db.collection("recipe_cost").countDocuments(costFilter) : Promise.resolve(0),
    db.collection("recipe_drafts").countDocuments({ "triage.batchId": batchId }),
    db.collection("recipe_drafts").countDocuments({ "triage.batchId": batchId, "triage.action": "auto_approve" }),
    db.collection("recipe_drafts").countDocuments({ needsReviewBatch: batchId }),
  ]);
  const res: RollbackResult = { batchId, write, recipes: recipeIds.length, recipeCosts, drafts, needsReview };
  if (recipeIds.length !== approvedDrafts) {
    res.warning = `recipes (${recipeIds.length}) != auto-approved drafts (${approvedDrafts}) — check before writing`;
  }
  if (!write) return res;

  if (recipeIds.length) {
    await db.collection("recipes").deleteMany({ autoApprovedBatchId: batchId });
    await db.collection("recipe_cost").deleteMany(costFilter);
  }
  await db.collection("recipe_drafts").updateMany({ "triage.batchId": batchId }, { $set: { status: "pending" }, $unset: { triage: "", rejectedReason: "" } });
  await db.collection("recipe_drafts").updateMany({ needsReviewBatch: batchId }, { $unset: { needs_review: "", needsReviewReason: "", needsReviewBatch: "" } });
  res.after = {
    recipesStillTagged: await db.collection("recipes").countDocuments({ autoApprovedBatchId: batchId }),
    draftsStillTagged: await db.collection("recipe_drafts").countDocuments({ "triage.batchId": batchId }),
  };
  return res;
}
