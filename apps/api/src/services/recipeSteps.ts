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

/** True when `steps` is already a string[] with no blank / untrimmed entries (i.e. normalizing changes nothing). */
export function stepsAreNormalized(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  const n = normalizeRecipeSteps(steps);
  return n.length === steps.length && n.every((s, i) => s === steps[i]);
}
