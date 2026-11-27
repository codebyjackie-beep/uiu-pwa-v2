/**
 * Tests for the recipe field guards (follow-up to PR #70 / #71):
 *   1. approveRecipeDraft / forceApproveRecipeDraft refuse a draft whose steps normalize to [] (no insert)
 *   2. draftRecipe() rejects non-string title / ingredient name / text-less steps as MODEL output errors
 *   3. parseStepsPatch() (admin PATCH of recipes + recipe_drafts) normalizes, and refuses empty results
 *   4. buildTagClassifyPrompt() never prints "[object Object]" for object steps
 *   5. fridge / photo / video / text-import LLM parsers return normalized string steps, null on bad shapes
 * No network, no DB: fetch is stubbed, Db is a tiny in-memory fake. Run with:
 *   npx tsx apps/api/test/recipeFieldGuards.test.ts
 */
import type { Db } from "mongodb";
import { checkLlmRecipeShape, parseStepsPatch } from "../src/services/recipeSteps";
import { approveRecipeDraft } from "../src/services/recipeDraftApproval";
import { forceApproveRecipeDraft } from "../src/services/recipeDraftOverride";
import { draftRecipe } from "../src/services/openrouter";
import { isModelOutputError } from "../src/jobs/dailyRecipeDraftOutcome";
import { buildTagClassifyPrompt } from "../src/services/recipeTagClassifyPrompt";
import { generateRecipeFromFridge } from "../src/services/fridgeRecipeGen";
import { extractRecipeFromPhotos, extractRecipeFromVideo } from "../src/services/openrouterVision";
import { parseRecipeFromText } from "../src/services/recipeImport";

let failures = 0;
let passes = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  } else {
    passes++;
  }
}

// Silence the services' own console.error/log lines (they only print ids / messages) so the output stays readable.
const realError = console.error;
const realLog = console.log;
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.error = () => {};
  console.log = () => {};
  return fn().finally(() => {
    console.error = realError;
    console.log = realLog;
  });
}

