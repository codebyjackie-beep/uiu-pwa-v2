/**
 * Shared by routes/shoppingList.ts and the meal-plan swap / delete sync (services/shoppingListPlanSync.ts):
 * list-text normalising and the fridge_stock "do you already have it" match. Moved here unchanged from routes/shoppingList.ts.
 */
import type { Db, Document } from "mongodb";

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

export type FridgeIndex = { canonicalIds: Map<string, string>; names: string[] };

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

export async function loadFridgeIndex(db: Db, userId: string, now: Date = new Date()): Promise<FridgeIndex> {
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
export function fridgeMatchName(fridge: FridgeIndex, ingredientName: string, canonicalDoc: Document | null | undefined): string | null {
  if (canonicalDoc) {
    const byId = fridge.canonicalIds.get(String(canonicalDoc._id));
    if (byId !== undefined) return byId;
  }
  return fridge.names.find((n) => fridgeNameMatches(ingredientName, n)) ?? null;
}

