/**
 * Price hub pages — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/priceHubs.test.ts
 */
import {
  PRICE_HUBS,
  PRICE_HUB_MIN_RECIPES,
  livePriceHubs,
  priceHubBySlug,
  priceHubMeta,
  priceHubPath,
  recipeInPriceHub,
  recipesForPriceHub,
  tightestPriceHubFor,
} from "./priceHubs";
import type { HubRecipe } from "./recipeHub";
import { hubLinksForRecipe, hubNavGroups, hubSitemapEntries } from "./recipeHubRegistry";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, detail ?? "");
  }
}

let seq = 0;
function r(title: string, fullTierPrice: number | null, extra: Partial<HubRecipe> = {}): HubRecipe {
  seq++;
  return { _id: seq.toString(16).padStart(24, "0"), title, tags: [], fullTierPrice, ...extra };
}
const one = priceHubBySlug("under-1-pound")!;
const two = priceHubBySlug("under-2-pounds")!;
const three = priceHubBySlug("under-3-pounds")!;

// Slugs / paths
const slugs = PRICE_HUBS.map((h) => h.slug);
check("slugs unique", new Set(slugs).size === slugs.length);
check("slugs URL-safe", slugs.every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)), slugs);
check("unknown slug → undefined", priceHubBySlug("under-5-pounds") === undefined && priceHubBySlug("UNDER-1-POUND") === undefined);
check("path", priceHubPath("under-2-pounds") === "/recipes/price/under-2-pounds");

// Membership: full tier only, strict <, compared in displayed pence
check("tier not full (null) never counts", !recipeInPriceHub(three, r("partial", null)));
check("0 / NaN / negative never count", !recipeInPriceHub(three, r("z", 0)) && !recipeInPriceHub(three, r("n", NaN)) && !recipeInPriceHub(three, r("m", -1)));
check("£0.99 is under £1", recipeInPriceHub(one, r("a", 0.99)));
check("exactly £1.00 is not under £1", !recipeInPriceHub(one, r("b", 1)));
check("£0.996 (shown £1.00) is not under £1", !recipeInPriceHub(one, r("c", 0.996)));
check("£0.994 (shown £0.99) is under £1", recipeInPriceHub(one, r("d", 0.994)));
check("nested: £0.50 is in all three", [one, two, three].every((h) => recipeInPriceHub(h, r("e", 0.5))));
check("£2.50 only under £3", !recipeInPriceHub(two, r("f", 2.5)) && recipeInPriceHub(three, r("f", 2.5)));

// Sort cheapest first
const mixed = [r("C", 0.8), r("A", 0.4), r("B", 0.4), r("partial", null), r("D", 1.2)];
check("members cheapest first, ties by title, partial excluded", recipesForPriceHub(two, mixed).map((x) => x.title).join() === "A,B,C,D");

// Threshold
const four = Array.from({ length: PRICE_HUB_MIN_RECIPES - 1 }, (_, i) => r(`cheap ${i}`, 0.5));
const five = [...four, r("cheap last", 0.6)];
check("threshold: 4 → no hub", livePriceHubs(four).length === 0);
check("threshold: 5 → all three hubs live (nested)", livePriceHubs(five).map((h) => h.def.slug).join() === "under-1-pound,under-2-pounds,under-3-pounds");
const fourPlusPartials = [...four, r("p1", null), r("p2", null), r("p3", null)];
check("threshold counts fully priced only", livePriceHubs(fourPlusPartials).length === 0);

// Meta
const m = priceHubMeta(one, five);
check("title", m.title === "Recipes Under £1 Per Serving, UK Prices · UseItUp", m.title);
check("description has count and cap", m.description === "5 recipes under £1 a serving at UK supermarkets. See what a meal costs before you shop.", m.description);
check("intro has count and cap only", m.intro === "5 recipes that cost under £1 a serving at UK supermarket prices.", m.intro);
const big = PRICE_HUBS.map((d) => priceHubMeta(d, Array.from({ length: 999 }, (_, i) => r(`x${i}`, 0.01 + i / 1000))));
check("never claims every ingredient is priced (tier full = >=80%)", big.concat(m).every((x) => !/every ingredient/i.test(`${x.description} ${x.intro}`)));
check("every title ≤ 60", big.every((x) => x.title.length <= 60), big.map((x) => x.title.length));
check("every description ≤ 155", big.every((x) => x.description.length <= 155), big.map((x) => x.description.length));
check("no £ figures other than the cap", (m.description.match(/£\d+(?:\.\d{2})?/g) ?? []).join() === "£1");
// Regression (Rex PR #74 review): no tier may surface a cheapest-member price ("from £0.10" for a 16-serving batch).
const withOutlier = PRICE_HUBS.map((d) => priceHubMeta(d, [...five, r("batch wontons", 0.1)]));
check(
  "no tier's description/intro contains 'from £' or 'cheapest'",
  withOutlier.concat(big, m).every((x) => !/from\s*£|cheapest/i.test(`${x.description} ${x.intro}`)),
  withOutlier.map((x) => x.description),
);
check("outlier price never appears in copy", withOutlier.every((x) => !`${x.description} ${x.intro}`.includes("£0.10")));

// Registry glue
const lib = [...five, r("mid 1", 1.5), r("mid 2", 1.6), r("dear", 2.9), r("partial", null)];
const nav = hubNavGroups(lib);
check("nav: one price group, live hubs only, cheapest first", nav.length === 1 && nav[0].links.map((l) => l.label).join() === "Under £1,Under £2,Under £3", nav);
check("detail: £0.50 recipe links only the tightest hub (under £1)", hubLinksForRecipe(five[0], lib).map((l) => l.href).join() === "/recipes/price/under-1-pound");
check("detail: £1.50 recipe → under £2", hubLinksForRecipe(lib[5], lib).map((l) => l.href).join() === "/recipes/price/under-2-pounds");
check("detail: partial recipe → no price link", hubLinksForRecipe(lib[8], lib).length === 0);
check("tightest: none when hub not live", tightestPriceHubFor(r("x", 0.5), four) === undefined);
const sm = hubSitemapEntries(lib.map((x) => ({ ...x, updatedAt: "2026-11-01T00:00:00.000Z" })));
check("sitemap: 3 absolute URLs, no lastmod", sm.length === 3 && sm.every((e) => e.url.startsWith("https://useitup.uk/recipes/price/") && e.lastModified === undefined), sm);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall priceHubs checks passed");
