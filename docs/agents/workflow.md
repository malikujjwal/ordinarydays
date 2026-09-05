# Project workflow and skill selection

Established 2026-09-04 from the checked-in code and automation at `5267327`.
This guide routes work; the [agent playbook](../04-conventions/agent-playbook.md),
area contracts, and [definition of done](../03-implementation/definition-of-done.md)
remain authoritative. Installed skills supply techniques, not replacement product rules.

## Default delivery loop

1. **Identify the outcome and owner.** Read `git status`, the supplied request or issue,
   and the relevant row in [CONTEXT-MAP.md](../../CONTEXT-MAP.md). For roadmap work,
   use its existing phase task ID and dependencies. A direct maintenance, investigation,
   or documentation request is its own scope; do not invent a phase ID or remote issue.
2. **Read the affected contracts and trace one real path.** Follow the screen/hook through
   the shared client, API service, repository, and persistence where applicable. State the
   observable acceptance conditions, exclusions, and verification commands before editing.
   Use the playbook's area-specific reading table instead of loading every phase document.
3. **Select one primary skill for the current phase.** Use the table below. An already
   specified phase task can go straight to implementation. Add specification or ticket
   work only when a real ambiguity or dependency requires it.
4. **Implement a small complete behavior.** Keep the domain/API/platform changes for that
   behavior together. For a regression, reproduce it with a failing behavioral test before
   fixing it. Run focused tests during iteration; record unrelated baseline failures.
5. **Verify at the affected boundaries.** Use the command matrix below and the task's
   acceptance criteria. Native persistence, gestures, notifications, and process restart
   require native evidence; a successful web run cannot establish their acceptance.
6. **Review and deliver.** Review against both requirements and coding standards, update
   affected canonical docs, and describe the behavior, evidence, and outstanding gates.
   Follow the existing branch/PR conventions. Distinguish implementation ready, verified,
   merged with green CI, and native/release accepted; the definition of done governs closure.

Completion evidence names the source revision, commands, results, and any unrun criteria.
For native work include Xcode/runtime/device, build configuration/profile, and artifact or
log location. A compilation result closes compilation only, not a Maestro/device matrix.

## Skill routes

Names below use the installed `matt-skills-curated:` prefix. Read the selected skill's
`SKILL.md` when using it; this table is not a replacement for its instructions.

| Situation | Route | Expected output |
| --- | --- | --- |
| Existing phase task with clear acceptance criteria | `implement` | Scoped behavior, tests, verification and review |
| Reproducible bug or unexplained runtime failure | `diagnosing-bugs` → `tdd` | Root cause, failing regression test, verified fix |
| New behavior with unresolved product decisions | `grill-with-docs` → `to-spec` | Only necessary questions, then a buildable contract |
| Approved work too large for one coherent change | `to-tickets` → `implement` | Ordered local slices with dependencies; remote tickets only when authorized |
| Review of a completed change | `code-review` | Separate standards and specification findings against a pinned revision |
| Change to domain language, ownership, or a cross-area invariant | `domain-modeling` | Canonical contract updates and an ADR where needed |
| Unclear module boundary or coupling problem | `codebase-design`; use `improve-codebase-architecture` for a requested broader survey | Evidence and a bounded refactor proposal |
| Uncertain interaction that needs an experiment | `prototype` | A disposable experiment answering a named question |
| Agent instructions or workflow documentation | `writing-for-agents` | Concise guidance linked from the repository entry points |
| Work continuing in another session | `handoff` | Revision, decisions, changed files, evidence, blockers and next action |
| Explicitly requested long autonomous effort | `goal`; `wayfinder` when a persistent decision map is warranted | Observable completion contract and durable progress context |

Use `engineering-workflow-guide` only when the route is unclear. Routine fixes do not need
an interview, new specification, ticket graph, or architecture survey. Use `retro` after a
meaningful delivery problem to improve the specific instruction or check that missed it.

The `code-review` skill specifies two review subagents. The `implement-spec` skill is for
deliberate multi-agent execution across a task graph; it is not the default for every phase
task. Follow the selected skill and current user/runtime delegation constraints.

## Architecture that determines the workflow

