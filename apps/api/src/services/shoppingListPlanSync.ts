/**
 * 購物清單方案 1 (claude-docs overnight 2026-11-08 §4, Jackie 批) — shopping_list_items lines added from a meal plan carry an
 * amount (`quantity` + `unit`) and where it came from (`sources[{planId, entryId, qty}]`).
 *
 *  - "Create shopping list": same ingredient + same unit → one line, amounts summed; different unit (g vs pc) → separate lines.
 *  - Swap / delete a meal-plan entry: that entry's share comes off every UNCHECKED plan line (line deleted when nothing is left),
 *    and on a swap the new recipe's ingredients go on. Checked lines and manual lines (no sources) are never touched.
 *
 * Older items (no quantity / unit / sources) read as quantity null and count as manual — nothing is migrated.
 * Amounts are the recipe's own line amounts (whole recipe, same basis as the plan's per-ingredient cost), not scaled by servings.
 */
import type { Db, Document, ObjectId as ObjectIdType } from "mongodb";
import type { ShoppingListFromIngredientRequest, ShoppingListFromPlanResult, ShoppingListItemSource } from "@uiu/shared";
import { getMongoModule } from "../db";
import { fridgeMatchName, loadFridgeIndex, normalizeListText } from "./shoppingListMatch";

const COLL = "shopping_list_items";

/** One recipe's need for one ingredient, in one unit. */
export interface PlanContribution {
  /** normalizeListText(canonical_name ?? rawName) — the merge key. */
  key: string;
  /** Display text for a new line ("Chicken thighs"). */
  text: string;
  canonicalName: string | null;
  /** g | ml | pc when the cost engine converted the line, else the raw unit; null when the line has no amount ("to taste"). */
  unit: string | null;
  qty: number;
  isPantry: boolean;
}

export interface EntryContribution extends PlanContribution {
  planId: string;
  entryId: string;
}

/** The subset of a shopping_list_items doc the merge needs. */
export interface ListDoc {
  _id?: unknown;
  text: string;
  checked?: boolean;
  canonicalName?: string | null;
  listKey?: string;
  unit?: string | null;
  quantity?: number | null;
  sources?: ShoppingListItemSource[];
}

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Amount of one recipe_cost line: the converted g / ml / pc when present, else the raw quantity + unit (empty unit = count). */
export function lineAmount(line: Document): { qty: number; unit: string | null } {
  if (typeof line.normValue === "number" && line.normValue > 0 && typeof line.normUnit === "string") return { qty: line.normValue, unit: line.normUnit };
  if (typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity > 0) {
    const raw = String(line.rawUnit ?? "").trim().toLowerCase();
    return { qty: line.quantity, unit: raw || "pc" };
  }
  return { qty: 0, unit: null };
}

/** One recipe's recipe_cost.lines → its needs, same key + unit summed (a recipe listing garlic twice). */
export function recipeContributions(lines: Document[]): PlanContribution[] {
  const out = new Map<string, PlanContribution>();
  for (const line of lines) {
    const rawName = String(line.rawName ?? "").trim();
    const canonicalName = typeof line.canonical_name === "string" && line.canonical_name.trim() ? line.canonical_name.trim() : null;
    const key = normalizeListText(canonicalName ?? rawName);
    if (!key) continue;
    const { qty, unit } = lineAmount(line);
    const id = `${key}\u0000${unit ?? ""}`;
    const prev = out.get(id);
    if (prev) {
      prev.qty += qty;
      prev.isPantry = prev.isPantry || line.isPantry === true;
    } else {
      out.set(id, { key, text: capitalizeFirst(rawName), canonicalName, unit, qty, isPantry: line.isPantry === true });
    }
  }
  return [...out.values()];
}

const hasSources = (d: ListDoc) => Array.isArray(d.sources) && d.sources.length > 0;

/** Manual line (no sources) whose text or canonical normalises to `key` — left alone, the ingredient counts as already on the list. */
function isManualMatch(d: ListDoc, key: string): boolean {
  if (d.checked || hasSources(d)) return false;
  return normalizeListText(String(d.text ?? "")) === key || (typeof d.canonicalName === "string" && normalizeListText(d.canonicalName) === key);
}

