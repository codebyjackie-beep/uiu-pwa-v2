/**
 * 購物清單方案 1 — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/api/src/services/shoppingListPlanSync.test.ts
 */
import { formatShoppingQuantity } from "@uiu/shared";
import { mergeContributions, recipeContributions, removeEntryFromItems, type EntryContribution, type ListDoc } from "./shoppingListPlanSync";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  } else console.log(`ok   ${name}`);
}

// recipe lines → contributions: converted g wins, raw unit fallback, empty unit = pc, duplicates summed
const lines = [
  { rawName: "chicken thighs", canonical_name: "chicken thigh", quantity: 500, rawUnit: "g", normValue: 500, normUnit: "g" },
  { rawName: "garlic", canonical_name: "garlic", quantity: 2, rawUnit: "", normValue: 2, normUnit: "pc" },
  { rawName: "Garlic", canonical_name: "garlic", quantity: 1, rawUnit: "" },
  { rawName: "olive oil", canonical_name: "olive oil", quantity: 2, rawUnit: "tbsp", isPantry: true },
  { rawName: "salt", quantity: 0, rawUnit: "" },
];
const rc = recipeContributions(lines);
const garlic = rc.find((c) => c.key === "garlic");
check("garlic summed across lines (same pc unit)", garlic?.qty === 3 && garlic.unit === "pc", garlic);
check("raw unit fallback", rc.find((c) => c.key === "olive oil")?.unit === "tbsp");
check("no amount -> unit null", rc.find((c) => c.key === "salt")?.unit === null);

const mk = (entryId: string, key: string, qty: number, unit: string | null): EntryContribution => ({
  key, text: key, canonicalName: key, unit, qty, isPantry: false, planId: "p1", entryId,
});

// two meals, same chicken in g → one line 900 g; onion g vs pc → two lines
let m = mergeContributions([], [mk("e1", "chicken thigh", 500, "g"), mk("e2", "chicken thigh", 400, "g"), mk("e1", "onion", 150, "g"), mk("e2", "onion", 1, "pc")]);
check("same name same unit merged", m.inserts.filter((d) => d.listKey === "chicken thigh").length === 1 && m.inserts.find((d) => d.listKey === "chicken thigh")?.quantity === 900);
check("different unit = 2 lines", m.inserts.filter((d) => d.listKey === "onion").length === 2);

// re-running Create shopping list doesn't double
const existing: ListDoc[] = m.inserts.map((d) => ({ ...d, _id: d.listKey + (d.unit ?? "") }));
m = mergeContributions(existing, [mk("e1", "chicken thigh", 500, "g"), mk("e2", "chicken thigh", 400, "g")]);
check("idempotent re-run", m.inserts.length === 0 && [...m.updates.values()][0]?.quantity === 900);

// manual line with the same name is left alone
m = mergeContributions([{ _id: "x", text: "Chicken thighs", checked: false }], [mk("e1", "chicken thigh", 500, "g")]);
check("manual same name -> already_on_list", m.inserts.length === 0 && m.updates.size === 0 && m.statusByKey.get("chicken thigh") === "already_on_list");

// checked plan line is not merged into → new line
m = mergeContributions([{ _id: "y", text: "Chicken", checked: true, listKey: "chicken thigh", unit: "g", quantity: 500, sources: [{ planId: "p1", entryId: "e1", qty: 500 }] }], [mk("e2", "chicken thigh", 400, "g")]);
check("checked line untouched, new line added", m.updates.size === 0 && m.inserts.length === 1);

// swap/delete removal: only unchecked plan lines, empty -> delete
const open: ListDoc[] = [
  { _id: 1, text: "Chicken", checked: false, listKey: "chicken thigh", unit: "g", quantity: 900, sources: [{ planId: "p1", entryId: "e1", qty: 500 }, { planId: "p1", entryId: "e2", qty: 400 }] },
  { _id: 2, text: "Onion", checked: false, listKey: "onion", unit: "g", quantity: 150, sources: [{ planId: "p1", entryId: "e1", qty: 150 }] },
  { _id: 3, text: "Toilet roll", checked: false },
  { _id: 4, text: "Rice", checked: true, listKey: "rice", unit: "g", quantity: 200, sources: [{ planId: "p1", entryId: "e1", qty: 200 }] },
];
const r = removeEntryFromItems(open, new Set(["e1"]));
check("shared line reduced 900 -> 400", r.get(0)?.quantity === 400);
check("only-source line emptied (deleted)", r.get(1)?.sources.length === 0);
check("manual + checked untouched", !r.has(2) && !r.has(3));

check("format 500 g", formatShoppingQuantity(500, "g") === "500 g");
check("format 1.5 kg", formatShoppingQuantity(1500, "g") === "1.5 kg");
check("format pc", formatShoppingQuantity(3, "pc") === "3");
check("format tbsp", formatShoppingQuantity(2, "tbsp") === "2 tbsp");
check("format null", formatShoppingQuantity(null, null) === "");

if (failures) throw new Error(`${failures} shopping-list plan-sync test(s) failed`);
console.log("all passed");
