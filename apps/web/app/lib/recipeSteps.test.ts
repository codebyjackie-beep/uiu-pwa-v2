/**
 * normalizeSteps — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/recipeSteps.test.ts
 */
import { normalizeSteps } from "./recipeSteps";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, { actual, expected });
  }
}

// Normal string steps — unchanged (only trimmed).
check("plain strings unchanged", normalizeSteps(["Chop the onion.", "Simmer for 20 minutes."]), [
  "Chop the onion.",
  "Simmer for 20 minutes.",
]);
check("strings trimmed", normalizeSteps(["  Chop.  ", "\tStir.\n"]), ["Chop.", "Stir."]);
check("inner whitespace kept", normalizeSteps(["a  b"]), ["a  b"]);

// Object steps (the shape seen in the live 500 case).
check(
  "object {name,quantity,unit}",
  normalizeSteps([
    { name: "Drain and rinse the chickpeas.", quantity: 1, unit: "step" },
    { name: " Mash the avocado. ", quantity: 1, unit: "step" },
  ]),
  ["Drain and rinse the chickpeas.", "Mash the avocado."],
);
check("object {text}", normalizeSteps([{ text: "Bake 10 min." }]), ["Bake 10 min."]);
check("object {instruction}", normalizeSteps([{ instruction: "Serve." }]), ["Serve."]);
check("object key order name > text > instruction", normalizeSteps([{ instruction: "c", text: "b", name: "a" }]), ["a"]);
check("object empty name falls through to text", normalizeSteps([{ name: "  ", text: "Use text." }]), ["Use text."]);
check("object non-string name falls through", normalizeSteps([{ name: 5, instruction: "Ok." }]), ["Ok."]);
check("object with no usable key dropped", normalizeSteps([{ quantity: 1, unit: "step" }]), []);

// Mixed.
check(
  "mixed strings / objects / junk",
  normalizeSteps(["One.", { name: "Two." }, 3, null, undefined, true, ["nested"], "", "   ", { text: "Three." }]),
  ["One.", "Two.", "Three."],
);

// Empty / null / non-array.
check("empty array", normalizeSteps([]), []);
check("null", normalizeSteps(null), []);
check("undefined", normalizeSteps(undefined), []);
check("string (non-array)", normalizeSteps("Chop the onion."), []);
check("object (non-array)", normalizeSteps({ name: "x" }), []);
check("number (non-array)", normalizeSteps(42), []);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
