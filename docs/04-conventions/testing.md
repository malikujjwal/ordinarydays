# Testing

**Status:** canonical for what gets tested, how, and what blocks a merge. The tool choices
are locked by the project brief and
[`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §2.5: Vitest,
`aws-sdk-client-mock`, DynamoDB Local, Playwright, Maestro. This document says how they are
used.

The purpose of the suite is not coverage. It is that an autonomous agent can change
recurrence expansion, money splitting, or a repository and know within 30 seconds whether it
broke the product.

---

## 1. The pyramid

| Layer | Runner | Where | Target count at v1 | Runtime budget | Covers |
| --- | --- | --- | --- | --- | --- |
| Unit — pure domain | Vitest | `packages/shared/src/**/*.test.ts` | ~450 | < 10 s | Recurrence, money, ranks, wall-clock maths, schema validation, ID generation |
| Unit — server logic | Vitest | `services/api/src/**/*.test.ts` | ~180 | < 15 s | Services with mocked repositories, middleware, error mapping, cursor encoding |
| Unit — client logic | Vitest | `apps/mobile/src/**/*.test.ts` | ~120 | < 15 s | Optimistic projections in `model/`, query-key factories, formatting |
| Component | Vitest + RNTL | `apps/mobile/**`, `packages/ui/**` | ~80 | < 40 s | Row and primitive behaviour, accessibility labels, states |
| Handler / route | Vitest + `aws-sdk-client-mock` | `services/api/test/routes/**` | ~70 | < 20 s | One test per endpoint in `api-contract.md` §2: happy path, auth, validation |
| Integration — repository | Vitest + DynamoDB Local | `services/api/test/integration/**` | ~60 | < 90 s | Key design, transactions, GSI1 projections, tenant isolation, pagination |
| Infrastructure | Vitest + `aws-cdk-lib/assertions` | `infra/test/**` | ~25 | < 30 s | Stack synthesis, IAM shape, removal policies, table schema parity |
| E2E — web | Playwright | `e2e/specs/**` | 8 flows | < 4 min | The flows in §6.1 against the exported static site |
| E2E — iOS | Maestro | `apps/mobile/e2e/**` | 6 flows | < 8 min | The flows in §6.2 on a simulator |

Counts are targets, not quotas. A layer far under its target means something is untested; a
layer far over usually means tests were written at the wrong level — the commonest version
of that mistake is testing recurrence behaviour through an HTTP route instead of through
`expandRecurrence`.

**The rule that keeps the shape right:** a behaviour is tested at the lowest layer that can
express it. An E2E test exists to prove the pieces are wired together, not to check a
calculation.

---

## 2. Unit tests (Vitest)

### 2.1 What must be unit-tested

| Must | Because |
| --- | --- |
| Every function in `packages/shared/src/recurrence/**` | §2.2 |
| Every function in `packages/shared/src/money/**` | §2.2 |
| `packages/shared/src/rank/lexoRank.ts` | Ordering corruption is silent and permanent |
| `packages/shared/src/time/**` | The wall-clock/instant distinction is the model's spine |
| Every Zod schema's rejection cases, not just its acceptance cases | The schema is the security boundary (`security-privacy.md` §4.1) |
| Capture schemas reject a missing request target, a changed echoed target, target/type keys inside model fields, participant or sharing writes, and every reminder/notification key (`reminder`, `reminders`, `offsetMinutes`) | Text and models may fill only fields compatible with the user's explicit choice; reminders come only from the visible control or an explicitly saved default |
| Every service method in `services/api/src/services/**` | Authorisation lives here |
| `middleware/errorHandler.ts` — one case per row of the mapping table | A wrong status is a client bug that looks like a server bug |
| `lib/cursor.ts` — round-trip, tamper rejection, cross-user rejection | A crafted cursor is a tenant-isolation hole |
| `lib/logger.ts` redaction | `security-privacy.md` §1 row 8 |
| Every pure function in `apps/mobile/src/features/*/model/**` | An optimistic projection that disagrees with the server makes rows visibly flip back |

### 2.2 The two modules held at ~100%

`packages/shared/src/recurrence/**` and `packages/shared/src/money/**` are held at
**100% statements and branches**, enforced by `@vitest/coverage-v8` thresholds and by CI
(§9). They are the only modules with that requirement.

**Recurrence.** It is the hardest logic in the product, it is pure, and it is invisible when
wrong: a DST bug or an off-by-one at a month boundary produces an agenda that is subtly
wrong rather than an error anyone sees. It has no I/O, so 100% is achievable without
elaborate mocking. Required cases:

| Case | Assertion |
| --- | --- |
| `daily`, `weekly`, `monthly`, `weekdays`, `interval_days` over a 62-day window, and `yearly` over a multi-year window | Exact date list |
| `byWeekday` with multiple days, `byMonthDay` including day 31 in a 30-day month | Month-end clamping: the 31st emits the last day of the shorter month, never skipped and never spilled into the next (`today-and-tasks.md` §6.1) |
| A `yearly` series with explicit `byMonth` + `byMonthDay`, and one with neither | The anchors drive expansion when present; the segment's `effectiveFrom` is the fallback for a hand-constructed series (`data-model.md` §4.2) |
| DST spring-forward and autumn-back in `America/New_York` and `Europe/London` | A 6 PM daily task is 6 PM local on every date, and its `Instant` shifts by an hour |
| `endDate` and `count` termination, and both together | The tighter bound wins |
| Window entirely before the first segment's `effectiveFrom`, entirely after `endDate` | Empty array, no throw |
| A window of exactly 62 days and of 63 days | 62 expands; 63 is rejected upstream |
| Occurrence overrides: `completed`, `skipped`, `snoozed`, `rescheduled` | Merge behaviour per `data-model.md` §6 step 5 |
| `after_completion` mode | At most **one** future occurrence; never projected |
| A leap day series | 29 February handled per `freq` |
| 200 active series | Returns `series_limit_exceeded` as a warning, not an error |

**Money.** Every value is someone's actual money and the failure is a number that does not
add up — which erodes trust in the whole product faster than any crash
(`expenses.md`, `overview.md` §4.5). It is also pure. Required cases:

| Case | Assertion |
| --- | --- |
| `splitEqual` where the total divides exactly | All parts equal |
| `splitEqual` with a remainder of 1 and of n−1 cents | Remainder to the lowest `personId`s, sum exact |
| `splitByShares` with zero shares for one person | That person gets 0, sum exact |
| `exact` splits that do not sum to the total | `ValidationError`, never a silent adjustment |
| A negative total (refund) | Rounds toward zero, sum exact |
| A one-cent total across three people | 1, 0, 0 in `personId` order |
| Balance from unsettled expense obligations, in both directions | Sign convention per `data-model.md` §4.8; settlement audit rows are never subtracted a second time |
| Marking a selected subset of expense obligations settled | Only those contributions become zero; the stored total is computed from them |
| A mark-settled request containing an amount, method, reference, remainder or credit | Rejected; external payment details are outside the app's model |
| Editing or deleting an Expense with a settled obligation | `409 settlement_conflict`, blocking Settlement ids returned, and every Expense, Settlement, and Balance row byte-identical |
| Deleting an Activity with any settled child obligation | The same `409`, no tombstone, exact distinct blocking ids; after explicit Undo, the cascade removes every Expense locator |
| Undoing one debtor on a multi-person Expense | Only the exact debtor recorded in that Settlement's coverage reopens; every other debtor and reverse reference is unchanged |
| Duplicate `coversExpenseIds` or an unknown settlement id | Strict validation / `404`; no inflated audit total, Scan, or partial write |

### 2.3 Style

- One behaviour per `it`. The name is a sentence a founder could read:
  `it('gives the remainder cent to the lowest personId', …)`.
- Arrange–act–assert, visually separated. No assertions inside loops without a message.
- No snapshot tests for logic. Snapshots are permitted only for the OpenAPI document and for
  `.ics` output, where the artefact is the contract.
- `vi.mock` is a last resort. If a function needs three mocks, its dependencies should be
  parameters (the `Clock` in `coding-standards.md` §4.3 is the pattern).
- Time is always frozen with `fixedClock(...)`. A test that would pass or fail depending on
  the day it runs is a broken test.

---

## 3. Repository and integration tests (DynamoDB Local)

These are the tests that prove the key design in `data-model.md` §3 actually works. They run
against real DynamoDB in Docker, never against mocks — a mock cannot tell you that a
`begins_with` on the wrong sort key returns nothing.

### 3.1 Setup

`docker-compose.yml` at the repo root defines a test-only DynamoDB Local service
(`infrastructure.md` §6.1). It is isolated from the persistent development database, runs
in memory on host port 8002 and is enabled only through the `test` Compose profile. Tests
bring their own table.

`services/api/test/integration/harness.ts` owns the whole lifecycle. A file claims a table by
importing it and calling `useTestTable()` once, at module scope:

```ts
// services/api/test/integration/activityRepository.int.test.ts
import { useTestTable } from './harness.js';

useTestTable();                                 // create → truncate per test → drop
useTestTable({ truncateBetweenTests: false });  // a file whose tests build on one write
```

That one call registers `beforeAll` (create), `beforeEach` (truncate) and `afterAll` (drop).
**One table per test FILE, named for it** — `od-main-test-activity-repository` — so no file can
see another's rows whatever order they run in. The name is derived from the importing file
rather than passed in: a constant a file states is a constant two files can state the same way,
and a harness that silently put two files on one table would reintroduce exactly the
interference it exists to remove.

Table-per-file is what makes `fileParallelism` a **performance** question rather than a
correctness-of-test-data one. It is currently off because the current suite is not reliable
under database contention. The 2026-08-26 measurement against the in-memory service was
25 files / 502 tests: serial passed in 122 s; eight workers finished in 38 s but failed four
tests under that load. Parallel is now faster, unlike the stale eight-file measurement, but it
is not yet a truthful gate. Diagnose those failures before enabling it; see the comment in
`vitest.int.config.ts`.

Importing the harness is also the whole of a file's per-file environment setup. It sets
`TABLE_NAME` at module scope, before `lib/config.ts` parses it; everything constant across
files, including `DDB_ENDPOINT`, lives in `vitest.int.config.ts`'s `env` block. No integration
test sets an environment variable of its own.

The table is created by `scripts/create-local-table.ts`, which reads the same `TABLE` definition
`DataStack` uses (`repo-structure.md` §3), so the local table and the deployed table cannot
drift. `infra/test/data-stack.test.ts` pins the CDK table to that object and
`table-schema.int.test.ts` pins the live local one to it, from both ends.

`truncate` empties the table with a **`Scan` plus batched deletes**. The `Scan` ban
(`data-model.md` §5) is about application code, where a `Scan` reads a multi-tenant table in
full and is denied by the Lambda's IAM policy at runtime; neither applies to a disposable table
holding one file's fixtures, and `check-forbidden.mjs`'s `no-scan` roots deliberately exclude
test code. The alternative is what the per-partition sweeps this harness replaced actually did:
clean only the partitions a test can name, and be wrong about `ACT#`, `IDEM#` and `RATE#`.

Authenticated requests come from `test/helpers/auth.ts`: `authedHeaders()` for the headers a
client sends, and `withUser(userId)` for an app running as a chosen user. **Neither sends an
identity header, because there is none** — a second user is a second app built with a stub
`IdentityProvider` (P1-01), never a bypass header that would have to exist in the shipped
bundle.

### 3.2 Fixtures

Fixtures are **built per test**, never shared. See §8.

```ts
const alice = aUser().build();
const bob   = aUser().build();
const plan  = anActivity({ ownerId: alice.userId, objectKind: 'plan', type: 'event' })
  .scheduledOn('2026-08-08', '19:00', 'America/New_York')
  .withParticipant(bob)
  .build();

await seed(TABLE_NAME, [alice, bob, plan]);
```

### 3.3 What these tests must cover

| Area | Assertion |
| --- | --- |
| Every access pattern in `data-model.md` §5 | One test per numbered row. A pattern with no test is not implemented. |
| **Tenant isolation** | Two seeded users; every user-scoped query for A returns zero items belonging to B. This is the test that stops the worst bug the product can have (`security-privacy.md` §1 row 4). |
| GSI1 projection | An `ActivityIndex` item appears in the right one of the **four** buckets (`#S`/`#P`/`#N`/`#R`) and moves buckets when scheduled or unscheduled. An undated shared or non-`task` activity lands in `#P`, not `#N`, and `#P` is never returned by the agenda |
| List membership fan-out | An index entry exists at `USER#<u>` / `LIST#<l>` for every **active** member and for nobody else; an `invited` member has none. The canonical row stays at `LIST#<l>` / `META`, so a rename is one write regardless of member count |
| Transactions | Each row of `data-model.md` §7: all items written, or none. Assert the "none" case by forcing a condition failure. |
| Participant fan-out | An index entry exists for the owner and for every participating app user; guests get none |
| Occurrence writes | Completing an occurrence writes only `ACT#/OCC#<date>` and leaves `ACT#/META` byte-identical. An `Occurrence` carries **no** user field: completion is global and owner-only |
| **Per-user reminders** | A partition holding `REM#` rows for two users returns both to the reminder scheduler (access pattern 4b) and **only the caller's** to the plan-detail projection (access pattern 4). Assert against the serialised response, not against a field: the other user's offset, id and existence must appear nowhere |
| Date suggestions | The 5-per-activity cap holds under two concurrent creates; scheduling the activity deletes every `SUGG#` row; unscheduling restores none |
| List-item scheduling | Two rows, bidirectionally linked, item **not** duplicated |
| `schemaVersion` upgrade-on-read | A v1 item read through a v2 repository comes back upgraded and is persisted on next write |
| Pagination | A cursor round-trips; a cursor from user A rejected for user B; `limit` respected |
| TTL attributes | Invite and idempotency records carry a `ttl` in the right range |

### 3.4 Running them

```bash
pnpm test:int   # starts and health-checks dynamodb-test and minio, then runs the task
```

CI uses the same root command. `dynamodb-test` stays outside ordinary `docker compose up -d`
and `pnpm dev`, so it neither creates a test table in the persistent development database nor
adds an idle container to the normal development stack. A caller that already manages an
ephemeral DynamoDB Local may instead run the filtered package command with an explicit
`DDB_ENDPOINT`.

`minio` is different, and deliberately so (P3-21): it is the **same** service `pnpm dev`
starts, named explicitly on the command rather than hidden behind the `test` profile, and the
attachment suite uses the same `od-media-local` bucket. Object keys carry a fresh ULID, so
files cannot collide the way they could on a shared table — and the whole reason the local
store is MinIO rather than a mock is that there is no test-only shape of it. `S3_ENDPOINT` is
overridable like `DDB_ENDPOINT`; the credentials are not, because MinIO checks the signature
against its root user while DynamoDB Local accepts any value.

Integration tests are a **required status check** on `main` (`git-workflow.md` §3.4). The
current 28-file suite adds about two minutes; the alternative is discovering a key-design
error after it has written production data.

---

## 4. API handler tests

The goal: exercise a real Hono route, with real middleware and real validation, without
deploying anything and without Docker.

### 4.1 Testing a route

`app.request()` is Hono's built-in fetch-style entry point. No server, no port, no adapter.

```ts
// services/api/test/routes/activities.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { withUser, authedHeaders } from '../helpers/auth';

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

it('creates an activity and returns 201 with the envelope', async () => {
  ddb.on(TransactWriteCommand).resolves({});

  const app = withUser('usr_01JTESTTESTTESTTESTTESTTES');
  const res = await app.request('/v1/activities', {
    method: 'POST',
    headers: authedHeaders({ idempotencyKey: 'e1c…' }),
    body: JSON.stringify({ type: 'task', title: 'Call the apartment office' }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.activityId).toMatch(/^act_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(body.meta.requestId).toBeDefined();
  expect(body.data).not.toHaveProperty('pk');          // storage keys never leave
  expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
});
```

### 4.2 Mocking the DynamoDB client

`aws-sdk-client-mock` intercepts `DynamoDBDocumentClient` at the command level, so the
assertion is on the command the code actually built.

| Pattern | Use |
| --- | --- |
| `ddb.on(GetCommand, { Key: { pk: 'ACT#…', sk: 'META' } }).resolves({ Item })` | Assert the key that was constructed |
| `ddb.on(QueryCommand).resolvesOnce({ Items, LastEvaluatedKey }).resolves({ Items: [] })` | Pagination |
| `ddb.on(TransactWriteCommand).rejects(new ConditionalCheckFailedException({ … }))` | The 409 path |
| `ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems` | Assert **exactly which** items a write path touches — this is how the "completing an occurrence never mutates the series" rule is tested at the route level |

Mocks answer "did we build the right command". DynamoDB Local answers "does the command
return the right rows". Both are needed; neither substitutes for the other.

### 4.3 The auth-context helper

Route tests must not depend on Cognito or the network. `AUTH_MODE` has exactly two values,
`local` and `cognito` (`infrastructure.md` §6.2); there is **no `dev-bypass` mode and no
`X-Dev-User` header**. A test that needs a specific user injects a stub `IdentityProvider`
through `createApp` instead — the same capability, with nothing in the production bundle to
guard.

```ts
// services/api/test/helpers/auth.ts

/** An app whose identity seam is pinned to one user; no argument means whoever AUTH_MODE resolves. */
export function withUser(userId?: string): { fetch(request: Request): Promise<Response> } {
  return {
    fetch: async (request) => {
      // Imported on first use, not at the top: `src/app.ts` parses the environment when it
      // loads, and the integration harness is what sets the table name in it.
      const { createApp } = await import('../../src/app.js');
      return createApp(
        userId === undefined
          ? {}
          : { identityProvider: { resolve: () => Promise.resolve(userId) } },
      ).fetch(request);
    },
  };
}

/** The non-identity headers a normal request carries. */
export function authedHeaders(opts: {
  idempotencyKey?: string;
  timezone?: string;
  clientVersion?: string;
} = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // Dashes stripped, as `resolveRequestId` does. Some routes echo this into
    // `meta.requestId`, and a dashed UUID drops four random `-<hex>` pairs into every response
    // body — enough to satisfy a `not.toContain('-90')` leak assertion by accident.
    'X-Request-Id': `req_test_${randomUUID().replaceAll('-', '')}`,
    // Not UTC, on purpose: UTC is also the server's fallback, so a UTC default would let a
    // handler that ignored the header pass every test.
    'X-Client-Timezone': opts.timezone ?? 'America/New_York',
    'X-Client-Version': opts.clientVersion ?? 'ios/1.0.0',
    ...(opts.idempotencyKey === undefined
      ? {}
      : { 'Idempotency-Key': opts.idempotencyKey }),
  };
}
```

Cross-tenant tests build two apps — `withUser('usr_a')` and `withUser('usr_b')` — and assert that
B's requests for A's identifiers return `404`. The default app under `AUTH_MODE=local`
resolves every request to `usr_local_dev`, which is what the single-user happy paths use.

`vitest.config.ts` for `services/api` sets `STAGE=local` and `AUTH_MODE=local`. A separate
unit test asserts the startup guard throws when `AUTH_MODE=local` and `STAGE !== 'local'`,
and does **not** throw for `AUTH_MODE=cognito` with `STAGE=local` — the guard is
one-directional on purpose.

The `401` case is tested against an app whose provider throws
`AppError('unauthenticated')`, not by omitting a header:

```ts
/** No identity — for the 401 case. */
export const appUnauthenticated = () =>
  createApp({
    identityProvider: { resolve: async () => { throw new AppError('unauthenticated'); } },
  });
