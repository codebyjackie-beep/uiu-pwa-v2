/**
 * HANDOFF_fridge.md — V1 shelf life was binary (pantry 365 d / everything else 7 d from the day it was added).
 *
 * 2026-10-25 (Jackie): receipt scans also read the purchase date, and the vision model estimates a
 * per-item shelf life (chicken ~2 d, milk ~7 d, potatoes ~21 d). When no estimate is given, fresh food
 * defaults to 5 days (was 7) and pantry items keep 365 days. The clock starts on the purchase date when
 * one is known (a receipt scanned two days after the shop), otherwise on the day the item is added.
 */
const PANTRY_SHELF_LIFE_DAYS = 365;
const DEFAULT_SHELF_LIFE_DAYS = 5;
const MAX_SHELF_LIFE_DAYS = 365;
/** A receipt older than this is more likely a misread date than a real one. */
const MAX_PURCHASE_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A whole number of days between 1 and 365, or null for anything else. */
export function clampShelfLifeDays(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const days = Math.round(n);
  return days >= 1 && days <= MAX_SHELF_LIFE_DAYS ? days : null;
}

/** "YYYY-MM-DD" (or a full ISO string) within the last 30 days and not in the future → that day at 12:00 UTC; else null. */
export function parsePurchaseDate(value: unknown, now: Date): Date | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return null;
  const todayNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  if (d.getTime() > todayNoon) return null;
  if (todayNoon - d.getTime() > MAX_PURCHASE_AGE_DAYS * DAY_MS) return null;
  return d;
}

export function estimateExpiresAt(isPantry: boolean, startedAt: Date, shelfLifeDays?: number | null): string {
  const days = shelfLifeDays ?? (isPantry ? PANTRY_SHELF_LIFE_DAYS : DEFAULT_SHELF_LIFE_DAYS);
  return new Date(startedAt.getTime() + days * DAY_MS).toISOString();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The date exactly as printed on a receipt → "YYYY-MM-DD", or null. Parsed in code so the model can't swap in the
 * time (Sainsbury's prints "13:28:12 25OCT2026"; the model once returned 2026-10-13). UK order: day before month.
 * Handles 25OCT2026, 25 Oct 2026, 25-Oct-26, 25/10/2026, 25/10/26, 25.10.26, 25-10-2026, and ISO 2026-10-25.
 */
export function parseReceiptDateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  const fmt = (y: number, mo: number, d: number) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (mo < 1 || mo > 12 || dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return fmt(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/\b(\d{1,2})[\s\-./]?([a-z]{3})[a-z]*[\s\-./,]?(\d{4}|\d{2})\b/);
  if (m && MONTHS.includes(m[2]!)) return fmt(Number(m[3]), MONTHS.indexOf(m[2]!) + 1, Number(m[1]));
  m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/);
  if (m) return fmt(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}
