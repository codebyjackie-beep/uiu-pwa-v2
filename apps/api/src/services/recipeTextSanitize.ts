/**
 * Clean-up for recipe text before it enters `recipe_drafts` / `recipes` (2026-11-09).
 *
 * Root cause: `canonical_ingredients` holds a few names copied from supermarket allergen
 * markup (`_egg_`, `_celery_`, `single cream (_milk_)`) plus the typo canonical `tomatoe`.
 * The daily draft prompt tells the model to use canonical names *verbatim*, so it wrote
 * `_egg_` / `tomatoe` into ingredients, and then repeated them in steps, title and description
 * (42 recipes hand-fixed on 2026-11-09, see claude-docs/update_2026-11-09_bulk_name_dryrun.md).
 *
 * Known fixes: `_egg_` -> egg/eggs, `tomatoe` -> tomato/tomatoes (tomato before sauce/relish/paste).
 * Any other `_word_` placeholder is reported so the caller can reject or flag the recipe.
 */

/** `_word_` / `_two words_` style markup, not part of a longer identifier like `foo_bar_baz`. */
const PLACEHOLDER_RE = /(?<![A-Za-z0-9_])_([A-Za-z][A-Za-z ]*?)_(?![A-Za-z0-9_])/g;
const EGG_PLACEHOLDER_RE = /(?<![A-Za-z0-9_])_(egg)_(?![A-Za-z0-9_])/gi;
const TOMATOE_RE = /\b(tomatoe)\b/gi;
/** Words after which "tomato" is used as a modifier, never "tomatoes". */
const TOMATO_MODIFIER_NEXT = /^\s+(sauce|relish|paste|purée|puree|passata|ketchup|soup|salsa|juice)\b/i;

/** Units that mean "count of whole items": `1 large egg`, `1 tomato`, `1 each`. */
const COUNT_UNITS = new Set(["", "whole", "count", "each", "pc", "pcs", "piece", "pieces", "large", "medium", "small", "x"]);

export interface SanitizeIngredient {
  name: string;
  quantity?: number;
  unit?: string;
}

export interface SanitizeRecipeInput {
  title: string;
  description?: string;
  ingredients: SanitizeIngredient[];
  steps: string[];
}

export interface SanitizeChange {
  field: string;
  before: string;
  after: string;
}

export interface SanitizeRecipeResult<T extends SanitizeRecipeInput> {
  recipe: T;
  changes: SanitizeChange[];
  /** Other `_word_` placeholders still present after the known fixes (e.g. `_celery_`), with where they were found. */
  unknownPlaceholders: Array<{ field: string; placeholder: string }>;
}

/** Keep the case shape of the original word: `TOMATOE` -> `TOMATOES`, `Tomatoe` -> `Tomatoes`. */
function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] && original[0] === original[0].toUpperCase()) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
}

/** True when an ingredient line means more than one whole item (300 g tomatoes, 8 large eggs). */
export function isPluralLine(quantity: number | undefined, unit: string | undefined): boolean {
  const u = (unit ?? "").trim().toLowerCase();
  if (!COUNT_UNITS.has(u)) return true; // weight / volume / tin etc. -> "300 g tomatoes"
  return !(typeof quantity === "number" && quantity > 0 && quantity <= 1);
}

export interface FixOptions {
  /** egg vs eggs. */
  eggPlural: boolean;
  /** tomato vs tomatoes (before sauce/relish/paste always tomato). */
  tomatoPlural: boolean;
}

/** Applies the two known fixes to one piece of text. */
export function fixKnownNames(text: string, opts: FixOptions): string {
  const eggFixed = text.replace(EGG_PLACEHOLDER_RE, (_m, word: string) => matchCase(word, opts.eggPlural ? "eggs" : "egg"));
  return eggFixed.replace(TOMATOE_RE, (m: string, word: string, offset: number, whole: string) => {
    const after = whole.slice(offset + m.length);
    const plural = opts.tomatoPlural && !TOMATO_MODIFIER_NEXT.test(after);
    return matchCase(word, plural ? "tomatoes" : "tomato");
  });
}

