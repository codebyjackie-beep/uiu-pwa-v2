# 2026-08-14 — Manual-Entry Design Fix + Two Image/Title Housekeeping Items

Three items from Cloud's handoff: (1) manual-pick an image for the taco-mismatch recipe, (2) strip the leftover test ingredient from the Cottage Pie recipe + recompute its cost, (3) rewrite manual recipe entry so it writes straight to `recipes` instead of going through `recipe_drafts`/admin approval (per Jackie's 2026-08-12 correction).

Commit: `3897a2f` — "Rewrite manual recipe entry to write directly to recipes, add imageUrl to admin recipe PATCH". Deployed: `apps/api` Version ID `941472ca-2686-42ee-8564-906e8d724734`, `apps/web` Version ID `1450cecb-a5ec-41ba-a647-ef4bb26be04f`. `npx tsc --noEmit` clean in both `apps/web` and `apps/api` before deploy.

---

## 1. Taco-mismatch recipe — manual image fix

Cloud had already manually picked a correct Pexels photo (id `26988137`, "Fresh avocado salad with corn, tomato, and lime") for `6a7514362ba18e08ad720e80` ("Charred Corn and Avocado Salsa with Lime-Roasted Jicama"), which previously had `imageUrl: ""` after the backfill run correctly skipped it (see `summaries/2026-08-13_recipe-image-backfill-write.md`).

Since `PATCH /api/admin/recipes/:id` didn't accept `imageUrl` as an editable field, added it to `EDITABLE_FIELDS` in `apps/api/src/routes/adminRecipes.ts` (previously: title/description/ingredients/steps/tags/servings/prepTimeMinutes/cookTimeMinutes only).

```
PATCH /api/admin/recipes/6a7514362ba18e08ad720e80
{"imageUrl":"https://images.pexels.com/photos/26988137/pexels-photo-26988137.jpeg?..."}
→ 200, imageUrl updated
```

**Raw DB re-check** — `recipes` doc now has `imageUrl` = the 26988137 URL (not 4958778, the taco photo). **Live render check** via WebFetch on `useitup.uk/recipes/6a7514362ba18e08ad720e80` confirms the same image URL renders with the correct title.

## 2. Cottage Pie — removed leftover test ingredient, recomputed cost