```

### 4.4 What every endpoint gets

One test file per resource, and for **every** endpoint in `api-contract.md` §2, at minimum:

1. Happy path — correct status, correct envelope, no storage keys in the body.
2. Unauthenticated — `401 unauthenticated` (or, for `/public/v1/*`, that it succeeds).
3. Invalid body — `400 validation_failed` with a `details[]` entry naming the field.
4. Not the caller's resource — `404 not_found`, never `403` (`api-contract.md` §3).

Mutating `POST`s add a fifth: the same `Idempotency-Key` twice returns the original stored
status and body unchanged (`201` remains `201`) and performs exactly one domain write.

Any route the authorisation matrix marks **owner-only** adds a sixth: a *participant* — who
can see the activity — gets `403`, not `404`, **and nothing is written**. Assert the second
half by counting the partition before and after; a handler that writes and then refuses passes
a status-code assertion and fails this one. The four completion routes (`complete`,
`uncomplete`, `skip`, `snooze`) are the ones this exists for
([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §3).

---

## 5. Component tests

`@testing-library/react`, run under Vitest with the jsdom environment and `react-native`
aliased to `react-native-web`. Test what a user perceives and what a screen reader
announces — never internal state.

> **Corrected in P1-31.** This section previously said "React Native Testing Library … with
> the jsdom environment and `react-native-web` aliased in", which is a hybrid of two
> mutually exclusive setups. RNTL renders through `react-test-renderer` to a JavaScript
> object tree: it uses neither jsdom nor `react-native-web`, its `fireEvent.press` has no
> DOM equivalent, and it would still need `react-native`'s Flow-typed source transformed by
> `@react-native/babel-preset`. The alias is the setup this repository uses — React Native
> Web is a shipping target rather than a shim (ADR-001), so these tests exercise what the
> web build actually serves, and it keeps one transform pipeline instead of two. The cost is
> that component tests do not exercise the iOS host components; Maestro (P1-29) and the
> physical-device criterion cover that, and a genuinely platform-divergent component belongs
> in a `.ios.tsx`/`.web.tsx` pair from `tech-stack.md` §3.5.

```tsx
it('completes the task from the checkbox without navigating', async () => {
  const onOpen = vi.fn();
  render(<AgendaRow item={aTaskItem({ title: 'Gym' })} onOpen={onOpen} />);

  const checkbox = screen.getByRole('checkbox', { name: 'Gym, not completed' });
  fireEvent.click(checkbox);

  expect(completeMutation).toHaveBeenCalledWith(expect.objectContaining({ title: 'Gym' }));
  expect(onOpen).not.toHaveBeenCalled();      // interaction-contract.md U1: taps don't mutate
});
```

React Native's `onPress` arrives as a DOM `click` through `react-native-web`, so
`fireEvent.click` — or `.click()` on the element — is what fires a press. The queries are
unchanged: `accessibilityRole` and `accessibilityLabel` survive the translation into `role`
and the accessible name, which is what keeps the rule below workable.

Required coverage:

| Subject | Tests |
| --- | --- |
| Every `packages/ui` primitive | Renders each documented state; hit target ≥ 44; role and label present; disabled does not fire |
| Every row type in `interaction-contract.md` §3.1 | Tap body navigates and does not mutate; checkbox mutates and does not navigate; each swipe action is exposed as an `accessibilityAction` |
| Empty, loading, error states | The exact copy from `interaction-contract.md` §5 — copy is a contract, and a test is where it is pinned |
| Undo toast | Appears, has a focusable `Undo`, commits on dismiss |
| Dynamic type reflow | At the largest accessibility size the row reflows and nothing is clipped |

Queries are by role and accessible name — `getByRole`, `getByLabelText`. `getByTestId` is
permitted only where no accessible name exists, which should be nowhere.

---

## 6. End-to-end

E2E proves the wiring. It is the slowest and flakiest layer, so it is deliberately small and
covers only flows whose failure would make the app unusable.

### 6.1 Web — Playwright

Specs in `e2e/specs/`, config in `e2e/playwright.config.ts`. Runs against the deployed dev
site after `deploy-dev.yml` (`infrastructure.md` §7.2), and locally against
`expo export --platform web` served statically.

> **Amended in P1-29.** The `create-activity.spec.ts` row below said "save it, and see it on
> **Today**". Today is a Phase 2 placeholder (P2-11) and the Plans tab reads `filter=upcoming`,
> so an **undated** Task created through global Add appears on no screen at all — the flow as
> written had nothing to assert on. The row now matches `phase-01-activity-core.md` P1-29 ("the
> flat activity list") and adds the step that makes it reachable: the flow picks a date, which
> puts the row in `#S` where `upcoming` reads it. The undated-Task-on-Today assertion belongs
> to Phase 2, when there is a Today to make it on.
>
> The other seven rows describe flows that do not exist yet; each is written by the phase that
> builds the surface it drives. P1-29 delivers the harness and this one flow.

| Flow | Spec | Why it is E2E |
| --- | --- | --- |
| Sign up, verify, land on Today | `auth.spec.ts` | Crosses Cognito's hosted redirect — nothing below E2E can prove it |
| Choose **Task** in global Add, give it a date, save it, and see it in the flat activity list | `create-activity.spec.ts` | Explicit object intent → API → list projection; the title never selects the kind |
| Complete a task and undo it | `complete-undo.spec.ts` | Optimistic update, compensating call, toast |
| Use **Plan this item**, choose a Plan kind and audience, and confirm the item is linked, not duplicated | `list-to-plan.spec.ts` | Explicit kind/audience plus the central linkage rule (`data-model.md` §4.6) |
| Add a guest participant and open the invite link in a fresh context | `invite-rsvp.spec.ts` | The public surface, unauthenticated |
| Add an expense, view the balance, drill down to the lines | `expenses.spec.ts` | "No unexplained numbers" (`overview.md` §4.5) |
| Reschedule from the time column | `reschedule.spec.ts` | U4 across the whole stack |
| Complete, reschedule, edit, convert, end and restart recurring occurrences | `recurrence-stabilization.spec.ts` | Explicit occurrence scope and eventually-consistent agenda reconciliation across the whole stack |
| Keyboard-only pass over Today | `a11y-keyboard.spec.ts` | `interaction-contract.md` §7.2, §7.3 |

Rules: no `waitForTimeout`; wait on a role or a network response. From Phase 4 onward, each
spec creates its own user via a fixture and deletes it in teardown; the explicit pre-auth
exception below governs Phases 1–3. `E2E_BASE_URL` selects the target;
`--project=chromium` in CI, WebKit locally before a release.

Locally the harness owns the whole stack: `global-setup.ts` seeds its **own** table
(`od-main-e2e`, dropped and rebuilt each run, so a run can never destroy the `od-main-local`
data a developer is looking at), and two `webServer` entries start the API on `:3000` and
`e2e/serve-export.mjs` on `:8082`. That server resolves the `expo export` layout rather than
falling everything back to `index.html` — `web.output` is `static`, so each route is its own
HTML file and an SPA-style fallback would serve the wrong page.

**Per-user fixtures are Phase 4.** There is no sign-up to build a user with while `AUTH_MODE`
is `local` and every request resolves as `usr_local_dev`; a spec isolates itself by creating
its own uniquely prefixed rows instead, asserts only on those rows and removes them in
teardown. It never introduces a user-selecting header or dev-bypass identity mode.

`axe-core` runs on every route a flow reaches, failing on `serious` and `critical` only —
`definition-of-done.md` §5 item 11. The failure message names the selector and the measured
value, not just the rule id, because a rule id alone sends the reader to open a browser.

The harness's five variables — `E2E_BASE_URL`, `E2E_WEB_PORT`, `E2E_API_PORT`,
`E2E_TABLE_NAME`, `DDB_ENDPOINT` — are declared on `turbo.json`'s `e2e` task. Nothing runs
that task today (`e2e/` is not a workspace; the harness is driven by the root `e2e:web`
script), but it is where Biome's `noUndeclaredEnvVars` looks and where an `@od/e2e` workspace
would inherit them from. `turbo.json` takes no comments, which is why that note is here.

### 6.2 iOS — Maestro

Flows in `apps/mobile/e2e/*.yaml`, run against a simulator build in `mobile.yml`, and on a
device before a TestFlight submission.

| Flow | File |
| --- | --- |
| Sign in with email and reach Today | `sign-in.yaml` |
| Add a task and complete it from the checkbox | `add-and-complete.yaml` |
| Swipe a row to snooze, confirm the series is unchanged | `snooze-occurrence.yaml` |
| Complete today and confirm tomorrow's recurring occurrence remains live | `recurrence-stabilization.yaml` |
| Add a person to a plan and send an invite | `share-plan.yaml` |
| Background, return, and confirm UP NEXT has advanced | `up-next-ticker.yaml` |
| Queue three completions, including one recurring occurrence, offline; kill/relaunch, reconnect, and land each exactly once | `offline-queue-relaunch.yaml` |

Maestro flows are YAML and readable by an agent, which is why they are the iOS choice
(`tech-stack.md` §2.5). They assert on accessibility labels — the same labels
`interaction-contract.md` §6.2 specifies — so a flow breaking usually means a label
regressed, which is itself worth knowing.

CI: `mobile.yml` on `workflow_dispatch` and on tags. iOS E2E does **not** gate a PR; EAS
build queues are slow and would block every merge (`infrastructure.md` §7.4). It gates a
TestFlight submission.

---

## 7. Property-based tests

> **Decision: `fast-check` as a dev dependency of `packages/shared`, used for money
> splitting, lexo ranks, and recurrence only.** Example-based tests prove the cases someone
> thought of. These three modules have invariants that must hold for *every* input, and the
> failure modes — a cent that vanishes, two items with the same rank, a date that appears
> twice — are exactly what random search finds and a human does not. It adds one
> dev-only dependency to one package and is not shipped in any bundle. It is recorded in
> `tech-stack.md` §2.5.

**Money splitting** (`packages/shared/src/money/split.test.ts`):

| Property | Statement |
| --- | --- |
| Conservation | For any integer total and any 1–50 people, the split sums to exactly the total |
| Fairness | Every part differs from every other by at most 1 cent, for `splitEqual` |
| Determinism | The same inputs in a different array order produce the same per-person result |
| Sign | A negative total produces parts that sum to it, all with the same sign as the total |
| Shares | For `splitByShares`, a person with twice the shares gets a part within 1 cent of twice |
| Round-trip | Applying a split then summing per person reproduces the total for any expense list |

**Recurrence** (`packages/shared/src/recurrence/expand.test.ts`):

| Property | Statement |
| --- | --- |
| Monotonic | Output dates are strictly ascending, with no duplicates |
| In-window | Every emitted date is within `[from, to]` and on or after its segment's `effectiveFrom` |
| Termination | The count never exceeds `count`, and no date is after `endDate` |
| Window composition | Expanding `[a,c]` equals expanding `[a,b]` concatenated with `[b+1,c]` |
| Zone stability | For a timed series, the local wall-clock time is identical on every emitted date, in every IANA zone tried, across DST boundaries |
| Purity | Two calls with the same arguments return deep-equal results |

**Lexo ranks** — the properties in `coding-standards.md` §9.

Failures are reported with the shrunk counter-example; when one is found, it is **added as
an example-based test** in the same commit, so the specific regression is pinned even if the
generator never produces it again.

---

## 8. Test data

### 8.1 Builders, not fixtures

> **No shared mutable fixture objects.** A module-scope `const testActivity = {...}` that
> several tests import is a shared mutable global: one test mutates it, another fails
> depending on file order, and the failure is attributed to the wrong change. Every test
> builds what it needs.

Builders live in `packages/shared/src/testing/builders.ts` (dev-only export, excluded from
the package's published `exports` map) so both the API and the client use the same ones.

```ts
export function anActivity(overrides: Partial<Activity> = {}) {
  const base: Activity = {
    activityId: newActivityId(FIXED_SEED_TIME),
    ownerId: 'usr_01JTESTTESTTESTTESTTESTTES' as UserId,
    objectKind: 'task',
    type: 'task',
    status: 'saved',
    title: 'Test activity',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: cents(0),
    visibility: 'private',
    details: { kind: 'task' },
    createdAt: FIXED_INSTANT,
    updatedAt: FIXED_INSTANT,
    schemaVersion: 1,
    ...overrides,
  };
  return {
    build: () => structuredClone(base),
    scheduledOn: (date: string, time?: string, tz = 'America/New_York') => /* … */,
    withParticipant: (p: Person) => /* … */,
    withReminderFor: (userId: UserId, offsetMinutes: number) => /* … */,
    withSuggestionFrom: (userId: UserId, date: string, time?: string) => /* … */,
    recurringWeekly: (byWeekday: number[]) => /* … */,
  };
}
```

Rules:

- `build()` returns a **deep clone**. Two calls never share a reference.
- Defaults are valid and boring. A builder that produces an invalid entity by default makes
  every test a puzzle.
- `objectKind` is always explicit. `withParticipant` rejects `objectKind: 'task'`; tests for
  coordinated work must deliberately build a Plan and choose one of its visible kinds.
- `withReminderFor` and `withSuggestionFrom` build **sibling items in the activity's
  partition**, not fields on the returned `Activity`. There is no `reminders[]` on an
  `Activity` and there never was one to restore; a builder that adds one would reintroduce
  the shape the model removed. Both take an explicit `userId` precisely so the two-user leak
  tests (§3.3) are one line to set up.
- Overrides are explicit at the call site, so a test reads as "given an activity that is
  *scheduled on Saturday with two participants*".
- One builder per entity: `anActivity`, `aUser`, `aPerson`, `aList`, `aListItem`,
  `aListMember`, `aPersonListLink`, `anExpense`, `aSettlement`, `anAgendaItem`, `anInvite`.

### 8.2 The seed script

`services/api/scripts/seed-local.ts` (the local table, from Phase 1 P1-21) and
`infra/scripts/seed-dev.ts` (the deployed dev table, from Phase 4 P4-30) write
a founder-sized, deterministic data set: 2 users, 1 shared person plus 4 contacts, ~40
activities spanning last week to next month, 2 recurring series with a snoozed and a skipped
occurrence, 4 lists with items including one registered reciprocal `LLINK#` pair, one invited
owner-only link and one caller-visible per-viewer Plan link, 6 expenses producing a
non-zero balance in both directions, and 1 outstanding invite.

