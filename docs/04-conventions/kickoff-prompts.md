# Kickoff prompts — running the plan with Claude Code

Ready-to-paste prompts for working through the phases with a Claude Code agent, one task
per session. `CLAUDE.md` is read automatically at session start; these prompts only aim the
agent at a task ID and restate the guardrails that matter most at kickoff. The
start-of-task protocol in [`agent-playbook.md`](agent-playbook.md) does the rest.

## How to run a session

1. Open Claude Code in the repo root. Start from a clean `git status` on `main`.
2. Paste the task's prompt. For **M and L tasks, enter plan mode first** (Shift+Tab), review
   the plan, then approve. S tasks can run straight through.
3. One task ID per session. When the task is merged, `/clear` (or start a fresh session)
   before the next — context from the last task should never leak into the next one.
4. Review the diff yourself before merging. The first three tasks set patterns every later
   task copies; scrutinise those hardest.
5. Strictly serial through Phase 0. From Phase 1 on, parallel agents are fine in separate
   git worktrees, subject to the merge-order rule in [`git-workflow.md`](git-workflow.md)
   for `packages/shared` and `infra/`.

## The generic template

Any task not listed below runs with this; replace the ID and the verification line as
appropriate for the phase.

```
Pick up task <ID>. Follow the start-of-task protocol in
docs/04-conventions/agent-playbook.md: read the task's detail subsection in its phase
file, then the product and architecture docs it cites, before writing anything.
Work on branch <type>/<ID>-<slug>, touch nothing outside this task's scope, and meet
docs/03-implementation/definition-of-done.md. If two docs disagree, stop and tell me —
do not resolve it silently. When done, run `pnpm typecheck && pnpm lint && pnpm test`
and show me the real output.
```

---

## Phase 0 — foundations

### Do these yourself, not with an agent

**P0-01 → P0-04** (AWS account, root hardening, zero-spend budget, IAM Identity Center)
are console work involving root credentials, MFA devices and billing. An agent should
never hold those. Follow the detail subsections in
[`../03-implementation/phase-00-foundations.md`](../03-implementation/phase-00-foundations.md)
as a personal checklist. An agent *can* help afterwards, read-only:

```
I've completed P0-01 through P0-04 by hand. Read their detail subsections in
docs/03-implementation/phase-00-foundations.md and give me a verification checklist I
can tick off in the AWS console to confirm I missed nothing. Do not ask for or handle
any credentials.
```

### Agent tasks, in dependency order

**P0-05 — Initialise the repository and pnpm workspaces** *(M — plan mode)*

```
Pick up task P0-05. Follow the start-of-task protocol in
docs/04-conventions/agent-playbook.md. Create the monorepo skeleton exactly as
docs/04-conventions/repo-structure.md lays it out — no extra folders, no placeholder
packages the plan doesn't name. Branch chore/P0-05-init-workspaces. This task sets the
patterns every later task copies, so keep it minimal and boring. When done, show me
`pnpm install` completing from a clean clone.
```

**P0-06 — Toolchain: Biome, lefthook, syncpack, tsconfig** *(M — plan mode)*

```
Pick up task P0-06 (depends on merged P0-05). Follow the start-of-task protocol.
Toolchain choices are already decided in docs/02-architecture/tech-stack.md — install
what it names, nothing else, and add no dependency without the tech-stack line the
non-negotiables require. Branch chore/P0-06-toolchain. Show me `pnpm lint` and
`pnpm typecheck` passing at the end.
```

**P0-07 — Scaffold `packages/shared`** *(M — plan mode)*

```
Pick up task P0-07 (depends on P0-06). Follow the start-of-task protocol, then read
docs/02-architecture/data-model.md §1–§3 before writing the table definition. Every Zod
schema lives here, once, and is imported everywhere else — never redefined. Branch
feat/P0-07-shared-package. Show me `pnpm typecheck && pnpm test` output.
```

**P0-08 — Scaffold `packages/ui`** *(S — mechanical)*

```
Pick up task P0-08 (depends on P0-06). It is on the mechanical list — follow the pattern
P0-07 established and docs/04-conventions/repo-structure.md. Branch
chore/P0-08-ui-package. Keep it to the scaffold; no components yet.
```

**P0-09 — Scaffold the CDK app and `infra/lib/config.ts`** *(M — plan mode)*

