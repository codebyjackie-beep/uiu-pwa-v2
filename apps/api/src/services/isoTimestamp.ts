/**
 * Normalise a stored timestamp to an ISO-8601 string, or undefined when it can't be trusted.
 *
 * `recipes.updatedAt` is stored inconsistently in Atlas: older (migrated) docs hold a BSON Date,
 * docs written by the v2 API hold an ISO string (`new Date().toISOString()`). Both normalise to
 * the same `YYYY-MM-DDTHH:mm:ss.sssZ` shape here. Anything else (missing, empty, unparseable,
 * non-date type) returns undefined so callers can omit the field instead of emitting garbage.
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}
