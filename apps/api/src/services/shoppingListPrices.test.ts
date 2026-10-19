/** Standalone assertions: npx tsx apps/api/src/services/shoppingListPrices.test.ts */
import { normaliseStore, buildPriceOptions, buildItemPrices } from "./shoppingListPrices";

function eq(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

eq(normaliseStore("sainsburys.co.uk")?.name, "Sainsbury's");
eq(normaliseStore("Asda Groceries")?.key, "asda");
eq(normaliseStore("Morrisons.com")?.name, "Morrisons");
eq(normaliseStore("Waitrose & Partners")?.key, "waitrose");
eq(normaliseStore("Tesco")?.name, "Tesco");
eq(normaliseStore("Co-op")?.name, "Co-op");
eq(normaliseStore("Amazon.co.uk"), null);
eq(normaliseStore("Random Marketplace"), null);
eq(normaliseStore(undefined), null);

const L = (store: string, title: string, price: number, qty: number | null, unit = "g_or_ml") => ({
  store, title, price, pack: qty === null ? null : { qty, unit }, source_of_pack: qty === null ? "unknown" : "title",
});
const r = buildPriceOptions("arborio rice", [
  L("Tesco", "Tesco Risotto Rice 1Kg", 3.3, 1000),
  L("sainsburys.co.uk", "Sainsbury's Arborio", 2.25, 500),
  L("sainsburys.co.uk", "Sainsbury's Arborio", 2.25, 500), // duplicate
  L("Amazon", "Arborio 5kg", 9, 5000), // not a supermarket
  L("Ocado", "Gold Rice 500g", 30, 500), // £60/kg vs median 4.5 -> >3x outlier
  L("Waitrose & Partners", "Waitrose Arborio", 2.65, null), // pack unknown -> perUnit null, last
]);
eq(r.options.length, 3);
eq(r.options.map((o) => o.storeKey), ["tesco", "sainsburys", "waitrose"]);
eq(r.options[0]!.perUnit?.value, 3.3);
eq(r.options[0]!.packLabel, "1kg");
eq(r.options[1]!.packLabel, "500g");
eq(r.options[2]!.perUnit, null);
eq(r.droppedOutliers.length, 1);
eq(r.droppedOutliers[0]!.store, "Ocado");

const milk = buildPriceOptions("milk", [L("Tesco", "Tesco Whole Milk 2.272L", 1.65, 2272), L("Asda", "Asda Milk 1L", 1.1, 1000)]);
eq(milk.options[0]!.perUnit?.unit, "L");
eq(milk.options[0]!.packLabel, "2.27L");

const stock = buildPriceOptions("chicken stock", [L("Tesco", "Knorr Chicken Stock Cubes 8 x 10g", 1, 80)]);
eq(stock.options[0]!.stockLabel, true);

const eachOpt = buildPriceOptions("lemon", [L("Tesco", "Lemons 4 pack", 1.2, 4, "each")]);
eq(eachOpt.options[0]!.perUnit, { value: 0.3, unit: "each" });

const p = buildItemPrices("arborio rice", { listings: [L("Tesco", "Risotto Rice 1Kg", 3.3, 1000), L("Asda", "Arborio 500g", 2.25, 500)], metadata: { fetched_at: "2026-10-12T03:00:00Z" } });
eq(p?.cheapestPack.store, "Asda");
eq(p?.bestValue?.store, "Tesco");
eq(p?.stamp, "2026-10-12T03:00:00Z");
eq(buildItemPrices("x", { listings: [] }), null);
console.log("all shopping-list price tests passed");