const realFetch = globalThis.fetch;
/** Stub fetch so the next OpenRouter call replies with `content` as the model message. */
function stubModelReply(content: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const GOOD = {
  title: "Lemon Chickpea Traybake",
  description: "Bright and quick.",
  ingredients: [
    { name: "chickpeas", quantity: 400, unit: "g" },
    { name: "lemon", quantity: 1, unit: "pc" },
  ],
  steps: ["Heat the oven.", "Roast for 20 minutes."],
  tags: ["traybake"],
  mealType: "dinner",
  servings: 2,
  prepTimeMinutes: 5,
  cookTimeMinutes: 20,
};

async function main() {
  // ---------------------------------------------------------------------------------------------
  // 3. parseStepsPatch (pure)
  // ---------------------------------------------------------------------------------------------
  eq("patch: strings kept + trimmed", parseStepsPatch([" Chop. ", "Fry."]), { ok: true, steps: ["Chop.", "Fry."] });
  eq(
    "patch: object steps normalized to text",
    parseStepsPatch([{ name: "Preheat", text: "Set the oven to 190C." }, { name: "Drain the chickpeas.", quantity: 1, unit: "step" }]),
    { ok: true, steps: ["Set the oven to 190C.", "Drain the chickpeas."] },
  );
  eq("patch: [] refused", parseStepsPatch([]).ok, false);
  eq("patch: blank strings only refused", parseStepsPatch(["", "   "]).ok, false);
  eq("patch: text-less objects refused", parseStepsPatch([{ quantity: 1, unit: "step" }, null]).ok, false);
  eq("patch: string (not array) refused", parseStepsPatch("Chop. Fry.").ok, false);
  eq("patch: null refused", parseStepsPatch(null).ok, false);
  eq("patch: object (not array) refused", parseStepsPatch({ text: "Chop." }).ok, false);

  // checkLlmRecipeShape (pure)
  eq("shape: good passes", checkLlmRecipeShape(GOOD, 2).ok, true);
  eq("shape: number title", checkLlmRecipeShape({ ...GOOD, title: 42 }), { ok: false, reason: "title not a non-empty string" });
  eq("shape: object title", checkLlmRecipeShape({ ...GOOD, title: { en: "x" } }).ok, false);
  eq("shape: blank title", checkLlmRecipeShape({ ...GOOD, title: "  " }).ok, false);
  eq(
    "shape: number ingredient name",
    checkLlmRecipeShape({ ...GOOD, ingredients: [{ name: 7, quantity: 1, unit: "g" }, GOOD.ingredients[1]] }),
    { ok: false, reason: "ingredient name not a non-empty string" },
  );
  eq("shape: object ingredient name", checkLlmRecipeShape({ ...GOOD, ingredients: [{ name: { text: "egg" }, quantity: 1, unit: "" }] }).ok, false);
  eq("shape: null ingredient item", checkLlmRecipeShape({ ...GOOD, ingredients: [null, GOOD.ingredients[0]] }).ok, false);
  eq("shape: string ingredient item", checkLlmRecipeShape({ ...GOOD, ingredients: ["egg"] }).ok, false);
  eq("shape: too few ingredients", checkLlmRecipeShape({ ...GOOD, ingredients: [GOOD.ingredients[0]] }, 2), { ok: false, reason: "ingredients < 2" });
  eq("shape: text-less object steps → no usable steps", checkLlmRecipeShape({ ...GOOD, steps: [{ quantity: 1, unit: "step" }] }), { ok: false, reason: "no usable steps" });
  eq("shape: steps not array", checkLlmRecipeShape({ ...GOOD, steps: "Chop." }).ok, false);
  eq("shape: not an object", checkLlmRecipeShape([GOOD]).ok, false);
  const shaped = checkLlmRecipeShape({ ...GOOD, title: "  Padded  ", steps: [{ name: "step 1", instruction: "Whisk." }] });
  eq("shape: title trimmed + steps normalized", shaped.ok ? [shaped.recipe.title, shaped.recipe.steps] : null, ["Padded", ["Whisk."]]);

  // ---------------------------------------------------------------------------------------------
  // 4. buildTagClassifyPrompt
  // ---------------------------------------------------------------------------------------------
  const prompt = buildTagClassifyPrompt({
    title: "T",
    description: "D",
    ingredients: [{ name: "egg", quantity: 2, unit: "pc" }],
    steps: [{ name: "Drain the chickpeas.", quantity: 1, unit: "step" }, { name: "Preheat", text: "Set the oven to 190C." }, "Serve."],
  });
  eq("tag prompt: no [object Object]", prompt.includes("[object Object]"), false);
  eq("tag prompt: object step text used", prompt.includes("Steps: Drain the chickpeas. Set the oven to 190C. Serve.\n"), true);
  eq("tag prompt: non-array steps do not throw", buildTagClassifyPrompt({ title: "T", description: "", ingredients: [], steps: undefined }).includes("Steps: \n"), true);

  // ---------------------------------------------------------------------------------------------
  // 2. draftRecipe (fetch stubbed)
  // ---------------------------------------------------------------------------------------------
  const env = { OPENROUTER_API_KEY: "test-key-not-real", OPENROUTER_MODEL: "test/model" };
  const input = { dishIdea: "chickpeas", canonicalNames: ["chickpeas", "lemon"] };
  async function draftError(reply: unknown): Promise<unknown> {
    stubModelReply(reply);
    try {
      await draftRecipe(env, input);
      return null;
    } catch (err) {
      return err;
    } finally {
      restoreFetch();
    }
  }
  for (const [name, reply] of [
    ["number title", { ...GOOD, title: 123 }],
    ["object title", { ...GOOD, title: { text: "x" } }],
    ["number ingredient name", { ...GOOD, ingredients: [{ name: 5, quantity: 1, unit: "g" }] }],
    ["object ingredient name", { ...GOOD, ingredients: [{ name: { en: "egg" }, quantity: 1, unit: "" }] }],
    ["null ingredient item", { ...GOOD, ingredients: [null] }],
    ["text-less object steps", { ...GOOD, steps: [{ quantity: 1, unit: "step" }] }],
  ] as const) {
    const err = await draftError(reply);
    eq(`draftRecipe ${name}: throws`, err instanceof Error, true);
    eq(`draftRecipe ${name}: counted as model output error (does not stop refill)`, isModelOutputError(err), true);
  }
  stubModelReply({ ...GOOD, steps: [{ name: "Preheat", text: "Heat the oven." }, "Roast."] });
  const drafted = await draftRecipe(env, input).finally(restoreFetch);
  eq("draftRecipe good: steps normalized", drafted.steps, ["Heat the oven.", "Roast."]);
  eq("draftRecipe good: title/ingredients kept", [drafted.title, drafted.ingredients.map((i) => i.name)], [GOOD.title, ["chickpeas", "lemon"]]);

  // ---------------------------------------------------------------------------------------------
  // 5. fridge / photo / video / text import (fetch stubbed; these return null rather than throw)
  // ---------------------------------------------------------------------------------------------
  const visionEnv = { OPENROUTER_API_KEY: "test-key-not-real", OPENROUTER_VISION_MODEL: "test/vision" };
  const objectSteps = [{ name: "Drain the chickpeas.", quantity: 1, unit: "step" }, { name: "Preheat", text: "Heat the oven." }];
  const parsers: Array<[string, () => Promise<unknown>]> = [
    ["fridge", () => generateRecipeFromFridge(env, ["chickpeas", "lemon"])],
    ["photo", () => extractRecipeFromPhotos(visionEnv, ["data:image/png;base64,AAAA"])],
    ["video", () => extractRecipeFromVideo(visionEnv, "data:video/mp4;base64,AAAA")],
    ["text import", () => parseRecipeFromText(env, "2 eggs, 1 lemon. Whisk and fry.")],
  ];
  for (const [name, run] of parsers) {
    stubModelReply({ ...GOOD, steps: objectSteps });
    const ok = (await quiet(run).finally(restoreFetch)) as { steps?: unknown } | null;
    eq(`${name}: object steps → strings`, ok?.steps, ["Drain the chickpeas.", "Heat the oven."]);

    stubModelReply({ ...GOOD, steps: [{ quantity: 1, unit: "step" }, {}] });
    eq(`${name}: text-less steps → null`, await quiet(run).finally(restoreFetch), null);

    stubModelReply({ ...GOOD, title: 99 });
    eq(`${name}: number title → null`, await quiet(run).finally(restoreFetch), null);

    stubModelReply({ ...GOOD, ingredients: [{ name: { en: "egg" }, quantity: 1, unit: "" }, GOOD.ingredients[1]] });
    eq(`${name}: object ingredient name → null`, await quiet(run).finally(restoreFetch), null);
  }
  const debug: { raw?: string; reason?: string } = {};
  stubModelReply({ ...GOOD, steps: [{}] });
  await quiet(() => parseRecipeFromText(env, "x", debug)).finally(restoreFetch);
  eq("text import: debug.reason names the gate", debug.reason?.startsWith("gate: no usable steps"), true);

  // ---------------------------------------------------------------------------------------------
  // 1. approveRecipeDraft / forceApproveRecipeDraft refuse 0-step drafts (fake Db, no network)
  // ---------------------------------------------------------------------------------------------
  const DRAFT_ID = "6a9d0fad645acffa58a800a0";
  function fakeDb(draft: Record<string, unknown>) {
    const calls = { insertOne: 0, updateOne: 0, find: 0 };
    const col = {
      findOne: async () => draft,
      insertOne: async () => {
        calls.insertOne++;
        return { insertedId: "x" };
      },
      updateOne: async () => {
        calls.updateOne++;
        return { matchedCount: 1 };
      },
      find: () => {
        calls.find++;
        return { toArray: async () => [] };
      },
    };
    const db = { collection: () => col } as unknown as Db;
    return { db, calls };
  }
  for (const [name, steps] of [
    ["text-less object steps", [{ quantity: 1, unit: "step" }]],
    ["empty array", []],
    ["missing steps", undefined],
    ["blank strings", ["", "  "]],
  ] as const) {
    const { db, calls } = fakeDb({ _id: DRAFT_ID, status: "pending", title: "T", ingredients: [], steps });
    const r = await quiet(() => approveRecipeDraft(db, {} as never, DRAFT_ID));
    eq(`approve ${name}: noSteps`, r, { noSteps: true });
    eq(`approve ${name}: nothing inserted / updated / scanned`, calls, { insertOne: 0, updateOne: 0, find: 0 });
  }
  {
    const { db, calls } = fakeDb({ _id: DRAFT_ID, status: "pending", title: "T", ingredients: [], steps: [{}] });
    const dry = await quiet(() => forceApproveRecipeDraft(db, {} as never, DRAFT_ID, { by: "test", note: "n", write: false }));
    eq("force-approve dry-run 0 steps: noSteps", dry, { noSteps: true });
    const wet = await quiet(() => forceApproveRecipeDraft(db, {} as never, DRAFT_ID, { by: "test", note: "n", write: true }));
    eq("force-approve write 0 steps: noSteps", wet, { noSteps: true });
    eq("force-approve 0 steps: nothing written", calls, { insertOne: 0, updateOne: 0, find: 0 });
  }
  {
    // Non-pending drafts still report alreadyDecided first (unchanged behaviour).
    const { db } = fakeDb({ _id: DRAFT_ID, status: "approved", steps: [] });
    eq("approve non-pending: alreadyDecided wins", await approveRecipeDraft(db, {} as never, DRAFT_ID), { alreadyDecided: true });
  }

  console.log(`recipeFieldGuards: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error = realError;
  console.error("recipeFieldGuards: crashed", err);
  process.exit(1);
});