- **Expo/React Native with an exported web app.** Inspect both platform implementations
  when changing hooks. For example, `useLists.native.ts` reads subscribed SQLite repositories;
  `useLists.ts` uses online-first TanStack queries. Native domain mutations belong in the
  transactional coordinator/outbox path, not a second query-cache materializer.
- **Shared domain contracts.** Schemas, explicit creation intent, recurrence, ranks and API
  types live in `packages/shared`. Follow existing public entry points and reuse helpers.
  Changes can affect both client platforms and the API; verify all affected consumers.
- **Hono and DynamoDB/S3.** Business rules live in services and storage access in repositories.
  Test storage behavior against DynamoDB Local/MinIO, including isolation, conflicts,
  idempotency and bounded reads where relevant. Keep shared UI primitives domain-free.
- **AWS CDK infrastructure.** Follow the existing deployment and identity phase contracts.
  The installed Next.js, Vercel hosting and Neon skills do not match this stack and are not
  default choices. Do not introduce another framework, database, or hosting workflow merely
  because a plugin is available.
- **Existing enforcement.** Keep pnpm/Turbo, Biome, Vitest, dependency-cruiser, Lefthook,
  gitleaks, Playwright and Maestro. Tracker/triage/domain conventions are already configured;
  setup skills are for an identified gap, not an additional setup pass.

For web interaction checks, use the existing Playwright suites. The installed
`vercel:agent-browser` skill can assist exploratory browser inspection when needed, but it
does not replace those suites or native verification. AI engineering skills become relevant
when the actual capture phase is in scope; they are not a prerequisite for ordinary app work.

## Verification matrix

Run commands from the repository root. `package.json` and CI remain the executable source
of truth. Use focused checks during development, then the existing required delivery gates.

| Change / gate | Existing command or workflow |
| --- | --- |
| Focused workspace tests | `pnpm --filter @od/mobile exec vitest run <test-file>` (substitute `@od/shared`, `@od/ui`, or `@od/api` as appropriate) |
| Standard pre-PR checks | `pnpm verify` |
| Shared scope guards | `pnpm --filter @od/shared test:guards` (included in `pnpm test`, not `pnpm verify`) |
| Storage/API integration | `pnpm test:int` starts the test services and runs integration suites |
| Schema or endpoint changes | `pnpm gen:openapi`, review the generated diff, then `pnpm gen:openapi:check` against the committed result |
| Web journeys | `pnpm e2e:web` with local services available; see the `e2e` CI job for setup |
| List UI and shared shell visual contracts | `pnpm e2e:lists-visual`; native capture/comparison follows `.github/workflows/lists-visual.yml` |
| CDK/runtime packaging | `pnpm --filter @od/infra exec cdk synth 'od-*-dev' --quiet`; `pnpm check:bundle-size` |
| Native compilation | Local-profile Release build via `pnpm --filter @od/mobile exec expo run:ios --device <simulator-id> --configuration Release --no-bundler`, with `EXPO_PUBLIC_PROFILE=local` |
| Native journeys and acceptance | Maestro catalogue in `apps/mobile/e2e`, with API/proxy setup from `.github/workflows/mobile.yml`, plus the documented device matrices |
| Documentation-only changes | Check links, command accuracy and `git diff --check`; state code tests are not applicable rather than implying they ran |

`pnpm verify` is not all of CI: integration, web E2E, OpenAPI drift, native workflows,
bundle-size, Expo health and secret checks have separate commands/jobs. Conversely,
`pnpm build` exports the mobile **web** app; it is not proof of an iOS compilation.
Do not mark a gate passed merely because its workflow exists, or approve changed visual
baselines without inspecting their appearance.

## Concurrent work and the next milestone

Use separate checkouts/worktrees for concurrent editing tasks. Agree on ownership of shared
schemas, generated OpenAPI, lockfiles and native build files before overlapping work. Never
stage, discard, or rewrite another task's changes. Avoid running competing native builds or
test services on the same simulator/ports; a handoff should identify those resources.

At this checkpoint another agent owns macOS compilation. Consume that agent's revision and
build evidence when available; this workflow review does not claim the build or any device
gate passed. Reconcile the deferred Phase 2/2.5/2.6 acceptance records separately from Phase 3
implementation status, then use the prerequisites in
[Phase 4 — Deploy and identity](../03-implementation/phase-04-deploy-and-identity.md)
to select subsequent work. Do not infer phase completion from the existence of code alone.
