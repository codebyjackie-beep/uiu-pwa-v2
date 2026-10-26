/**
 * Post-scan filters for receipt OCR results. The vision model still lets through
 * discount lines (Costco "IRC ..." rebates, Nectar / Lidl Plus savings) and the
 * odd laundry or cleaning product, so the route drops those before the client sees them.
 * Pure string logic, no imports, so it runs under node --experimental-strip-types.
 */

/** Phrases that mark a discount/coupon line rather than a product (matched case-insensitively, as whole phrases). */
const DISCOUNT_PHRASES = [
  "price saving",
  "price cut",
  "lidl plus",
  "% off",
  "discount",
  "coupon",
  "voucher",
  "multibuy saving",
  "clubcard price",
];

/** Household, laundry and cleaning brands or words. None of these are food. Brands that are also food words
 * (Bold, Surf, Comfort, Finish, Flash, Method, Plenty, Nectar juice) are left to the prompt, not this list. */
const NON_FOOD_WORDS = [
  "fairy",
  "persil",
  "ariel",
  "lenor",
  "daz",
  "domestos",
  "dettol",
  "cif",
  "harpic",
  "zoflora",
  "ecover",
  "toilet roll",
  "toilet tissue",
  "kitchen roll",
  "bin bag",
  "bin bags",
  "washing up",
  "laundry",
  "detergent",
  "fabric softener",
  "bleach",
  "dishwasher tablets",
  "dishwasher",
  "andrex",
  "kleenex",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-phrase match: the phrase must not sit inside a longer run of letters. */
function containsWholePhrase(name: string, phrases: string[]): boolean {
  const pattern = new RegExp(`(?<![a-z])(?:${phrases.map(escapeRegex).join("|")})(?![a-z])`, "i");
  return pattern.test(name);
}

/** True for discount, coupon and saving lines (e.g. Costco "IRC ...", "Nectar Price Saving", "Price Cut"). */
export function isDiscountLine(name: string): boolean {
  const trimmed = name.trim();
  if (/^irc\s/i.test(trimmed)) return true;
  return containsWholePhrase(trimmed, DISCOUNT_PHRASES);
}

/** True for household, laundry and cleaning products. */
export function isNonFood(name: string): boolean {
  return containsWholePhrase(name.trim(), NON_FOOD_WORDS);
}

/** Drops discount lines and non-food items from a scanned receipt list. */
export function filterReceiptItems<T extends { name: string }>(items: T[]): T[] {
  return items.filter((item) => !isDiscountLine(item.name) && !isNonFood(item.name));
}
