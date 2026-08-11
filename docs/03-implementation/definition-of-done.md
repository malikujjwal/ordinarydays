# Definition of done

**Status:** canonical for what "complete" means. Every task in every phase document and every
phase as a whole is measured against this. A task that meets its own acceptance criteria but
fails this document is not done.

This exists because the project is built by autonomous agents working from written plans. An
agent has no instinct for "this needs a test" or "this should have been documented". Those
judgements are written down here instead, as conditions that can be checked.

Two rules about the document itself:

1. **If a condition here cannot be checked, it does not belong here.** Every line is either a
   command, a number, or a yes/no question about an artefact.
2. **Exceptions are recorded, not assumed.** A condition that does not apply to a particular
   change is stated in the pull request with a one-line reason. Silence is not an exception.

---

## 1. The rule

> A change is done when it is merged to `main`, CI is green, the behaviour it claims is
> covered by a test that fails without it, the documentation that describes it is true again,
> and an operator could diagnose it at 2 a.m. from the logs and the runbook alone.

Everything below is that sentence, made checkable.

---

## 2. Per-task definition of done

Every one of these applies to every task, in every phase.

| # | Condition | How it is checked |
| --- | --- | --- |
| 1 | The task's acceptance criteria in its phase document are met | Named in the PR description, one line each |
| 2 | `pnpm turbo run typecheck` passes with no `any`, no `@ts-expect-error` without a comment naming the reason and a follow-up | CI |
| 3 | `pnpm exec biome ci .` passes with no new suppressions | CI |
| 4 | Tests exist at the layer's required level (§3) and fail when the change is reverted | Review, plus coverage |
| 5 | Coverage thresholds hold, including the near-100% modules (§4) | CI |
| 6 | Every new error path returns a code from the closed enum and a message safe to show a user (§7) | Review + test |
| 7 | Every new failure mode has a log line and, where it can go unnoticed, an alarm (§8) | Review |
| 8 | Documentation that the change makes untrue is updated **in the same pull request** (§9) | Review |
| 9 | `pnpm run gen:openapi` produces no diff | CI |
| 10 | Data changes are additive, or carry a `schemaVersion` bump with an upgrade-on-read path, or ship as two deploys (§10) | Review |
| 11 | Anything risky or incomplete is behind a flag with a default that is safe when the flag is missing (§11) | Review |
| 12 | No `Scan` in application code; no `pk`/`sk` construction outside the repository layer | Lint + IAM deny + review |
| 13 | No new dependency without the justification in §12.3 | Review |
| 14 | If a security trigger in §12.1 is touched, the security checklist is completed in the PR | Review |
| 15 | Accessibility conditions (§5) hold for any UI change | Automated + review |
| 16 | Performance budgets (§6) are not regressed | CI gates + measurement |
| 17 | The PR description uses the checklist in §14 | Review |
| 18 | If the change touches creation, capture, new-list setup, list-item planning, or settlement, the explicit-intent contract gates in §3.1 pass | Named contract + integration tests |

---

## 3. Test coverage expectations, per layer

Coverage percentages are a floor, not a goal. The condition that matters is the second column:
**what must have a test at all**.

| Layer | What must be tested | Minimum coverage | Test kind |
| --- | --- | --- | --- |
| `packages/shared/src/recurrence/**` | Every branch, every DST case, every frequency, every override interaction | **100%** statements, branches, functions, lines | Vitest unit, pure |
| `packages/shared/src/money/**` | Every split mode, the remainder rule, every currency shape, plus the ten named property tests | **100%** statements, branches, functions, lines | Vitest unit + `fast-check` |
| `packages/shared/src/schemas/**` | Each schema accepts a valid object and rejects an unknown key, a wrong type, and each bound | 95% statements | Vitest unit |
| `packages/shared` (everything else) | Each exported function's happy path and each documented edge case | 90% statements | Vitest unit |
| `packages/ui` | Each primitive renders; each interactive primitive has one interaction test and one accessibility assertion | 70% statements | Vitest + Testing Library |
| `services/api/src/services/**` | Every business rule and every authorisation decision, with repositories mocked | 85% statements | Vitest unit |
| `services/api/src/repositories/**` | **Every public method**, plus one tenant-isolation case per repository asserting user A never sees user B's items | Every method covered | Integration against DynamoDB Local |
| `services/api/src/routes/**` | **Every route**: happy path, `401`, the authorisation outcome for each actor (`403`/`404`), and one validation failure | Every route covered | Integration through the Hono app |
| `services/api/src/middleware/**` | Order-dependent behaviour: what runs before what, and what happens when each fails | 90% statements | Vitest unit |
| `services/api/src/worker/**` | Duplicate delivery, out-of-order delivery, partial batch failure, poison record | Every handler covered | Vitest unit + DynamoDB Local |
| `apps/mobile/src/features/*/model/**` | Pure projections, especially every optimistic update, which must agree with what the server returns | 90% statements | Vitest unit |
| `apps/mobile/src/features/*/hooks/**` | Each mutation's optimistic apply **and** its rollback on failure | Every mutation covered | Vitest + `msw` |
| `apps/mobile` screens | One flow per primary journey | Journeys, not percentage | Maestro on simulator |
| Web | One flow per primary journey, plus `axe-core` on every route | Journeys, not percentage | Playwright |
| `infra/**` | Log retention on every log group; no VPC or NAT gateway; no public bucket; the local table schema matches the synthesised one; every alarm has an SNS action | Assertions, not percentage | Vitest + `aws-cdk-lib/assertions` |

