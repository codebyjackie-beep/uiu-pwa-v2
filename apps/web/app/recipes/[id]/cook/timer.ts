/**
 * cc_prompt_recipe-list-redesign-and-cook-mode.md Part C §2 — auto-detect a cook timer
 * from a step's free text. Pure, no DOM/browser deps, so it's unit-testable standalone.
 *
 * Strategy:
 * 1. A range ("10-15 minutes" / "10 to 15 minutes") takes the SMALLER number — Jackie's
 *    explicit rule — and must be checked before the generic per-unit scan below, because
 *    that scan would otherwise only see "15 minutes" (the "10-" has no unit attached).
 * 2. Otherwise, sum consecutive "<number> <unit>" matches that sit close together (e.g.
 *    "2 hrs 30 mins") into one duration. A gap bigger than GAP_CHARS between matches is
 *    treated as an unrelated second time phrase in the same sentence, so only the first
 *    phrase is used — one suggested timer per step, not every time mentioned in it.
 */

const UNIT_PATTERN = "hours?|hrs?|minutes?|mins?|seconds?|secs?";
const RANGE_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "i");
const UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "gi");

/** Max characters allowed between two unit matches for them to count as one combined
 * duration (e.g. "2 hrs 30 mins" — the gap is just the space). */
const GAP_CHARS = 8;

function unitToSeconds(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return value * 3600;
  if (u.startsWith("m")) return value * 60;
  return value;
}

/** Returns whole seconds, or null when no time phrase is found. */
export function extractTimerSeconds(text: string): number | null {
  const range = text.match(RANGE_RE);
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    const smaller = Math.min(a, b);
    return unitToSeconds(smaller, range[3]);
  }

  const matches = [...text.matchAll(UNIT_RE)];
  if (matches.length === 0) return null;

  let total = 0;
  let lastEnd: number | null = null;
  for (const m of matches) {
    const start = m.index ?? 0;
    if (lastEnd !== null && start - lastEnd > GAP_CHARS) break;
    total += unitToSeconds(parseFloat(m[1]), m[2]);
    lastEnd = start + m[0].length;
  }
  return total > 0 ? total : null;
}

export function formatMmSs(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
