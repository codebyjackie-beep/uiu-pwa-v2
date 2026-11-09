/** Standalone assertions: node --experimental-strip-types apps/api/src/services/recipeTextSanitize.test.mts */
import assert from "node:assert";
import {
  cleanCanonicalNamesForPrompt,
  findPlaceholders,
  fixKnownNames,
  isPluralLine,
  sanitizeRecipeText,
  stripRecipePlaceholders,
} from "./recipeTextSanitize.ts";

const plural = { eggPlural: true, tomatoPlural: true };
const single = { eggPlural: false, tomatoPlural: false };

// --- fixKnownNames ---------------------------------------------------------
assert.strictEqual(fixKnownNames("whisk the _egg_ with cream", plural), "whisk the eggs with cream");
assert.strictEqual(fixKnownNames("mix in the _egg_, salt", single), "mix in the egg, salt");
assert.strictEqual(fixKnownNames("_Egg_ wash", single), "Egg wash");
assert.strictEqual(fixKnownNames("Add the tomatoe and broth.", plural), "Add the tomatoes and broth.");
assert.strictEqual(fixKnownNames("Tomatoe halves", plural), "Tomatoes halves");
assert.strictEqual(fixKnownNames("TOMATOE", plural), "TOMATOES");
assert.strictEqual(fixKnownNames("a bright tomatoe sauce", plural), "a bright tomato sauce");
assert.strictEqual(fixKnownNames("quick tomatoe relish", plural), "quick tomato relish");
assert.strictEqual(fixKnownNames("stir in tomatoe paste", plural), "stir in tomato paste");
assert.strictEqual(fixKnownNames("1 tomatoe, diced", single), "1 tomato, diced");
// Already-correct words are untouched.
for (const ok of ["tomatoes", "Tomato soup", "eggs", "egg_noodles", "eggplant", "snake_egg_case"]) {
  assert.strictEqual(fixKnownNames(ok, plural), ok, `unchanged: ${ok}`);
}

// --- isPluralLine ----------------------------------------------------------
assert.strictEqual(isPluralLine(8, "large"), true);
assert.strictEqual(isPluralLine(1, "large"), false);
assert.strictEqual(isPluralLine(1, ""), false);
assert.strictEqual(isPluralLine(1, "whole"), false);
assert.strictEqual(isPluralLine(300, "g"), true);
assert.strictEqual(isPluralLine(1, "tin"), true);
assert.strictEqual(isPluralLine(3, "each"), true);

// --- findPlaceholders / strip ------------------------------------------------
assert.deepStrictEqual(findPlaceholders("chop the _celery_ and add single cream (_milk_)"), ["celery", "milk"]);
assert.deepStrictEqual(findPlaceholders("no markup here, snake_case_name or __init__"), []);
assert.deepStrictEqual(findPlaceholders("_egg_"), ["egg"]);

// --- sanitizeRecipeText: frittata case from the 11-09 bulk fix -------------------
const frittata = sanitizeRecipeText({
  title: "Golden Spinach Frittata",
  description: "Fluffy _egg_ with spinach and a tomatoe relish.",
  ingredients: [
    { name: "_egg_", quantity: 8, unit: "large" },
    { name: "tomatoe", quantity: 1, unit: "medium" },
    { name: "spinach", quantity: 200, unit: "g" },
  ],
  steps: ["In a bowl, whisk the _egg_ with heavy cream.", "Dice the tomatoe."],
});
assert.deepStrictEqual(frittata.recipe.ingredients.map((i) => i.name), ["eggs", "tomato", "spinach"]);
assert.strictEqual(frittata.recipe.description, "Fluffy eggs with spinach and a tomato relish.");
assert.deepStrictEqual(frittata.recipe.steps, ["In a bowl, whisk the eggs with heavy cream.", "Dice the tomato."]);
assert.strictEqual(frittata.unknownPlaceholders.length, 0);
assert.deepStrictEqual(
  frittata.changes.map((c) => c.field),
  ["ingredients[0].name", "ingredients[1].name", "description", "steps[0]", "steps[1]"],
);
// quantity / unit kept as-is
assert.strictEqual(frittata.recipe.ingredients[0]!.quantity, 8);
assert.strictEqual(frittata.recipe.ingredients[0]!.unit, "large");

// Title uses the singular modifier; 300 g line -> plural.
const guac = sanitizeRecipeText({
  title: "Smoky Citrus Guacamole with Crunchy Tomatoe Relish",
  description: "",
  ingredients: [{ name: "tomatoe", quantity: 300, unit: "g" }],
  steps: ["Chop the tomatoe finely."],
});
assert.strictEqual(guac.recipe.title, "Smoky Citrus Guacamole with Crunchy Tomato Relish");
assert.strictEqual(guac.recipe.ingredients[0]!.name, "tomatoes");
assert.strictEqual(guac.recipe.steps[0], "Chop the tomatoes finely.");

// Clean recipe: no changes, same content.
const cleanInput = {
  title: "Egg Fried Rice",
  description: "Quick rice with eggs and tomatoes.",
  ingredients: [{ name: "egg", quantity: 2, unit: "" }, { name: "tomatoes", quantity: 2, unit: "" }],
  steps: ["Scramble the eggs."],
};
const cleanResult = sanitizeRecipeText(cleanInput);
assert.deepStrictEqual(cleanResult.recipe, cleanInput);
assert.strictEqual(cleanResult.changes.length, 0);
assert.strictEqual(cleanResult.unknownPlaceholders.length, 0);

// Unknown placeholders are reported (not silently fixed) ...
const celery = sanitizeRecipeText({
  title: "Soup",
  description: "With single cream (_milk_).",
  ingredients: [{ name: "_celery_", quantity: 2, unit: "stick" }],
  steps: ["Slice the _celery_."],
});
assert.deepStrictEqual(celery.unknownPlaceholders, [
  { field: "ingredients[0].name", placeholder: "celery" },
  { field: "description", placeholder: "milk" },
  { field: "steps[0]", placeholder: "celery" },
]);
assert.strictEqual(celery.recipe.ingredients[0]!.name, "_celery_");
// ... and can be stripped once logged/flagged.
const stripped = stripRecipePlaceholders(celery.recipe);
assert.strictEqual(stripped.ingredients[0]!.name, "celery");
assert.strictEqual(stripped.description, "With single cream (milk).");
assert.strictEqual(stripped.steps[0], "Slice the celery.");

// Extra fields on the input (tags, servings, ...) pass through.
const extra = sanitizeRecipeText({ title: "T", ingredients: [], steps: [], tags: ["x"], servings: 2 });
assert.deepStrictEqual(extra.recipe.tags, ["x"]);
assert.strictEqual(extra.recipe.servings, 2);
assert.strictEqual("description" in extra.recipe, false);

// --- cleanCanonicalNamesForPrompt (live Atlas names, 2026-11-09) -------------------
assert.deepStrictEqual(
  cleanCanonicalNamesForPrompt(["egg", "_egg_", "_celery_", "celery", "single cream (_milk_)", "single cream", "tomatoe", "tomato", "canned tomatoes"]),
  ["egg", "celery", "single cream", "tomato", "canned tomatoes"],
);

console.log("recipeTextSanitize: all assertions passed");