function sumSources(sources: ShoppingListItemSource[], unit: string | null | undefined): number | null {
  if (!unit) return null;
  const total = sources.reduce((s, x) => s + (Number.isFinite(x.qty) ? x.qty : 0), 0);
  return total > 0 ? Math.round(total * 1000) / 1000 : null;
}

export interface MergePlan {
  /** Existing docs whose sources / quantity change, keyed by index into `openItems`. */
  updates: Map<number, { sources: ShoppingListItemSource[]; quantity: number | null }>;
  inserts: ListDoc[];
  /** Status per contribution key. */
  statusByKey: Map<string, ShoppingListFromPlanResult["status"]>;
}

/**
 * Pure merge: put each entry's contributions onto the user's open (unchecked) items. Same key + same unit on a plan line → that
 * entry's source is set (replaced, so pressing "Create shopping list" twice doesn't double it) and quantity re-summed. A manual line
 * with the same name → skipped (already_on_list). Otherwise a new line. `textFor` picks the display text for a new line.
 */
export function mergeContributions(openItems: ListDoc[], contributions: EntryContribution[], textFor: (c: EntryContribution) => string = (c) => c.text): MergePlan {
  const updates: MergePlan["updates"] = new Map();
  const inserts: ListDoc[] = [];
  const statusByKey: MergePlan["statusByKey"] = new Map();
  const rank = { already_on_list: 0, merged: 1, added: 2 } as const;
  const setStatus = (key: string, s: ShoppingListFromPlanResult["status"]) => {
    const prev = statusByKey.get(key);
    if (!prev || rank[s] > rank[prev]) statusByKey.set(key, s);
  };
  const upsertSource = (sources: ShoppingListItemSource[], c: EntryContribution) => [
    ...sources.filter((s) => s.entryId !== c.entryId),
    { planId: c.planId, entryId: c.entryId, qty: c.qty },
  ];

  for (const c of contributions) {
    if (openItems.some((d) => isManualMatch(d, c.key))) {
      setStatus(c.key, "already_on_list");
      continue;
    }
    const sameUnit = (d: ListDoc) => !d.checked && hasSources(d) && d.listKey === c.key && (d.unit ?? null) === c.unit;
    const existingIdx = openItems.findIndex(sameUnit);
    if (existingIdx >= 0) {
      const base = updates.get(existingIdx)?.sources ?? openItems[existingIdx]!.sources ?? [];
      const sources = upsertSource(base, c);
      updates.set(existingIdx, { sources, quantity: sumSources(sources, c.unit) });
      setStatus(c.key, "merged");
      continue;
    }
    const pending = inserts.find(sameUnit);
    if (pending) {
      pending.sources = upsertSource(pending.sources ?? [], c);
      pending.quantity = sumSources(pending.sources, c.unit);
      setStatus(c.key, "added");
      continue;
    }
    const sources = [{ planId: c.planId, entryId: c.entryId, qty: c.qty }];
    inserts.push({ text: textFor(c), canonicalName: c.canonicalName, checked: false, listKey: c.key, unit: c.unit, quantity: sumSources(sources, c.unit), sources });
    setStatus(c.key, "added");
  }
  return { updates, inserts, statusByKey };
}

/** Pure: take one entry's share off open plan lines. Returns per-index new sources (empty = delete the line). */
export function removeEntryFromItems(openItems: ListDoc[], entryIds: Set<string>): Map<number, { sources: ShoppingListItemSource[]; quantity: number | null }> {
  const out = new Map<number, { sources: ShoppingListItemSource[]; quantity: number | null }>();
  openItems.forEach((d, i) => {
    if (d.checked || !hasSources(d)) return;
    const sources = d.sources!.filter((s) => !entryIds.has(s.entryId));
    if (sources.length !== d.sources!.length) out.set(i, { sources, quantity: sumSources(sources, d.unit) });
  });
  return out;
}

