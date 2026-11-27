/**
 * Defensive read of `recipe.steps`. The shared type says `string[]`, but at least one AI-draft
 * recipe reached the API with steps stored as objects (`{ name, quantity, unit: "step" }`), and
 * rendering an object as a React child throws → the whole recipe page 500s.
 *
 * Rules: a string is trimmed; an object contributes its first non-empty string among
 * `name` / `text` / `instruction`; anything else is dropped; empty results are dropped;
 * a non-array input gives []. Normal string steps come out unchanged apart from trim.
 */
const OBJECT_TEXT_KEYS = ["name", "text", "instruction"] as const;

function stepText(step: unknown): string {
  if (typeof step === "string") return step.trim();
  if (step && typeof step === "object" && !Array.isArray(step)) {
    const rec = step as Record<string, unknown>;
    for (const key of OBJECT_TEXT_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
  }
  return "";
}

export function normalizeSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map(stepText).filter((s) => s.length > 0);
}
