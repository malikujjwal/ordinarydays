# Documentation index

Every document in this repository, what it is for, and when to read it. Start with
`../CLAUDE.md` if you are an agent picking up a task.

---

## Reading orders

**New to the project (human or agent), 30 minutes:**
`../CLAUDE.md` → `01-product/overview.md` → `02-architecture/data-model.md` §1 →
`03-implementation/roadmap.md`

**About to write code:**
`../CLAUDE.md` → `04-conventions/agent-playbook.md` → the `03-implementation/phase-NN-*.md`
that owns your task ID → the product spec for the feature → `02-architecture/api-contract.md`

**Setting up AWS for the first time:**
`02-architecture/cost-model.md` → `02-architecture/infrastructure.md` §bootstrap →
`03-implementation/phase-00-foundations.md`

**Reviewing a PR:**
`03-implementation/definition-of-done.md` → `04-conventions/coding-standards.md`

---

## 00 — Root

| Document | Read it when |
| --- | --- |
| [00-open-decisions.md](00-open-decisions.md) | You want the decisions made on the founder's behalf during planning, the phase by which each must be settled, and what has been confirmed or deferred. |

## 01 — Product

What the app does. Behaviour is decided here; mechanics are not.

| Document | Read it when |
| --- | --- |
| [original-concept.md](01-product/original-concept.md) | You need the founder's intent. Wins over every other doc on questions of *what the product should do*. |
| [overview.md](01-product/overview.md) | Onboarding, or you need the principles as testable rules. |
| [activities.md](01-product/activities.md) | Working on creation, the explicit Task / Plan / List item choice, contextual Add entry points, any type-specific form, or the activity lifecycle. |
| [today-and-tasks.md](01-product/today-and-tasks.md) | Working on the Today screen, tasks, recurrence, snooze, overdue, or passed plans. |
| [plans-and-lists.md](01-product/plans-and-lists.md) | Working on the three-stage Plans tab including Needs a date, plan detail, explicit new-List template choice, lists, shared lists, or the explicit `Plan this item` bridge and its Just me / Choose people choice. |
| [sharing-and-people.md](01-product/sharing-and-people.md) | Working on participants, invites, the public invite page, guests, or the People layer. |
| [expenses.md](01-product/expenses.md) | Working on expenses, splits, balances, or settlement. |
| [ai-capture.md](01-product/ai-capture.md) | Working on field extraction after the user has explicitly chosen Task, Plan, or a destination List. Capture never chooses object kind, Plan type, sharing, or reminder state. Phase 8. |
| [notifications.md](01-product/notifications.md) | Working on reminders, push, the in-app inbox, the notification catalogue, or the four transactional emails. |
| [interaction-contract.md](01-product/interaction-contract.md) | Working on any interactive surface. The gesture and state contract is universal. |

## 02 — Architecture

How it is built. Mechanics are decided here.

| Document | Read it when |
| --- | --- |
| [data-model.md](02-architecture/data-model.md) | **Anything touching storage.** The single-table design, entity shapes, access patterns, recurrence expansion, and transaction boundaries. |
| [feature-to-schema-map.md](02-architecture/feature-to-schema-map.md) | You want to see a product flow traced end to end through the schema, or you think a feature needs a new table. Read it before proposing a model change. |
| [api-contract.md](02-architecture/api-contract.md) | Adding or calling any endpoint. The client never calls something that is not in here. |
| [tech-stack.md](02-architecture/tech-stack.md) | Choosing a library, or you need the client/server layering. |
| [aws-services.md](02-architecture/aws-services.md) | You need to know which AWS service does what, and what it costs. |
| [infrastructure.md](02-architecture/infrastructure.md) | CDK stacks, environments, bootstrap runbook, deployment, CI/CD, local dev. |
| [auth.md](02-architecture/auth.md) | Anything touching Cognito, tokens, Sign in with Apple, or guest linking. |
| [cost-model.md](02-architecture/cost-model.md) | **Before adding any AWS resource.** Free-tier buckets, projections, and guardrails. |
| [security-privacy.md](02-architecture/security-privacy.md) | Threat model, IAM, PII handling, App Store privacy labels, incident response. |
| [decisions.md](02-architecture/decisions.md) | You want to know *why* something is the way it is, or you are about to argue with a decision. |

## 03 — Implementation

The plan. Ten numbered phases plus the blocking Phase 2.5 recurrence-stabilization gate,
375 tasks total. Phases 0–3 are local-first: nothing is deployed to AWS until Phase 4.

