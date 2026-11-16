/**
 * Kitchen tips — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/kitchenTips.test.ts
 */
import { KITCHEN_TIPS, TIPS_PER_DAY, londonDateKey, tipsForDay } from "./kitchenTips";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  } else {
    console.log(`ok   ${name}`);
  }
}

// Pool content rules
check("pool has 60-100 tips", KITCHEN_TIPS.length >= 60 && KITCHEN_TIPS.length <= 100, KITCHEN_TIPS.length);
check("ids are unique", new Set(KITCHEN_TIPS.map((t) => t.id)).size === KITCHEN_TIPS.length);
check("texts are unique", new Set(KITCHEN_TIPS.map((t) => t.text)).size === KITCHEN_TIPS.length);
check("no prices in tips", KITCHEN_TIPS.every((t) => !t.text.includes("£")), KITCHEN_TIPS.filter((t) => t.text.includes("£")));
const tooLong = KITCHEN_TIPS.filter((t) => t.text.length > 160);
check("tips fit the card (<= 160 chars)", tooLong.length === 0, tooLong);

// Daily pick
const day = tipsForDay("2026-11-16");
check("three tips a day", day.length === TIPS_PER_DAY);
check("three different tips", new Set(day.map((t) => t.id)).size === TIPS_PER_DAY);
check("same date gives the same tips", JSON.stringify(tipsForDay("2026-11-16")) === JSON.stringify(day));
check("next day gives different tips", tipsForDay("2026-11-17").every((t) => !day.some((x) => x.id === t.id)));

// No repeats inside one cycle; every day over a year is a valid pick.
const daysPerCycle = Math.floor(KITCHEN_TIPS.length / TIPS_PER_DAY);
let badDays = 0;
let cycleRepeats = 0;
const start = Date.UTC(2026, 0, 1) / 86_400_000;
const seenByCycle = new Map<number, Set<number>>();
for (let i = 0; i < 366; i += 1) {
  const n = start + i;
  const key = new Date(n * 86_400_000).toISOString().slice(0, 10);
  const picks = tipsForDay(key);
  if (picks.length !== TIPS_PER_DAY || new Set(picks.map((t) => t.id)).size !== TIPS_PER_DAY) badDays += 1;
  const cycle = Math.floor(n / daysPerCycle);
  const seen = seenByCycle.get(cycle) ?? new Set<number>();
  for (const p of picks) {
    if (seen.has(p.id)) cycleRepeats += 1;
    seen.add(p.id);
  }
  seenByCycle.set(cycle, seen);
}
check("every day of a year has three distinct tips", badDays === 0, badDays);
check("no tip repeats within a cycle", cycleRepeats === 0, cycleRepeats);

// Small pools
check("empty pool gives nothing", tipsForDay("2026-11-16", []).length === 0);
check("pool of two gives two", tipsForDay("2026-11-16", KITCHEN_TIPS.slice(0, 2)).length === 2);

// UK date: 23:30 UTC on 30 June is already 1 July in London (BST); in winter it is still the same day.
check("londonDateKey uses UK summer time", londonDateKey(new Date("2026-06-30T23:30:00Z")) === "2026-07-01");
check("londonDateKey uses UK winter time", londonDateKey(new Date("2026-11-16T23:30:00Z")) === "2026-11-16");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all kitchen tip checks passed");
