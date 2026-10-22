# uiu-pwa-v2

UseItUp PWA **v2** — a zero-waste kitchen app. Next.js frontend + Cloudflare Workers backend,
deployed entirely on Cloudflare, MongoDB Atlas for data.

> **Repo boundary (read this first).** This is the v2 codebase and the *only* active
> development repo. The v1 system lives at `github.com/codebyjackie-beep/UseItUp` and is a
> **frozen, read-only archive** — reference only, never commit there again. See `CLAUDE.md`.

## What this app does

UseItUp shows what in your fridge is about to go off, what to cook with it, and what every
meal costs at UK supermarket prices. One loop across six tabs:

- **Fridge** — add what you have with expiry dates; mark each item **Used** or **Binned**.
  An Impact card counts the £ you used up vs the £ you threw away this month.
- **Home** — "Use it up soon" list, this week's plan and cost, month impact at a glance.
- **Recipes** — 328 public recipes, each priced per serving from UK supermarket prices;
  "Cook with these" starts from what's in the fridge.
- **Meal Planner** — day and week views, with cost and calorie totals.
- **Shop** — one shopping list (restock from the fridge + your own items), estimated basket
  and a supermarket price comparison.
- **Health** — macros and weight logged against the meals you planned.

Try it without an account (guest mode), sign up when you want it to stick. Installable as a
PWA, with a daily expiry reminder by Web Push.

Live at [useitup.uk](https://useitup.uk).

## How this was built

I'm a chef transitioning into software development — this project is the applied practice
ground for that transition, and it's public because I want it to hold up to an interviewer's
scrutiny, not despite that.

Straight answer: this codebase was built with **Claude Code** (an AI coding agent),
prompt-driven — I did not hand-type the implementation line by line. What I did do:

- **Own every architecture and product decision** — stack choice (Next.js + Cloudflare
  Workers over the original Flutter build), data model, the six-tab structure, the
  Fridge→Shop relationship, deploy platform, CI/CD-from-day-one as a hard rule.
- **Write the specs the AI implements against** — scoped, testable instructions, not
  "build me an app."
- **Run an independent verification gate before accepting any change as done.** I don't take
  an AI's narrative report ("this should work now") as evidence. Every commit gets checked
  against raw output — `git show`/`git log` on the actual diff, not a description of it — and
  claimed production behavior gets checked against the live system (hit the real endpoint,
  read the actual log/DB row), not assumed. Two real bugs the assistant itself caught and
  reported honestly are still in the commit history rather than edited out.

Why I'm foregrounding this rather than hiding it: reviewing AI-generated code — reading a
diff critically, reasoning about the architecture it sits in, and telling "code exists" apart
from "code verified in production" — is a real part of how software gets built now, and it's
the skill I'm actually claiming here.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) on Cloudflare Workers via `@opennextjs/cloudflare`, PWA + Web Push |
| API | Hono on a Cloudflare Worker, TypeScript, 7 Cron Triggers (price refresh, cost precompute, reminders, clean-up, health checks) |
| Data | MongoDB Atlas (HTTP-friendly driver, request-scoped connections) |
| Auth | Clerk (Google + email), plus guest mode with sign-up claim |
| Shared types | `@uiu/shared` — one source of truth for web + api |
| Ops | GitHub Actions CI/CD on every push to `main`; Telegram alerts for failed crons |

## Engineering practices

- **CI/CD from the first commit** — every push to `main` runs install → typecheck → build →
  deploy both Workers.
- **Data changes are reversible by design** — admin data endpoints dry-run by default, write
  only with `?write=true`, back up what they change under a batch id, and ship with a
  rollback endpoint.
- **Guard rails on automated writes** — the weekly recipe-cost job refuses to write when a
  public recipe's price moves suspiciously (e.g. over £8 a serving or a drop of more than
  half) and reports the anomalies instead.
- **Encrypted weekly database backup** — `mongodump` every Sunday, encrypted (GPG AES-256)
  before it leaves the runner, because this repo is public (`.github/workflows/db-backup.yml`).
- **Secrets never in the repo** — Cloudflare / Clerk / database credentials live in GitHub and
  Workers secrets; health data is never written to logs.

## Structure (monorepo, npm workspaces)

```
apps/
  web/       Next.js app (PWA frontend) — deployed to Workers via @opennextjs/cloudflare
  api/       Cloudflare Worker (Hono) — HTTP-based backend, /health + /api/*
packages/
  shared/    Shared TypeScript types used by both web and api (@uiu/shared)
```

## Requirements

- Node.js >= 22 (`.nvmrc` pins 22)
- npm (workspaces)

## Getting started

```bash
npm install          # installs all workspaces
npm run build        # build shared -> api -> web
npm run typecheck    # typecheck every workspace
```

### Run locally

```bash
npm run dev --workspace=@uiu/api   # wrangler dev, Worker API on :8787
npm run dev --workspace=@uiu/web   # next dev, frontend on :3000
```

## Deploy

Deployment is CI-driven (GitHub Actions → Cloudflare Workers) from day one — see
`.github/workflows/deploy.yml`. Every push to `main` builds and deploys both
Workers (secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

Manual deploy:

```bash
npm run deploy:api
npm run deploy:web
```

## Data / backend notes

- MongoDB Atlas cluster `uiu-pwa-v2` (AWS eu-west-1). The Worker uses an **HTTP-based**
  data driver (no long-lived TCP pool — Workers are request-scoped).
- Cost engine (`recipe_cost`) logic + unit-conversion table are ported from the v1 archive.
- Weekly encrypted backup: `.github/workflows/db-backup.yml` (see the header for restore steps).
