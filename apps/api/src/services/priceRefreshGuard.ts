/**
 * Guarded price refresh — pure logic (no fs / no mongodb / no fetch).
 *
 * Ported VERBATIM from apps/api/scripts/price_refresh.cjs (guard rules 1–33, reviewed by cloud over 5 rounds,
 * 2026-10-13 .. 2026-10-16). The script and the Worker job (jobs/priceRefresh.ts) both consume THIS module, so there
 * is exactly one copy of the logic. Do not "improve" anything here without a cloud review; the offline parity test
 * (scripts/price_refresh_parity.cjs) must stay 600/600 identical.
 *
 * Baseline = old computePerUnit() (reference numbers, kept bit-for-bit). Guarded = new rules. decideAction() = Guard 6.
 */

// ------------------------------------------------------------------------------------------------
// shared helpers / types
// ------------------------------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
export type RawListing = { store?: string; title?: string; price?: any };
export type Pack = { qty: number; unit: "g_or_ml" | "each" };
export type PerUnit = { value: number; unit: "g_or_ml" | "each"; n: number } | null;
export type CurSnapshot = {
  metric: { value: number; n: number } | null;
  count: { value: number; n: number } | null;
  cheapest: { store: string; price: number; title: string } | null;
  n_supermarkets: number | null;
  confidence: string | null;
  fetched_at: string | null;
};

export const r4 = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * 1e4) / 1e4);
export const r5 = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * 1e5) / 1e5);
export const r6 = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * 1e6) / 1e6);
export const countBy = <T>(arr: T[], f: (x: T) => unknown): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const x of arr) {
    const k = String(f(x));
    m[k] = (m[k] || 0) + 1;
  }
  return m;
};

