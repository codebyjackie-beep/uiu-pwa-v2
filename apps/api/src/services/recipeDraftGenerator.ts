/**
 * Gap-aware rotation for the daily recipe draft agent
 * (HANDOFF_daily-recipe-draft-agent.md + gap-aware addendum, 2026-07-30/31).
 *
 * Reuses buildPool()/DIETARY_FILTERS/SLOT_ORDER from mealPlanGenerator.ts
 * (DRY, per the addendum) rather than re-deriving pool eligibility here.
 */
import type { Document } from "mongodb";
import type { GapMatrixCell, GapTarget, MealSlot } from "@uiu/shared";
import { DIETARY_FILTERS, SLOT_ORDER, type PoolRecipe } from "./mealPlanGenerator";
import { withDb, type DbEnv } from "../db";

const DIETARY_KEYS = Object.keys(DIETARY_FILTERS);

/** 4 meal slots x 10 DIETARY_FILTERS keys = 40 cells. Allergens deliberately excluded (see addendum). */
export function computeGapMatrix(pool: PoolRecipe[]): GapMatrixCell[] {
  const cells: GapMatrixCell[] = [];
  for (const slot of SLOT_ORDER) {
    for (const dietary of DIETARY_KEYS) {
      const fn = DIETARY_FILTERS[dietary]!;
      const count = pool.filter((r) => r.mealSlots.has(slot) && fn(r)).length;
      cells.push({ slot, dietary, count });
    }
  }
  return cells;
}

/**
 * Ascending sort, lowest 5 selected as priority gap targets — ties at the
 * 5th-place boundary all qualify (no arbitrary cut to exactly 5), per the
 * addendum. Returned array may therefore have more than 5 entries; callers
 * that need a fixed draft quota should slice deterministically off the front
 * (stable sort keeps ties in matrix iteration order: slot then dietary).
 */
export function selectPriorityGapTargets(matrix: GapMatrixCell[], n = 5): GapMatrixCell[] {
  const sorted = [...matrix].sort((a, b) => a.count - b.count);
  if (sorted.length <= n) return sorted;
  const boundaryCount = sorted[n - 1]!.count;
  return sorted.filter((c) => c.count <= boundaryCount);
}

// ---------------------------------------------------------------------------
// Rotation state (collection: recipe_draft_state — single doc)
// ---------------------------------------------------------------------------

export const ROTATION_CUISINES = [
  "italian", "mexican", "chinese", "japanese", "indian", "french", "thai",
  "mediterranean", "american", "korean", "spanish", "vietnamese", "greek",
  "british", "middle eastern",
];

export const ROTATION_DIETS = [
  "vegetarian", "vegan", "gluten free", "dairy free", "pescatarian", "paleo",
  "ketogenic", "balanced", "high protein", "low fat",
];

export interface DraftStateDoc {
  lastCuisineIndex: number;
  lastDietIndex: number;
  gapTargetHistory: Array<{ date: string; targets: GapTarget[] }>;
}

const DEFAULT_STATE: DraftStateDoc = { lastCuisineIndex: -1, lastDietIndex: -1, gapTargetHistory: [] };

export async function readDraftState(env: DbEnv): Promise<DraftStateDoc> {
  return withDb(env, async (db) => {
    const doc = (await db.collection("recipe_draft_state").findOne({})) as Document | null;
    if (!doc) return { ...DEFAULT_STATE };
    return {
      lastCuisineIndex: (doc.lastCuisineIndex as number) ?? -1,
      lastDietIndex: (doc.lastDietIndex as number) ?? -1,
      gapTargetHistory: (doc.gapTargetHistory as DraftStateDoc["gapTargetHistory"]) ?? [],
    };
  });
}