```
Pick up task P0-09 (depends on P0-06). Follow the start-of-task protocol, then
docs/02-architecture/infrastructure.md for the stack layout and config shape. Nothing
deploys in Phase 0 — stacks are written and synthesised only. Respect the cost
constraint in CLAUDE.md: nothing with an hourly charge, ever. Branch
feat/P0-09-cdk-app. Show me `pnpm --filter @od/infra cdk synth` succeeding.
```

**P0-10 — `NodeLambda` construct** *(S)*

```
Pick up task P0-10 (depends on P0-09). Follow the start-of-task protocol and the detail
subsection's construct contract exactly. Branch feat/P0-10-node-lambda.
```

**P0-11 — `AccountStack`** *(M — plan mode)*

```
Pick up task P0-11 (depends on P0-09). Follow the start-of-task protocol. State in your
summary which free-tier bucket every resource falls into, per
docs/02-architecture/cost-model.md. Branch feat/P0-11-account-stack. Synth must pass.
```

**P0-12 — `DataStack`** *(M — plan mode)*

```
Pick up task P0-12 (depends on P0-09, P0-07). Follow the start-of-task protocol. The
table shape comes from packages/shared's table definition (P0-07) and
docs/02-architecture/data-model.md §3 — single table, GSI1 only, on-demand billing. No
new GSI without a written justification in data-model.md. Branch feat/P0-12-data-stack.
```

**P0-13 — Scaffold `services/api`: Hono app and middleware chain** *(L — plan mode)*

```
Pick up task P0-13 (depends on P0-07). Follow the start-of-task protocol, then read
docs/02-architecture/api-contract.md §1 (envelope, errors, idempotency) and
docs/04-conventions/agent-playbook.md §7 (how to add an endpoint) before writing the
chain. No DynamoDB call outside the repository layer — the middleware and routing
skeleton this task builds is what enforces that for the rest of the project. Branch
feat/P0-13-api-scaffold. Show me `pnpm typecheck && pnpm test` output.
```

**P0-14 — `GET /v1/health`** *(S)*

```
Pick up task P0-14 (depends on P0-13). Follow the start-of-task protocol. One endpoint,
through the full middleware chain and the shared Zod schema, exactly per
docs/02-architecture/api-contract.md. Branch feat/P0-14-health-endpoint.
```

**P0-15 — `ApiStack`** *(L — plan mode)*

```
Pick up task P0-15 (depends on P0-10, P0-12, P0-14). Follow the start-of-task protocol
and docs/02-architecture/infrastructure.md. Synth only, no deploy; free-tier statement
per resource. Branch feat/P0-15-api-stack.
```

**P0-16 — `static-site` construct and `WebStack`** *(L — plan mode)*

```
Pick up task P0-16 (depends on P0-10, P0-12). Follow the start-of-task protocol and
docs/02-architecture/infrastructure.md. Synth only; free-tier statement per resource.
Branch feat/P0-16-web-stack.
```

**P0-17 — `ObservabilityStack`** *(M — plan mode)*

```
Pick up task P0-17 (depends on P0-15, P0-16). Follow the start-of-task protocol. Alarms
and dashboards only within the free tier, per docs/02-architecture/cost-model.md.
Branch feat/P0-17-observability-stack.
```

**P0-18 — Empty `DnsStack`, `AuthStack`, `SchedulerStack` shells** *(S — mechanical)*

```
Pick up task P0-18 (depends on P0-09). Mechanical: three empty stack shells following
the established pattern, so later phases have a place to land. Branch
chore/P0-18-stack-shells.
```

**P0-19 — Scaffold `apps/mobile`** *(L — plan mode)*

```
Pick up task P0-19 (depends on P0-07, P0-08). Follow the start-of-task protocol, then
docs/02-architecture/tech-stack.md for the Expo Router / Metro workspace configuration.
One codebase for iOS and web. No screens beyond what the task names. Branch
feat/P0-19-mobile-scaffold.
```

**P0-20 — Shared HTTP client and the `health` endpoint function** *(M)*

```
Pick up task P0-20 (depends on P0-07). Follow the start-of-task protocol. The client
imports the shared Zod schemas — it never redefines a shape. Branch
feat/P0-20-http-client.
```

**P0-21 — DynamoDB Local, table script, local API server** *(M — plan mode)*

```
Pick up task P0-21 (depends on P0-13, P0-12). Follow the start-of-task protocol. The
local table must be created from the same definition packages/shared exports — one
source of truth. Branch feat/P0-21-local-dev. Show me the local API answering
GET /v1/health against DynamoDB Local.
```