// ------------------------------------------------------------------------------------------------
// BASELINE — old logic, verbatim from serper_price.service.js. It is the reference the guarded numbers are compared with.
// ------------------------------------------------------------------------------------------------
export const UK_SUPERMARKETS = ["tesco", "sainsbury", "asda", "morrisons", "waitrose", "ocado", "iceland", "co-op", "coop", "aldi", "lidl"];
export const MARKETPLACE_BLOCKLIST = ["amazon", "ebay"];
const WEIGHT_VOLUME_RE = /(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i;
const MULTIPACK_RE = /(\d+)\s?(?:pack|x|×)\b/i;
const EACH_RE = /\beach\b/i;
const UNIT_TO_GRAMS_OR_ML: Record<string, number> = { g: 1, ml: 1, kg: 1000, l: 1000, cl: 10 };

export function cleanPrice(raw: any): number | null {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(num) ? num : null;
}
export function isUkSupermarket(source: string | undefined | null): boolean {
  const s = (source || "").toLowerCase();
  if (MARKETPLACE_BLOCKLIST.some((m) => s.includes(m))) return false;
  return UK_SUPERMARKETS.some((m) => s.includes(m));
}
function parsePackFromTitle(title: string | undefined): Pack | null {
  if (!title) return null;
  const wv = title.match(WEIGHT_VOLUME_RE);
  if (wv) {
    const qty = parseFloat(wv[1]!) * UNIT_TO_GRAMS_OR_ML[wv[2]!.toLowerCase()]!;
    const multi = title.match(MULTIPACK_RE);
    return { qty: multi ? qty * parseInt(multi[1]!, 10) : qty, unit: "g_or_ml" };
  }
  const multi = title.match(MULTIPACK_RE);
  if (multi) return { qty: parseInt(multi[1]!, 10), unit: "each" };
  if (EACH_RE.test(title)) return { qty: 1, unit: "each" };
  return null;
}
function trimOutliers(values: number[]): number[] {
  if (values.length < 5) return values;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.slice(1, -1);
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
/** Old computePerUnit(). */
export function computeBaseline(rawListings: RawListing[], referencePack: Pack | null = null): any {
  const listings = rawListings
    .map((s) => {
      const price = cleanPrice(s.price);
      const titlePack = parsePackFromTitle(s.title);
      const pack = titlePack || referencePack || null;
      const sourcePack = titlePack ? "title" : referencePack ? "reference" : "unknown";
      const perUnit = price != null && pack ? price / pack.qty : null;
      return { store: s.store, title: s.title, price, pack, source_of_pack: sourcePack, per_unit: perUnit != null ? Math.round(perUnit * 10000) / 10000 : null };
    })
    .filter((l) => l.price != null) as any[];
  const cheapest = listings.length ? listings.reduce((min: any, l: any) => (l.price < min.price ? l : min)) : null;
  const metricValues = listings.filter((l) => l.per_unit != null && l.pack?.unit === "g_or_ml").map((l) => l.per_unit as number);
  const countValues = listings.filter((l) => l.per_unit != null && l.pack?.unit === "each").map((l) => l.per_unit as number);
  const perUnitMetric = median(trimOutliers(metricValues));
  const perUnitCount = median(trimOutliers(countValues));
  const hasAnyPerUnit = perUnitMetric != null || perUnitCount != null;
  let confidence = "none";
  if (listings.length >= 3 && hasAnyPerUnit) confidence = "high";
  else if (listings.length >= 1 && hasAnyPerUnit) confidence = "low";
  else if (listings.length >= 1) confidence = "price_only";
  return {
    per_unit_metric: perUnitMetric != null ? { value: perUnitMetric, unit: "g_or_ml", n: metricValues.length } : null,
    per_unit_count: perUnitCount != null ? { value: perUnitCount, unit: "each", n: countValues.length } : null,
    cheapest: cheapest ? { store: cheapest.store, price: cheapest.price, title: cheapest.title } : null,
    n_supermarkets: listings.length,
    listings,
    confidence,
  };
}

// ------------------------------------------------------------------------------------------------
// GUARDED — Guard 3 (title match), rule 10 / 16 / 22 exemptions
// ------------------------------------------------------------------------------------------------
const EXCLUDE_WORDS: Array<[string, RegExp]> = [
  ["seed", /\bseeds?\b/i], ["plant", /\bplants?\b(?![\s-]*based)/i], ["grow", /\bgrow\b/i], ["kit", /\bkit\b/i],
  ["supplement", /\bsupplements?\b/i], ["capsule", /\bcapsules?\b/i], ["tablet", /\btablets?\b/i], ["powder", /\bpowder\b/i],
  ["pet", /\bpets?\b/i], ["dog", /\bdogs?\b/i], ["cat", /\bcats?\b/i], ["candle", /\bcandles?\b/i], ["gift", /\bgifts?\b/i], ["hamper", /\bhampers?\b/i],
];
export function stem(w: string): string {
  w = w.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|s|z|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
const TOKEN_STOP = new Set(["of", "and", "or", "with", "the", "in", "a", "an", "for", "to", "fresh", "raw", "hot", "cold", "whole", "dried", "dry", "large", "small", "medium", "extra", "plain", "free", "range", "organic", "low", "fat", "reduced", "light", "style", "piece", "pieces", "cut", "sliced", "diced", "chopped", "minced", "peeled", "boneless", "skinless", "lean", "cooked", "canned", "tinned", "frozen", "unsalted", "salted", "sweet", "red", "green", "white", "black", "brown", "yellow", "mixed", "natural"]);
// UK/US and spelling variants a supermarket title may use instead of the canonical word
const TOKEN_SYNONYMS: Record<string, string[]> = {
  shrimp: ["prawn"], shrimps: ["prawn"], prawn: ["shrimp"], prawns: ["shrimp"], chickpea: ["chick pea", "chick-pea", "chana"], chickpeas: ["chick pea", "chick-pea", "chana"],
  aubergine: ["eggplant"], eggplant: ["aubergine"], courgette: ["zucchini"], zucchini: ["courgette"], coriander: ["cilantro"], cilantro: ["coriander"],
  arugula: ["rocket"], rocket: ["arugula"], scallion: ["spring onion"], scallions: ["spring onion"], ground: ["mince"], mince: ["ground"], cornstarch: ["cornflour"], cornflour: ["cornstarch"],
};
const normChilli = (s: string): string => s.replace(/\bchill?(?:ies|ie|i|y|es|e)\b/g, "chilli");
function tokenStems(phrase: unknown): Set<string> {
  const out = new Set<string>();
  if (!phrase) return out;
  const cleaned = normChilli(String(phrase).toLowerCase()).replace(/[(),]/g, " ");
  for (const t of cleaned.split(/[^a-zà-ÿ]+/)) {
    if (!t || t.length < 3 || TOKEN_STOP.has(t)) continue;
    out.add(stem(t));
    for (const syn of TOKEN_SYNONYMS[t] || []) out.add(stem(syn).replace(/s$/, ""));
  }
  return out;
}
// Spices that are only ever sold as powder: a "powder" listing is the right product (cloud rule 10).
const POWDER_SPICE_RE = /\b(turmeric|paprika|cayenne|garam masala|five[- ]spice|mixed spice|allspice|curry)\b/i;

// Rule 16 (cloud 10-15): processed / different-form listings are not the plain ingredient. Guarded only.
const PROCESSED_FORM: Array<[string, RegExp, string?]> = [
  ["battered", /\bbattered\b/i], ["breaded", /\bbreaded\b/i], ["dusted", /\bdusted\b/i], ["chip shop", /\bchip shop\b/i],
  ["in butter", /\bin (?:a )?butter\b/i, "protein"], ["butter", /\bbutter\b/i, "protein"],
  ["in sauce", /\bin (?:\w+ )?sauce\b/i], ["with sauce", /\bwith (?:\w+ )?sauce\b/i], ["marinated", /\bmarinated\b/i],
  ["garlic & herb", /\bgarlic\s?(?:&|and)\s?herbs?\b/i, "protein"], ["in juice", /\bin (?:\w+ )?juice\b/i, "fruit"], ["in syrup", /\bin (?:\w+ )?syrup\b/i, "fruit"], // fruit-only: canned tomatoes in tomato juice stay valid
  ["chunks", /\bchunks?\b/i, "fruit"],
  // rule 22 (cloud 10-15 night): dried herbs / pulses are the normal product; air-dried = cured meat; smoked bacon/ham/sausage/paprika
  ["dried", /(?<!air[- ])\bdried\b/i, "dried_applies"], ["smoked", /\bsmoked\b/i, "smoked_applies"],
];
// rule 22: labels whose scope was relaxed in this revision (used only to count rescued listings)
const RULE22_RELAXED = new Set(["dried", "smoked", "garlic & herb", "in butter"]);
const HERB_NAME_RE = /\b(rosemary|oregano|parsley|sage|mint|coriander|thyme|basil|dill|bay (?:leaf|leaves)|curry leaves?|kaffir)\b/i;
const PULSE_NAME_RE = /\b(lentils?|beans?|pulses?|peas?|chick ?peas?)\b/i;
const SMOKED_OK_NAME_RE = /\b(bacon|pancetta|ham|sausages?|paprika)\b/i;
// no `category` field exists on canonical_ingredients, so "seafood / meat / fish" and "fruit" are name keyword lists
export const PROTEIN_NAME_RE = /\b(prawns?|shrimps?|fish|cod|haddock|salmon|tuna|trout|mackerel|sea ?bass|bream|tilapia|pollock|plaice|crab|lobster|scallops?|mussels?|squid|calamari|oysters?|clams?|seafood|steaks?|chicken|beef|pork|lamb|turkey|duck|bacon|ham|sausages?|mince|fillets?|brisket|ribs?|gammon|veal|venison|cutlets?|chops?)\b/i;
export const FRUIT_NAME_RE = /\b(mango(?:es)?|pineapples?|peach(?:es)?|pears?|apples?|melons?|papayas?|apricots?|cherr(?:y|ies)|oranges?|bananas?|coconuts?|grapefruits?|plums?|kiwis?|lychees?|figs?|guavas?|fruits?|berr(?:y|ies)|grapes?|lemons?|limes?|mandarins?|clementines?|nectarines?|passion ?fruit|pomegranates?)\b/i;
function pfApplies(scope: string | undefined, nameLower: string): boolean {
  if (!scope) return true;
  if (scope === "protein") return PROTEIN_NAME_RE.test(nameLower);
  if (scope === "fruit") return FRUIT_NAME_RE.test(nameLower);
  if (scope === "dried_applies") return !((HERB_NAME_RE.test(nameLower) && !/\bfresh\b/.test(nameLower)) || PULSE_NAME_RE.test(nameLower));
  if (scope === "smoked_applies") return !SMOKED_OK_NAME_RE.test(nameLower);
  return true;
}

export type MatchResult =
  | { ok: true; rescued: string[]; pfRescued: string[]; rule22Rescued: string[] }
  | { ok: false; reason: string };

// Guard 3 is deliberately lenient: ANY content token of canonical_name / query_alias / aliases may appear in the title
// (it exists to drop non-food and wrong-category listings, not to demand an exact product name).
export function makeTitleMatcher(canon: any, priceDoc?: any): (title: string | undefined) => MatchResult {
  const name = canon?.canonical_name ?? priceDoc?.canonical_name;
  const aliasList: string[] = Array.isArray(canon?.aliases) ? canon.aliases.filter((x: unknown) => typeof x === "string") : [];
  const phrases = [name, canon?.query_alias, ...aliasList].filter((x) => typeof x === "string");
  const tokens = new Set<string>();
  for (const p of phrases) for (const h of tokenStems(p)) tokens.add(h);
  const nameLower = String(name || "").toLowerCase();
  const aliasLower = aliasList.join(" | ").toLowerCase();
  const nameAliasLower = `${nameLower} | ${aliasLower}`;
  const isGround = /^ground\b/.test(nameLower);
  const wordIn = (label: string, s: string) => new RegExp(`\\b${label}`, "i").test(s);
  // pre-rule-10 behaviour: only the canonical name itself exempts the word
  const oldExempt = (label: string) => wordIn(label, nameLower);
  // rule 10: canonical name OR an alias exempts it; `powder` also exempt for ground X / powder-only spices;
  // `seed` is NOT exempted by an alias on `ground X` (seeds and ground spice are different products).
  const newExempt = (label: string) => {
    if (oldExempt(label)) return true;
    if (label === "powder" && (isGround || POWDER_SPICE_RE.test(nameLower))) return true;
    if (wordIn(label, aliasLower)) return !(label === "seed" && isGround);
    return false;
  };
  return (title) => {
    const t = String(title || "").toLowerCase();
    const rescued: string[] = [];
    for (const [label, re] of EXCLUDE_WORDS) {
      if (!re.test(t)) continue;
      if (!newExempt(label)) return { ok: false, reason: `excluded_word:${label}` };
      if (!oldExempt(label)) rescued.push(label);
    }
    // cloud rule 16: processed / different-form products. A phrase is exempt when the canonical name or an alias itself contains it.
    const pfRescued: string[] = [];
    const rule22Rescued: string[] = [];
    for (const [label, re, scope] of PROCESSED_FORM) {
      if (!re.test(t)) continue;
      if (!pfApplies(scope, nameLower)) {
        if (RULE22_RELAXED.has(label)) rule22Rescued.push(label);
        continue;
      }
      if (re.test(nameAliasLower)) {
        pfRescued.push(label);
        continue;
      }
      return { ok: false, reason: `processed_form:${label}` };
    }
    if (!tokens.size) return { ok: true, rescued, pfRescued, rule22Rescued };
    const tStems = [...tokenStems(normChilli(t))];
    const hit = [...tokens].some((tok) => tStems.some((ts) => ts === tok || (ts.length >= 4 && tok.length >= 4 && (ts.startsWith(tok) || tok.startsWith(ts)))));
    return hit ? { ok: true, rescued, pfRescued, rule22Rescued } : { ok: false, reason: "title_no_match" };
  };
}

// Does the title contain every content word of the full canonical name? (rule 11 audit of the lenient Guard 3)
export function titleHasFullName(title: string | undefined, name: string | undefined): boolean {
  const words = String(name || "").toLowerCase().split(/[^a-zà-ÿ]+/).filter((w) => w.length >= 2 && !["of", "and", "or", "with", "the", "in", "a"].includes(w)).map(stem);
  const tStems = new Set(String(title || "").toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean).map(stem));
  return words.length > 0 && words.every((w) => tStems.has(w));
}

// ------------------------------------------------------------------------------------------------
// Pack parse fixes (cloud decision point 4). Only used by `guarded`; baseline keeps the old regexes.
// ------------------------------------------------------------------------------------------------
function parsePackGuarded(title: string | undefined, referencePack: Pack | null): any {
  const flags: string[] = [];
  const t = String(title || "");
  const nxm = t.match(/(\d+)\s?[x×]\s?(\d+(?:\.\d+)?)\s?(kg|g|l|ml|cl)\b/i);
  if (nxm) {
    const qty = parseInt(nxm[1]!, 10) * parseFloat(nxm[2]!) * UNIT_TO_GRAMS_OR_ML[nxm[3]!.toLowerCase()]!;
    flags.push("nxm_multiplied");
    return { pack: { qty, unit: "g_or_ml" }, source: "title", flags };
  }
  const wv = t.match(WEIGHT_VOLUME_RE);
  if (wv) {
    const single = parseFloat(wv[1]!) * UNIT_TO_GRAMS_OR_ML[wv[2]!.toLowerCase()]!;
    const np = t.match(/\b(\d+)\s?pack\b/i);
    const po = t.match(/\bpack of (\d+)\b/i);
    const n = np ? parseInt(np[1]!, 10) : po ? parseInt(po[1]!, 10) : null;
    if (n && n > 1) {
      flags.push("ambiguous_pack");
      return { pack: null, source: "title", flags, ambiguous: { n, weight: single, asTotal: { qty: single, unit: "g_or_ml" }, asEach: { qty: single * n, unit: "g_or_ml" } } };
    }
    const multi = t.match(MULTIPACK_RE); // "2x ... 400g" / "4 x" (old behaviour, kept)
    return { pack: { qty: multi ? single * parseInt(multi[1]!, 10) : single, unit: "g_or_ml" }, source: "title", flags };
  }
  const po = t.match(/\bpack of (\d+)\b/i);
  if (po) {
    flags.push("pack_of_n_each");
    return { pack: { qty: parseInt(po[1]!, 10), unit: "each" }, source: "title", flags };
  }
  const multi = t.match(MULTIPACK_RE);
  if (multi) return { pack: { qty: parseInt(multi[1]!, 10), unit: "each" }, source: "title", flags };
  if (EACH_RE.test(t)) return { pack: { qty: 1, unit: "each" }, source: "title", flags };
  if (referencePack) return { pack: referencePack, source: "reference", flags };
  return { pack: null, source: "unknown", flags };
}

/** Guard 5 predicate (also used by the shopping-list price comparison): a per-unit value more than 3x, or less than 1/3, of its dimension's median. */
export const isOutlier3x = (perUnit: number, med: number): boolean => perUnit > med * 3 || perUnit < med / 3;

export type AmbiguousMode = "exclude" | "total" | "each";
export type GuardCtx = { matcher: (title: string | undefined) => MatchResult; referencePack: Pack | null };

/** One guarded evaluation (Guards 2/3, pack-parse fixes, Guard 5 outlier). */
export function computeGuarded(rawListings: RawListing[], ctx: GuardCtx, ambiguousMode: AmbiguousMode): any {
  const rows: any[] = rawListings.map((s) => {
    const price = cleanPrice(s.price);
    const row: any = { store: s.store, title: s.title, price, status: "kept", reason: null, flags: [], pack: null, source_of_pack: "unknown", per_unit: null };
    if (price == null) { row.status = "dropped"; row.reason = "no_price"; return row; }
    const m = ctx.matcher(s.title);
    if (!m.ok) { row.status = "dropped"; row.reason = m.reason; return row; }
    if (m.rescued && m.rescued.length) row.rule10Rescued = m.rescued;
    if (m.pfRescued && m.pfRescued.length) row.processedFormExempt = m.pfRescued;
    if (m.rule22Rescued && m.rule22Rescued.length) row.rule22Rescued = m.rule22Rescued;
    const p = parsePackGuarded(s.title, ctx.referencePack);
    row.flags = p.flags;
    row.source_of_pack = p.source;
    if (p.ambiguous) {
      row.ambiguous = p.ambiguous;
      if (ambiguousMode === "exclude") { row.status = "ambiguous"; row.reason = "ambiguous_pack"; return row; }
      row.pack = ambiguousMode === "total" ? p.ambiguous.asTotal : p.ambiguous.asEach;
    } else row.pack = p.pack;
    if (row.pack && price != null) row.per_unit = r4(price / row.pack.qty);
    return row;
  });
  // Guard 5 — doc-level outlier: per dimension, drop values >3x or <1/3 of the median, then re-median.
  const dims: Record<string, any> = {};
  for (const unit of ["g_or_ml", "each"]) {
    const cands = rows.filter((r) => r.status === "kept" && r.per_unit != null && r.per_unit > 0 && r.pack?.unit === unit);
    if (!cands.length) continue;
    const med = median(cands.map((r) => r.per_unit))!;
    const kept: any[] = [];
    for (const r of cands) {
      if (isOutlier3x(r.per_unit, med)) { r.status = "dropped"; r.reason = `outlier_3x(median ${r5(med)})`; } else kept.push(r);
    }
    dims[unit] = { n: kept.length, medianBefore: med, value: median(kept.map((r) => r.per_unit)), droppedOutliers: cands.length - kept.length };
  }
  const priced = rows.filter((r) => (r.status === "kept" || r.status === "ambiguous") && r.price != null); // passed Guard 3, not an outlier
  const cheapestRow = priced.length ? priced.reduce((m, r) => (r.price < m.price ? r : m)) : null;
  const metric = dims.g_or_ml ? { value: dims.g_or_ml.value, unit: "g_or_ml", n: dims.g_or_ml.n } : null;
  const countD = dims.each ? { value: dims.each.value, unit: "each", n: dims.each.n } : null;
  const nValidAny = rows.filter((r) => r.status === "kept" && r.per_unit != null).length;
  let confidence = "none";
  if (nValidAny >= 3) confidence = "high";
  else if (nValidAny >= 1) confidence = "low";
  else if (priced.length) confidence = "price_only";
  return {
    rows,
    per_unit_metric: metric && metric.n >= 1 ? metric : null,
    per_unit_count: countD && countD.n >= 1 ? countD : null,
    cheapest: cheapestRow ? { store: cheapestRow.store, price: cheapestRow.price, title: cheapestRow.title } : null,
    n_supermarkets: rows.filter((r) => r.status === "kept" || r.status === "ambiguous").length,
    confidence,
    dims,
  };
}

// ------------------------------------------------------------------------------------------------
// Guard 6 — new vs current
// ------------------------------------------------------------------------------------------------
// rule 21 (cloud 10-15 night): food inflation is ~1.7%/yr, so a >1.3x rise is almost surely a listing-mix change, not a real price rise. Rises only; falls stay.
export const RISE_CAP = 1.3;
// hold_drop (cloud decision 40, 2026-10-16): a doc a previous refresh already wrote (`refreshBatch` set) holds a freshly reviewed price,
// so a drop of more than 1 - 1/1.3 (= 23%) within one cycle is almost surely a Serper listing-mix change — symmetric with RISE_CAP.
// Docs that still hold their original (July) value are NOT subject to it: they may really need a correction.
export const DROP_FLOOR = 1 / RISE_CAP;
export type Decision = { action: string; reason: string; fields: string[]; detail?: any; supported?: string[]; ratios?: Record<string, number> };
/** @param refreshed - the live doc already carries a `refreshBatch` (written by an earlier refresh run). Default false = old behaviour. */
export function decideAction(cur: { per_unit_metric: any; per_unit_count: any }, g: any, rawCount: number, refreshed = false): Decision {
  if (rawCount === 0) return { action: "keep_old", reason: "no_whitelisted_listings_after_retry", fields: [] };
  const nM = g.per_unit_metric?.n || 0;
  const nC = g.per_unit_count?.n || 0;
  if (Math.max(nM, nC) < 2) {
    const dropped = countBy(g.rows.filter((r: any) => r.status !== "kept"), (r: any) => String(r.reason).replace(/\(.*$/, "").replace(/^excluded_word:.*$/, "excluded_word"));
    const nPer = g.rows.filter((r: any) => r.status === "kept" && r.per_unit == null).length;
    return { action: "hold_low_n", reason: Math.max(nM, nC) === 0 ? "no_valid_listing_after_guards" : "only_1_valid_listing", detail: { rawListings: rawCount, kept_without_pack: nPer, dropped }, fields: [] };
  }
  const supported: string[] = [];
  if (nM >= 2) supported.push("per_unit_metric");
  if (nC >= 2) supported.push("per_unit_count");
  const curDims = ["per_unit_metric", "per_unit_count"].filter((k) => (cur as any)[k] && (cur as any)[k].value != null);
  if (curDims.length && !curDims.some((d) => supported.includes(d))) return { action: "hold", reason: "dimension_lost", fields: [], supported };
  const ratios: Record<string, number> = {};
  let breach: string | null = null;
  for (const d of supported) {
    const c = (cur as any)[d];
    if (!c || !(c.value > 0)) continue;
    const r = g[d].value / c.value;
    ratios[d] = Math.round(r * 1000) / 1000;
    if (r > 3 || r < 1 / 3) breach = d;
  }
  if (breach) return { action: "hold", reason: `ratio_out_of_range:${breach}=${ratios[breach]}`, fields: [], supported, ratios };
  const rise = supported.filter((d) => (ratios[d] ?? 0) > RISE_CAP);
  if (rise.length) return { action: "hold_rise", reason: `rise_over_${RISE_CAP}x:${rise.map((d) => `${d}=${ratios[d]}`).join(",")}`, fields: [], supported, ratios };
  if (refreshed) {
    const drop = supported.filter((d) => ratios[d] != null && (ratios[d] as number) < DROP_FLOOR);
    if (drop.length) return { action: "hold_drop", reason: `drop_under_${r4(DROP_FLOOR)}x_of_refreshed:${drop.map((d) => `${d}=${ratios[d]}`).join(",")}`, fields: [], supported, ratios };
  }
  return { action: "update", reason: "ok", fields: supported, supported, ratios };
}

/**
 * Per-doc evaluation = guarded (ambiguous excluded) + rule-"ambiguous_pack" fallback (when nothing valid remains and ambiguous
 * listings exist, evaluate both readings and keep the one closer to the current value) + Guard 6 decision.
 * `cur` is curSnapshot(doc). Overrides are NOT applied here (they live in the script / the price_refresh_overrides collection).
 */
export function evaluateListings(rawListings: RawListing[], cur: CurSnapshot, ctx: GuardCtx, refreshed = false): { g: any; decision: Decision; ambiguityFallback: any } {
  let g = computeGuarded(rawListings, ctx, "exclude");
  let ambiguityFallback: any = null;
  const nAny = (g.per_unit_metric?.n || 0) + (g.per_unit_count?.n || 0);
  if (nAny === 0 && g.rows.some((r: any) => r.status === "ambiguous")) {
    const tot = computeGuarded(rawListings, ctx, "total");
    const each = computeGuarded(rawListings, ctx, "each");
    const dist = (x: any) => {
      let best: number | null = null;
      for (const [k, cs] of [["per_unit_metric", cur.metric], ["per_unit_count", cur.count]] as const) {
        if (x[k] && cs && cs.value > 0) { const d = Math.abs(Math.log(x[k].value / cs.value)); best = best == null ? d : Math.min(best, d); }
      }
      return best;
    };
    const dt = dist(tot), de = dist(each);
    if (dt != null && de != null) {
      const chosen = dt <= de ? "total" : "each";
      g = chosen === "total" ? tot : each;
      ambiguityFallback = { chosen, reason: "0 valid listing after excluding ambiguous_pack; both readings computed, closer to current value chosen", total: { metric: tot.per_unit_metric, count: tot.per_unit_count }, each: { metric: each.per_unit_metric, count: each.per_unit_count }, current: { metric: cur.metric, count: cur.count } };
    } else ambiguityFallback = { chosen: null, reason: "no current value to compare; ambiguous listings stay excluded", total: { metric: tot.per_unit_metric, count: tot.per_unit_count }, each: { metric: each.per_unit_metric, count: each.per_unit_count } };
  }
  const decision = decideAction({ per_unit_metric: cur.metric, per_unit_count: cur.count }, g, rawListings.length, refreshed);
  return { g, decision, ambiguityFallback };
}

/** The `$set` an `update` decision writes (field names exactly as the reviewed dry-run / refresh-20261016). */
export function buildUpdateSet(name: string, g: any, decision: Decision, rawCount: number, attempts: number | null): Record<string, any> {
  const set: Record<string, any> = {};
  for (const f of decision.fields) set[f] = g[f];
  set.cheapest = g.cheapest;
  set.n_supermarkets = g.n_supermarkets;
  set.listings = g.rows.filter((r: any) => r.status === "kept" || r.status === "ambiguous").map((r: any) => ({ store: r.store, title: r.title, price: r.price, pack: r.pack, source_of_pack: r.source_of_pack, per_unit: r.per_unit, ...(r.status === "ambiguous" ? { ambiguous_pack: true } : {}) }));
  set.confidence = g.confidence;
  set.needs_review = g.confidence === "none" || g.confidence === "low" || g.n_supermarkets === 0;
  set["metadata.source"] = "serper";
  set["metadata.query_used"] = name;
  set["metadata.raw_listing_count"] = rawCount;
  set["metadata.attempts"] = attempts;
  return set;
}

// ------------------------------------------------------------------------------------------------
// Protection (what the refresh must never touch) + snapshots
// ------------------------------------------------------------------------------------------------
const STANDARD_KEYS = new Set(["_id", "canonical_name", "per_unit_metric", "per_unit_count", "cheapest", "n_supermarkets", "listings", "confidence", "needs_review", "metadata",
  "priceFixPrev", "priceFixBatch", "priceFixAt", "refreshPrev", "refreshBatch", "refreshAt"]); // refresh* are our own bookkeeping, not curation
export function liveProtectReasons(d: any): string[] {
  const reasons: string[] = [];
  if (d.priceFixBatch || d.priceFixPrev) reasons.push(`priceFixBatch=${d.priceFixBatch ?? "?"}`);
  if (!d.metadata || d.metadata.source !== "serper") reasons.push(`metadata.source=${d.metadata?.source ?? "(missing)"}`);
  if (typeof d.confidence === "string" && d.confidence.startsWith("manual")) reasons.push(`confidence=${d.confidence}`);
  if (d.curation_note || d.metadata?.curation_note) reasons.push("has curation_note");
  const extra = Object.keys(d).filter((k) => !STANDARD_KEYS.has(k) && k !== "curation_note");
  if (extra.length) reasons.push(`non-standard keys: ${extra.join(",")}`);
  return reasons;
}
export function curSnapshot(d: any): CurSnapshot {
  return {
    metric: d.per_unit_metric ? { value: d.per_unit_metric.value, n: d.per_unit_metric.n } : null,
    count: d.per_unit_count ? { value: d.per_unit_count.value, n: d.per_unit_count.n } : null,
    cheapest: d.cheapest ? { store: d.cheapest.store, price: d.cheapest.price, title: d.cheapest.title } : null,
    n_supermarkets: d.n_supermarkets ?? null,
    confidence: d.confidence ?? null,
    fetched_at: d.metadata?.fetched_at ? new Date(d.metadata.fetched_at).toISOString() : null,
  };
}
const sameVal = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9);
export function snapshotsEqual(a: CurSnapshot, b: CurSnapshot): boolean {
  return sameVal(a.metric?.value, b.metric?.value) && sameVal(a.count?.value, b.count?.value) && a.n_supermarkets === b.n_supermarkets &&
    a.confidence === b.confidence && a.fetched_at === b.fetched_at && (a.cheapest?.price ?? null) === (b.cheapest?.price ?? null);
}
/** `refreshPrev` object stored before a write (same shape as refresh-20261016). */
export function refreshPrevOf(d: any): Record<string, any> {
  return { per_unit_metric: d.per_unit_metric ?? null, per_unit_count: d.per_unit_count ?? null, cheapest: d.cheapest ?? null, n_supermarkets: d.n_supermarkets ?? null, listings: d.listings ?? [], confidence: d.confidence ?? null, needs_review: d.needs_review ?? null, price_basis: d.price_basis ?? null, curation_note: d.curation_note ?? null, metadata: d.metadata ?? null };
}

// ------------------------------------------------------------------------------------------------
// STOCK family (cloud decision point 5): £/ml of made-up stock from cube/pot listings that state a piece count.
// (Stock docs become confidence=manual_nominal after the first write, i.e. protected; the Worker job never recomputes them.)
// ------------------------------------------------------------------------------------------------
export const STOCK_NAME_RE = /\b(broth|stock|bouillon)\b/i;
export const CORE_TYPES = ["chicken", "beef", "fish", "vegetable"];
export function docStockType(name: string): { type: string; source: string } {
  const l = name.toLowerCase();
  let best: { type: string; idx: number } | null = null;
  for (const [t, re] of [["chicken", /\bchicken\b/], ["beef", /\bbeef\b/], ["fish", /\bfish\b/], ["vegetable", /\bveg(?:etable)?s?\b/]] as Array<[string, RegExp]>) {
    const m = l.match(re);
    if (m && (best == null || m.index! < best.idx)) best = { type: t, idx: m.index! };
  }
  if (best) return { type: best.type, source: "name_first_type_word" };
  if (/\bbrown\b/.test(l)) return { type: "beef", source: "brown_stock_is_beef_group" }; // cloud rule 9
  return { type: "vegetable", source: "default_vegetable_no_type_word" };
}
export function titleStockTypes(title: string): string[] {
  const l = title.toLowerCase();
  const out: string[] = [];
  if (/\bchicken\b/.test(l)) out.push("chicken");
  if (/\bbeef\b/.test(l)) out.push("beef");
  if (/\bfish\b/.test(l)) out.push("fish");
  if (/\bveg(?:etable)?s?\b/.test(l)) out.push("vegetable");
  return out;
}
function stockCount(title: string): { n: number; rule: string } | null {
  const t = title;
  let m = t.match(/(\d+)\s?[x×]\s?\d+(?:\.\d+)?\s?(?:kg|g|l|ml|cl)\b/i);
  if (m) return { n: parseInt(m[1]!, 10), rule: "NxMg" };
  m = t.match(/(?<![\d.])(\d+)\s+(?!(?:kg|g|l|ml|cl)\b)(?:[a-z&'-]+\s+){0,3}?(?:cubes?|pots?)\b/i);
  if (m) return { n: parseInt(m[1]!, 10), rule: "N_cubes_or_pots" };
  m = t.match(/\bpack of (\d+)\b/i);
  if (m) return { n: parseInt(m[1]!, 10), rule: "pack_of_N" };
  m = t.match(/(?<![\d.])(\d+)\s?pack\b/i);
  if (m) return { n: parseInt(m[1]!, 10), rule: "N_pack" };
  m = t.match(/(?<![a-z\d])x\s?(\d+)\b(?!\s?(?:kg|g|l|ml|cl)\b)/i);
  if (m) return { n: parseInt(m[1]!, 10), rule: "xN" }; // "Stock Pots x4 112g"
  return null;
}
function stockMl(title: string): { ml: number; source: string } {
  const l = title.toLowerCase();
  if (/\bpots?\b/.test(l)) return { ml: 500, source: "stock_pot_500ml_any_brand" }; // rule 8: every pot = Knorr pot spec
  if (/\boxo\b/.test(l)) return { ml: 190, source: "oxo_cube_190ml" };
  if (/\bknorr\b/.test(l)) return { ml: 500, source: "knorr_stock_cube_500ml" };
  return { ml: 190, source: "other_or_own_brand_190ml" };
}
export function classifyStockListing(l: RawListing, groupType: string): any {
  const title = String(l.title || "");
  const lower = title.toLowerCase();
  const price = cleanPrice(l.price);
  const base = { store: l.store, title, price };
  if (price == null || !(price > 0)) return { ...base, used: false, reason: "no_price" };
  if (!isUkSupermarket(l.store)) return { ...base, used: false, reason: "not_whitelisted_store" };
  const types = titleStockTypes(title);
  if (/\bgranul\w*\b|\bpowder\b/.test(lower)) return { ...base, used: false, reason: "stock_granules" };
  const isCubePot = /\bcubes?\b|\bpots?\b/.test(lower);
  if (!isCubePot) {
    const hasSize = /\d\s?(?:kg|g|l|ml|cl)\b/.test(lower) || /\b(?:carton|ready|fresh|liquid|bottle)\b/.test(lower);
    return { ...base, used: false, reason: hasSize ? "stock_ready_made" : "stock_no_form" };
  }
  if (!types.length) return { ...base, used: false, reason: "stock_type_unknown" };
  const otherCore = types.filter((t) => t !== groupType);
  if (!types.includes(groupType) || otherCore.length) return { ...base, used: false, reason: `stock_type_mismatch(title:${types.join("+")},need:${groupType})` };
  const c = stockCount(title);
  if (!c) return { ...base, used: false, reason: "stock_no_count" };
  if (!(c.n >= 1 && c.n <= 120)) return { ...base, used: false, reason: `stock_count_implausible(${c.n})` };
  const { ml, source } = stockMl(title);
  const perCube = price / c.n;
  return { ...base, used: true, count: c.n, count_rule: c.rule, ml, ml_source: source, per_cube: r4(perCube), per_ml: perCube / ml, per_l: r4((perCube / ml) * 1000) };
}

/**
 * Pool the usable cube/pot listings of all non-protected stock-family canonicals of one type (cloud rule 9) and take the median £/ml.
 * `cachedListingsByDoc`: [canonicalName, listings][] ; `extraListings`: optional listings from a type query (`<type> stock cubes price`).
 */
export function buildStockGroup(type: string, cachedListingsByDoc: Array<[string, RawListing[]]>, extraListings: RawListing[] = []): any {
  const grp: any = { type, contributingCanonicals: [] };
  const seen = new Map<string, any>();
  const addRow = (c: any, origin: string, fromName: string | null) => {
    const key = `${c.store}|${c.title}|${c.price}`;
    if (seen.has(key)) {
      if (fromName && !seen.get(key).fromCanonicals.includes(fromName)) seen.get(key).fromCanonicals.push(fromName);
      return;
    }
    seen.set(key, { ...c, origin, fromCanonicals: fromName ? [fromName] : [] });
  };
  for (const [name, listings] of cachedListingsByDoc) {
    for (const l of listings || []) {
      const c = classifyStockListing({ store: l.store, title: l.title, price: l.price }, type);
      const titleTypes = titleStockTypes(String(l.title || ""));
      if (c.used || titleTypes.includes(type) || !titleTypes.length) addRow(c, "cache", name);
    }
  }
  for (const l of extraListings) addRow(classifyStockListing(l, type), "serper_type_query", null);
  const usable = [...seen.values()].filter((r) => r.used);
  const rows = [...seen.values()];
  grp.contributingCanonicals = [...new Set(usable.flatMap((r) => r.fromCanonicals))];
  grp.listingsUsed = usable.map((r) => ({ store: r.store, title: r.title, price: r.price, count: r.count, count_rule: r.count_rule, ml: r.ml, ml_source: r.ml_source, per_cube: r.per_cube, per_l: r.per_l, origin: r.origin, fromCanonicals: r.fromCanonicals }));
  grp.listingsDropped = rows.filter((r) => !r.used).map((r) => ({ store: r.store, title: r.title, price: r.price, reason: r.reason, origin: r.origin, fromCanonicals: r.fromCanonicals }));
  grp.droppedReasonCounts = countBy(grp.listingsDropped, (r: any) => String(r.reason).replace(/\(.*$/, ""));
  grp.nUsed = usable.length;
  if (!usable.length) { grp.result = "hold_stock_no_usable_listing"; grp.medianPerL = null; return grp; }
  const med = median(usable.map((r) => r.per_ml))!;
  const nearest = usable.reduce((m, r) => (Math.abs(r.per_ml - med) < Math.abs(m.per_ml - med) ? r : m));
  grp.medianPerMl = r6(med);
  grp.medianPerL = r4(med * 1000);
  grp.nearest = { store: nearest.store, title: nearest.title, per_cube: nearest.per_cube, ml: nearest.ml, per_l: nearest.per_l };
  grp.result = med * 1000 < 0.2 || med * 1000 > 1.0 ? "stock_out_of_range" : "ok";
  return grp;
}

/** The nominal_stock `$set` for one stock-family doc (null when its type group has no usable listing). */
export function stockProposal(type: string, grp: any): { set: Record<string, any>; note: string } | null {
  if (!grp.nUsed) return null;
  const nearest = grp.nearest;
  const note = `Stock cube made up: £${r4(nearest.per_cube)!.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} per cube ÷ ${nearest.ml} ml = £${nearest.per_l.toFixed(2)}/L, source ${nearest.store} ${nearest.title}; ${type} group median of ${grp.nUsed} listings = £${grp.medianPerL.toFixed(2)}/L`;
  const set = { per_unit_metric: { value: grp.medianPerMl, unit: "g_or_ml", n: grp.nUsed }, confidence: "manual_nominal", price_basis: "stock_cube_made_up", curation_note: note };
  return { set, note };
}
