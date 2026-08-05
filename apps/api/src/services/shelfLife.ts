/**
 * HANDOFF_fridge.md — canonical_ingredients has no category/tag field beyond
 * is_pantry (confirmed against the audited schema in packages/shared/src/index.ts,
 * CanonicalIngredient), so V1 shelf-life estimation collapses to the binary
 * case the handoff allows: pantry items keep for a year, everything else
 * (matched non-pantry ingredient, or unmatched free-text entry) gets a week.
 */
const PANTRY_SHELF_LIFE_DAYS = 365;
const DEFAULT_SHELF_LIFE_DAYS = 7;

export function estimateExpiresAt(isPantry: boolean, addedAt: Date): string {
  const days = isPantry ? PANTRY_SHELF_LIFE_DAYS : DEFAULT_SHELF_LIFE_DAYS;
  const expires = new Date(addedAt.getTime() + days * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}