**Rules that override the table.**

- **A bug fix ships with a test that fails on the previous commit.** No exceptions. If the bug
  cannot be reproduced in a test, the diagnosis is incomplete.
- **A test that asserts an implementation detail rather than a behaviour is a liability.** Do
  not assert the number of calls to a repository unless the number is the behaviour.
- **Snapshot tests are for output formats** — `.ics` files, the public invite projection, email
  bodies, notification copy — not for component trees.
- **A test that has been skipped for more than one merge is deleted**, and the gap is recorded
  as an issue. A permanently skipped test is worse than no test: it looks like coverage.

### 3.1 Explicit-intent, linkage, and settlement contract gates

These apply whenever the named surface is touched. They are cross-layer behavior tests, not
review reminders; a PR marks an unrelated row `n/a` and names why.

| Surface | Required gates |
| --- | --- |
| Task / Plan / ListItem creation | The client supplies a `CreationTarget` before entry; Plan includes a user-selected `PlanType`, ListItem includes a selected `listId`, and omission or an incompatible combination is `400`. Run the same ambiguous title through at least two explicit targets and assert the selected target wins. No title, date, participant, list behavior, or server/model output chooses object kind, type, or destination. |
| New list | The style catalogue starts with nothing selected. `POST /v1/lists` requires the exact user-selected `templateKey`; omission is `400` and writes nothing. A title change does not change the key. There is no title matcher, recommended template, or implicit simple-list fallback. The server copies behaviour, capabilities, slot, icon and empty-state copy from that exact record, rejects client overrides, and a catalogue mutation cannot change any of those stored values on an existing List. |
| `Plan this item` | The request requires `{ objectKind: 'plan', type: PlanType }` plus exactly one audience, `just_me` or non-empty `selected_people`. A shared list never pre-selects its members. Test private Plans from the same item under two users and a selectively shared Plan: only explicit participants get Activity access, and only those who are also active list members get viewer pointers. |
| Shared List → People relationship | Only a confirmed member selection creates the relationship; titles and item words never do. A registered add creates/reuses reciprocal owner-scoped People and two active `LLINK#` rows; an accountless invite creates only an owner invited link until verified signup. Active links power `sharedListCount`/`listsTogether` but never authorise a List or affect Plan counters/relevance. Removal and list deletion remove links but retain People; Person delete names invited/active List blockers; merge migrates and deduplicates membership and links. Test all paths, including two non-owner co-members receiving no implicit relationship. |
| List / Activity linkage | `ListItem` has no `linkedActivityId`. Links are `LIST#<listId>` / `LNK#<viewerUserId>#<itemId>` rows; list detail removes other viewers' rows **before** Activity lookup and authorisation. Renaming either object never mirrors to the other. Deleting or replacing one viewer's pointer leaves the ListItem, every Activity, and other viewers' pointers intact. |
| Settlement | The strict request is exactly `{ personId, coversExpenseIds }`, with 1–25 distinct ids. Tests reject duplicates, client-supplied `amountCents`, currency, direction, note, method, reference, remainder, and unknown keys. Each id resolves without a Scan; the server stores exact per-Expense debtor coverage, marks only those expense-person obligations, derives display metadata, and recomputes balances from Expenses only. Undo resolves by `settlementId`, preserves every other debtor, and deletes its locator. The Settlement row is immutable audit history, never a payment delta. Editing/deleting a covered Expense **or its parent Activity** is `409 settlement_conflict` until the user explicitly undoes every blocking Settlement, with zero hidden fix-up or tombstone writes; a permitted delete removes each Expense locator. |
| Leaving with expenses | Removing or leaving deletes Plan access and Activity index entries. If retained Expenses need the relationship, its PersonLinks become `finance_only`: excluded from People activity history and forbidden from Plan reads, but accepted by exact expense drill-down, settlement, Undo, stream replay, and full balance rebuild. The last Expense deletion removes those links. |
| Capture | Every endpoint requires and exactly echoes `creationTarget`, returns only fields compatible with it, and writes no target object. Closed model-output schemas contain no object kind, Plan type, list destination, participant, audience, sharing, reminder/notification, or save field. Paired-target fixtures prove there is no intent classifier; `with Alice` cannot add a person, and `remind me an hour before` cannot change the visible Reminder control. Only an explicit Reminder action or the user's saved default may supply one. |

