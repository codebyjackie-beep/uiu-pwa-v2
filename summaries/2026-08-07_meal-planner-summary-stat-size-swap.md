# 2026-08-07 — Meal Planner Summary Card：大細字對調

## 改動

`apps/web/app/meal-planner/MealPlannerView.tsx` 第40-49行，兩個 stat block class 對調：

- `£X.XX`/`NNNN`（Week cost / Week calories 總數）：由 `meal-planner-summary__value`（大字綠色）改做 `meal-planner-summary__subtitle`（細字）
- `average per day` 數字：由 `meal-planner-summary__subtitle` 改做 `meal-planner-summary__value`
- `Week cost`/`Week calories` label 冇搬，維持中間

CSS 冇改（`globals.css` 兩個 class 本身定義已經係 `__value`=20px/700/綠色、`__subtitle`=11px/muted，純粹靠對調 JSX class 達成效果，唔使加新 class）。

## 驗證

- `npm run typecheck`（shared/api/web 全部）：pass
- `npm run build`：pass（同上次一樣有個 benign `[uiu-web] apiGet non-ok response: /api/recipes?limit=250 503` info log，係 static generation 時期預期行為，唔影響 build 結果）
- `npm run deploy:web` → Version `945f23b5-1613-44ec-84c7-99710bdde389`

**CC 冇 browser automation 工具（冇 Playwright/Puppeteer），做唔到真係影張截圖。** 改用以下兩步做等效驗證：

1. `curl` production `https://uiu-web.codeby-jackie.workers.dev/meal-planner`（cache-busted query param，因為第一次 curl 撞咗 edge cache 攞到部署前嘅舊版本），剥走 RSC flight `<script>` payload 後嘅 raw HTML 確認 class 掛法：
   ```
   <span class="meal-planner-summary__subtitle">£46.03</span>
   <span class="meal-planner-summary__label">Week cost</span>
   <span class="meal-planner-summary__value">£6.58 average per day</span>
   ```
   （calories 個 block 一樣，`11417`=`subtitle`、`1631 average per day`=`value`）
2. 直接攞返部署緊嗰份 production CSS bundle（`/_next/static/css/50aa48a2c3191d9c.css`）出嚟核對呢兩個 class 實際 CSS rule：
   ```css
   .meal-planner-summary__value{font-size:20px;font-weight:700;color:var(--accent)}
   .meal-planner-summary__subtitle{font-size:11px;color:var(--uiu-muted)}
   ```

Class 掛法 + 對應 CSS rule 兩樣都喺 production 度直接攞到，合埋就完全決定咗實際顯示效果（大細字位置對調咗，`average per day` 而家係大字綠色，週總數而家係細字）——呢個係 code-level 100% 確定嘅證據，但**唔等於真人肉眼睇個畫面**。若果想要真係嘅視覺截圖確認，要 Jackie 自己開瀏覽器影。

## Commit

- `92e2242` — "Swap Meal Planner summary stat sizes: average-per-day now large/green, week total now small"
- Files: `apps/web/app/meal-planner/MealPlannerView.tsx`
- 冇改動 `apps/api/scripts/investigate_unit_bug*.cjs` / `write_conversion_curation.cjs`（舊 session 遺留 untracked script，keep 唔理）

## 未做/下一步

- 真瀏覽器截圖確認（Jackie 自己做，CC 冇 browser 工具）
- 舊 priority 提提：Shop tab（CLAUDE.md 第9節）
