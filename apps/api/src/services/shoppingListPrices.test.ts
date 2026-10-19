/** Standalone assertions: npx tsx apps/api/src/services/shoppingListPrices.test.ts */
import { computeShoppingListMix, computeShoppingListStoreTotals } from "@uiu/shared";
import { normaliseStore, buildPriceOptions, buildItemPrices, STOCK_PACK_LABEL } from "./shoppingListPrices";

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
// --- B2: wrong products are dropped via the refresh guard's matcher (incl. substitute words)
const butter = buildPriceOptions("unsalted butter", [
  L("Tesco", "Tesco Unsalted Butter 250g", 1.99, 250),
  L("Asda", "Flora Unsalted Block Butter Alternative 200g", 0.98, 200),
  L("Tesco", "Elmlea Creamy & Buttery Blend Block 250g", 1.95, 250),
  L("Waitrose & Partners", "Lurpak Unsalted Spreadable Blend 400g", 3, 400),
]);
eq(butter.options.map((o) => o.store), ["Tesco"]);
eq(butter.droppedProduct.length, 3);
eq(butter.droppedProduct.every((d) => d.reason.startsWith("substitute:") || d.reason.length > 0), true);

// --- B2: stock canonicals keep cube / pot only, no £/kg, labelled "Stock cube / pot"
const stk = buildPriceOptions("vegetable stock", [
  L("Iceland", "Knorr 4 Vegetable Stock Pot 112g", 1.9, 112),
  L("Ocado", "Soup Broth Pack-Vegetable 150 g", 8.45, 150),
  L("Sainsbury's", "Itsu Miso Ramen Brilliant Broth 200g", 2.7, 200),
]);
eq(stk.options.length, 1);
eq(stk.options[0]!.packLabel, STOCK_PACK_LABEL);
eq(stk.options[0]!.perUnit, null);
eq(stk.options[0]!.stockLabel, true);
eq(STOCK_PACK_LABEL, "Stock cube / pot");

// --- B2: cheapestPack is chosen among listings with a size; unsized only when none has one
const prawns = buildItemPrices("king prawns", { listings: [
  L("Sainsbury's", "King Prawns 180g", 2.64, 180),
  L("Tesco", "Real Seafood Co King Prawns", 2.32, null), // cheaper but no size
] });
eq(prawns?.cheapestPack.store, "Sainsbury's");
eq(prawns?.options.length, 2); // the expanded list still shows the unsized one
eq(prawns?.options.find((o) => o.store === "Tesco")?.packLabel, null);
const unsizedOnly = buildItemPrices("king prawns", { listings: [L("Tesco", "Real Seafood Co King Prawns", 2.32, null)] });
eq(unsizedOnly?.cheapestPack.packLabel, null);
eq(unsizedOnly?.cheapestPack.store, "Tesco");

// --- B2: store totals use the sized listing; unsized only when that store has no sized one
const tot = computeShoppingListStoreTotals([{ checked: false, prices: prawns ?? null }]);
const tescoTot = tot.find((s) => s.storeKey === "tesco");
eq(tescoTot?.total, 2.32); // Tesco only lists an unsized one -> falls back to it
eq(tot.find((s) => s.storeKey === "sainsburys")?.total, 2.64);