/** Every entry of one plan (owned by userId) → its contributions. null when the plan isn't the user's. */
export async function loadPlanContributions(db: Db, userId: string, planId: string): Promise<EntryContribution[] | null> {
  const { ObjectId } = await getMongoModule();
  if (!ObjectId.isValid(planId)) return null;
  const planObjectId = new ObjectId(planId);
  const owned = await db.collection("meal_plan_sets").findOne({ _id: planObjectId, userId }, { projection: { _id: 1 } });
  if (!owned) return null;
  const entries = await db.collection("meal_plans").find({ planId: planObjectId, userId }, { projection: { recipeId: 1 } }).toArray();
  const recipeIds = [...new Map(entries.map((e) => [String(e.recipeId), e.recipeId as ObjectIdType])).values()];
  const costDocs = recipeIds.length ? await db.collection("recipe_cost").find({ recipeId: { $in: recipeIds } }, { projection: { recipeId: 1, lines: 1 } }).toArray() : [];
  const byRecipe = new Map(costDocs.map((d) => [String(d.recipeId), recipeContributions((d.lines as Document[]) ?? [])]));
  return entries.flatMap((e) => (byRecipe.get(String(e.recipeId)) ?? []).map((c) => ({ ...c, planId, entryId: String(e._id) })));
}

async function loadOpenItems(db: Db, userId: string): Promise<(ListDoc & { _id: unknown })[]> {
  return (await db.collection(COLL).find({ userId, checked: false }).sort({ addedAt: 1 }).toArray()) as unknown as (ListDoc & { _id: unknown })[];
}

/** Write a MergePlan / removal map to Mongo. Lines whose sources become empty are deleted. */
async function writeChanges(
  db: Db,
  userId: string,
  openItems: (ListDoc & { _id: unknown })[],
  updates: Map<number, { sources: ShoppingListItemSource[]; quantity: number | null }>,
  inserts: ListDoc[],
): Promise<void> {
  const ops: Document[] = [];
  for (const [i, u] of updates) {
    const filter = { _id: openItems[i]!._id, userId, checked: false };
    ops.push(u.sources.length === 0 ? { deleteOne: { filter } } : { updateOne: { filter, update: { $set: { sources: u.sources, quantity: u.quantity } } } });
  }
  const now = new Date().toISOString();
  for (const doc of inserts) ops.push({ insertOne: { document: { userId, ...doc, checked: false, addedAt: now } } });
  if (ops.length) await db.collection(COLL).bulkWrite(ops as never, { ordered: false });
}

/** Key a "Create shopping list" request row the same way contributions are keyed. */
export function requestKey(i: ShoppingListFromIngredientRequest): string {
  return normalizeListText(i.canonicalName?.trim() ? i.canonicalName : i.ingredientName);
}

/** POST /from-plan — add the ticked ingredients of a plan. null when the plan isn't the user's. */
export async function addPlanContributions(
  db: Db,
  userId: string,
  planId: string,
  ingredients: ShoppingListFromIngredientRequest[],
): Promise<{ results: ShoppingListFromPlanResult[]; added: number; merged: number } | null> {
  const all = await loadPlanContributions(db, userId, planId);
  if (!all) return null;
  const textByKey = new Map(ingredients.map((i) => [requestKey(i), i.ingredientName.trim()]));
  const picked = all.filter((c) => textByKey.has(c.key));
  const openItems = await loadOpenItems(db, userId);
  const plan = mergeContributions(openItems, picked, (c) => textByKey.get(c.key) || c.text);
  await writeChanges(db, userId, openItems, plan.updates, plan.inserts);
  // An ingredient with no recipe_cost line (rare: the sheet and the cost doc disagree) falls back to a plain line with no amount,
  // unless a line with that name is already open (the old from-ingredient behaviour).
  const missing: ShoppingListFromIngredientRequest[] = [];
  const results: ShoppingListFromPlanResult[] = ingredients.map((i) => {
    const k = requestKey(i);
    const status = plan.statusByKey.get(k);
    if (status) return { ingredientName: i.ingredientName, status };
    if (openItems.some((d) => !d.checked && (normalizeListText(String(d.text ?? "")) === k || d.listKey === k))) return { ingredientName: i.ingredientName, status: "already_on_list" };
    missing.push(i);
    return { ingredientName: i.ingredientName, status: "added" };
  });
  if (missing.length) {
    const now = new Date().toISOString();
    await db.collection(COLL).insertMany(
      missing.map((i) => ({ userId, text: i.ingredientName.trim(), canonicalName: i.canonicalName?.trim() || null, checked: false, addedAt: now })),
    );
  }
  return { results, added: plan.inserts.length + missing.length, merged: plan.updates.size };
}

