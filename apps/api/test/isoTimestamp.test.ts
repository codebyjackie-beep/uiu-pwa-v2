/**
 * Pure tests for services/isoTimestamp.ts (recipes.updatedAt → list item `updatedAt`). Run with:
 *   npx tsx apps/api/test/isoTimestamp.test.ts
 */
import { toIsoTimestamp } from "../src/services/isoTimestamp";

let failures = 0;
let passes = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  } else {
    passes++;
  }
}

// Older migrated docs: BSON Date.
eq("Date → ISO", toIsoTimestamp(new Date("2026-07-22T20:56:13.925Z")), "2026-07-22T20:56:13.925Z");
// v2-written docs: ISO string (round-trips unchanged).
eq("ISO string → same", toIsoTimestamp("2026-11-25T07:02:06.704Z"), "2026-11-25T07:02:06.704Z");
// Non-canonical but parseable string is normalised to the canonical form.
eq("offset string → UTC ISO", toIsoTimestamp("2026-11-25T08:02:06.704+01:00"), "2026-11-25T07:02:06.704Z");
eq("date-only string → ISO", toIsoTimestamp("2026-11-25"), "2026-11-25T00:00:00.000Z");

// Anything untrustworthy → undefined (caller omits the field).
eq("undefined", toIsoTimestamp(undefined), undefined);
eq("null", toIsoTimestamp(null), undefined);
eq("empty string", toIsoTimestamp(""), undefined);
eq("whitespace string", toIsoTimestamp("   "), undefined);
eq("garbage string", toIsoTimestamp("not a date"), undefined);
eq("invalid Date", toIsoTimestamp(new Date("nope")), undefined);
eq("number (not accepted)", toIsoTimestamp(1764054126704), undefined);
eq("object", toIsoTimestamp({ $date: "2026-11-25T07:02:06.704Z" }), undefined);
eq("boolean", toIsoTimestamp(true), undefined);

console.log(`isoTimestamp: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
