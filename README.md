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

**Status:** Phase 0 in progress. The five-workspace skeleton exists and installs; there is
no application code yet. The plan is
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

You need three things installed: **Node 22** (`.nvmrc`), **pnpm 9** (`corepack enable`), and
**Docker Desktop**, running.

```bash
git clone https://github.com/malikujjwal/ordinarydays.git
cd ordinarydays
pnpm install
pnpm dev
```

That is the whole quickstart. There is no file to edit, no container to start by hand and no
database to create — `pnpm dev` runs a preflight first that starts DynamoDB Local, creates
the `od-main-local` table from the shared definition, and copies `services/api/.env.example`
to `.env.local` if it is missing. It prints a line for each thing it does, and does nothing
at all when everything is already in place.

What you get:

| Where | What |
| --- | --- |
| `http://localhost:3000/v1/health` | The API, on the Hono Node adapter |
| `http://localhost:8081` | The app in a browser, showing the health screen |
| `http://localhost:8001` | `dynamodb-admin`, for looking at the rows |
| Expo Go on an iPhone | Scan the QR code Metro prints; the app resolves your LAN address automatically — but see below on Windows |

If it cannot start, it says which of Node, Docker, the database, the table or the env file is
the problem, and what to run. Two things it deliberately will not do for you: install Node,
or start Docker Desktop.

```bash
pnpm dev:preflight         # the checks alone, without starting anything
docker compose down        # stop the database when you are done
```

### Running on a physical iPhone from Windows

No Mac is needed — Expo Go downloads the bundle over your LAN. Three things have to be true,
and on a developer machine none of them is automatic:

1. **Metro must advertise your LAN address, not a loopback one.** With Hyper-V, WSL or Docker
   installed, Metro can pick the wrong adapter and serve `127.0.0.1`, which on a phone means
   the phone. Check what it chose, and override it if it guessed wrong:

   ```bash
   REACT_NATIVE_PACKAGER_HOSTNAME=10.0.0.197 pnpm dev
   ```

   Substitute your own Wi-Fi address (`ipconfig`, the adapter your Wi-Fi is on).

2. **The Wi-Fi network profile must be Private.** On a Public profile Windows Firewall drops
   the phone's inbound connections to Metro (8081) and the API (3000), and the symptom is a
   spinner with no error.

3. **Allow Node through the firewall on both ports** when Windows prompts, for Private
   networks.

The health screen prints the resolved API base URL for exactly this reason. If it shows
`localhost` or `127.0.0.1` on the phone, stop — that is item 1, not a network fault.

Before touching AWS, read
[`docs/03-implementation/phase-00-foundations.md`](docs/03-implementation/phase-00-foundations.md)
in full. There is an account-setup trap that closes your AWS account after six months if
you get it wrong.

## Licence

Private. All rights reserved.
