/**
 * HANDOFF_shop-tab-v1.md §3 — manual shopping list items (collection: shopping_list_items).
 * Not tied to canonical_ingredients — no price match in V1. Deletable outright (unlike
 * fridge_stock, a manual item doesn't need a history trail once bought).
 */
import { Hono } from "hono";
import type { Db, Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  ApiResponse,
  ShoppingListCheckResult,
  ShoppingListFromIngredientRequest,
  ShoppingListFromIngredientResponse,
  ShoppingListItem,
  ShoppingListResponse,
} from "@uiu/shared";
import { computeShoppingListStoreTotals } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { buildItemPrices } from "../services/shoppingListPrices";

export const shoppingListRouter = new Hono<{ Bindings: DbEnv }>();

function toShoppingListItem(doc: Document): ShoppingListItem {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    text: doc.text as string,
    checked: !!doc.checked,
    addedAt: doc.addedAt as string,
    ...(doc.canonicalName !== undefined ? { canonicalName: (doc.canonicalName as string | null) ?? null } : {}),
  };
}

/** One word to its singular: case / plural folding for "already on the list" matching
 * ("Prawns" == "prawn", "tomatoes" == "tomato", "cherries" == "cherry"). */
function singularWord(w: string): string {
  if (w.length > 3 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && /(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

export function normalizeListText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularWord)
    .join(" ");
}

type FridgeIndex = { canonicalIds: Map<string, string>; names: string[] };

/** Europe/London calendar day (YYYY-MM-DD) of an instant — "today" for expiry is the user's day, not UTC's. */
export function londonDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Part 0b — what the user can still use: not flagged needsRestock, and not expired. An item expiring today still counts; one whose
 * expiresAt day (Europe/London) is before today doesn't. A missing / unparseable expiresAt counts as in date.
 */
export function isUsableFridgeDoc(doc: Document, today: string): boolean {
  if (doc.needsRestock === true) return false;
  if (typeof doc.expiresAt === "string" || doc.expiresAt instanceof Date) {
    const t = new Date(doc.expiresAt);
    if (!Number.isNaN(t.getTime()) && londonDay(t) < today) return false;
  }
  return true;
}

async function loadFridgeIndex(db: Db, userId: string, now: Date = new Date()): Promise<FridgeIndex> {
  const today = londonDay(now);
  const docs = (
    await db
      .collection("fridge_stock")
      .find({ userId }, { projection: { ingredientName: 1, canonicalIngredientId: 1, needsRestock: 1, expiresAt: 1 } })
      .toArray()
  ).filter((d) => isUsableFridgeDoc(d, today));
  return {
    canonicalIds: new Map(docs.filter((d) => d.canonicalIngredientId).map((d) => [String(d.canonicalIngredientId), String(d.ingredientName ?? "")])),
    names: docs.map((d) => d.ingredientName as string),
  };
}

/** Words that describe the state of an ingredient, not what it is — ignored when comparing names. */
const FRIDGE_DESCRIPTOR_WORDS = new Set(["fresh", "chopped", "minced", "diced", "sliced", "peeled", "large", "small"]);
/** Words that turn one product into another (chicken -> chicken stock cube, milk -> coconut milk tin): extra ones on the longer name = no match. */
const FRIDGE_TYPE_CHANGING_WORDS = new Set(["stock", "cube", "tin", "canned", "milk", "powder", "paste", "sauce", "oil", "juice", "extract", "flake", "seed"]);

function fridgeTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularWord)
    .filter((w) => !FRIDGE_DESCRIPTOR_WORDS.has(w));
}

/**
 * Part 0b — does a fridge item's name cover this recipe ingredient? Whole words only: every word of the shorter name (singularised,
 * descriptor words dropped) must be a whole word of the longer one, and the longer one may not add a type-changing word the shorter
 * lacks. Replaces the old "normalised length > 8 => substring" rule, which let "chicken" cover a chicken stock cube.
 */
export function fridgeNameMatches(ingredientName: string, fridgeName: string): boolean {
  const a = fridgeTokens(ingredientName);
  const b = fridgeTokens(fridgeName);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const longSet = new Set(long);
  if (!short.every((w) => longSet.has(w))) return false;
  const shortSet = new Set(short);
  return !long.some((w) => !shortSet.has(w) && FRIDGE_TYPE_CHANGING_WORDS.has(w));
}