/**
 * POST /check with planId — keys (requestKey) whose open plan lines already hold every entry of this plan that needs them, in every
 * unit. Such an ingredient shows "Already on list"; one with a newly added meal doesn't, so ticking it merges the new amount in.
 */
export async function planCoverageOnList(db: Db, userId: string, planId: string): Promise<Set<string>> {
  const all = await loadPlanContributions(db, userId, planId);
  const covered = new Set<string>();
  if (!all) return covered;
  const openItems = await loadOpenItems(db, userId);
  const byKey = new Map<string, EntryContribution[]>();
  for (const c of all) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  for (const [key, cs] of byKey) {
    const ok = cs.every((c) => openItems.some((d) => hasSources(d) && d.listKey === key && (d.unit ?? null) === c.unit && d.sources!.some((s) => s.entryId === c.entryId)));
    if (ok) covered.add(key);
  }
  return covered;
}

/**
 * Meal-plan swap / delete hook. Takes `entryIds`' share off every unchecked plan line. When `newRecipeId` is given (a swap) and the
 * entry was on the list before, the new recipe's ingredients are added — skipping pantry staples, fridge matches and names that
 * already have a manual line (same defaults as the "Create shopping list" sheet). Best effort: errors are logged, never thrown,
 * so the meal-plan change itself still succeeds.
 */
export async function syncEntriesToShoppingList(
  db: Db,
  userId: string,
  change: { entryIds: string[]; planId?: string; newRecipeId?: ObjectIdType },
): Promise<void> {
  try {
    const ids = new Set(change.entryIds);
    const wasOnList = (await db.collection(COLL).countDocuments({ userId, "sources.entryId": { $in: [...ids] } }, { limit: 1 })) > 0;
    if (!wasOnList) return;

    let openItems = await loadOpenItems(db, userId);
    const removals = removeEntryFromItems(openItems, ids);
    await writeChanges(db, userId, openItems, removals, []);

    if (!change.newRecipeId || !change.planId || change.entryIds.length !== 1) return;
    const costDoc = await db.collection("recipe_cost").findOne({ recipeId: change.newRecipeId }, { projection: { lines: 1 } });
    const contributions = recipeContributions(((costDoc?.lines as Document[]) ?? []).filter(Boolean));
    if (!contributions.length) return;
    const canonicalNames = [...new Set(contributions.map((c) => c.canonicalName).filter((n): n is string => !!n))];
    const [canonicalDocs, fridge] = await Promise.all([
      canonicalNames.length ? db.collection("canonical_ingredients").find({ canonical_name: { $in: canonicalNames } }).toArray() : Promise.resolve([] as Document[]),
      loadFridgeIndex(db, userId),
    ]);
    const canonByName = new Map(canonicalDocs.map((d) => [d.canonical_name as string, d]));
    const wanted = contributions.filter((c) => {
      const canon = c.canonicalName ? canonByName.get(c.canonicalName) : undefined;
      if (c.isPantry || canon?.is_pantry === true || canon?.pantry_staple === true) return false;
      return fridgeMatchName(fridge, c.text, canon) === null;
    });
    if (!wanted.length) return;
    openItems = await loadOpenItems(db, userId);
    const entryId = change.entryIds[0]!;
    const plan = mergeContributions(
      openItems,
      wanted.map((c) => ({ ...c, planId: change.planId!, entryId })),
    );
    await writeChanges(db, userId, openItems, plan.updates, plan.inserts);
  } catch (err) {
    console.error("[uiu-api] shopping-list plan sync error:", err instanceof Error ? err.message : String(err));
  }
}

/** Plan card deleted — take every entry of it off the open list (same rule as deleting one entry). */
export async function removePlanFromShoppingList(db: Db, userId: string, planId: string): Promise<void> {
  try {
    const openItems = await loadOpenItems(db, userId);
    const entryIds = new Set(openItems.flatMap((d) => (d.sources ?? []).filter((s) => s.planId === planId).map((s) => s.entryId)));
    if (!entryIds.size) return;
    await writeChanges(db, userId, openItems, removeEntryFromItems(openItems, entryIds), []);
  } catch (err) {
    console.error("[uiu-api] shopping-list plan delete sync error:", err instanceof Error ? err.message : String(err));
  }
}