`6a711d7f401468e5cba9701d` ("British Mushroom and Lentil Cottage Pie") still carried a `{"name":"smoked paprika","quantity":1,"unit":"tsp"}` ingredient line from the same 2026-08-04 test-edit session that left the "(CC verify edit)" title residue (fixed in the previous summary). Confirmed via the raw doc that none of the 8 recipe steps ever mention paprika — this was purely a leftover test marker, not a real ingredient (unlike the taco recipe's own `smoked paprika` line above, which is real and stayed untouched).

Removed via `PATCH /api/admin/recipes/6a711d7f401468e5cba9701d` with the full 19-line ingredients array (the 20th line, smoked paprika, dropped).

**Cost recompute:** ran the existing `POST /api/admin/recompute-costs` job (upsert-only across all `recipes`, keyed by `recipeId` — the established bulk job that already runs on a 3-hourly Cron Trigger) with `?write=true`, rather than hand-rolling a scoped recompute:
```
{"dryRun":false,"processed":1003,"withBasket":954,"lineWeightedAdjustedPct":54.57,...}
```
**Raw `recipe_cost` re-check** — doc for this recipe now has 19 lines, `has paprika: false`:
```
["mushroom","lentils","onion","carrot","celery","garlic","olive oil","tomato paste","soy sauce",
 "worcestershire sauce","vegetable stock","bay leaf","thyme","pepper","salt","new potatoes",
 "soy milk","cornflour","parsley"]
```
**Live render check** via WebFetch confirms the recipe title is clean and the ingredient list has no smoked paprika.

## 3. Manual-entry design fix — writes straight to `recipes`, no `recipe_drafts`

**Root cause of the design mismatch:** `HANDOFF_recipes-page-manual-entry-and-refresh.md` §A was originally implemented (commit `78f566e`) so that `POST /api/recipe-import/manual` called the same `insertDraft()` helper as every other import path (URL/paste/photo), landing the hand-typed recipe in `recipe_drafts` pending admin approval. Jackie corrected this design on 2026-08-12: a manually-typed recipe is fully specified by the user with nothing left for an AI/admin review step to add — it should be final the instant Save is pressed.

**What changed:**
- `apps/api/src/routes/recipeImport.ts` — `POST /manual` no longer calls `insertDraft()`. It now mirrors `adminRecipeDrafts.ts`'s approve handler directly: builds the `Recipe` doc (`isPublic: true`, `source: "manual_entry"`, `sourcePlatform: null`, `sourceUrl: undefined`, best-effort `findRecipePhoto()` for `imageUrl`, nutrition computed from `costRecipe()` lines same as before), `insertOne`s into `recipes`, then computes and `insertOne`s the matching `recipe_cost` doc in the same request. Returns `{recipeId}` instead of `{recipeDraftId}`.
- `packages/shared/src/index.ts` — removed the now-dead `"manual"` variant from `RecipeDraft.importMethod` (rebuilt `packages/shared/dist` via `npm run build` so `apps/api`/`apps/web` pick up the change, since both resolve `@uiu/shared` via built output, not `src/`).
- `apps/api/src/routes/adminRecipeDrafts.ts` — approve handler's `source` derivation dropped the `draft.importMethod === "manual"` branch (dead code, since manual drafts can no longer exist).
- `apps/web/app/recipes/SaveFromLinkModal.tsx` — the "Manually" tab's Preview→Save flow itself was already correct (per Jackie's note, only the backend path was wrong) — left untouched except: (a) the `fetchJson` response type changed from `{recipeDraftId}` to `{recipeId}` to match the new response shape, and (b) the "done" screen's message, which previously always said "Added to the review queue — go to Admin → Recipe Drafts to check and approve it." (now stale/wrong for the manual path), now shows "Saved! Your recipe is live in Recipes." specifically when `mode === "manual"`, keeping the original review-queue message for the URL/paste/photo paths (which are unaffected and still go through `recipe_drafts`).

### Verification (raw evidence)

**1. `recipe_drafts` count unchanged across the live call:**
```
before: recipe_drafts count = 176
POST https://useitup.uk/api/recipe-import/manual
  {"title":"Test Manual Toast Direct Insert","ingredients":[{"name":"bread","quantity":2,"unit":"slice"}],"steps":["Toast the bread."]}
→ {"ok":true,"data":{"recipeId":"6a7e53c6e74a482fe2821683"}}
after:  recipe_drafts count = 176   ← unchanged, confirms no draft was created
```

**2. Raw `recipes` doc — created directly, live immediately:**
```json
{
  "_id": "6a7e53c6e74a482fe2821683",
  "title": "Test Manual Toast Direct Insert",
  "isPublic": true,
  "source": "manual_entry",
  "sourcePlatform": null,
  "imageUrl": "https://images.pexels.com/photos/7696923/pexels-photo-7696923.jpeg?...",
  "ingredients": [{"name":"bread","quantity":2,"unit":"slice"}],
  "steps": ["Toast the bread."]
}
```

**3. Raw `recipe_cost` doc — computed in the same request:**
```
recipe_cost exists: true, 1 lines
```

**4. Cleanup — deleted both test docs, re-queried:**
```
deleted recipes: 1, deleted recipe_cost: 1
recipe recheck: null
recipe_cost recheck: null
```
Confirmed clean.

---

## Outstanding for Jackie

None from this task — all three items closed with raw-evidence verification. (Carried over from the previous summary, still unresolved: none — the taco image and Cottage Pie artifact were exactly the two items flagged there, and both are now fixed.)
