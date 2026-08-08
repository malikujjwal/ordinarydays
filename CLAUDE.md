# CLAUDE.md — read this before doing anything

You are working on **Ordinary Days**, a personal life planner. This file is the entry
point for every agent. Read it fully, then read the docs it points you at for your task
type. Do not start writing code from the issue title alone.

---

## What this product is, in one paragraph

Ordinary Days is a lightweight organiser for everyday life. The user explicitly chooses
whether they are adding a **Task**, a **Plan**, or a **List item**; the words they type never
make that decision for them. Plans can then be scheduled and shared, Tasks appear on the day
they belong to, and Lists keep possibilities without turning them into commitments. Anything
that follows — expenses, episode progress, the next occurrence — is handled. It is
deliberately not Jira, not Notion, not a nutrition tracker, not a TV tracker, and not a
social network. The user-facing mental model is exactly three words: **Today · Plans · Lists**.

---

## The six rules that break the product if you get them wrong

1. **There is one schedulable entity: `Activity`.** Task, Meal, Watch, Event, Outing and
   Custom are a `type` field, not six tables. A "Plan" is an Activity the user intends to
   make happen, **with or without a date yet** — an undated one sits in Plans → Needs a
   date. "Today" is a query, not storage. If you are creating a `Plan` table or a `Meal`
   table, you have
   misread the model — see `docs/02-architecture/data-model.md` §1.
2. **Object intent is explicit, never inferred from words.** Global Add asks `Task`, `Plan`,
   or `List item` before capture. Only a labelled contextual action fixes the choice: Today's
   `Add a task`, Plan detail's `Add a prep task`, or an open List's `Add an item`. The Plans
   tab uses Global Add and keeps all three choices unselected. Text, photos, links, heuristics and models may fill visible fields only after
   that choice. They never choose or change the object kind, activity type, destination List,
   participants, sharing state, or reminder/notification state. A reminder comes only from
   its visible control or the user's explicitly saved default; `remind me` in source text does
   not set one. A new List's template/style is also a visible choice; its typed name never
   selects behaviour. Every commit button names the exact write and destination.
3. **Recurring activities are one row, never materialised into the future.** Completing or
   snoozing an occurrence writes an `Occurrence` override and must never mutate the series.
4. **Money is integer cents.** No floats, anywhere, ever. And no balance is ever shown
   without the underlying expenses being reachable.
5. **Suggest, never auto-create.** Nothing is scheduled, generated, or created on the
   user's behalf without an explicit confirmation. This applies to the next episode, to
   generated lists, and above all to anything a model extracted from a photo.
6. **Tap a row opens detail. It never mutates data.** The only exception is the task
   checkbox.

---

## Where to look

| Your task | Read, in this order |
| --- | --- |
| Anything at all | This file, then `docs/04-conventions/agent-playbook.md` |
| A new screen or UI change | `docs/01-product/` for the relevant feature, `docs/01-product/interaction-contract.md`, `docs/04-conventions/design-system.md` |
| A new API endpoint | `docs/02-architecture/api-contract.md`, `docs/02-architecture/data-model.md`, `docs/04-conventions/agent-playbook.md` §"How to add a new API endpoint" |
| Anything touching storage | `docs/02-architecture/data-model.md` — all of it |
| You think a feature needs a new table | `docs/02-architecture/feature-to-schema-map.md` — it almost certainly does not |
| Recurrence | `docs/02-architecture/data-model.md` §6, `docs/01-product/today-and-tasks.md` §6 |
| Expenses or balances | `docs/01-product/expenses.md`, `docs/02-architecture/data-model.md` §4.8 |
| Sharing, invites, the public page | `docs/01-product/sharing-and-people.md`, `docs/02-architecture/security-privacy.md` |
| Infrastructure or deployment | `docs/02-architecture/infrastructure.md`, `docs/02-architecture/aws-services.md`, `docs/02-architecture/cost-model.md` |
| Auth | `docs/02-architecture/auth.md` |
| Picking up a phase task | `docs/03-implementation/roadmap.md`, then the `phase-NN-*.md` that owns your task ID |
| Before opening a PR | `docs/03-implementation/definition-of-done.md`, `docs/04-conventions/git-workflow.md` |

Full index: `docs/00-index.md`.

---

## Rule hierarchy when docs disagree

1. `docs/01-product/original-concept.md` — the founder's intent. Wins on *what the product
   should do*.
2. `docs/01-product/*` — the product specs. Win on *behaviour*.
3. `docs/02-architecture/*` — win on *mechanics*.
4. `docs/04-conventions/*` — win on *style*.

**Raise a conflict, do not silently resolve it.** If two canonical docs disagree, say so in
your PR description and propose the amendment as part of the same PR.

---

## Non-negotiables

- TypeScript strict. No `any`. `unknown` at boundaries.
- No `Scan` in application code. Ever.
- No secrets in the repo, in environment variables in plaintext, or in logs.
- No DynamoDB call outside the repository layer.
- No new GSI without a written justification in `docs/02-architecture/data-model.md`.
- No new npm dependency without a line in `docs/02-architecture/tech-stack.md` saying why.
- Every Zod schema is defined once in `packages/shared` and imported by both the API and
  the client. Never redefine a shape.
- Docs are updated in the same PR as the code that changes them. A PR that makes a doc
  stale is incomplete.

---

## Cost constraint

This project must run for effectively **$0/month of AWS spend** at personal and small-beta
scale. Before you add an AWS resource, check `docs/02-architecture/cost-model.md` and state
in your PR which free-tier bucket it falls into. Anything with an hourly charge — NAT
gateways, load balancers, RDS instances, ECS tasks, provisioned OpenSearch — is rejected by
default.

---

## Commands

```bash
pnpm install                # install everything
pnpm dev                    # api (local Hono) + expo dev server
pnpm typecheck              # tsc across all packages
pnpm lint                   # Biome
pnpm test                   # Vitest, all packages
pnpm test:integration       # requires DynamoDB Local: docker compose up -d
pnpm e2e:web                # Playwright
pnpm gen:openapi            # regenerate docs/generated/openapi.json — must be committed
pnpm --filter @od/infra cdk diff 'od-*-dev'   # stage comes from the stack name, never -c
```

## Working alongside other agents

One agent owns one task ID and one branch. Branch names are
`<type>/<PHASE-TASK>-<slug>`, e.g. `feat/P2-01-recurrence-engine`. If your change touches
`packages/shared/src/types/`, `packages/shared/src/schemas/`, or `infra/`, say so in your
PR title — those are high-contention files and there is a merge-order rule in
`docs/04-conventions/git-workflow.md`.

## When to stop and ask the founder

Anything that changes the product's shape rather than its implementation: adding a
navigation tab, adding an activity type, adding a paid tier, storing a new category of
personal data, or introducing a recurring cost. The full trigger list is in
`docs/04-conventions/agent-playbook.md`.

Ask. Do not decide.