---

## 4. The near-100% modules

`packages/shared/src/recurrence/**` and `packages/shared/src/money/**` are held at **100%
statements, branches, functions and lines**, enforced by per-directory thresholds in the Vitest
config and failing CI below it.

They are singled out because they are the two places where a wrong answer is silent. A broken
screen is obvious within a minute; a recurrence that skips one occurrence a year, or a split
that loses a cent on one in three hundred expenses, is discovered by a user, months later, and
undermines trust in everything else the app says.

Consequences to accept rather than work around:

- A defensive `throw` that "cannot happen" needs a test that reaches it. If it genuinely cannot
  be reached, it is dead code and is deleted. Either outcome is an improvement.
- These modules stay pure: no I/O, no clock read, no `process.env`, no locale dependence.
  `now`, `timezone` and `locale` are parameters. That is what makes 100% achievable.
- A change to either module that drops coverage below 100% does not merge, even behind a flag.

---

## 5. Accessibility checks

Applies to every change that touches UI. From
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6, which is
the specification; this is the checklist.

| # | Check | Automated? |
| --- | --- | --- |
| 1 | Every interactive element is at least 44 × 44 pt, with ≥ 8 pt between adjacent targets | Yes — hit-target test |
| 2 | Every `Pressable` has an `accessibilityRole` and either an `accessibilityLabel` or accessible text children | Yes — tree-walking test |
| 3 | State is spoken, not implied by colour: `not completed`, `checked`, `unread`, `pending`, `awaiting reply` | Review + label test |
| 4 | Every swipe action is also exposed as an `accessibilityAction` on the row | Yes — per row type |
| 5 | The screen renders with no clipping at the largest accessibility text size (`AX5`) and at 320 pt width | Yes — snapshot at three sizes |
| 6 | `allowFontScaling={false}` appears nowhere | Yes — lint rule |
| 7 | Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and control boundaries, in **both** themes | Yes — token pair test |
| 8 | Colour is never the only carrier of meaning | Review |
| 9 | Reduce Motion is honoured: cross-fades, no insert/remove animation, no toast slide | Yes — config test |
| 10 | Focus order equals visual order; no positive `tabIndex`; focus is trapped in a sheet and returns on close (web) | Yes — Playwright |
| 11 | `axe-core` reports zero `serious` or `critical` violations on every web route | Yes — Playwright |
| 12 | Any new aggregate number is tappable and reaches the records behind it | Review + the `<Balance>` lint rule |

Items 3, 8 and 12 are review judgements. They are on the PR checklist so they are answered
rather than assumed.

---

## 6. Performance budgets

A change that regresses any of these does not merge. Where a budget has no automated gate, the
measurement is recorded in the PR.

The budgets whose gate is a deploy job or a nightly run against dev cannot be measured before
**Phase 4**, because nothing is deployed until then. In Phases 0–3 they are targets that the
design must not obviously violate, and they are measured for the first time on the first
deployed dev environment (P4-13) — not waived.

