/**
 * Ingredient hub pages — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/ingredientPages.test.ts
 */
import {
  INGREDIENT_HUBS,
  INGREDIENT_MIN_RECIPES,
  ingredientHubBySlug,
  ingredientHubMeta,
  ingredientHubPath,
  liveIngredientHubs,
  recipeMatchesIngredient,
  recipesForIngredient,
} from "./ingredientPages";
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
function r(title: string, extra: Partial<HubRecipe> = {}): HubRecipe {
  seq++;
  return { _id: seq.toString(16).padStart(24, "0"), title, tags: [], fullTierPrice: null, ...extra };
}
const hub = (slug: string) => ingredientHubBySlug(slug)!;
const matches = (slug: string, title: string, tags: string[] = []) => recipeMatchesIngredient(hub(slug), r(title, { tags }));

// Matching
check("eggs: 'Scotch Eggs' and 'Poached Egg' match", matches("eggs", "Scotch Eggs") && matches("eggs", "Poached Egg With Spinach"));
check("eggs: eggplant is not an egg", !matches("eggs", "Smoky Eggplant Dip"));
check("prawns: shrimp counts as prawns", matches("prawns", "Garlicky Black Bean Shrimp Scramble") && matches("prawns", "King Prawn Curry"));
check("potatoes: sweet potato is not a potato", !matches("potatoes", "Sweet Potato Wedges"));
check("potatoes: both → still a potato recipe", matches("potatoes", "Sweet Potato and New Potatoes Tray Bake"));
check("sweet-potatoes: matches sweet potato", matches("sweet-potatoes", "Sweet Potato Wedges"));
check("rice: cauliflower rice / rice paper / rice noodles don't count", !matches("rice", "Cauliflower Rice Bowl") && !matches("rice", "Rice Paper Rolls") && !matches("rice", "Rice Noodle Salad"));
check("rice: brown rice + 'fried rice' count", matches("rice", "Cauliflower, Brown Rice, and Vegetable Fried Rice"));
check("chicken: 'chicken stock' alone doesn't count", !matches("chicken", "Leek Soup in Chicken Stock"));
check("chicken: real chicken + stock still counts", matches("chicken", "Chicken Thighs Braised in Chicken Stock"));
check("beef: 'Beefless Bibimbap' is not beef", !matches("beef", "Korean-Inspired Beefless Bibimbap"));
check("beans: jelly beans / bean sprouts don't count", !matches("beans", "Jelly Bean Cupcakes") && !matches("beans", "Bean Sprout Stir-fry"));
check("chickpeas: tag match (hyphen/case normalised)", matches("chickpeas", "Warm Skillet", ["Chick-Peas"]));
check("cheese: cheesecake is not cheese", !matches("cheese", "Lemon Cheesecake"));
check("pasta: spaghetti / gnocchi count as pasta", matches("pasta", "Celery Spaghetti") && matches("pasta", "Chickpea Gnocchi"));
check("lemongrass is not lemon-anything (no lemon hub)", !INGREDIENT_HUBS.some((h) => h.slug.startsWith("lemon")));

// Registry: slugs unique, URL-safe
const slugs = INGREDIENT_HUBS.map((h) => h.slug);
check("slugs unique", new Set(slugs).size === slugs.length);
check("slugs lowercase a-z and hyphens only", slugs.every((s) => /^[a-z]+(?:-[a-z]+)*$/.test(s)), slugs);
check("unknown slug → undefined", ingredientHubBySlug("unicorn") === undefined && ingredientHubBySlug("Chicken") === undefined);
check("path", ingredientHubPath("sweet-potatoes") === "/recipes/ingredient/sweet-potatoes");

// Threshold
const four = Array.from({ length: INGREDIENT_MIN_RECIPES - 1 }, (_, i) => r(`Salmon Dish ${i}`));
const five = [...four, r("Salmon Dish last")];
check("threshold: 4 salmon → no salmon hub", !liveIngredientHubs(four).some((h) => h.def.slug === "salmon"));
check("threshold: 5 salmon → salmon hub", liveIngredientHubs(five).some((h) => h.def.slug === "salmon" && h.recipes.length === 5));

// Meta: £ only from tier full; lengths
const priced = [
  r("Chicken A", { fullTierPrice: 2.4 }),
  r("Chicken B", { fullTierPrice: 0.926 }),
  r("Chicken C"), // partial / unavailable — never feeds the range
  r("Chicken D"),
  r("Chicken E", { fullTierPrice: 1.5 }),
];
const m = ingredientHubMeta(hub("chicken"), priced);
check("meta: £ range from full tier only", m.description.includes("£0.93–£2.40 per serving") && m.description.startsWith("5 chicken recipes"), m.description);
check("meta: intro says how many are fully priced", m.intro.includes("For the 3 with most ingredients priced, a serving costs £0.93–£2.40 at UK"), m.intro);
check("meta: never claims every ingredient is priced (tier full = >=80%)", !/every ingredient/i.test(`${m.description} ${m.intro}`));
check("meta: 'per serving' never doubled", !/per serving.*per serving/.test(m.intro + m.description), m);
const unpriced = ingredientHubMeta(hub("chicken"), [r("Chicken C"), r("Chicken D")]);
check("meta: no full-tier recipe → no £ anywhere", !/£/.test(unpriced.description + unpriced.title + unpriced.intro), unpriced);
check("meta: one price → single figure", ingredientHubMeta(hub("salmon"), [r("x", { fullTierPrice: 1 }), r("y", { fullTierPrice: 1.001 })]).description.includes("£1.00 per serving"));
check("meta: label grammar ('prawn recipes', not 'prawns recipes')", ingredientHubMeta(hub("prawns"), five).heading === "Prawn recipes");
const longest = INGREDIENT_HUBS.map((d) => ingredientHubMeta(d, Array.from({ length: 999 }, (_, i) => r(`x${i}`, { fullTierPrice: i === 0 ? 0.01 : 99.99 }))));
check("meta: every title ≤ 60 chars", longest.every((x) => x.title.length <= 60), longest.map((x) => x.title.length));
check("meta: every description ≤ 155 chars", longest.every((x) => x.description.length <= 155), longest.map((x) => x.description.length));

// Sort: fully priced cheapest first
const sorted = recipesForIngredient(hub("chicken"), priced).map((x) => x.title);
check("members sorted cheapest full-tier first", sorted.slice(0, 3).join(",") === "Chicken B,Chicken E,Chicken A", sorted);

// Registry glue: only live hubs are linked / listed
const lib = [...five, r("Chicken one"), r("Egg one")];
const nav = hubNavGroups(lib);
check("nav: only live hubs", nav.length === 1 && nav[0].links.length === 1 && nav[0].links[0].href === "/recipes/ingredient/salmon", nav);
check("detail links: recipe gets its live hubs only", hubLinksForRecipe(five[0], lib).map((l) => l.href).join() === "/recipes/ingredient/salmon");
check("detail links: chicken recipe gets no dead chicken link", hubLinksForRecipe(lib[5], lib).length === 0);
const withDates = five.map((x, i) => ({ ...x, updatedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
const sm = hubSitemapEntries(withDates);
check("sitemap: one entry per live hub, absolute URL, lastmod = newest member", sm.length === 1 && sm[0].url === "https://useitup.uk/recipes/ingredient/salmon" && sm[0].lastModified?.toISOString() === "2026-11-05T00:00:00.000Z", sm);
check("sitemap: no dates → no lastmod", hubSitemapEntries(five)[0].lastModified === undefined);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall ingredientPages checks passed");