**P0-22 — Health screen on simulator, web and a physical iPhone** *(M)*

```
Pick up task P0-22 (depends on P0-19, P0-20, P0-21). Follow the start-of-task protocol.
Build the screen and wire it through the shared client; I will do the physical-device
verification myself and report back. Branch feat/P0-22-health-screen.
```

**P0-23 — `pnpm dev`: one command, and the clean-clone check** *(M)*

```
Pick up task P0-23 (depends on P0-21, P0-22). Follow the start-of-task protocol. The
acceptance test is brutal and simple: a clean clone, `pnpm install`, `pnpm dev`, and
everything works. Prove it by actually doing it in a temp directory and showing me the
output. Branch chore/P0-23-pnpm-dev.
```

**P0-24 — Vitest configuration and coverage gates** *(M — plan mode)*

```
Pick up task P0-24 (depends on P0-07, P0-13). Follow the start-of-task protocol and
docs/04-conventions/testing.md — the per-layer coverage numbers there are the gate,
not aspirations. Branch chore/P0-24-vitest.
```

**P0-25 — OpenAPI generation harness** *(M)*

```
Pick up task P0-25 (depends on P0-07). Follow the start-of-task protocol. `pnpm
gen:openapi` writes docs/generated/openapi.json from the Zod schemas; it is checked in,
and CI fails when it is stale. Branch feat/P0-25-openapi-gen.
```

**P0-26 — CDK assertion tests** *(M)*

```
Pick up task P0-26 (depends on P0-12, P0-15, P0-16). Follow the start-of-task protocol
and docs/04-conventions/testing.md's infra layer section. Branch chore/P0-26-cdk-tests.
```

**P0-27 — dependency-cruiser rules and the three grep checks** *(M)*

```
Pick up task P0-27 (depends on P0-13, P0-19). Follow the start-of-task protocol. These
rules are the mechanical enforcement of the non-negotiables (no DynamoDB outside
repositories, no cross-layer imports) — write them so a violation fails loudly. Branch
chore/P0-27-depcruise.
```

**P0-28 — Bundle-size check script** *(S — mechanical)*

```
Pick up task P0-28 (depends on P0-13). Mechanical: follow the detail-free pattern the
phase file describes. Branch chore/P0-28-bundle-size.
```

**P0-29 — `ci.yml`** *(L — plan mode)*

```
Pick up task P0-29 (depends on P0-24 through P0-28). Follow the start-of-task protocol
and docs/02-architecture/infrastructure.md §CI. The pipeline runs typecheck, lint,
test, depcruise and synth — and fails when docs/generated/openapi.json is stale. Branch
chore/P0-29-ci. I will confirm the green run on GitHub myself.
```

**P0-30 — GitHub environments, branch protection, signed commits** *(S — do together)*

```
Task P0-30 (depends on P0-29) is GitHub settings, which I will click through myself.
Read its detail subsection and docs/04-conventions/git-workflow.md and give me the
exact settings checklist, in order, with the values to enter.
```

**P0-31 — Deploy smoke test: bootstrap, one throwaway stack, destroy** *(M — supervise closely)*

```
Pick up task P0-31 (depends on P0-04, P0-29). Follow the start-of-task protocol. This
is the only Phase 0 task that touches the real AWS account: bootstrap, deploy the
named throwaway stack, verify, then DESTROY it and show me the empty `cdk list` /
console state. Stop and ask before any command that creates a resource not named in
the task. Branch chore/P0-31-deploy-smoke.
```

---

## Phase 1 — activity core

Run the phase gate first (read-only session):

```
Read docs/03-implementation/phase-01-activity-core.md end to end, plus
docs/03-implementation/roadmap.md §risks. Compare against the repo as built through
Phase 0. List anything the plan assumes that the code contradicts — file layout, naming,
tsconfig, CI — before I start scheduling tasks. Change nothing.
```

### Sequencing

The task IDs are numbered so that **ascending ID order is a valid dependency order** —
within each track below, just run the IDs in numeric sequence and every dependency row is
satisfied. Do not reorder for convenience; P1-11 needs P1-04's idempotency middleware and
P1-15 needs P1-11, which numeric order handles and cherry-picking breaks.

**Step 1 — `packages/shared`, serially, before anything else** (the merge-order rule in
git-workflow.md: never two open branches on `shared`):

