# uiu-pwa-v2

UseItUp PWA **v2** — full rebuild. Next.js frontend + Cloudflare Workers backend, deployed entirely on Cloudflare.

> **Repo boundary (read this first).** This is the v2 codebase and the *only* active
> development repo. The v1 system lives at `github.com/codebyjackie-beep/UseItUp` and is a
> **frozen, read-only archive** — reference only, never commit there again. See `CLAUDE.md`.

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
