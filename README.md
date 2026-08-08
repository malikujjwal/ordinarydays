# Ordinary Days

A personal life planner where you explicitly add a Task, a Plan, or a List item. Tasks and
Plans can be scheduled; Plans and Lists can be shared; Tasks keep no direct participant
roster. Typed words and AI may help
fill fields, but never decide which of those three things the user meant, which Plan kind to
use, which List behaviour to create, who it is shared with, or whether to set a reminder.

> Choose it → capture it → organise it → schedule it → share it → do it → follow up.

The user-facing mental model is three words: **Today · Plans · Lists**. Meals, TV, events,
outings, expenses and people are not separate mini-apps — they all move through the same
lifecycle.

**Status:** planning complete, implementation not started. There is no code in this repo
yet. Phase 0 begins at
[`docs/03-implementation/phase-00-foundations.md`](docs/03-implementation/phase-00-foundations.md).

---

## Platforms

| Target | How |
| --- | --- |
| iPhone | Expo + React Native, built with EAS, distributed via TestFlight then the App Store |
| Web | The same codebase via React Native Web, static-exported to S3 + CloudFront |

One TypeScript codebase, one design system, one API client.

## Architecture at a glance

```
Expo app (iOS + Web)
        │  HTTPS, Cognito ID token
        ▼
CloudFront ──► API Gateway (HTTP API)
                     │
                     ▼
               Lambda (Node 22, ARM64, Hono router)
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   DynamoDB       S3 (images)   Cognito
  (single table)
```

Infrastructure is AWS CDK v2 in TypeScript. Everything is serverless and sized to run
inside the AWS always-free allowances at personal and small-beta scale. See
[`docs/02-architecture/cost-model.md`](docs/02-architecture/cost-model.md).

## Repository layout

```
apps/mobile        Expo app — iOS and web
services/api       The Lambda: Hono router, handlers, services, repositories
packages/shared    Types, Zod schemas, recurrence engine, money math, API client
packages/ui        Design-system primitives
infra              AWS CDK v2 app
docs               Everything below
```

Details in [`docs/04-conventions/repo-structure.md`](docs/04-conventions/repo-structure.md).

## Documentation

Start at [`docs/00-index.md`](docs/00-index.md).

If you are a coding agent, start at [`CLAUDE.md`](CLAUDE.md) instead — it is the operating
manual and it tells you which docs to read for your task.

The four sets:

| Set | What it decides |
| --- | --- |
| [`docs/01-product/`](docs/01-product/) | What the app does |
| [`docs/02-architecture/`](docs/02-architecture/) | How it is built |
| [`docs/03-implementation/`](docs/03-implementation/) | The ten-phase plan and every task in it |
| [`docs/04-conventions/`](docs/04-conventions/) | How we work |

## Getting started

Nothing to install yet. When Phase 0 lands:

```bash
pnpm install
docker compose up -d       # DynamoDB Local
pnpm dev                   # local API + Expo dev server
```

Before touching AWS, read
[`docs/03-implementation/phase-00-foundations.md`](docs/03-implementation/phase-00-foundations.md)
in full. There is an account-setup trap that closes your AWS account after six months if
you get it wrong.

## Licence

Private. All rights reserved.
