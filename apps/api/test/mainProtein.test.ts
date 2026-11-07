/**
 * Pure-rule tests for services/mainProtein.ts. Run with:
 *   npx tsx apps/api/test/mainProtein.test.ts
 */
import { compatibleMainProteins, mainProteins } from "../src/services/mainProtein";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const r = (title: string, ingredientNames: string[]) => ({ title, ingredientNames });

eq("salmon frittata", mainProteins("Lemon-Dill Salmon Skillet Frittata", ["eggs", "smoked salmon", "dill"]), ["salmon"]);
eq("veg frittata", mainProteins("Spring Meadow Keto Frittata", ["eggs", "spinach", "goat cheese"]), []);
eq("stock is not a protein", mainProteins("Veg Soup", ["chicken stock", "carrot"]), []);
eq("fish sauce / oyster sauce ignored", mainProteins("Stir-fry", ["fish sauce", "oyster sauce", "tofu"]), ["tofu"]);
eq("title counts even with soup", mainProteins("Chicken Noodle Soup", ["noodles", "chicken stock"]), ["chicken"]);
eq("tuna in oil still tuna", mainProteins("Tuna Pasta", ["tinned tuna in olive oil", "pasta"]), ["tuna"]);

eq("salmon vs veg frittata → not comparable", compatibleMainProteins(r("Salmon Frittata", ["eggs", "salmon"]), r("Veg Frittata", ["eggs", "spinach"])), false);
eq("salmon vs mushroom crepes → not comparable", compatibleMainProteins(r("Smoked Salmon Crepes", ["salmon", "flour"]), r("Mushroom Crêpes", ["mushroom", "flour"])), false);
eq("two veg frittatas → comparable", compatibleMainProteins(r("Veg Frittata", ["eggs", "spinach"]), r("Asparagus Frittata", ["eggs", "asparagus"])), true);
eq("two prawn biryanis → comparable", compatibleMainProteins(r("Prawn Biryani", ["prawns", "rice"]), r("Shrimp Biryani", ["king prawns", "basmati rice"])), true);
eq("overlapping seafood → comparable", compatibleMainProteins(r("Stew", ["prawns", "cod"]), r("Stew", ["prawns", "scallops", "cod"])), true);
eq("chicken vs turkey → not comparable", compatibleMainProteins(r("Chicken Sloppy Joes", ["chicken"]), r("Turkey Sloppy Joes", ["turkey mince"])), false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("mainProtein: all tests passed");