1. **P1-06** — the `User`/`Activity`/`Reminder` schemas. Solo; everything imports it.
2. **P1-17** → **P1-19** → **P1-20** — the remaining `shared` tasks, one at a time.
   (P1-17 and P1-20 need P1-06; P1-19 needs only P0-20. All three are prerequisites for
   Track B's later tasks, so front-loading them unblocks everything.)

**Step 2 — two parallel tracks in separate git worktrees** (they share no files):

- **Track A — API, in numeric order:**
  P1-01 → P1-02 → P1-03 → P1-04 → P1-05 → P1-07 → P1-08 → P1-09 → P1-10 → P1-11 →
  P1-12 → P1-13 → P1-14 → P1-15 → P1-16 → P1-18 → P1-21 → P1-28.
  (P1-18, the capture stubs, depends only on P0-13 and can run any time you want a
  small task between large ones — it is the one legitimate float in the track.)
- **Track B — UI, in numeric order:**
  P1-22 → P1-23 → P1-24 → P1-25 → P1-26 → P1-27 → P1-29.

**The only cross-track waits** (Track B pauses if Track A hasn't landed these yet):
P1-26 needs **P1-12** (GET endpoint), P1-29 needs **P1-21** (the seed script). Everything
else in Track B rests on Step 1 and on Track B's own predecessors. In practice Track A
reaches P1-12 long before Track B finishes the creation forms, so the wait is
theoretical — but check, don't assume.

### Prompts for the tasks that need more than the template

**P1-06 — shared schemas** *(L — plan mode, solo, high contention)*

```
Pick up task P1-06. Follow the start-of-task protocol. The schemas transcribe
docs/02-architecture/data-model.md §4 exactly — including the SEGMENTED recurrence shape
in §4.2 (segments[], effectiveFrom, series-level endDate/count) and Occurrence's
overrideDate in §4.5. Defined once in packages/shared, imported everywhere, never
redefined. Branch feat/P1-06-core-schemas. No other branch touches packages/shared
until this merges.
```

**P1-05 — repository base** *(L — plan mode)*

```
Pick up task P1-05. Follow the start-of-task protocol and data-model.md §3 (keys,
GSI1), §5 (access patterns), §7 (transactions). No Scan, ever; no DynamoDB call will
exist outside this layer. Branch feat/P1-05-repo-base. Integration tests run against
DynamoDB Local (docker compose up -d).
```

**P1-09 / P1-10 — ActivityRepository and service** *(L each — plan mode)*

```
Pick up task P1-09 (then P1-10 in its own session). Follow the start-of-task protocol.
The bucket derivation (deriveGsi1Bucket, data-model.md §3.5), status derivation, and
owner-only authz rules come from the docs verbatim — do not re-derive them. Recurrence
is one row, never materialised (CLAUDE.md rule 3). Branch feat/P1-09-activity-repo.
```

**P1-22 — `packages/ui` primitives** *(L — plan mode; the design refresh lands here)*

```
Pick up task P1-22. Follow the start-of-task protocol, then read ALL of
docs/04-conventions/design-system.md — it was rewritten on 2026-08-08 from the
founder's design mock (decision #49): cream/olive palette, mulberry accent, Newsreader
serif for display/title only, new radii and shadows, IconTile / SegmentedControl /
ProgressBar primitives. Build theme/ first (tokens, elevation(), useMotion(),
useBreakpoint()), then the primitives inventory in §6. Add Newsreader (latin-subset
variable font) via expo-font with the required one-line entry in tech-stack.md, same
PR. Include the programmatic AA contrast test over every token pair in both schemes —
it is a CI gate. ALSO build a dev-only token-gallery screen that renders every
primitive in every state, light and dark; I will review the gallery before any feature
screen is built. Branch feat/P1-22-ui-primitives. Screenshot the gallery at 390px and
1280px and show me.
```

**P1-24 / P1-25 — Add chooser and creation forms** *(L each — plan mode)*

```
Pick up task P1-24 (then P1-25 in its own session). Follow the start-of-task protocol,
then activities.md §2 and interaction-contract.md §1a.3. CLAUDE.md rule 2 is the whole
task: Task / Plan / List item, nothing pre-selected, no inference from words, every
commit button names the exact write. The four Plan-kind forms in P1-25 follow
activities.md §4 field-for-field. Branch feat/P1-24-add-chooser. Screenshot every
screen you build at 390px and show me.
```

**P1-26 — detail screen** *(L — plan mode)*

```
Pick up task P1-26. Follow the start-of-task protocol, plans-and-lists.md §2.1 for the
anatomy conventions and today-and-tasks.md §5.6 for the task-detail reduction. Tap
opens detail and never mutates (rule 6); U4: tapping a date opens the reschedule
sheet. Branch feat/P1-26-activity-detail. Screenshots at 390px and 1280px.
```

For everything else in Phase 1 (P1-01…P1-04, P1-07, P1-08, P1-11…P1-21, P1-23, P1-27,
P1-28, P1-29), the generic template at the top of this file is enough — each has a full
detail subsection or a mechanical-list entry in the phase file.

### Phase 1 exit check

Before calling the phase done, one read-only session:

```
Read docs/03-implementation/phase-01-activity-core.md's acceptance criteria and
docs/03-implementation/definition-of-done.md. Audit the repo as built against every
criterion and give me a pass/fail table with evidence (file paths, test names, command
output). Change nothing.
```

---

## Phase 2 — the autonomous run

From Phase 2 on there is a second way to work: `scripts/run-phase.mjs` runs a span of
tasks unattended — one fresh headless Claude Code session per task (`claude -p`), the
same one-task-one-branch discipline, with the script (not the agent) re-running the
gates between tasks and merging `--no-ff` only when they are green.

**Still manual, before and after:** the phase gate (read-only session, prompt above)
before scheduling anything, and the exit check after the last task. Those two need your
eyes; the middle mostly does not.

**Phase 2 happens to be single-track:** plain numeric order P2-01 → P2-37 satisfies
every dependency row, and the `packages/shared` tasks (P2-01…P2-06) sit at the front, so
one worktree suffices — no parallel scheduling needed.

The 2026-08-10 Phase 2 plan amendment preserves that run order: every added dependency
still points to a lower-numbered P2 task (or a completed Phase 1 task). No task may be
scheduled out of numeric order to work around the expanded cross-layer scopes.

The second gate amendment on the same date preserves it too: agenda-boundary cases 25–30
moved from P2-02 to their existing owner P2-08 rather than adding a forward dependency, and
the only dependency-column addition is P2-07 to P2-12. Numeric P2-01…P2-37 remains the
dependency-valid run order.

```bash
# from the repo root, on a clean integration branch (e.g. `phase-2` cut from main):
node scripts/run-phase.mjs --range P2-01..P2-37 --pause-after P2-02,P2-11,P2-22
```

The three default checkpoints are where a human genuinely adds value:

| After | Review |
| --- | --- |
| P2-02 | The recurrence engine and its test matrix — the highest-correctness-stakes code in the product. Read the segment-boundary tests yourself. |
| P2-11 | `GET /v1/agenda` end to end — hit it against seeded data, eyeball the four sections in the JSON. |
| P2-22 | The Today screen with rows and gestures — run the app, compare against the design mock and `design-system.md` §7.1. |

Resume after a checkpoint with the `--range` the script prints.

**The safety model, so you can trust it while away:**

- No `bypassPermissions` — sessions run `--permission-mode acceptEdits` plus an explicit
  allowlist (pnpm, scoped git, npx/node, docker compose). No push, no installs outside
  the repo, no network fetches beyond what pnpm itself does.
- The script re-runs `pnpm typecheck && pnpm lint && pnpm test` itself after every task.
  A red run gets exactly one repair attempt in the same session, then the run halts with
  the branch left in place.
- Agents are told there is no human: any doc conflict or founder-decision trigger goes
  into `.claude/phase-runs/QUESTIONS.md` and the run **halts** instead of guessing —
  the unattended version of "Ask. Do not decide."
- Every task starts from a clean tree; a dirty tree or a missing branch halts the run.
  `git log --first-parent` on the integration branch reads as one line per task.

When the run completes, review the integration branch as a whole (the checkpoints saw
the risky parts already), merge it to `main`, and run the exit check.

---

## After Phase 1

From Phase 2 on, the generic template is enough — the phase files carry full detail for
every task (or name it on their mechanical list). Two additions worth keeping:

- **Phase gates.** Before starting a phase, run one read-only session: *"Read
  docs/03-implementation/phase-0N-\*.md end to end and docs/03-implementation/roadmap.md
  §risks. List anything already contradicted by the code as built, before I start
  scheduling tasks."* Ten minutes that catches drift while it is still cheap.
- **Parallel work.** Give each agent its own worktree and never let two concurrently-open
  branches both touch `packages/shared/src/schemas/` — that is the merge-order rule in
  git-workflow.md, and it is cheaper to schedule around than to resolve.
