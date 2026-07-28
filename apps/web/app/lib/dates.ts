/** Minimal date helpers for the meal planner's weekly grid — no external date lib needed. */

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Monday (ISO start-of-week) of the week containing `key` (or today when omitted). */
export function mondayOf(key?: string): Date {
  const base = key ? parseDateKey(key) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const dow = base.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(base.getTime() + diff * DAY_MS);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function weekDates(mondayKey: string): string[] {
  const monday = parseDateKey(mondayKey);
  return Array.from({ length: 7 }, (_, i) => toDateKey(addDays(monday, i)));
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayLabel(dateKey: string, index: number): string {
  const d = parseDateKey(dateKey);
  return `${WEEKDAY_LABELS[index]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}
