/**
 * recipeSlug — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/recipeSlug.test.ts
 */
import { parseRecipeParam, queryStringFrom, recipePath, recipeSegment, recipeSlug, RECIPE_SLUG_MAX } from "./recipeSlug";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, { actual, expected });
  }
}

const ID = "6a42e05cd33617bebef22d83";

// --- recipeSlug ---
check("basic title", recipeSlug("Almond Rainbow Cake"), "almond-rainbow-cake");
check("accents folded", recipeSlug("Crème Fraîche Pasta"), "creme-fraiche-pasta");
check("ampersand → and", recipeSlug("Mac & Cheese"), "mac-and-cheese");
check("apostrophe dropped", recipeSlug("Shepherd's Pie"), "shepherds-pie");
check("curly apostrophe dropped", recipeSlug("Nan’s Stew"), "nans-stew");
check("punctuation + £ collapse", recipeSlug("  £1 Dinner!! (Quick, Easy)  "), "1-dinner-quick-easy");
check("emoji stripped", recipeSlug("🔥 Spicy 🌶️ Wings 🍗"), "spicy-wings");
check("emoji-only → fallback", recipeSlug("🍕🍔"), "recipe");
check("empty → fallback", recipeSlug(""), "recipe");
check("whitespace → fallback", recipeSlug("   "), "recipe");
check("non-Latin → fallback", recipeSlug("番茄炒蛋"), "recipe");
check("mixed non-Latin keeps Latin part", recipeSlug("番茄 Tomato Egg"), "tomato-egg");
check("null → fallback", recipeSlug(null), "recipe");
check("number → fallback", recipeSlug(42), "recipe");
check("ß / æ / ø", recipeSlug("Straße Smørrebrød Æble"), "strasse-smorrebrod-aeble");
check("dots removed (middleware skips dotted paths)", recipeSlug("v2.0 St. Clement's"), "v2-0-st-clements");
check("slashes removed", recipeSlug("Half/Half 50/50"), "half-half-50-50");
const long = recipeSlug("Slow Cooker Honey Garlic Chicken Thighs with Roasted Vegetables and Fluffy Rice");
check("long: within cap", long.length <= RECIPE_SLUG_MAX, true);
check("long: word boundary", long, "slow-cooker-honey-garlic-chicken-thighs-with-roasted");
check("long: no trailing dash", long.endsWith("-"), false);
const oneWord = recipeSlug("a".repeat(100));
check("one huge word hard-cut", oneWord, "a".repeat(RECIPE_SLUG_MAX));
for (const t of ["Almond Rainbow Cake", "🔥 Spicy 🌶️ Wings", "Crème Brûlée", "", "x".repeat(200), "a-b--c---d"]) {
  check(`charset [a-z0-9-] only: ${JSON.stringify(t).slice(0, 20)}`, /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipeSlug(t)), true);
}

// --- recipePath / recipeSegment ---
check("path", recipePath(ID, "Almond Rainbow Cake"), `/recipes/almond-rainbow-cake-${ID}`);
check("path uppercase id lowered", recipePath(ID.toUpperCase(), "Cake"), `/recipes/cake-${ID}`);
check("path empty title", recipePath(ID, ""), `/recipes/recipe-${ID}`);
check("path non-ObjectId id → raw encoded", recipePath("abc def", "Cake"), "/recipes/abc%20def");
check("segment", recipeSegment(ID, "Almond Rainbow Cake"), `almond-rainbow-cake-${ID}`);

// --- parseRecipeParam ---
check("parse bare id", parseRecipeParam(ID), ID);
check("parse bare uppercase id", parseRecipeParam(ID.toUpperCase()), ID);
check("parse slug-id", parseRecipeParam(`almond-rainbow-cake-${ID}`), ID);
check("parse stale slug", parseRecipeParam(`old-name-${ID}`), ID);
check("parse slug that itself looks hex", parseRecipeParam(`deadbeef-${ID}`), ID);
check("parse slug containing another id", parseRecipeParam(`${"b".repeat(24)}-${ID}`), ID);
check("parse encoded", parseRecipeParam(encodeURIComponent(`crème-${ID}`)), ID);
check("parse malformed %", parseRecipeParam(`%E0%A4%A-${ID}`), ID);
check("reject 23 hex", parseRecipeParam(ID.slice(1)), null);
check("reject 25 hex (no dash)", parseRecipeParam(`a${ID}`), null);
check("reject non-hex tail", parseRecipeParam(`cake-${ID.slice(0, 23)}z`), null);
check("reject id then slug", parseRecipeParam(`${ID}-cake`), null);
check("reject empty", parseRecipeParam(""), null);
check("reject undefined", parseRecipeParam(undefined), null);
check("reject share-target", parseRecipeParam("share-target"), null);
check("reject just dash", parseRecipeParam(`-`), null);
check("parse leading dash only", parseRecipeParam(`-${ID}`), ID);

// --- roundtrip: built path parses back to the same id, and rebuilding gives the same segment (no redirect loop) ---
for (const title of ["Almond Rainbow Cake", "🔥", "", "Crème Brûlée & Co.", "x".repeat(300), "Shepherd's Pie", "番茄炒蛋"]) {
  const seg = recipeSegment(ID, title);
  const parsed = parseRecipeParam(seg);
  check(`roundtrip id: ${JSON.stringify(title).slice(0, 20)}`, parsed, ID);
  check(`roundtrip stable: ${JSON.stringify(title).slice(0, 20)}`, recipeSegment(parsed!, title), seg);
}

// --- queryStringFrom ---
check("qs empty", queryStringFrom({}), "");
check("qs null", queryStringFrom(undefined), "");
check("qs single", queryStringFrom({ utm_source: "ig" }), "?utm_source=ig");
check("qs multi-value", queryStringFrom({ a: ["1", "2"], b: "x y" }), "?a=1&a=2&b=x+y");
check("qs skips undefined", queryStringFrom({ a: undefined, b: "1" }), "?b=1");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall ok");