/** Every `_word_` placeholder left in the text (lower-cased inner word). */
export function findPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!.toLowerCase());
}

/** `_celery_` -> `celery`, `(_milk_)` -> `(milk)`: drops the markup underscores, keeps the word. */
export function stripPlaceholderMarkup(text: string): string {
  return text.replace(PLACEHOLDER_RE, (_m, word: string) => word);
}

function pluralFor(ingredients: SanitizeIngredient[], test: RegExp, fallback: boolean): boolean {
  const lines = ingredients.filter((i) => test.test(i.name));
  if (lines.length === 0) return fallback;
  return lines.some((i) => isPluralLine(i.quantity, i.unit));
}

/**
 * Applies the known fixes to title, description, ingredient names and steps.
 * Ingredient names use that line's own quantity; steps/description use plural if any matching line is plural.
 * The title always uses the singular modifier form ("Tomato Relish", "Egg Fried Rice").
 */
export function sanitizeRecipeText<T extends SanitizeRecipeInput>(input: T): SanitizeRecipeResult<T> {
  const changes: SanitizeChange[] = [];
  const unknownPlaceholders: SanitizeRecipeResult<T>["unknownPlaceholders"] = [];
  const eggTest = /(?<![A-Za-z0-9_])_egg_(?![A-Za-z0-9_])/i;
  const tomatoTest = /\btomatoe\b/i;
  const textOpts: FixOptions = {
    eggPlural: pluralFor(input.ingredients, eggTest, true),
    tomatoPlural: pluralFor(input.ingredients, tomatoTest, true),
  };

  const apply = (field: string, text: string, opts: FixOptions): string => {
    const after = fixKnownNames(text, opts);
    if (after !== text) changes.push({ field, before: text, after });
    for (const placeholder of findPlaceholders(after)) unknownPlaceholders.push({ field, placeholder });
    return after;
  };

  const ingredients = input.ingredients.map((ing, i) => {
    const plural = isPluralLine(ing.quantity, ing.unit);
    return { ...ing, name: apply(`ingredients[${i}].name`, ing.name, { eggPlural: plural, tomatoPlural: plural }) };
  });
  const recipe = {
    ...input,
    title: apply("title", input.title, { eggPlural: false, tomatoPlural: false }),
    ...(typeof input.description === "string" ? { description: apply("description", input.description, textOpts) } : {}),
    ingredients,
    steps: input.steps.map((s, i) => apply(`steps[${i}]`, s, textOpts)),
  } as T;
  return { recipe, changes, unknownPlaceholders };
}

/** Removes every `_word_` markup from a recipe's text fields (used once a placeholder has been logged/flagged). */
export function stripRecipePlaceholders<T extends SanitizeRecipeInput>(input: T): T {
  return {
    ...input,
    title: stripPlaceholderMarkup(input.title),
    ...(typeof input.description === "string" ? { description: stripPlaceholderMarkup(input.description) } : {}),
    ingredients: input.ingredients.map((ing) => ({ ...ing, name: stripPlaceholderMarkup(ing.name) })),
    steps: input.steps.map(stripPlaceholderMarkup),
  } as T;
}

/**
 * Canonical names as shown to the draft model: drops names carrying `_word_` markup or the `tomatoe`
 * typo (`_egg_`, `_celery_`, `single cream (_milk_)`), since a clean canonical exists for each
 * (`egg`, `celery`, `single cream`, `tomato` — checked in Atlas 2026-11-09). Order is kept.
 */
export function cleanCanonicalNamesForPrompt(names: string[]): string[] {
  return names.filter((name) => findPlaceholders(name).length === 0 && !/\btomatoe\b/i.test(name));
}
