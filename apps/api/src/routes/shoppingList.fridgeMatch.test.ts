/**
 * cc_prompt_shopping_list_price_compare.md Part 0b — standalone assertion script (no vitest/jest in this repo; same style as
 * apps/web/app/recipes/[id]/cook/timer.test.ts). Run with:
 *   npx tsx apps/api/src/routes/shoppingList.fridgeMatch.test.ts
 */
import { fridgeNameMatches, isUsableFridgeDoc, londonDay } from "./shoppingList";

const matchCases: Array<[string, string, boolean]> = [
  ["Garlic Clove, minced", "garlic", true],
  ["chicken stock cube", "chicken", false],
  ["coconut milk tin", "milk", false],
  ["Fresh Ginger", "ginger", true],
  ["mixed greens", "greens", true],
  ["tenderstem broccoli", "broccoli", true],
  // both directions, plurals, descriptors
  ["garlic", "Garlic Clove, minced", true],
  ["Cloves of garlic", "garlic cloves", true],
  ["king prawns", "prawn", true],
  ["tomato paste", "tomato", false],
  ["tomatoes", "chopped tomato", true],
  ["olive oil", "olive", false],
  ["chicken breast", "chicken", true],
  ["", "garlic", false],
];

const expiryCases: Array<[string, Record<string, unknown>, string, boolean]> = [
  ["expires today", { expiresAt: "2026-10-19T08:00:00.000Z" }, "2026-10-19", true],
  ["expired yesterday", { expiresAt: "2026-10-18T10:00:00.000Z" }, "2026-10-19", false],
  ["London day (BST): 23:30Z on the 18th is already the 19th, so still today", { expiresAt: "2026-10-18T23:30:00.000Z" }, "2026-10-19", true],
  ["future", { expiresAt: "2026-10-25T00:00:00.000Z" }, "2026-10-19", true],
  ["needsRestock", { needsRestock: true, expiresAt: "2026-10-25T00:00:00.000Z" }, "2026-10-19", false],
  ["no expiresAt", {}, "2026-10-19", true],
];

let failed = 0;
for (const [ingredient, fridge, want] of matchCases) {
  const got = fridgeNameMatches(ingredient, fridge);
  if (got !== want) { failed += 1; console.error(`FAIL fridgeNameMatches(${JSON.stringify(ingredient)}, ${JSON.stringify(fridge)}) = ${got}, want ${want}`); }
  else console.log(`ok   ${JSON.stringify(ingredient)} vs ${JSON.stringify(fridge)} -> ${got}`);
}
for (const [label, doc, today, want] of expiryCases) {
  const got = isUsableFridgeDoc(doc, today);
  if (got !== want) { failed += 1; console.error(`FAIL expiry: ${label} = ${got}, want ${want}`); }
  else console.log(`ok   expiry: ${label} -> ${got}`);
}
if (londonDay(new Date("2026-10-18T23:30:00.000Z")) !== "2026-10-19") { failed += 1; console.error("FAIL londonDay BST"); }
if (londonDay(new Date("2026-12-01T23:30:00.000Z")) !== "2026-12-01") { failed += 1; console.error("FAIL londonDay GMT"); }
if (failed > 0) throw new Error(`${failed} fridge-match test(s) failed`);
console.log("all fridge-match tests passed");
