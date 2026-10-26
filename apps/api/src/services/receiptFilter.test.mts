/** Standalone assertions: node --experimental-strip-types apps/api/src/services/receiptFilter.test.mts */
import assert from "node:assert";
import { isDiscountLine, isNonFood, filterReceiptItems } from "./receiptFilter.ts";

for (const name of ["IRC ITOEN OI OCHA", "Nectar Price Saving", "Price Cut", "20% off with Lidl Plus"]) {
  assert.strictEqual(isDiscountLine(name), true, `discount: ${name}`);
}

for (const name of ["FAIRY BEADS 735G", "Persil Bio Liquid", "Andrex Toilet Roll 9pk"]) {
  assert.strictEqual(isNonFood(name), true, `non-food: ${name}`);
}

const food = ["Oi Ocha Green Tea", "Pork Belly Slices", "Greek Yoghurt", "Basmati Rice", "Blueberries", "Sweet Corn", "Hot Dogs", "Pak Choi"];
for (const name of food) {
  assert.strictEqual(isDiscountLine(name), false, `not discount: ${name}`);
  assert.strictEqual(isNonFood(name), false, `not non-food: ${name}`);
}

const mixed = [
  { name: "OI OCHA TEA 12X500", quantity: 1 },
  { name: "IRC ITOEN OI OCHA", quantity: null },
  { name: "FAIRY BEADS 735G", quantity: 1 },
  { name: "Nectar Price Saving", quantity: null },
  { name: "Pork Belly Slices", quantity: 2 },
  { name: "Andrex Toilet Roll 9pk", quantity: 1 },
  { name: "Price Cut", quantity: null },
  { name: "Pak Choi", quantity: 1 },
];
assert.deepStrictEqual(
  filterReceiptItems(mixed).map((item) => item.name),
  ["OI OCHA TEA 12X500", "Pork Belly Slices", "Pak Choi"],
);

for (const f of ["Surf & Turf Burger", "Comfort Food Pie", "Peach Nectar", "Nectarines", "Bold Cheddar"]) assert.equal(isNonFood(f) || isDiscountLine(f), false, f);
console.log("receiptFilter: all pass");