| Document | Read it when |
| --- | --- |
| [roadmap.md](03-implementation/roadmap.md) | Planning, sequencing, or deciding what to parallelise. Includes the risk register. |
| [phase-00-foundations.md](03-implementation/phase-00-foundations.md) | AWS account and budgets, the monorepo, CI, the eight CDK stacks written but not deployed, hello-world end to end on a laptop. |
| [phase-01-activity-core.md](03-implementation/phase-01-activity-core.md) | The identity seam, the repository layer, Activity CRUD, explicit Add intent, per-user reminder rows, the Add screen and creation forms. |
| [phase-02-today-and-tasks.md](03-implementation/phase-02-today-and-tasks.md) | The recurrence engine, the GSI1 bucket rule, `lastActivityAt`, the agenda endpoint, owner-only plan completion with the parent-participant rule for prep tasks, the reminder endpoints, the Today screen. |
| [phase-02-5-recurrence-stabilization.md](03-implementation/phase-02-5-recurrence-stabilization.md) | The blocking recurrence correctness gate: explicit occurrence targets, distinct Does not repeat / No end / End series operations, authoritative detail projection, atomic writes, and cross-layer tests. |
| [phase-03-plans-and-lists.md](03-implementation/phase-03-plans-and-lists.md) | Lists, the explicit private/shared list-item → Plan bridge, the three-stage Plans tab, plan detail, attachments. |
| [phase-04-deploy-and-identity.md](03-implementation/phase-04-deploy-and-identity.md) | The first real deploy, Cognito, Sign in with Apple, token storage, the auth screens. |
| [phase-05-ship-v1.md](03-implementation/phase-05-ship-v1.md) | Domain and DNS, prod, web hosting, EAS builds, push, TestFlight, App Store setup. |
| [phase-06-sharing.md](03-implementation/phase-06-sharing.md) | Participants, RSVP and its reset on a date change, date suggestions, invites, the public page and its date-sensitive vocabulary, calendar export, SES, shared lists. |
| [phase-07-people-and-expenses.md](03-implementation/phase-07-people-and-expenses.md) | The People layer, expenses, balances, settlement, Streams. |
| [phase-08-ai-capture.md](03-implementation/phase-08-ai-capture.md) | Target-constrained field extraction, the review screen, eval harness and spend controls; no intent or type classification. |
| [phase-09-followup-and-launch.md](03-implementation/phase-09-followup-and-launch.md) | Follow-up suggestions, shortcuts, offline, widgets, public launch. |
| [definition-of-done.md](03-implementation/definition-of-done.md) | **Before opening any PR.** |

## 04 — Conventions

How we work.

| Document | Read it when |
| --- | --- |
| [agent-playbook.md](04-conventions/agent-playbook.md) | **Every task.** Start-of-task protocol, common mistakes, end-to-end recipes, glossary. |
| [repo-structure.md](04-conventions/repo-structure.md) | You are unsure where a file goes. |
| [coding-standards.md](04-conventions/coding-standards.md) | Writing any code. Types, errors, money, dates, IDs, logging, React. |
| [testing.md](04-conventions/testing.md) | Writing tests, or you need the coverage requirement for your layer. |
| [git-workflow.md](04-conventions/git-workflow.md) | Branching, commits, PRs, releases, working alongside other agents. |
| [design-system.md](04-conventions/design-system.md) | Any visual work. Tokens, components, layout anatomies, responsive rules. |

## Generated and produced

These do not exist yet. They are **outputs of phase tasks**, not documents to be written
in advance. The phase task that produces each one is named beside it.

| Path | Produced by |
| --- | --- |
| `generated/openapi.json` | `pnpm gen:openapi` from the Zod schemas, from Phase 0. Checked in; CI fails if stale. |
| `05-operations/runbook.md` | Phase 9 — on-call and incident procedures |
| `05-operations/flags.md` | Phase 5 — the feature-flag and kill-switch register |
| `05-operations/launch-checklist.md`, `launch-report.md` | Phase 9 |
| `05-operations/app-store-submission.md` | Phase 5 — the submission record and review notes |
| `05-operations/ses-production-access.md` | Phase 6 — the SES review request and its outcome |
| `05-operations/accessibility-audit.md` | Phase 9 |
| `05-operations/perf/lambda-power-tuning.md` | Phase 9 — the memory/cost curve |

Create `docs/05-operations/` when the first of these is produced, not before.

---

## Maintaining these docs

- A PR that changes behaviour updates the product spec in the same PR.
- A PR that changes storage or endpoints updates `data-model.md` or `api-contract.md` in
  the same PR.
- A decision worth remembering gets an ADR entry in `02-architecture/decisions.md`.
- Phase docs are living: mark tasks complete in place, and record deviations rather than
  quietly editing the plan to match what was built.
