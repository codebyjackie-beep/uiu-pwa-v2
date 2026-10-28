/**
 * Shopping-list add path only: turn what someone types into the names we try for an exact canonical match.
 * "alpro soya milk" → also "soya milk" → also "soy milk". Brand / store words are only removed from the
 * FRONT, and only from a short known list, so "milk" can never be reached by stripping ("alpro soya milk" must not become "milk").
 */
const LEADING_BRANDS = new Set([
  "alpro", "oatly", "tesco", "sainsburys", "sainsbury's", "asda", "morrisons", "waitrose", "ocado", "heinz", "lurpak", "anchor", "kerrygold", "isio",
]);

const SPELLING_VARIANTS: [RegExp, string][] = [[/\bsoya\b/g, "soy"]];

export function nameCandidates(text: string): string[] {
  const base = text.trim().toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const variants = (s: string) => {
    add(s);
    for (const [re, to] of SPELLING_VARIANTS) add(s.replace(re, to));
  };
  variants(base);
  const words = base.split(" ");
  const first = words[0] ?? "";
  // Only when at least two words remain: "alpro milk" must NOT become "milk" (dairy milk).
  if (words.length > 2 && LEADING_BRANDS.has(first)) variants(words.slice(1).join(" "));
  return out;
}
