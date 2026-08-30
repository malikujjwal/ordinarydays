# Repository context map

Ordinary Days is a pnpm monorepo. Read the canonical product and engineering contracts before
changing an area, then follow the nearest package tests and public interfaces.

| Area | Context and ownership |
| --- | --- |
| `apps/mobile/` | Expo/React Native application and web-rendered mobile UI |
| `packages/shared/` | Isomorphic schemas, types, recurrence, rank, List domain, and API client |
| `packages/ui/` | Shared visual primitives, tokens, themes, and icons |
| `services/api/` | Hono API, services, repositories, middleware, and integration tests |
| `infra/` | Deployment infrastructure and runtime packaging |
| `e2e/` | Cross-boundary Playwright journeys and visual contracts |
| `docs/01-product/` | Canonical product and interaction contracts |
| `docs/03-implementation/` | Phase specifications and definition of done |
| `docs/04-conventions/` | Design, coding, testing, and agent workflow standards |
| `docs/adr/` | Durable architectural decisions that span or constrain multiple areas |

When context crosses areas, link the relevant canonical documents or ADR rather than copying
their rules into package-local prose.