| Budget | Value | Gate |
| --- | --- | --- |
| Lambda init duration, p95 | ≤ **400 ms** | Cold-start test in the deploy job |
| Cold `GET /v1/agenda`, end to end | ≤ **700 ms** | Deploy-job measurement |
| Warm `GET /v1/agenda`, server-side p95 | ≤ **60 ms** | Nightly load test against dev |
| DynamoDB round trips per agenda request | ≤ **4** | Test asserting the call count |
| DynamoDB round trips, any other endpoint | ≤ **3** without a written justification in the PR | Review |
| Lambda artifact, zipped | ≤ **5 MB** | `pnpm run check:bundle-size` in CI (P0-28) |
| App launch to first painted row, warm cache | ≤ **1.0 s** | Maestro timing, median of 10 |
| App launch to first painted row, cold | ≤ **2.0 s** | Maestro timing, median of 10 |
| Add screen open to keyboard-ready | ≤ **300 ms** | Maestro timing |
| Today scroll, 100 rows, iPhone 11 | ≥ **58 fps** average, no frame over 32 ms | Recorded measurement |
| `/invite/[token]` initial JS, gzipped | ≤ **120 KB** | Bundle analysis in CI |
| Any authenticated route's initial JS, gzipped | ≤ **350 KB** | Bundle analysis in CI |
| First authenticated load, total JS, gzipped | ≤ **900 KB** | Bundle analysis in CI |
| Capture call, p95 end to end | ≤ **6 s** | Evaluation harness gate |
| API response body, 30-day agenda for a heavy user | ≤ **200 KB** | Integration assertion |

Budgets are revised with evidence, in a pull request that shows the measurement. They are not
revised because a change did not fit.

---

## 7. Error handling

| # | Condition |
| --- | --- |
| 1 | Every thrown error is an `AppError` with a code from the closed enum in `packages/shared/src/errors.ts`. A raw `Error` reaching the handler is a `500` and a bug. |
| 2 | The `message` on a `4xx` is written for a person to read and contains no exception text, no stack, no DynamoDB fragment and no internal identifier. |
| 3 | Every `500` returns the literal string `An unexpected error occurred.` — never the exception. |
| 4 | Every response carries a `requestId`, and every client error surface shows it in small, copyable text. |
| 5 | A stranger gets `404`, never `403`. `403` is used only where the caller already knows the resource exists. |
| 6 | Every `5xx` logs at `error` with a stack; every `4xx` logs at `warn` without one. |
| 7 | No new error path swallows an exception. A caught error is either handled, re-thrown, or logged with a reason for continuing, stated in a comment. |
| 8 | Every client mutation has a failure path: the optimistic change reverts, and an error toast names what failed (`Couldn't complete "Gym."`), with `Retry` where retrying is meaningful. |
| 9 | Retries have a retryability predicate and exponential backoff. A blanket `retry: 3` on a non-idempotent call is a bug. |
| 10 | A background worker never fails a whole batch for one bad record where partial failure reporting is available. |
| 11 | An external dependency (SES, the model provider, Expo Push) failing never fails the user's primary action. It degrades and is logged. |
| 12 | A rate limiter, a cache or a metrics write failing fails **open**, not closed. |

---

## 8. Observability

Every change that adds a failure mode adds the means to see it.

| # | Condition |
| --- | --- |
| 1 | One structured log line per request, carrying `requestId`, `route`, `status`, `durationMs`, `coldStart` and, when known, `userId`. |
| 2 | Every new failure mode logs a **stable event code** (`balance_divergence`, `capture_budget_exhausted`, `invite_send_failed`) that a Log Insights query can filter on. Codes are grep-able constants, not interpolated strings. |
| 3 | No content in logs, ever: no title, note, description, location, email, display name, token, image byte or model input. The `pino` redaction list covers each; a test feeds an object containing all of them and asserts none of the values appear. |
| 4 | An email address that must be correlated is logged as a SHA-256 hash. An IP address is hashed before it is written anywhere. |
| 5 | A failure that a user would not notice — a stale cache, an abandoned worker record, a failed send, an exhausted budget — has an **alarm**, not just a log line. A failure the user sees immediately does not need one. |
| 6 | Every new alarm publishes to `od-alerts-{env}` and its meaning and first action are added to the runbook's alarm index in the same PR. |
| 7 | Custom metrics stay rare (the free allowance is ten). Prefer a Log Insights query; use an EMF counter only when the query is too slow to be useful, and say why in the PR. |
| 8 | A new asynchronous path (a stream handler, a scheduled job, a queue consumer) ships with a DLQ or an equivalent, and an alarm on it being non-empty. |
| 9 | Every log group has an explicit retention. A CDK assertion fails the build otherwise. |

---

## 9. Documentation

