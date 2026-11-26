/**
 * SEO meta helpers — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/seoMeta.test.ts
 */
import { clamp, DESCRIPTION_MAX, RECIPE_DESCRIPTION_FALLBACK, recipeMetaDescription, recipeMetaTitle, TITLE_MAX } from "./seoMeta";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, detail ?? "");
  }
}

// clamp
check("clamp: short string unchanged", clamp("Hello world", 20) === "Hello world");
const c = clamp("The quick brown fox jumps over the lazy dog", 20);
check("clamp: ≤ n chars", c.length <= 20, c);
check("clamp: ends with …", c.endsWith("…"), c);
check("clamp: cuts at a word boundary", c === "The quick brown fox…", c);

// title
check("title: short name", recipeMetaTitle("Red Lentil Soup with Chicken and Turnips") === "Red Lentil Soup with Chicken and Turnips · UseItUp");
const longTitle = recipeMetaTitle("Slow-Cooked Smoky Chickpea, Sweet Potato and Spinach Stew with Garlic Yoghurt and Flatbreads");
check("title: long name ≤ 60", longTitle.length <= TITLE_MAX, longTitle);
check("title: long name keeps brand suffix", longTitle.endsWith("… · UseItUp"), longTitle);
check("title: empty name falls back", recipeMetaTitle("  ") === "Recipe · UseItUp");

// description
const base = {
  description: "A warming soup for cold nights. Uses up the veg drawer.",
  servings: 4,
  prepTimeMinutes: 10,
  cookTimeMinutes: 25,
};
const full = recipeMetaDescription({ ...base, cost: { tier: "full", text: "£1.20" } });
check(
  "desc: full tier includes price",
  full === "A warming soup for cold nights. Serves 4, ready in 35 min, about £1.20 per serving at UK supermarkets.",
  full,
);
const partial = recipeMetaDescription({ ...base, cost: { tier: "partial", text: "£1.20+" } });
check("desc: partial tier has no £", !partial.includes("£"), partial);
check("desc: partial tier keeps servings/time", partial === "A warming soup for cold nights. Serves 4, ready in 35 min.", partial);
const unavailable = recipeMetaDescription({ ...base, cost: { tier: "unavailable", text: "Price unavailable" } });
check("desc: unavailable tier has no price text", !unavailable.includes("£") && !unavailable.includes("unavailable"), unavailable);
const noCost = recipeMetaDescription({ ...base, cost: null });
check("desc: no cost has no £", !noCost.includes("£"), noCost);

const longLead = recipeMetaDescription({
  ...base,
  description:
    "This is a very long single sentence describing a hearty and comforting one-pot dish that you can make on a weeknight with whatever is left in the fridge and cupboard without much fuss at all",
  cost: { tier: "full", text: "£0.95" },
});
check("desc: long lead ≤ 155", longLead.length <= DESCRIPTION_MAX, longLead.length);
check("desc: long lead keeps the price fact whole", longLead.endsWith("about £0.95 per serving at UK supermarkets."), longLead);

const noStop = recipeMetaDescription({
  description: "Quick and easy weeknight curry",
  servings: 4,
  prepTimeMinutes: 10,
  cookTimeMinutes: 20,
  cost: { tier: "full", text: "£1.50" },
});
check(
  "desc: lead without full stop gets one",
  noStop === "Quick and easy weeknight curry. Serves 4, ready in 30 min, about £1.50 per serving at UK supermarkets.",
  noStop,
);
const bang = recipeMetaDescription({ description: "So good!", servings: 2 });
check("desc: lead ending in ! is left alone", bang === "So good! Serves 2.", bang);
const leadOnly = recipeMetaDescription({ description: "Just a simple salad" });
check("desc: lead only, no facts, still gets a full stop", leadOnly === "Just a simple salad.", leadOnly);

check("desc: empty everything → fallback", recipeMetaDescription({}) === RECIPE_DESCRIPTION_FALLBACK);
const factsOnly = recipeMetaDescription({ servings: 2, cookTimeMinutes: 15, cost: { tier: "full", text: "£2.00" } });
check("desc: no description → facts only", factsOnly === "Serves 2, ready in 15 min, about £2.00 per serving at UK supermarkets.", factsOnly);
const timeOnly = recipeMetaDescription({ prepTimeMinutes: 5 });
check("desc: capitalises first fact", timeOnly === "Ready in 5 min.", timeOnly);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall seoMeta checks passed");