/** HANDOFF_meal-plan-shopping-list-fridge-merge.md §2 rule, shared by from-ingredient and check:
 * canonical id match first, then the whole-word name match above. Returns the fridge item's own name, or null. */
function fridgeMatchName(fridge: FridgeIndex, ingredientName: string, canonicalDoc: Document | null | undefined): string | null {
  if (canonicalDoc) {
    const byId = fridge.canonicalIds.get(String(canonicalDoc._id));
    if (byId !== undefined) return byId;
  }
  return fridge.names.find((n) => fridgeNameMatches(ingredientName, n)) ?? null;
}

/** Normalised texts of the user's unchecked shopping-list items. */
async function loadOnListTexts(db: Db, userId: string): Promise<Set<string>> {
  const docs = await db.collection("shopping_list_items").find({ userId, checked: false }, { projection: { text: 1 } }).toArray();
  return new Set(docs.map((d) => normalizeListText(String(d.text ?? ""))).filter(Boolean));
}

/** Part A — canonical_name for free text via the ingredient resolver: exact or alias hit only, never the fuzzy fallback. */
export async function resolveCanonicalExact(db: Db, text: string): Promise<string | null> {
  const r = resolve(text, await buildAliasIndex(db.collection("canonical_ingredients")));
  return "canonical_name" in r && r.method === "exact" ? r.canonical_name : null;
}

shoppingListRouter.get("/", async (c) => {
  try {
    const { items, storeTotals } = await withDb(c.env, async (db) => {
      const docs = await db.collection("shopping_list_items").find({ userId: c.var.clerkUserId }).sort({ addedAt: 1 }).toArray();
      // Part B — attach every qualified product price (canonical_price_cache read only, 0 Serper credits) to lines that carry a canonical.
      const names = [...new Set(docs.map((d) => d.canonicalName).filter((n): n is string => typeof n === "string" && n !== ""))];
      const cache = names.length
        ? await db.collection("canonical_price_cache").find({ canonical_name: { $in: names } }, { projection: { canonical_name: 1, listings: 1, metadata: 1 } }).toArray()
        : [];
      const byName = new Map(cache.map((d) => [d.canonical_name as string, d]));
      // makeTitleMatcher needs the canonical's aliases / query_alias — the same doc the price refresh uses.
      const canons = names.length ? await db.collection("canonical_ingredients").find({ canonical_name: { $in: names } }).toArray() : [];
      const canonByName = new Map(canons.map((d) => [d.canonical_name as string, d]));
      const items = docs.map((d) => {
        const item = toShoppingListItem(d);
        const cacheDoc = typeof d.canonicalName === "string" ? byName.get(d.canonicalName) : undefined;
        return { ...item, prices: cacheDoc ? buildItemPrices(d.canonicalName as string, cacheDoc, canonByName.get(d.canonicalName as string)) : null };
      });
      return { items, storeTotals: computeShoppingListStoreTotals(items) };
    });
    const body: ShoppingListResponse = { ok: true, data: items, storeTotals };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch shopping_list_items" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const text = payload?.text as string | undefined;
  if (typeof text !== "string" || !text.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "text is required" } };
    return c.json(body, 400);
  }

  try {
    const inserted = await withDb(c.env, async (db) => {
      // Part A — resolve the typed text with the same resolver costRecipe() uses, exact / alias only (no fuzzy); null when it doesn't resolve.
      const canonicalName = await resolveCanonicalExact(db, text.trim());
      const doc = { userId: c.var.clerkUserId, text: text.trim(), canonicalName, checked: false, addedAt: new Date().toISOString() };
      const result = await db.collection("shopping_list_items").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<ShoppingListItem> = { ok: true, data: toShoppingListItem(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] shopping-list create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to add shopping_list_item" } };
    return c.json(body, 502);
  }
});

/** cc_prompt_guest_browse.md Part D2 — read-only flags for the recipe "Add to shopping list" sheet. */
shoppingListRouter.post("/check", async (c) => {
  const payload = (await c.req.json().catch(() => null)) as { ingredients?: ShoppingListFromIngredientRequest[] } | null;
  const ingredients = payload?.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length > 100 || ingredients.some((i) => typeof i?.ingredientName !== "string")) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "ingredients[] (max 100) is required" } };
    return c.json(body, 400);
  }

  try {
    const results = await withDb(c.env, async (db) => {
      const userId = c.var.clerkUserId;
      const canonicalNames = [...new Set(ingredients.map((i) => i.canonicalName).filter((n): n is string => typeof n === "string" && n !== ""))];
      const [canonicalDocs, fridge, onList] = await Promise.all([
        canonicalNames.length ? db.collection("canonical_ingredients").find({ canonical_name: { $in: canonicalNames } }).toArray() : Promise.resolve([] as Document[]),
        loadFridgeIndex(db, userId),
        loadOnListTexts(db, userId),
      ]);
      const canonicalByName = new Map(canonicalDocs.map((d) => [d.canonical_name as string, d]));
      return ingredients.map((ing): ShoppingListCheckResult => {
        const canonicalDoc = ing.canonicalName ? canonicalByName.get(ing.canonicalName) : undefined;
        const keys = [ing.ingredientName, ing.canonicalName].filter((k): k is string => !!k).map(normalizeListText);
        const fridgeMatch = fridgeMatchName(fridge, ing.ingredientName, canonicalDoc);
        return {
          inFridge: fridgeMatch !== null,
          ...(fridgeMatch ? { fridgeMatch } : {}),
          pantry: !!canonicalDoc && (canonicalDoc.is_pantry === true || canonicalDoc.pantry_staple === true),
          onList: keys.some((k) => k !== "" && onList.has(k)),
        };
      });
    });
    const body: ApiResponse<{ results: ShoppingListCheckResult[] }> = { ok: true, data: { results } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list check error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to check ingredients" } };
    return c.json(body, 502);
  }
});

