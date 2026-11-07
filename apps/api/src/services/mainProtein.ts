/**
 * Hard "main protein" rule for the same-dish check (Jackie 2026-11-07). The model ignored the prompt rule
 * (#31 keepers eval: salmon frittata ≈ veg frittata, salmon crêpes ≈ mushroom crêpes), so code decides this part:
 * two recipes whose main-protein sets differ are never the same dish, and are not shown to the model at all.
 *
 * Proteins come from the title + ingredient names. Flavourings (stock, sauce, paste, powder…) don't count:
 * "chicken stock" in a veg soup is not a chicken soup.
 */

const FLAVOURING_RE = /\b(stock|broth|bouillon|sauce|paste|powder|seasoning|gravy|extract|cube)s?\b/;

const PROTEINS: Array<[string, RegExp]> = [
  ["chicken", /\bchicken\b/],
  ["turkey", /\bturkey\b/],
  ["beef", /\b(beef|steak|brisket|veal)\b/],
  ["pork", /\b(pork|bacon|ham|gammon|sausages?|chorizo|pancetta|prosciutto|salami|lardons?)\b/],
  ["lamb", /\b(lamb|mutton)\b/],
  ["duck", /\bduck\b/],
  ["salmon", /\bsalmon\b/],
  ["tuna", /\btuna\b/],
  ["white fish", /\b(cod|haddock|hake|basa|pollock|tilapia|sea ?bass|bream|plaice|sole|white ?fish|monkfish)\b/],
  ["oily fish", /\b(mackerel|sardines?|trout|herring|kippers?)\b/],
  ["prawn", /\b(prawns?|shrimps?)\b/],
  ["shellfish", /\b(mussels?|squid|calamari|crab|scallops?|clams?|lobster|octopus)\b/],
  ["tofu", /\b(tofu|tempeh|seitan)\b/],
  ["paneer", /\bpaneer\b/],
  ["halloumi", /\bhalloumi\b/],
];

function proteinsIn(text: string): string[] {
  const t = text.toLowerCase();
  if (FLAVOURING_RE.test(t)) return [];
  return PROTEINS.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/** Sorted, de-duplicated main-protein families of a recipe (empty = no meat / fish / tofu / paneer / halloumi). */
export function mainProteins(title: string, ingredientNames: string[]): string[] {
  const found = new Set<string>();
  // Title words are checked without the flavouring filter: "Chicken Noodle Soup" is a chicken dish.
  for (const [name, re] of PROTEINS) if (re.test(title.toLowerCase())) found.add(name);
  for (const ing of ingredientNames) for (const p of proteinsIn(ing ?? "")) found.add(p);
  return [...found].sort();
}

/**
 * False when the main proteins clearly differ: the two sets share nothing and at least one is non-empty
 * (salmon frittata vs veg frittata; chicken scones vs cheddar scones). Overlapping sets stay comparable
 * ("prawn + cod stew" vs "prawn + scallop + cod stew"), and so do two recipes with no main protein.
 * Checked on the 159 duplicates hidden 2026-11-06: 140 still reach the model; the other 19 really differ
 * in main protein (bacon vs none, turkey vs chicken, tuna vs none…).
 */
export function compatibleMainProteins(a: { title: string; ingredientNames: string[] }, b: { title: string; ingredientNames: string[] }): boolean {
  const pa = mainProteins(a.title, a.ingredientNames);
  const pb = mainProteins(b.title, b.ingredientNames);
  if (pa.length === 0 && pb.length === 0) return true;
  return pa.some((p) => pb.includes(p));
}
