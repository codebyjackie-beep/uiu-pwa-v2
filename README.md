# uiu-pwa-v2

UseItUp PWA **v2** — a zero-waste kitchen app. Next.js frontend + Cloudflare Workers backend,
deployed entirely on Cloudflare, MongoDB Atlas for data.

> **Repo boundary (read this first).** This is the v2 codebase and the *only* active
> development repo. The v1 system lives at `github.com/codebyjackie-beep/UseItUp` and is a
> **frozen, read-only archive** — reference only, never commit there again. See `CLAUDE.md`.

## What this app does

Six tabs, one loop: **Fridge** (scan what you have, with expiry dates) generates the
**Shop** list — only what's actually missing, with supermarket price comparison. **Recipes**
suggests dishes from what's in the fridge. **Meal Planner** turns that into a week's plan with
cost/calorie totals. **Health** logs macros/weight against those meals. **Home** is the
dashboard tying it together.

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
`.github/workflows/deploy.yml`. The deploy job runs only when the two repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set; until then, push still runs
install + typecheck + build so the pipeline stays green.

Manual deploy (once Cloudflare is set up):

```bash
npm run deploy:api
npm run deploy:web
```

## Data / backend notes

- MongoDB Atlas cluster `uiu-pwa-v2` (AWS eu-west-1). The Worker uses an **HTTP-based**
  data driver (no long-lived TCP pool — Workers are request-scoped).
- Cost engine (`recipe_cost`) logic + unit-conversion table are ported from the v1 archive.
