/**
 * normalizeName() — ported line-for-line from assets/name_normalizer.js
 * (which was itself extracted from the old repo's rescue_shared.service.js).
 *
 * This is the canonical resolver's key normalizer: index build + lookup both
 * go through it. Changing it changes coverage. Do not "improve" it here —
 * verify any change via `node tools/parity_replay.js` (must stay 1278/1791 = 71.36%).
 */

const KNOWN_PREFIXES = ["freshly cracked ", "julienne young ", "organic extract of "];
const KNOWN_SUFFIXES = [" confit"];

const SINGULARIZE_EXCEPTIONS = new Set([
  "cheese", "molasses", "couscous", "hummus", "asparagus", "citrus", "grease",
]);

function singularizeLastWord(name: string): string {
  const words = name.split(" ");
  const last = words[words.length - 1]!;
  if (SINGULARIZE_EXCEPTIONS.has(last) || last.length < 4 || last.endsWith("ss")) {
    return name;
  }
  let singular = last;
  if (last.endsWith("ies")) singular = `${last.slice(0, -3)}y`;
  else if (last.endsWith("es")) singular = last.slice(0, -2);
  else if (last.endsWith("s")) singular = last.slice(0, -1);
  words[words.length - 1] = singular;
  return words.join(" ");
}

export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim().replace(/\s+/g, " ");
  const commaIdx = s.indexOf(",");
  if (commaIdx !== -1) s = s.slice(0, commaIdx).trim();
  s = s.replace(/\([^)]*\)?/g, "").trim().replace(/\s+/g, " ");
  for (const prefix of KNOWN_PREFIXES) {
    if (s.startsWith(prefix)) { s = s.slice(prefix.length).trim(); break; }
  }
  for (const suffix of KNOWN_SUFFIXES) {
    if (s.endsWith(suffix)) { s = s.slice(0, -suffix.length).trim(); break; }
  }
  s = singularizeLastWord(s);
  return s;
}