It is seeded from a **fixed random seed** so screenshots and E2E assertions are stable, is
idempotent (running twice produces the same state, not double the rows), and refuses to run
against `prod`.

E2E tests do **not** assert on seed data. Through Phase 3 they run as fixed
`usr_local_dev`, create uniquely prefixed per-spec rows and delete those rows in teardown;
they never add a user-selecting header. From Phase 4 onward they create their own user and
their own rows. In both eras a seed change cannot break them and parallel runs cannot collide.

---

## 9. Coverage

Thresholds are per package, enforced by `@vitest/coverage-v8` in each package's config and
failed in CI. They are floors that ratchet upward, never downward — lowering a threshold
requires a line in the PR description explaining why.

The root `test:coverage` command runs five Vitest processes concurrently through Turbo. Each
process is capped at 20% of the available workers for that aggregate run, so the processes
share the host rather than each independently claiming almost every core. Package-local test
commands remain uncapped: the limit addresses aggregate coverage oversubscription without
slowing an isolated suite. Without it, CDK/esbuild work can starve Vitest's worker RPC long
enough for every assertion to pass but the run to fail with an `onTaskUpdate` timeout.

| Package / path | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `packages/shared/src/recurrence/**` | **100** | **100** | 100 | 100 |
| `packages/shared/src/money/**` | **100** | **100** | 100 | 100 |
| `packages/shared/src/rank/**` | 100 | 95 | 100 | 100 |
| `packages/shared` (overall) | 90 | 85 | 90 | 90 |
| `services/api/src/services/**` | 90 | 85 | 90 | 90 |
| `services/api/src/repositories/**` | 85 | 75 | 85 | 85 |
| `services/api` (overall) | 80 | 70 | 80 | 80 |
| `packages/ui` | 75 | 65 | 75 | 75 |
| `apps/mobile/src/features/*/model/**` | 95 | 90 | 95 | 95 |
| `apps/mobile` (overall) | 60 | 50 | 60 | 60 |
| `infra` | 70 | 60 | 70 | 70 |