**Documentation is updated in the same pull request as the code, or the pull request is not
done.** A follow-up documentation task is a promise, and promises rot.

| Change | Document to update |
| --- | --- |
| A new or changed endpoint | [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2, then regenerate the OpenAPI spec |
| A new item type, key pattern or entity field | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §3 or §4 |
| A new query shape | The access-pattern table in [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §5 — **before** writing the code |
| A new multi-item write | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §7, with its item count |
| A behaviour a user can see | The relevant `01-product/` document |
| A gesture, state or accessibility rule | [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) |
| A new notification | The catalogue in [`../01-product/notifications.md`](../01-product/notifications.md) §7 |
| A new AWS resource or a changed setting | [`../02-architecture/aws-services.md`](../02-architecture/aws-services.md) and, if it costs anything, [`../02-architecture/cost-model.md`](../02-architecture/cost-model.md) |
| A choice with a rejected alternative | A new ADR in [`../02-architecture/decisions.md`](../02-architecture/decisions.md) |
| An answered open question | The OQ table in [`../02-architecture/decisions.md`](../02-architecture/decisions.md), moved to an ADR |
| A new operational procedure or alarm | `docs/05-operations/runbook.md` |
| A new limit or constant both sides enforce | `packages/shared/src/constants.ts`, imported by both — never two copies of the number |

`docs/generated/openapi.json` is checked in and CI fails on a diff. Regenerating it is part of
the change, not a chore afterwards.

---

## 10. Migration safety

DynamoDB has no schema, so "migration" means one of three things and each has one correct
handling.

| Kind | Handling |
| --- | --- |
| **Additive** — a new optional attribute | No migration. The repository defaults it on read. This is the large majority. |
| **Shape change** — an attribute's meaning or type changes | Bump `schemaVersion`, handle it in the repository's upgrade-on-read path, persist the upgraded shape on the next write. No downtime, no backfill. |
| **Key change** — a new access pattern needing a new key or index | Two deploys, never one. Deploy the code that writes the new attribute; run the backfill; only then deploy the code that reads it. |

Rules for any change touching stored data:

1. **The old shape must still read correctly after the deploy.** A deployed client is always
   older than the server; a rollback puts an older server in front of newer data. Both must
   work.
2. Backfill scripts live in `infra/scripts/migrations/NNNN-description.ts`, are reviewed like
   code, are **idempotent**, accept `--dry-run` (defaulting to **true**) and `--stage`, and log
   every item they would change before changing anything.
3. They are the only place a `Scan` is permitted.
4. They run against dev first, always. Before a prod run: PITR is on, and an on-demand backup
   is taken (`aws dynamodb create-backup --table-name od-main-prod --backup-name
   pre-migration-NNNN`).
5. A migration is never bundled with a feature in the same pull request. It merges, runs, and
   is verified on its own.
6. Deleting a field is a two-stage operation with a release between: stop writing it, ship,
   confirm nothing reads it, then remove it from the type.
7. Until the first TestFlight build, `od-main-dev` may simply be wiped
   ([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §9). After that,
   migrations are mandatory in both environments.

---

## 11. Feature flags

> **Decision — flags are SSM parameters at `/od/{stage}/flags/<name>`, read at cold start with
> a five-minute TTL, defaulting to the safe value when the parameter is missing.** No
> third-party flag service: that is another vendor, another SDK in the cold-start budget, and
> another thing to be down. Five minutes is fast enough for an incident and slow enough to cost
> nothing.

| # | Rule |
| --- | --- |
| 1 | A flag's **default when absent is the safe value** — feature off, kill switch engaged. A missing parameter must never enable something. |
| 2 | Client-visible flags are returned in `GET /v1/me` under `flags`. There is no client-side flag store and no second source of truth. |
| 3 | Every flag is created with an owner, a default, a purpose, and a **removal date** recorded in `docs/05-operations/flags.md`. |
| 4 | A flag past its removal date is a failing check in the nightly workflow. Flags are temporary by definition; a permanent one is configuration and belongs in `config.ts`. |
| 5 | Both sides of a flag are tested. A branch that CI never executes is a branch that does not work. |
| 6 | Kill switches use the same mechanism: `capture.enabled`, `auth.min-token-issued-at`, and the `X-Client-Version` `426` path. Each is rehearsed at least once before it is needed. |
| 7 | A change that is risky, incomplete, or dependent on an unreleased client ships behind a flag rather than sitting on a long-lived branch. |

---

## 12. Security review triggers

### 12.1 When a security review is required

A pull request touching any of these completes the checklist in §12.2 in its description. It is
not optional and it is not a separate approval step — it is a set of questions answered in
writing.

| Trigger |
| --- |
| The auth middleware, token verification, or anything reading a claim |
| `assertActivityAccess` or any authorisation decision |
| Any route under `/public/v1/*` |
| The public invite projection, or any field added to `Activity` |
| Any handler that serialises the `ACT#<id>` partition — the caller-scoped `REM#` filter lives there, and a projection that returns what it read leaks one user's reminders to another (`../02-architecture/security-privacy.md` §1 row 15) |
| Any list-detail projection or `LNK#<viewerUserId>#<itemId>` write — the shared partition contains opaque Activity ids belonging to other viewers, and filtering after lookup is already a leak (`../02-architecture/security-privacy.md` §1 row 15a) |
| Any IAM policy, role, or CDK `grant*` call |
| Presigned URL generation, or the media bucket's configuration |
| The `.ics` builder or the Google Calendar redirect (output encoding, open redirect) |
| Any money path: split arithmetic, balances, settlements |
| Secrets: reading, storing, rotating, or a new one |
| The capture prompt, the model output schema, or the link fetcher |
| Rate limiting, spend accounting, or a kill switch |
| Account deletion, data export, or the retention job |
| A new dependency, or a major version bump of an existing one |
| Anything writing to or reading from a shared container (App Group, keychain, `localStorage`) |

### 12.2 The security checklist

- [ ] The tenant key comes only from the verified token, never from a path, query or body.
- [ ] A caller with no relationship to the resource gets `404`, not `403`.
- [ ] Every new input is validated by a shared Zod schema with `.strict()` and explicit bounds.
- [ ] No server-derived field (`ownerId`, `status`, counters, timestamps) is accepted from the
      client.
- [ ] No new response field exposes an email address, an internal identifier, or another user's
      data — including another user's **reminder**, which lives in a partition every
      participant may read and is scoped only by the projection's filter.
- [ ] If list links are touched: list detail keeps only the authenticated caller's `LNK#`
      rows before any Activity lookup, every retained Activity passes ordinary authorisation,
      and no response contains another viewer's Activity id or state.
- [ ] If the public projection is touched: the allow-list snapshot test was updated
      deliberately and the deny list in
      [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.3 still
      holds.
- [ ] No new IAM permission is broader than the code path needs; no `Resource: "*"` without a
      stated reason.
- [ ] No secret in the repository, in a Lambda environment variable, in a log line, or in an
      error message. `gitleaks` is green.
- [ ] No content (titles, notes, emails, image bytes, model inputs) reaches a log line.
- [ ] Any redirect target is validated against a host allow-list.
- [ ] Any outbound fetch resolves and checks the destination address on every hop.
- [ ] Money paths use integers only and are validated server-side regardless of what the client
      computed.
- [ ] Rate limits apply, and the limiter fails open.

### 12.3 New dependencies

Adding a dependency is a decision recorded in the PR, with: what it does, why nothing already
present does it, its weekly download count, its last publish date, its transitive dependency
count, and its licence. Exact version, `--frozen-lockfile`, no lifecycle scripts unless
explicitly approved in `pnpm.onlyBuiltDependencies`. `pnpm audit --audit-level=high` is green.
The best supply-chain defence is a small tree, and every addition is measured against that.

> **Known accepted advisories (2026-08-11):** `image-size`
> `GHSA-w3rx-r6r6-pgpr` / `GHSA-5p2g-fcmc-qvqq` — build-time only (Metro asset handling),
> DoS class, no patched release; re-check each nightly-audit design review and drop this note
> when Metro ships a fix.

---

## 13. Per-phase definition of done

A phase is done when all of these hold, not when its last task merges.

| # | Condition |
| --- | --- |
| 1 | Every task in the phase's table is merged, or explicitly deferred with a recorded reason and a destination phase. |
| 2 | Every numbered acceptance criterion in the phase document is demonstrated — by a named test, a recorded measurement, or a walkthrough with a date. |
| 3 | The phase's deliverable checklist is fully ticked. |
| 4 | Every canonical-document amendment the phase declared has landed. |
| 5 | Every open question the phase was supposed to close is closed, and its ADR is written. |
| 6 | The full test suite passes on `main`, with no skipped tests introduced by the phase. |
| 7 | Coverage thresholds hold, including 100% on the recurrence and money modules. |
| 8 | **From Phase 4 on:** the dev environment is deployed from `main` and its smoke tests and E2E suites are green. In Phases 0–3 nothing is deployed, so the equivalent gate is that `cdk synth` and the CDK assertion tests pass in CI and the E2E suites are green against the local stack. |
| 9 | Every performance budget in §6 is measured — not assumed — and met. |
| 10 | Every new alarm has fired at least once in a rehearsal, or has been verified by a synthetic trigger. |
| 11 | The runbook covers every new operational procedure and alarm the phase introduced. |
| 12 | The cost model is re-checked against the phase's new resources, and any new line item is added. |
| 13 | No feature flag introduced by the phase is past its removal date. |
| 14 | The phase's `Out of scope` list is still true — nothing on it was quietly built. |

---

## 14. The pull-request checklist

Copy this into every pull request description. Delete nothing; answer `n/a` with a reason where
a line does not apply.

```markdown
## What and why

<one paragraph: what changed, and which task ID and acceptance criteria it satisfies>

## Correctness
- [ ] Acceptance criteria met: <list the criterion numbers>
- [ ] Tests added that fail on the previous commit
- [ ] Edge cases from the task description are covered by tests
- [ ] `pnpm turbo run typecheck` passes; no new `any`, no undocumented `@ts-expect-error`
- [ ] `pnpm exec biome ci .` passes; no new suppressions
- [ ] Coverage thresholds hold (100% on `recurrence/**` and `money/**` if touched)

## Contract and docs
- [ ] `pnpm run gen:openapi` produces no diff
- [ ] `api-contract.md` / `data-model.md` updated if endpoints, entities or keys changed
- [ ] Product docs updated if user-visible behaviour changed
- [ ] If creation, new-list, `Plan this item`, settlement or capture changed: the applicable
      explicit-intent contract gates in §3.1 pass; no type, destination, template, audience,
      participant, reminder/notification action or external payment detail is inferred
- [ ] New access pattern added to `data-model.md` §5 **before** the query was written
- [ ] New limit or constant added to `packages/shared/src/constants.ts`, imported by both sides
- [ ] ADR written if an alternative was rejected; OQ table updated if a question was answered

## Data
- [ ] Change is additive, or bumps `schemaVersion` with upgrade-on-read, or ships as two deploys
- [ ] Old-shape items still read correctly after this deploy
- [ ] A rollback to the previous version still works against data this version wrote
- [ ] Backfill script (if any) is idempotent, defaults to `--dry-run`, and was run against dev

## Errors and observability
- [ ] New error paths use a code from the closed enum with a user-safe message
- [ ] `404` (not `403`) for callers with no relationship to the resource
- [ ] New failure modes log a stable event code
- [ ] Failures a user would not notice have an alarm, and the runbook's alarm index is updated
- [ ] No content, email, token or image byte reaches a log line

## Security
- [ ] No security trigger touched — **or** the §12.2 checklist is completed below
- [ ] No new dependency — **or** the §12.3 justification is included below
- [ ] `gitleaks` and `pnpm audit --audit-level=high` are green

> **Known accepted advisories (2026-08-11):** `image-size`
> `GHSA-w3rx-r6r6-pgpr` / `GHSA-5p2g-fcmc-qvqq` — build-time only (Metro asset handling),
> DoS class, no patched release; re-check each nightly-audit design review and drop this note
> when Metro ships a fix.

## UI (delete if not a UI change)
- [ ] Hit targets ≥ 44×44 with ≥ 8 pt separation
- [ ] `accessibilityRole` and a label or accessible text on every interactive element
- [ ] Swipe actions also exposed as accessibility actions
- [ ] Verified at `AX5` text size and at 320 pt width
- [ ] Contrast verified in both light and dark themes
- [ ] Colour is not the only carrier of any meaning
- [ ] Any aggregate number is tappable through to its records
- [ ] Loading, empty and error states implemented per the interaction contract
- [ ] `axe-core` clean on affected web routes

## Performance
- [ ] No budget in `definition-of-done.md` §6 regressed
- [ ] Measurement recorded here if a budget was near its limit: <numbers>

## Flags
- [ ] Behind a flag, with a safe default when the parameter is missing, and a removal date
      recorded in `docs/05-operations/flags.md` — or `n/a` with a reason

## Rollback
- [ ] How to undo this: <one line>
```
