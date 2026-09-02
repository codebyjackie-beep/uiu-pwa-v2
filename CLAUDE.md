# CLAUDE.md — uiu-pwa-v2 (v2 codebase)

This file is auto-read at the start of each session working in this repo. It states the
**hard boundaries** and standing decisions for the v2 build. Dynamic progress lives in the
project `memory.md` (claude.ai project **UIU_PWA_V2**), not here.

---

## 0. Repo boundary — HARD RULE

- **This repo (`uiu-pwa-v2`) is the only active codebase.** All v2 development happens here.
- **`github.com/codebyjackie-beep/UseItUp` is a FROZEN, read-only archive.** Last commit
  `dde4bf9` was the final change. Never commit or develop there again — reference only.
- Three locations, three roles: old repo = museum, this repo = worksite,
  `C:\Project\UIU-PWA-v2\` = staging/transit (exports, migration scripts, notes).
- v1's `recipe_cost.service.js` logic + `unit_conversion.md` will be **ported** into this
  repo's Workers backend (rewritten to an HTTP-based DB driver). The archive keeps the original.

## 1. Stack (standing decisions — not re-litigated)

- **Frontend:** Next.js (App Router). No Flutter.
- **Backend:** Node.js + TypeScript, rewritten for **serverless / Cloudflare Workers**
  (request-scoped, no long-lived process, HTTP-based DB driver, cron via Cloudflare Cron Triggers).
- **Deploy platform:** Cloudflare Workers for both `apps/web` (via `@opennextjs/cloudflare`)
  and `apps/api`. Same origin → no CORS, no VM to manage, native CI/CD, auto SSL.
- **Shared types:** `packages/shared` (`@uiu/shared`) — one source of truth for domain types
  across web + api, to kill interface-drift bugs.

## 2. Governance rules (inherited, unchanged)

- **CI/CD from Day 1.** GitHub Actions → Workers deploy must exist from the first commit.
  "Workers makes it simple" ≠ "set it up later" (that's exactly how v1's VM2 ended up on
  manual SSH deploy with no CI/CD).
- **Evidence discipline:** raw bytes/counts are verification; narrative reports are not.
- **Reversible-first:** stop before delete, observe before permanent removal.
- **Commit + push every sub-task** — do not batch to the end.
- **Secrets never committed.** Cloudflare/API tokens live in GitHub repo secrets and
  Workers secrets, never in the repo. `.env*` is gitignored (except `.env.example`).
- Health data is secret-tier: never logged to console/error output.

## 3. Old-infra deletion gate (do NOT delete yet)

- Old **VM2** and old **Atlas cluster** must NOT be deleted until the v2 backend runs
  end-to-end against the new Atlas cluster `uiu-pwa-v2`. Old Atlas M0 is the free fallback.
- VM2 also waits until all related automation code is on GitHub + moved to its new host.

## 4. App surface (6 tabs)

Home / Meal Planner / Recipes / Shop / Fridge / Health.
Colors: black / white / green (UIU brand green) via design tokens — components read tokens,
never hardcode. Fridge generates the shopping list; Shop displays that same list + price
comparison (one list, not two).

---

*Static architecture only. Progress, decisions log, and pending items live in project `memory.md`.*
