/**
 * SEO hub helpers — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/recipeHub.test.ts
 */
import { buildItemListJsonLd, formatGbp, fullTierPerServing, fullTierPriceRange, latestUpdatedAt, sortForHub, type HubRecipe } from "./recipeHub";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, detail ?? "");
  }
}

// Mirrors toHubRecipe (hubPricing.ts): the price is only kept when coverage puts the recipe in tier "full" (>= 80).
// The real tier call lives in @uiu/shared (costDisplayTier), which tsx can't load here; this stub only models
// its output so the pure helpers below can be checked.
function r(id: string, title: string, perServing: number | null, coverage: number | null, updatedAt?: string): HubRecipe {
  const full = coverage != null && Number.isFinite(coverage) && coverage >= 80;
  return {
    _id: id,
    title,
    tags: [],
    fullTierPrice: full ? perServing : null,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

const full1 = r("a", "Zesty Soup", 0.926, 100);
const full2 = r("b", "Apple Pie", 2.5, 80);
const partial = r("c", "Bean Stew", 0.2, 79.9);
const unavailable = r("d", "Alpha Salad", 0.1, 10);
const noCost = r("e", "Beta Bowl", null, null);
const zero = r("f", "Gamma", 0, 100);

check("full tier: >=80% coverage gives a price", fullTierPerServing(full2) === 2.5);
check("partial (79.9%) never priced", fullTierPerServing(partial) === null);
check("unavailable / no cost / £0 never priced", fullTierPerServing(unavailable) === null && fullTierPerServing(noCost) === null && fullTierPerServing(zero) === null);
check("NaN coverage never priced", fullTierPerServing(r("g", "x", 1, Number.NaN)) === null);
check("junk fullTierPrice (NaN / negative) never priced", fullTierPerServing({ fullTierPrice: Number.NaN }) === null && fullTierPerServing({ fullTierPrice: -1 }) === null);
check("formatGbp: 2dp like formatCostWithCoverage", formatGbp(0.926) === "£0.93" && formatGbp(2.5) === "£2.50");

const range = fullTierPriceRange([full1, full2, partial, unavailable, noCost]);
check("range: only full tier counts", range?.min === 0.926 && range?.max === 2.5 && range?.count === 2, range);
check("range: null when nothing is fully priced", fullTierPriceRange([partial, unavailable, noCost]) === null);

const sorted = sortForHub([noCost, partial, full2, unavailable, full1]).map((x) => x._id);
check("sort: full cheapest first, then rest by title", sorted.join(",") === "a,b,d,c,e", sorted);

check(
  "latestUpdatedAt: newest valid date, ignores junk",
  latestUpdatedAt([{ updatedAt: "2026-11-01T00:00:00.000Z" }, { updatedAt: "nope" }, { updatedAt: "2026-11-20T00:00:00.000Z" }, {}])?.toISOString() === "2026-11-20T00:00:00.000Z",
);
check("latestUpdatedAt: none → undefined", latestUpdatedAt([{}, { updatedAt: 5 }]) === undefined);

const ld = buildItemListJsonLd({ name: "Chicken recipes", path: "/recipes/ingredient/chicken", recipes: [full1, full2] });
const items = ld.itemListElement as { position: number; url: string; "@type": string }[];
check("ItemList: type + absolute url", ld["@type"] === "ItemList" && ld.url === "https://useitup.uk/recipes/ingredient/chicken");
check("ItemList: numberOfItems matches", ld.numberOfItems === 2);
check(
  "ItemList: ListItem position from 1, url to recipe page only",
  items[0].position === 1 && items[1].position === 2 && items[0].url === "https://useitup.uk/recipes/a" && Object.keys(items[0]).length === 3,
  items,
);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall recipeHub checks passed");