// --- B2 narrowing (cloud 10-19 22:05): substitute words only for dairy / meat / oil canonicals, plant qualifier exempts
const kept = (canonical: string, title: string): boolean => buildPriceOptions(canonical, [L("Tesco", title, 2, 500)]).options.length === 1;
const dropReason = (canonical: string, title: string): string | undefined => buildPriceOptions(canonical, [L("Tesco", title, 2, 500)]).droppedProduct[0]?.reason;
eq(kept("butter", "Flora Butter Alternative 500g"), false); // 1 butter ✗ Butter Alternative
eq(dropReason("butter", "Flora Butter Alternative 500g"), "substitute:alternative");
eq(kept("olive oil", "Olivio Blended Olive and Vegetable Oil 500ml"), false); // 2 olive oil ✗ Blended
eq(dropReason("olive oil", "Olivio Blended Olive and Vegetable Oil 500ml"), "substitute:blend");
eq(kept("soy milk", "Alpro Plant-Based Soya Milk 500ml"), true); // 3 soy milk ✓ plant-based
eq(kept("coconut milk", "Mighty Vegan Coconut Milk 500ml"), true); // 4 coconut milk ✓ vegan
eq(kept("garam masala", "Schwartz Garam Masala Spice Blend 500g"), true); // 5 spice blend
eq(kept("mixed salad greens", "Tesco Mixed Salad Blend 500g"), true); // 6 salad blend
eq(kept("cucumber", "Tesco Vegan Cucumber 500g"), true); // 7 cucumber ✓ vegan
eq(kept("tofu", "Cauldron Plant-Based Tofu 500g"), true); // 8 tofu ✓ plant-based
// in scope + non-exempt canonical still drops the other substitute words
eq(kept("cheddar cheese", "Violife Dairy-Free Cheddar Style 500g"), false);
eq(kept("chicken breast", "Quorn Vegan Chicken Breast 500g"), false);

// --- cloud 22:10 exemptions: butter substitute / vegetable burger crumbles behave like the reviewed dry-run again
eq(kept("butter substitute", "Flora Plant-Based Butter Alternative 500g"), true);
eq(kept("vegetable burger crumbles", "Quorn Vegan Burger Crumbles 500g"), true);
// B3: Mixing stores total + Best one-stop tag
const P = (store: string, price: number, size: string | null) => ({ store, storeKey: store.toLowerCase(), title: store + " x", price, packLabel: size, perUnit: null });
const itemOf = (opts: ReturnType<typeof P>[]) => ({ checked: false, prices: { options: opts, cheapestPack: opts[0]!, bestValue: null, stamp: null } });
const mixItems = [
  itemOf([P("Tesco", 2.0, "500g"), P("Asda", 1.5, "500g"), P("Lidl", 0.9, null)]), // unsized Lidl never wins -> Asda 1.50
  itemOf([P("Tesco", 3.0, "1kg"), P("Asda", 3.5, "1kg")]), // Tesco 3.00
  itemOf([P("Lidl", 1.0, "each")]), // Lidl only
  { checked: true, prices: { options: [P("Tesco", 9, "1kg")], cheapestPack: P("Tesco", 9, "1kg"), bestValue: null, stamp: null } }, // ticked: ignored
  { checked: false, prices: null }, // no price
];
eq(computeShoppingListMix(mixItems), { total: 5.5, itemsPriced: 3, itemsTotal: 4 });
eq(computeShoppingListMix([itemOf([P("Lidl", 0.9, null)])]), { total: 0.9, itemsPriced: 1, itemsTotal: 1 }); // unsized only as fallback
eq(computeShoppingListMix([{ checked: false, prices: null }]), null);
const rows = computeShoppingListStoreTotals(mixItems);
eq(rows.map((r) => [r.storeKey, r.total, r.itemsPriced]), [["lidl", 1.9, 2], ["tesco", 5, 2], ["asda", 5, 2]]); // same coverage -> cheaper first
eq(rows.map((r) => [!!r.bestOneStop, !!r.lowCoverage]), [[true, false], [false, false], [false, false]]);
// a cheaper store that prices fewer items is NOT best one-stop, and is flagged lowCoverage
const cov = computeShoppingListStoreTotals([
  itemOf([P("Tesco", 2, "1kg"), P("Aldi", 0.5, "1kg")]),
  itemOf([P("Tesco", 3, "1kg")]),
]);
eq(cov.map((r) => [r.storeKey, r.total, r.itemsPriced, !!r.bestOneStop, !!r.lowCoverage]), [["tesco", 5, 2, true, false], ["aldi", 0.5, 1, false, true]]);
console.log("all shopping-list price tests passed");
