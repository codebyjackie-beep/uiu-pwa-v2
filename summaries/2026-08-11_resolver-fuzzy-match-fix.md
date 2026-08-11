# resolver-fuzzy-match-fix — write summary

Source: `HANDOFF_resolver-fuzzy-match-fix.md`, based on `HANDOFF_resolver-fuzzy-match-audit.md`
(187 liveFuzzyMatches across production). Jackie confirmed dry-run 2026-08-11, write executed same day.

## 1. Changes written to `canonical_ingredients`

**4 new `known_gap` stub docs** (raw text was fuzzy-matching an unrelated real ingredient before this):

| canonical_name | recipe_count | type | reason |
|---|---|---|---|
| beef | 34 | S | was fuzzy-matching `beer` |
| custard | 5 | S | was fuzzy-matching `mustard` (3 mispriced live) |
| rapeseed oil | 7 | L | was fuzzy-matching `grapeseed oil` (5 mispriced live) |
| sake | 3 | L | was fuzzy-matching `sage` |

All inserted as `{ ..., density_cup:null, per_item_g:null, display_unit:null, known_gap:true, known_gap_reason:"pending_curation" }` — unpriced honest gaps, not guesses. Density/per_item_g curation deferred to a future round per handoff scope.

**Typo rename:** `canonical_name: "blacks olives"` → `"black olives"`, old spelling kept via `$addToSet` alias.

**Added finding, not in original handoff text:** `canonical_price_cache` is a separate collection also keyed by `canonical_name` text, and only had a price doc for the old typo. Renaming `canonical_ingredients` alone would have broken the price join and regressed 5 currently-priceable `black olives` lines to unpriceable. Confirmed no naming collision, then renamed the matching `canonical_price_cache` doc's `canonical_name` in the same write step. Jackie signed off on this before write.

**17 alias additions** (spelling variants onto existing correct canonical docs — fuzzy→exact only, no resolve-result change):
all-purpose flour, bread crumbs, cornflour, hot sauce, eggplant, shallot, lemon grass, chili sauce, goat cheese, sriracha, skirt steaks, cloves, black-eyed peas, tabasco sauce, crab meat, bok choy, soy milk.

## 2. Raw evidence — DB state verification after write

```
ci: beef -> {"canonical_name":"beef","known_gap":true,"aliases":[]}
ci: custard -> {"canonical_name":"custard","known_gap":true,"aliases":[]}
ci: rapeseed oil -> {"canonical_name":"rapeseed oil","known_gap":true,"aliases":[]}
ci: sake -> {"canonical_name":"sake","known_gap":true,"aliases":[]}
ci: black olives -> {"canonical_name":"black olives","aliases":["blacks olives"]}
ci: blacks olives -> NOT FOUND
price_cache: black olives -> {"canonical_name":"black olives","cheapest":{"store":"Tesco","price":1.15}}
price_cache: blacks olives -> NOT FOUND
cloves aliases: ["cloves","clove"]
```
All 6 checks confirm the write landed as intended; the price-cache companion rename is verified — no dangling doc left under the old name.

## 3. Coverage impact (dry-run, before write — the authoritative before/after)

- BEFORE (live DB pre-write): `totalLines=10274, priceableCount=5679, coverage=55.28%`
- AFTER (simulated, with price-cache rename included): `totalLines=10274, priceableCount=5671, coverage=55.20%`
- **Delta: -8** — exactly custard's 3 + rapeseed oil's 5 mispriced lines flipping from "priceable but wrong price" to honest `known_gap` (unpriceable). Beef/sake contribute 0 (already unpriceable pre-fix). Black olives contributes 0 net (price-cache companion rename neutralizes the rename).

Note: the post-write simulation baked into `write_fuzzy_match_fix.cjs` re-queries the DB *after* the write already landed, so its own before/after printed `+0` — that's the script measuring post-write state against itself, not a discrepancy. The dry-run numbers above (captured pre-write) are the trustworthy before/after.

## 4. Real production recompute (`precomputeRecipeCosts`, `?write=true`)

```
POST https://uiu-api.codeby-jackie.workers.dev/api/admin/recompute-costs?write=true
{"ok":true,"data":{"dryRun":false,"processed":1003,"avgAdjustedCoveragePct":53.75446005063147,
"adjustedPriceableTotal":5147,"adjustedTotalSum":9499,"lineWeightedAdjustedPct":54.184651015896414,
"withBasket":953,"priceCacheStamp":1784587647589}}
```
Ran successfully post-write, `processed:1003` (all recipes recomputed against the new resolver state).

## 5. Flagged but explicitly NOT fixed (out of scope)

**New fuzzy collision:** the `sake` stub introduces a new distance-1 fuzzy match against raw text `"hake"` (fish, previously fully `unresolved`). Currently zero pricing consequence — both `unresolved` (before) and `known_gap` (after) are non-priceable — but it is the same failure class this handoff exists to fix, latent for whenever `sake` gets priced in a future curation round. Resolver algorithm/threshold changes are explicitly out of scope for this handoff; flagged here for awareness only, not actioned.

## 6. Explicitly not done (per handoff scope)

- `name_normalizer.js` / `canonical_resolver.service.js` algorithm/thresholds — untouched.
- USDA/CoFID density curation for beef/custard/rapeseed oil/sake — deferred to a future, separate curation round.
- `memory.md` — untouched.
