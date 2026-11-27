/**
 * Recipe `steps` must always be string[] (the web recipe page renders each step as text).
 *
 * The drafting model sometimes ignores the `"steps": [string]` instruction and returns objects
 * instead. Shapes seen in recipe_drafts (2026-08/09):
 *   {name, quantity, unit: "step"}            — step text in `name`
 *   {name: "Preheat", text: "..."}            — `name` is a short label, text in `text`
 *   {name: "step 1", quantity, unit, instruction: "..."}
 *   {step: "..."}
 * One of these reached a public recipe and made its page throw (React can't render an object).
 *
 * Rules: string → trimmed; object → first non-empty string of text / instruction / step /
 * description / name (the long-text keys win over `name`, which is often only a label);
 * number → String(); anything else (null, arrays, objects with no text) dropped. Empty results
 * are dropped. Order is kept.
 */
const TEXT_KEYS = ["text", "instruction", "step", "description", "name"] as const;

function stepToString(step: unknown): string {
  if (typeof step === "string") return step.trim();
  if (typeof step === "number" && Number.isFinite(step)) return String(step);
  if (step && typeof step === "object" && !Array.isArray(step)) {
    const obj = step as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

export function normalizeRecipeSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map(stepToString).filter((s) => s.length > 0);
}

/**
 * Admin PATCH guard for a `steps` value from a request body. Normalizes it (objects → text) and
 * refuses anything that would leave the recipe with no steps — a non-array, `[]`, or an array with
 * no usable text — instead of silently writing `[]`.
 */
export function parseStepsPatch(raw: unknown): { ok: true; steps: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "steps must be an array of strings" };
  const steps = normalizeRecipeSteps(raw);
  if (steps.length === 0) return { ok: false, message: "steps must contain at least 1 non-empty step" };
  return { ok: true, steps };
}

export interface LlmRecipeShape {
  title: string;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  steps: string[];
}

/**
 * Shape gate for a recipe JSON object parsed from an LLM reply (draft / fridge / photo / video / text
 * import). The model sometimes returns a number or object where a string belongs; those values later
 * crash string code (`.replace`, `.toLowerCase`) far from here. Checks:
 *   - title is a non-empty string
 *   - ingredients is an array of ≥ minIngredients objects, each with a non-empty string `name`
 *   - steps, after normalizeRecipeSteps, has ≥ 1 entry (gate on the NORMALIZED count — an array of
 *     text-less objects must not pass)
 * Returns the trimmed title + normalized steps, or a short reason (no recipe content in it).
 */
export function checkLlmRecipeShape(
  parsed: unknown,
  minIngredients = 0,
): { ok: true; recipe: LlmRecipeShape } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not an object" };
  const p = parsed as Record<string, unknown>;
  if (typeof p.title !== "string" || !p.title.trim()) return { ok: false, reason: "title not a non-empty string" };
  if (!Array.isArray(p.ingredients)) return { ok: false, reason: "ingredients not an array" };
  if (p.ingredients.length < minIngredients) return { ok: false, reason: `ingredients < ${minIngredients}` };
  const badIngredient = p.ingredients.some(
    (i) => !i || typeof i !== "object" || Array.isArray(i) || typeof (i as Record<string, unknown>).name !== "string" || !((i as Record<string, unknown>).name as string).trim(),
  );
  if (badIngredient) return { ok: false, reason: "ingredient name not a non-empty string" };
  if (!Array.isArray(p.steps)) return { ok: false, reason: "steps not an array" };
  const steps = normalizeRecipeSteps(p.steps);
  if (steps.length === 0) return { ok: false, reason: "no usable steps" };
  return {
    ok: true,
    recipe: { title: p.title.trim(), ingredients: p.ingredients as LlmRecipeShape["ingredients"], steps },
  };
}

/** True when `steps` is already a string[] with no blank / untrimmed entries (i.e. normalizing changes nothing). */
export function stepsAreNormalized(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  const n = normalizeRecipeSteps(steps);
  return n.length === steps.length && n.every((s, i) => s === steps[i]);
}