/** HANDOFF_meal-plan-shopping-list-fridge-merge.md §2 — dedupe check against fridge_stock
 * before inserting a meal-plan-aggregated ingredient. Never writes to fridge_stock.
 * cc_prompt_guest_browse.md Part D2 — also skips when the user already has an unchecked item with
 * the same text (case / plural normalised): `{ merged: true, reason: "already_on_list" }`. */
shoppingListRouter.post("/from-ingredient", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const ingredientName = payload?.ingredientName as string | undefined;
  const canonicalName = payload?.canonicalName as string | undefined;
  if (typeof ingredientName !== "string" || !ingredientName.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "ingredientName is required" } };
    return c.json(body, 400);
  }

  try {
    const reason = await withDb(c.env, async (db) => {
      const userId = c.var.clerkUserId;
      const onList = await loadOnListTexts(db, userId);
      if (onList.has(normalizeListText(ingredientName))) return "already_on_list" as const;

      const canonicalDoc = canonicalName ? await db.collection("canonical_ingredients").findOne({ canonical_name: canonicalName }) : null;
      return fridgeMatchName(await loadFridgeIndex(db, userId), ingredientName, canonicalDoc) !== null ? ("in_fridge" as const) : null;
    });

    if (reason) {
      const body: ApiResponse<ShoppingListFromIngredientResponse> = { ok: true, data: { merged: true, reason } };
      return c.json(body);
    }

    // Part A — keep the canonical the recipe / plan resolved (null when it sent none), so the Shop tab can price the line.
    const doc = {
      userId: c.var.clerkUserId,
      text: ingredientName.trim(),
      canonicalName: typeof canonicalName === "string" && canonicalName.trim() ? canonicalName.trim() : null,
      checked: false,
      addedAt: new Date().toISOString(),
    };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("shopping_list_items").insertOne(doc);
      return { ...doc, _id: result.insertedId as ObjectIdType };
    });
    const body: ApiResponse<ShoppingListFromIngredientResponse> = {
      ok: true,
      data: { merged: false, added: true, item: toShoppingListItem(inserted) },
    };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] shopping-list from-ingredient error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to process ingredient" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.patch("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid shopping_list_item id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload.checked !== "boolean") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "checked (boolean) is required" } };
    return c.json(body, 400);
  }

  try {
    const result = await withDb(c.env, (db) =>
      db.collection("shopping_list_items").findOneAndUpdate({ _id: new ObjectId(id), userId: c.var.clerkUserId }, { $set: { checked: payload.checked } }, { returnDocument: "after" }),
    );
    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "shopping_list_item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<ShoppingListItem> = { ok: true, data: toShoppingListItem(result) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update shopping_list_item" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.delete("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid shopping_list_item id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("shopping_list_items").deleteOne({ _id: new ObjectId(id), userId: c.var.clerkUserId });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "shopping_list_item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete shopping_list_item" } };
    return c.json(body, 502);
  }
});