Excluded from coverage: generated files, `*.config.ts`, `src/index.ts` entry points,
`local.ts`, type-only modules, and Expo Router route files (their logic lives in feature
components, which are covered).

`apps/mobile`'s low overall floor is deliberate. Chasing coverage through screen components
produces tests that assert on markup and break on every layout change. The mobile numbers
that matter are the `model/` directories, which are held at 95.

---

## 10. Flaky tests

> **A flaky test is a broken test.** It is not a nuisance to be retried; it is a test that
> reports a result uncorrelated with the code, which is worse than no test because it trains
> everyone to ignore red.

The policy, in order:

1. **No automatic retries in unit, component, handler, or integration layers.** `retry: 0`
   in every Vitest config. A retry there hides a real race.
2. **Playwright gets `retries: 1` in CI and `0` locally.** A pass-on-retry still fails the
   job's flake report and opens an issue; it does not fail the build.
3. **A test that fails intermittently is quarantined within one working day.** Quarantine
   means `it.skip` with `// FLAKY(P<n>-<task>): <one-line symptom>` and a linked GitHub
   issue labelled `flaky`. A skip without both is a rejection.
4. **Quarantine expires in 14 days.** The nightly workflow opens an issue listing every
   quarantined test older than that. Two options at expiry: fix it, or delete it. A test
   nobody will fix is not protecting anything.
5. **More than two quarantined tests at once blocks a production deploy.** It means the
   suite is no longer telling the truth.
6. **Fix the cause, not the symptom.** The causes seen in a codebase shaped like this one,
   in order of frequency: real time instead of an injected `Clock`; a shared mutable fixture
   (§8.1); an unawaited promise; `waitForTimeout` instead of waiting on a condition; test
   order dependence from a table not truncated in `beforeEach`; and an animation not disabled
   in the component test environment.

Every quarantine and every fix is noted in the issue, so a recurring cause becomes visible
rather than being re-diagnosed each time.
