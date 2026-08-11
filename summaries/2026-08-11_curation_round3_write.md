# canonical-ingredients-curation-round3-write — write summary

Source: `HANDOFF_canonical-ingredients-curation-round3-write.md`. Values researched (USDA/CoFID)
and pre-approved by Jackie in `summaries/2026-08-11_curation_round3_dryrun.json`/`_summary.md`.
Final pre-write diff re-shown and confirmed 2026-08-11 per house convention (last-check even on
pre-approved values), write executed same day.

## 1. Changes written to `canonical_ingredients` (12 items)

**8 clean null-fills** (no pre-existing value, straightforward):

| canonical_name | field | value |
|---|---|---|
| cloves | density_cup | 101 |
| coconut milk | density_cup | 226 |
| bok choy | density_cup | 70 |
| sriracha | density_cup | 312 |
| ground coriander | density_cup | 125 |
| bisquick | density_cup | 120 |
| juice of lime | per_item_g | 15 |
| canned tomatoes | density_cup | 175 |

**4 corrections of pre-existing non-null values** (flagged for explicit sign-off before write):

| canonical_name | field | before → after | note |
|---|---|---|---|
| garlic | density_cup | 136 → 147 | Round 3 re-check, per handoff |
| star anise | display_unit | "g" → "pc" | bundled inside what handoff framed as a per_item_g null-fill; per_item_g itself null→0.15 |
| shrimp | per_item_g / display_unit | 30/"g" → 12/"pc" | handoff's own note already flags this as lower-confidence, inferred (non-USDA-direct) |
| kosher salt | density_cup | 280 → 128 | Diamond Crystal convention. Handoff table read like a fresh addition but DB already had 280 — >2x change, flagged explicitly, Jackie confirmed before write |

5 zero-lineCount candidates explicitly skipped per handoff: frozen dumplings, beef bouillon cube, agave, cola, sweetener.

## 2. Raw evidence — DB state verification after write

```
garlic -> {"density_cup":147,"per_item_g":3,"display_unit":"g+pc"}
cloves -> {"density_cup":101,"per_item_g":null,"display_unit":"g"}
star anise -> {"density_cup":null,"per_item_g":0.15,"display_unit":"pc"}
coconut milk -> {"density_cup":226,"per_item_g":400,"display_unit":"ml"}
bok choy -> {"density_cup":70,"per_item_g":150,"display_unit":"g+pc"}
shrimp -> {"density_cup":null,"per_item_g":12,"display_unit":"pc"}
sriracha -> {"density_cup":312,"per_item_g":null,"display_unit":"g"}
ground coriander -> {"density_cup":125,"per_item_g":null,"display_unit":"g"}
bisquick -> {"density_cup":120,"per_item_g":null,"display_unit":"g"}
juice of lime -> {"density_cup":null,"per_item_g":15,"display_unit":"ml"}
kosher salt -> {"density_cup":128,"per_item_g":null,"display_unit":"g"}
canned tomatoes -> {"density_cup":175,"per_item_g":400,"display_unit":"g"}
```
All 12 fields confirm the write landed exactly as specified.

## 3. Coverage impact

- BEFORE this handoff's write (live DB, already reflecting the prior fuzzy-match-fix commit): `totalLines=10274, priceableCount=5671, coverage=55.20%`
- AFTER (live DB, post-write): `totalLines=10274, priceableCount=5705, coverage=55.53%`
- **Delta: +34 priceable lines, no regressions.** All 12 items moved lines from `missing_density_cup`/`missing_per_item_g_and_count_price` to priceable, spanning recipe lines for star anise, juice of lime, bisquick, bok choy, ground coriander, cloves, sriracha, canned tomatoes, garlic, coconut milk, shrimp, kosher salt.

Note: as with the prior handoff, the script's own post-write simulation queries the DB after the write already landed, so it printed the same value for its "before" and "after" (5705/5705, +0) — that's post-write state measured against itself, not a discrepancy. The trustworthy before/after is the pre-write dry-run figure (5671→5705) confirmed above against the actual DB read.

## 4. Real production recompute (`precomputeRecipeCosts`, `?write=true`)

```
POST https://uiu-api.codeby-jackie.workers.dev/api/admin/recompute-costs?write=true
{"ok":true,"data":{"dryRun":false,"processed":1003,"avgAdjustedCoveragePct":54.06442096065192,
"adjustedPriceableTotal":5181,"adjustedTotalSum":9499,"lineWeightedAdjustedPct":54.54258342983472,
"withBasket":954,"priceCacheStamp":1784587647589}}
```
Ran successfully post-write, `processed:1003`. `lineWeightedAdjustedPct` moved 54.18% → 54.54% (up from the prior handoff's recompute), consistent with the +34 net-priceable gain here.

## 5. Confidence notes (per handoff acceptance criteria)

- **kosher salt** (density_cup 128, Diamond Crystal convention) and **shrimp** (per_item_g 12, inferred/non-USDA-direct) carry lower confidence than the other 10 items, per the handoff's own caveat. Both are explicitly logged as `[correction]` above, not silently blended in with the clean fills.

## 6. Explicitly not done (per handoff scope)

- `recipe_cost.service.js` / `recipeCost.ts` conversion-logic engine — untouched.
- Resolver (`canonical_resolver.service.js`) — untouched (that was the other handoff's scope; the two ran together this session but were committed separately, per instruction).
- `memory.md` — untouched.
