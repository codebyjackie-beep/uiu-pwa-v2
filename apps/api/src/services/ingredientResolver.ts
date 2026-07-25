/**
 * Raw ingredient name -> canonical_ingredients resolver.
 *
 * Ported line-for-line from assets/canonical_resolver.service.js.
 *
 * buildAliasIndex() scans canonical_ingredients (excluding quarantine:true)
 * and maps every normalized canonical_name + alias back to its
 * canonical_name. resolve(rawName) looks up the index for an exact match,
 * falls back to edit-distance <=1 fuzzy match, else reports unresolved.
 */
import type { Collection, Document } from "mongodb";
import { normalizeName } from "./nameNormalizer";

export interface ResolverCandidateDoc {
  canonical_name: string;
  aliases?: string[];
  density_cup?: number | null;
  per_item_g?: number | null;
  recipe_count?: number;
}

export type ResolveResult =
  | { canonical_name: string; method: "exact" }
  | { canonical_name: string; method: "fuzzy"; confidence: "low" }
  | { unresolved: true };

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

// On a normalized-key collision, prefer the doc with more complete pricing
// data (density_cup or per_item_g present) over one without; if that's tied,
// prefer higher recipe_count. Root-cause fix for malformed/junk docs (e.g.
// unclosed-paren seed docs) stealing a normalized key from the real doc they
// happened to collide with, purely by insertion order.
function isBetterMatch(candidate: ResolverCandidateDoc, current: ResolverCandidateDoc): boolean {
  const candidateComplete = candidate.density_cup != null || candidate.per_item_g != null;
  const currentComplete = current.density_cup != null || current.per_item_g != null;
  if (candidateComplete !== currentComplete) return candidateComplete;
  return (candidate.recipe_count || 0) > (current.recipe_count || 0);
}

/** normalized-key -> canonical_name */
export async function buildAliasIndex(ingredientsCollection: Collection<Document>): Promise<Map<string, string>> {
  const docs = await ingredientsCollection
    .find({ quarantine: { $ne: true } })
    .project({ canonical_name: 1, aliases: 1, density_cup: 1, per_item_g: 1, recipe_count: 1 })
    .toArray();

  const winners = new Map<string, ResolverCandidateDoc>();
  for (const doc of docs as unknown as ResolverCandidateDoc[]) {
    const keys = new Set([doc.canonical_name, ...(doc.aliases || [])]);
    for (const key of keys) {
      const normalized = normalizeName(key);
      if (!normalized) continue;
      const current = winners.get(normalized);
      if (!current || isBetterMatch(doc, current)) {
        winners.set(normalized, doc);
      }
    }
  }

  const index = new Map<string, string>();
  for (const [normalized, doc] of winners) {
    index.set(normalized, doc.canonical_name);
  }
  return index;
}

export function resolve(rawName: string, index: Map<string, string>): ResolveResult {
  const normalized = normalizeName(rawName);
  if (!normalized) return { unresolved: true };

  const exact = index.get(normalized);
  if (exact) return { canonical_name: exact, method: "exact" };

  // Short strings (< 4 chars) are too ambiguous for edit-distance fuzzy
  // matching — e.g. "Ice" (3 chars) was matching "rice" at distance 1.
  if (normalized.length < 4) return { unresolved: true };

  let best: string | null = null;
  let bestDist = Infinity;
  for (const key of index.keys()) {
    if (Math.abs(key.length - normalized.length) > 1) continue;
    const dist = levenshtein(normalized, key);
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
      if (dist === 0) break;
    }
  }

  if (best && bestDist <= 1) {
    return { canonical_name: index.get(best) as string, method: "fuzzy", confidence: "low" };
  }

  return { unresolved: true };
}