export async function writeDraftState(
  env: DbEnv,
  state: DraftStateDoc,
  gapTargetHistoryEntry: { date: string; targets: GapTarget[] },
): Promise<void> {
  await withDb(env, async (db) => {
    await db.collection("recipe_draft_state").updateOne(
      {},
      {
        $set: {
          lastCuisineIndex: state.lastCuisineIndex,
          lastDietIndex: state.lastDietIndex,
          updatedAt: new Date().toISOString(),
        },
        $push: { gapTargetHistory: gapTargetHistoryEntry } as unknown as Document,
      },
      { upsert: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Idea specs: what to ask Spoonacular/OpenRouter for, one per draft slot in
// today's quota of 20 (5 gap-target + 15 general rotation).
// ---------------------------------------------------------------------------

export interface GapIdeaSpec {
  kind: "gap";
  slot: MealSlot;
  dietary: string;
  countBefore: number;
}

export interface RotationIdeaSpec {
  kind: "rotation";
  cuisine: string;
  diet: string;
}

export type IdeaSpec = GapIdeaSpec | RotationIdeaSpec;

/**
 * Builds today's 20 idea specs: up to 5 gap-target specs (1 per priority
 * combo, front-sliced deterministically when ties push the priority list
 * past 5) + the remainder (always 15, since the gap quota never exceeds 5)
 * from general cuisine x diet rotation, cycling lastCuisineIndex/lastDietIndex
 * forward within the call so consecutive specs in the same run don't repeat
 * the same combo.
 *
 * The persisted resume pointer (nextState) advances by exactly +1 (mod
 * length) per *call*, independent of rotationCount — NOT by however many
 * times the in-call loop incremented it. Confirmed live 2026-07-31:
 * rotationCount (15) happened to equal ROTATION_CUISINES.length (15), so
 * advancing the persisted index by the loop's own running total meant
 * lastCuisineIndex silently returned to its starting value on every call
 * (15 increments mod 15 = 0 net movement) — the exact "rotation never
 * actually rotates" bug class the addendum calls out for Max's pillar
 * rotation, reproduced here by numeric coincidence rather than a missing
 * increment. Decoupling the persisted advance from the in-call cycle length
 * makes it immune to any future coincidence between quota size and array length.
 */
export function buildIdeaSpecs(
  priorityTargets: GapMatrixCell[],
  state: DraftStateDoc,
): { specs: IdeaSpec[]; nextState: DraftStateDoc; draftedTargets: GapTarget[] } {
  const gapTargets = priorityTargets.slice(0, 5);
  const gapSpecs: GapIdeaSpec[] = gapTargets.map((t) => ({ kind: "gap", slot: t.slot, dietary: t.dietary, countBefore: t.count }));

  const rotationCount = 20 - gapSpecs.length;
  const rotationSpecs: RotationIdeaSpec[] = [];
  let cuisineIdx = state.lastCuisineIndex;
  let dietIdx = state.lastDietIndex;
  for (let i = 0; i < rotationCount; i++) {
    cuisineIdx = (cuisineIdx + 1) % ROTATION_CUISINES.length;
    dietIdx = (dietIdx + 1) % ROTATION_DIETS.length;
    rotationSpecs.push({ kind: "rotation", cuisine: ROTATION_CUISINES[cuisineIdx]!, diet: ROTATION_DIETS[dietIdx]! });
  }

  const draftedTargets: GapTarget[] = gapTargets.map((t) => ({ slot: t.slot, dietary: t.dietary, countBefore: t.count }));

  const nextCuisineIdx = (state.lastCuisineIndex + 1) % ROTATION_CUISINES.length;
  const nextDietIdx = (state.lastDietIndex + 1) % ROTATION_DIETS.length;

  return {
    specs: [...gapSpecs, ...rotationSpecs],
    nextState: { ...state, lastCuisineIndex: nextCuisineIdx, lastDietIndex: nextDietIdx },
    draftedTargets,
  };
}

// ---------------------------------------------------------------------------
// Title dedup — rough case-insensitive/substring comparison, per the handoff.
// ---------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export interface TitleMatch {
  matchedTitle: string;
  rule: "exact" | "substring";
}

/** Finds the existing title (if any) that makes `candidate` too similar, and which rule tripped. */
export function findTitleMatch(candidate: string, existingTitles: string[]): TitleMatch | null {
  const norm = normalizeTitle(candidate);
  if (!norm) return { matchedTitle: "", rule: "exact" };
  for (const existing of existingTitles) {
    const existingNorm = normalizeTitle(existing);
    if (!existingNorm) continue;
    if (norm === existingNorm) return { matchedTitle: existing, rule: "exact" };
    if (norm.length > 8 && (existingNorm.includes(norm) || norm.includes(existingNorm))) {
      return { matchedTitle: existing, rule: "substring" };
    }
  }
  return null;
}

/** True if `candidate` is too similar to any of `existingTitles` (exact match after normalizing, or one is a substring of the other). */
export function isTooSimilarTitle(candidate: string, existingTitles: string[]): boolean {
  return findTitleMatch(candidate, existingTitles) !== null;
}

export async function fetchExistingTitles(env: DbEnv): Promise<string[]> {
  return withDb(env, async (db) => {
    const [recipeTitles, draftTitles] = await Promise.all([
      db.collection("recipes").find({}, { projection: { title: 1 } }).toArray(),
      db.collection("recipe_drafts").find({ status: "pending" }, { projection: { title: 1 } }).toArray(),
    ]);
    return [...recipeTitles, ...draftTitles].map((d) => String((d as Document).title ?? "")).filter(Boolean);
  });
}
