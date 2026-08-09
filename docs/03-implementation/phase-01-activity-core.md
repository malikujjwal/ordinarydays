# Phase 1 — The activity core

## Goal

At the end of this phase the full single-player activity core runs on a laptop. The
repository layer exists — key construction, transactions, cursor pagination,
upgrade-on-read — against DynamoDB Local, and the Activity is fully implemented behind it:
create, read, patch with optimistic concurrency, delete with its cascade, duplicate, and the
flat filtered list. The global `+` asks for an explicit `Task`, `Plan`, or `List item` target;
choosing Plan then asks for `General`, `Meal`, `Watch`, `Event`, or `Outing`. The Task and five
Plan-kind forms work, writing one `POST /v1/activities` per save. The three
`/v1/capture/*` endpoints return `501`
from a handler the client is already written against, so Phase 8 changes no client code. A
seed script fills the local table with a dev profile and realistic activities, so every
screen has something to render from the first commit.

There is **no authentication**. What there is instead is the identity seam: every item is
keyed `USER#<userId>` exactly as `data-model.md` §3.2 specifies, and the user ID comes from
an `IdentityProvider` that, in this phase, returns a constant. Deferring identity does not
mean deferring `ownerId` — the multi-tenant key structure is load-bearing from the first
line of repository code and is never retrofitted. Phase 4 replaces one implementation of one
interface and adds the screens in front of it.

What is still missing is any sense of *when*: there is no agenda, no Today, no recurrence.
Things go in and can be found again; they do not yet come back to you.

## Amendment — 2026-08-08

> **Amended before any Phase 1 task was scheduled**, from the phase-gate audit of this
> document against the repository as built through Phase 0. Nothing below is a change of
> intent; each item is a place where the plan described code that does not exist, or
> described code that exists in a different shape. Recorded here rather than edited in
> silently, so that a reader who remembers the original text can see what moved.
>
> | # | Change | Where |
> | --- | --- | --- |
> | 1 | **P1-30 added** — `routeSplit` converts from a hard-coded set of implemented paths to a per-route registry. Ten tasks assumed the per-route layout; none of them owned building it. It is now a dependency of P1-01, P1-07, P1-08, P1-11 through P1-16 and P1-18. | New task; task table; P1-01's edge cases |
> | 2 | **P1-31 added** — the React Native test environment for `packages/ui` and `apps/mobile`, split out of P1-22. `packages/ui` declares no `react` or `react-native` dependency and both workspaces run Vitest under `environment: 'node'` with a `.test.ts`-only include, so no `.tsx` render test could run. P1-22 was carrying that as unstated scope on top of twelve primitives. | New task; task table; P1-22 |
> | 3 | **P1-14 no longer ships the settlement guard.** `settlement_conflict` is not in the closed `ErrorCode` union, and Phase 1 has no Expense schema, no `EXP#` key builder and no rows to guard. The guard and the error code both belong to **P7-08**, which already claims the parent-delete case. | P1-14; out-of-scope table; `api-contract.md` §2.3 |
> | 4 | **P1-19's seam shape corrected to the code that shipped in P0-20.** The interface is `getToken(): Promise<string \| undefined>` in `client/http.ts`, exported as `nullTokenProvider`. This document was the only place carrying `string \| null`, `client/auth.ts` and `NullTokenProvider`; no architecture doc disagreed with the code, so the phase file was the wrong one. | P1-19; deliverables; criterion 18; Prepared for Phase 4 |
> | 5 | **P1-13 depends on P1-17, and the table did not say so.** P1-13's `Depends on` column read `P1-10, P1-30`, while its own Approach says the conversion "runs P1-17 server-side" and its Tests require the `watch → task` drop behaviour and the Plan → Task blockers — both of which *are* `changeActivityKind`. Nothing in P1-13 can produce them without it. The column now names P1-17; nothing else about either task changes. Found when P1-13 was picked up and the dependency turned out not to exist. | P1-13's task-table row |
> | 7 | **P1-16's filter enum corrected: `inbox` removed, `saved` split from `needs_date`.** `inbox` had no definition in any document — no surface, no GSI1 bucket, no access pattern — and `overview.md` names Inbox among the fourth nouns the product does not have. `saved` was pointed at `#N` by `today-and-tasks.md` §2.3 and at `#P` by `plans-and-lists.md` §5; those are separate partitions, so one filter could not page across both without a composite cursor no doc defines. Raised before any code was written and decided by the founder. | P1-16; `api-contract.md` §2.2; `plans-and-lists.md` §5 |
> | 6 | **An identity kind change is a no-op**, which the §6.3 mapping table does not state. Read literally its `watch → any` row includes `watch → watch`, which would report the season and episode as dropped and return an emptied `details` — data loss from a request that changed nothing, reachable because `PATCH` takes `objectKind` and `type` as a pair and a form may re-send the current values. §6.3's own rule already gives the right answer ("keeps `details` fields that still apply and drops the rest"), so the `→ any` rows are read as shorthand for the cross-kind cases. Recorded rather than assumed. | P1-17; `activities.md` §6.3 point 5 |
>
> Phase 1 is therefore **30 live tasks and 72 AWU** — 29, plus two M, less P1-19's S —
> re-summed in [`roadmap.md`](roadmap.md) §4.2. The two new tasks run **out of numeric
> order** — see the
> sequencing note in [`../04-conventions/kickoff-prompts.md`](../04-conventions/kickoff-prompts.md).
>
> Three instructions in the original text told an agent to amend a document that had
> already been amended: `infrastructure.md` §6.2 and `testing.md` §4.3 already say there is
> no `dev-bypass` mode and no `X-Dev-User` header, and `testing.md` §8.2 already names
> `seed-local.ts`. Those instructions are struck below rather than left to produce an empty
> diff.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phase 0 complete and its acceptance criteria passing | Particularly `pnpm dev` from a clean clone, DynamoDB Local matching the synthesised table, and CI's four green jobs. |
| 2 | Docker running, with DynamoDB Local up | Every repository test in this phase is an integration test. There is no mock substitute. |
| 3 | [`../01-product/activities.md`](../01-product/activities.md) and [`../02-architecture/data-model.md`](../02-architecture/data-model.md) read in full | They are the specification for this phase; this document does not restate them. |
| 4 | Apple Developer Program enrolment **started** | Not needed by any task here. It is needed by Phase 4 (Sign in with Apple) and Phase 5 (TestFlight), enrolment takes several days, and starting it now costs nothing. |

No AWS access is required to complete this phase. No AWS resource is created by it.

## Deliverables

- [ ] `routeSplit` converted from Phase 0's implemented-paths set to a per-route registry
      that matches parameterised paths and states, per route, whether identity is required.
- [ ] `IdentityProvider` interface with a `LocalIdentityProvider` implementation, selected by
      `AUTH_MODE`, resolved once at module scope.
- [ ] A startup-time hard guard: the process refuses to start when `AUTH_MODE=local` and the
      stage is anything but local.
- [ ] A repository layer with key construction confined to one file,
      `TransactWriteItems` helpers, opaque cursors, and upgrade-on-read.
- [ ] Full Activity CRUD: `POST`, `GET /:id`, `PATCH` with `If-Match`, `DELETE` with
      cascade, `duplicate`, `GET /v1/activities?filter=`.
- [ ] `CreateActivityInput.type` required in the shared Zod schema, with a missing-type create
      rejected end to end. Neither the schema, handler nor client supplies a fallback.
- [ ] `REM#<userId>#<reminderId>` rows written for the creator, and a detail projection that
      returns **only the caller's** reminders. No `reminders[]` field on `Activity`.
- [ ] `GET`/`PATCH /v1/me`, `POST`/`DELETE /v1/me/devices`, answering for the local dev user.
- [ ] `rateLimit` and `idempotency` middleware live, keyed off `c.get('userId')`.
- [ ] Zod schemas for every shape above, defined once in `packages/shared` and imported by
      both sides; `docs/generated/openapi.json` regenerated.
- [ ] The `AuthTokenProvider` seam in the shared client, with `nullTokenProvider` supplied by
      `apps/mobile`. **Delivered by P0-20; verified, not rebuilt, in this phase.**
- [ ] `pnpm seed:local` populating DynamoDB Local with the dev profile and realistic
      activities, idempotently.
- [ ] The explicit global Add chooser (`Task`, `Plan`, `List item`), the five Plan-kind
      choices, and the Task plus five Plan-kind forms with the exact fields, order, defaults
      and validation from
      [`../01-product/activities.md`](../01-product/activities.md) §4.
- [ ] The activity detail screen: read, inline edit with commit-on-blur, explicitly change
      object or Plan kind with the loss/blocker contract, duplicate, delete.
- [ ] `/v1/capture/parse|extract|link` returning `501 not_implemented` with the stable error
      envelope; the client's capture paths degrade exactly as
      [`../01-product/ai-capture.md`](../01-product/ai-capture.md) §6 specifies.
- [ ] A React Native test environment — jsdom, the RN transform and React Native Testing
      Library — under which `packages/ui` and `apps/mobile` can both run `.tsx` render tests,
      with `apps/mobile`'s deferred coverage floor armed.
- [ ] `packages/ui` primitives sufficient for every screen in this phase.
- [ ] Playwright and Maestro harnesses running one real flow each against the local stack.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P1-01 | `IdentityProvider` seam and `LocalIdentityProvider` | api | P1-30 | no | M |
| P1-02 | The `AUTH_MODE` startup guard | api | P1-01 | no | S |
| P1-03 | `rateLimit` middleware | api | P1-01 | yes | M |
| P1-04 | `idempotency` middleware | api | P1-01 | yes | M |
| P1-05 | Repository base: keys, cursors, transactions, upgrade-on-read | api | P0-13 | no | L |
| P1-06 | Shared types and schemas for `User`, `Activity` and `Reminder` | shared | P0-07 | no | L |
| P1-07 | `UserRepository` and `GET`/`PATCH /v1/me` | api | P1-05, P1-06, P1-01, P1-30 | no | M |
| P1-08 | Device registration endpoints | api | P1-07, P1-30 | yes | S |
| P1-09 | `ActivityRepository` | api | P1-05, P1-06 | no | L |
| P1-10 | Activity service: status derivation, authz, transactions | api | P1-09 | no | L |
| P1-11 | `POST /v1/activities` | api | P1-10, P1-04, P1-30 | no | M |
| P1-12 | `GET /v1/activities/:id` | api | P1-10, P1-30 | yes | M |
| P1-13 | `PATCH /v1/activities/:id` with `If-Match` | api | P1-10, P1-17, P1-30 | no | M |
| P1-14 | `DELETE /v1/activities/:id` and its cascade | api | P1-10, P1-30 | no | M |
| P1-15 | `POST /v1/activities/:id/duplicate` | api | P1-11, P1-30 | yes | S |
| P1-16 | `GET /v1/activities?filter=` with cursors | api | P1-09, P1-30 | yes | M |
| P1-17 | Object/Plan-kind change mapping (pure, in `shared`) | shared | P1-06 | yes | M |
| P1-18 | `/v1/capture/*` `501` stubs | api | P1-30 | yes | S |
| ~~P1-19~~ | ~~`AuthTokenProvider` seam and `NullTokenProvider`~~ — delivered by P0-20; see the amended subsection | shared | — | — | — |
| P1-20 | Shared API client: `me`, `activities`, `capture` | shared | P1-06 | no | M |
| P1-21 | `seed-local.ts`: the dev profile and sample activities | api | P1-07, P1-09 | no | M |
| P1-22 | `packages/ui` theme, primitives and token gallery | shared | P0-08, P1-31 | yes | L |
| P1-23 | App shell: three tabs, header, FAB, placeholders | mobile | P0-19, P1-22, P1-31 | no | M |
| P1-24 | The explicit Add chooser and target routing | mobile | P1-23, P1-20 | no | L |
| P1-25 | Task and five Plan-kind creation forms | mobile | P1-24, P1-22, P1-31 | no | L |
| P1-26 | Activity detail screen: read and inline edit | mobile | P1-25, P1-12 | no | L |
| P1-27 | Change object/Plan kind, duplicate, delete in the UI | mobile | P1-26, P1-17 | no | M |
| P1-28 | Repository integration-test harness on DynamoDB Local | ci | P1-09, P0-21 | yes | M |
| P1-29 | Playwright and Maestro harnesses with one flow each | ci | P1-25, P1-21 | no | M |
| **P1-30** | **`routeSplit`: the per-route registry and the identity split** | api | P0-13 | no | M |
| **P1-31** | **The React Native test environment for `ui` and `mobile`** | ci | P0-08, P0-19, P0-24 | yes | M |

**P1-30 and P1-31 were appended on 2026-08-08 and therefore break the "ascending ID order is
a valid dependency order" property this phase's IDs previously had.** P1-30 runs *first* of
all the API tasks and P1-31 *before* P1-22. Both are called out in
[`../04-conventions/kickoff-prompts.md`](../04-conventions/kickoff-prompts.md); do not
schedule Phase 1 from the ID column alone.

P1-19 is struck: the seam it describes shipped in P0-20 and this phase verifies it rather
than building it. Its subsection is kept, and amended, because the shape is load-bearing for
Phase 4 and deleting it would lose the reasoning.

P1-08, P1-12, P1-15, P1-16 and P1-27 have no detail subsection. They follow
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2 and the
primitives from P1-05 and P1-09 directly, with no design decision left in them. The one
non-obvious rule on P1-12 — the detail response returns only the **caller's** `REM#` rows —
is specified in P1-10 rule 6, because it is a projection policy rather than a route
concern. P1-18 is
mechanical in the same way but carries one non-obvious instruction, so it keeps its section.

---

### P1-01 — `IdentityProvider` seam and `LocalIdentityProvider`

**What to build.** The one place in the codebase that knows where a user ID comes from. This
task is the reason Phases 1 to 3 can be built with no authentication without any of that work
needing to be revisited.

**Files.** `services/api/src/middleware/identity.ts`, `services/api/src/lib/config.ts`
(the `AUTH_MODE` variable), `services/api/src/app.ts` (mounting).

**The interface.**

```ts
// services/api/src/middleware/identity.ts
import type { Context } from 'hono';
import type { UserId } from '@od/shared/types';

export interface IdentityProvider {
  /**
   * Resolve a request to the user it acts for.
   * Throws AppError('unauthenticated') when it cannot.
   */
  resolve(c: Context): Promise<UserId>;
}
```

One method. It takes a request and returns a user ID. It does not return a session, a token,
a set of claims, or a permission list — everything the rest of the system needs from identity
is the ID, and keeping the return type that narrow is what keeps the seam honest.

**The two implementations.**

| Implementation | Ships in | Behaviour |
| --- | --- | --- |
| `LocalIdentityProvider` | Phase 1 | Returns the constant `usr_local_dev`. Reads no header, parses no token, makes no network call, and has no failure mode. |
| `CognitoIdentityProvider` | Phase 4 | Verifies the bearer ID token with a module-scope `CognitoJwtVerifier` (`aws-jwt-verify`), hydrated during init, and returns the `custom:app_user_id` claim. Exactly the implementation in [`../02-architecture/auth.md#51-the-verifier`](../02-architecture/auth.md#51-the-verifier). |

Phase 1 ships only the first. Do not write a stub of the second: an empty
`CognitoIdentityProvider` that throws is a file somebody will half-fill, and the interface is
the contract, not a placeholder class.

**Selection, and the middleware.**

```ts
const providers: Record<AuthMode, () => IdentityProvider> = {
  local:   () => new LocalIdentityProvider(),
  cognito: () => new CognitoIdentityProvider(config),   // Phase 4
};

// Module scope. Resolved once per execution environment, never per request.
export const identityProvider: IdentityProvider = providers[config.AUTH_MODE]();

export const identity = createMiddleware(async (c, next) => {
  c.set('userId', await identityProvider.resolve(c));
  await next();
});
```

`AUTH_MODE` is a Zod enum of `'local' | 'cognito'` parsed in `lib/config.ts`. It has **no
default**: an unset value throws at startup. A default of `local` is dangerous and a default
of `cognito` is merely inconvenient, so neither is worth the ambiguity — every environment
states which mode it is in.

`identity` mounts at position 8 of the chain in
[`../02-architecture/tech-stack.md#42-middleware-chain-in-order`](../02-architecture/tech-stack.md#42-middleware-chain-in-order),
replacing the entry that document calls `auth`. Everything downstream is unchanged by the
substitution.

**The rule that makes this work.**

> **Every route handler, service and repository reads the user ID from `c.get('userId')` and
> knows nothing about where it came from. No handler, service, or repository contains an
> `if (AUTH_MODE …)` branch, a token parse, or a header read for identity.** `AUTH_MODE` may
> appear in exactly two files: `services/api/src/lib/config.ts` and
> `services/api/src/middleware/identity.ts`.

Enforce it with a grep check in `ci.yml`, alongside the three in
[`../04-conventions/repo-structure.md#4-how-the-rules-are-enforced`](../04-conventions/repo-structure.md#4-how-the-rules-are-enforced):

```bash
! grep -rn "AUTH_MODE" services/api/src apps packages \
    --include=*.ts \
    --exclude=config.ts --exclude=identity.ts
```

This is the check that keeps the Phase 4 change small. Without it, `AUTH_MODE` leaks into a
handler within a fortnight and Phase 4 becomes a search-and-replace across the API.

**Testing without a bypass header.** Route tests get a second user by constructing the app
with an injected provider, using the `createApp(overrides)` parameter from P0-13:

```ts
const app = createApp({ identityProvider: stubIdentity('usr_other_test_user') });
```

> **Decision:** there is no `X-Dev-User` header and no `dev-bypass` mode. A header-driven
> bypass is shipped code that reads attacker-controlled input to decide who you are, guarded
> only by an environment check. Injecting a stub through `createApp` gives tests the same
> capability with nothing in the production bundle to guard.
>
> ~~`infrastructure.md` §6.2 and `testing.md` §4.3 describe an `AUTH_MODE=dev-bypass`;
> amend both in this task's PR, and drop `authedHeaders()`'s `x-dev-user` entry.~~
> **Already done — do not re-do it.** `infrastructure.md` §6.2 (line 1071) and `testing.md`
> §4.3 both already state that there is no `dev-bypass` mode and no `X-Dev-User` header, and
> `authedHeaders()` already carries no such entry. Verified 2026-08-08.
>
> One thing this task *does* still have to build: `createApp` currently takes
> `AppOverrides { _reserved?: never }` and ignores the argument
> ([`services/api/src/app.ts`](../../services/api/src/app.ts)). It is a reserved placeholder,
> not a working injection point, and the whole no-bypass-header decision rests on it. Make it
> real here.

> **Decision:** `usr_local_dev` is deliberately not a ULID. It is instantly recognisable in a
> table browser, greps cleanly, and can never collide with a real generated ID. The
> consequence is that the shared `userId` schema cannot be `ulidId('usr')`: define it in
> `schemas/common.ts` as a prefixed-string check (`startsWith('usr_')`, 5–40 characters), and
> keep the strict ULID assertion at the point where an ID is **generated**, in P1-07. A
> validator that rejects the ID the system is currently running as is a validator that gets
> deleted under pressure.

**Edge cases.**

- `resolve` is `async` even though `LocalIdentityProvider` needs no await. The Cognito
  implementation must await verification, and a synchronous interface would force Phase 4 to
  change the signature and therefore every call site — which is precisely what this seam
  exists to prevent.
- The provider is constructed at module scope, not per request. In Phase 4 that is what
  keeps the JWKS fetch out of the request path; in Phase 1 it costs nothing and establishes
  the shape.
- `routeSplit` decides which paths need identity at all. `/v1/health` and, later,
  `/public/v1/*` never reach this middleware. **Amended 2026-08-08:** Phase 0 shipped
  `routeSplit` with that decision unimplemented — it exports
  `UNAUTHENTICATED_PRIVATE_PATHS` and never reads it, and gates on an exact-match
  `IMPLEMENTED_PATHS` set instead. P1-30 makes the export load-bearing before this task
  mounts anything, which is why P1-01 now depends on it.

**Tests.** Unit: `LocalIdentityProvider.resolve()` returns `usr_local_dev` for a request with
no headers, with a bogus `Authorization` header, and with a hostile `X-Dev-User` header — the
same answer in all three, proving it reads nothing. A route test asserting `c.get('userId')`
reaches a handler. A test constructing the app with a stub provider and asserting the handler
sees the stub's ID. The CI grep check, verified by adding a scratch `AUTH_MODE` reference in
a handler and watching it fail.

---

### P1-02 — The `AUTH_MODE` startup guard

**What to build.** A hard guard that makes it impossible for `LocalIdentityProvider` to run
in a deployed environment. Not a warning, not a log line, not a lint rule: a throw, at module
load, before any request is served.

**Files.** `services/api/src/lib/config.ts`.

**Approach.** At module scope in `lib/config.ts`, immediately after the Zod parse:

```ts
if (config.AUTH_MODE === 'local' && config.STAGE !== 'local') {
  throw new Error(
    `AUTH_MODE=local is only permitted when STAGE=local. ` +
      `STAGE=${config.STAGE}. Refusing to start.`,
  );
}
```

`lib/config.ts` is imported by `app.ts`, which is imported by both `index.ts` and `local.ts`,
so the guard runs during Lambda **init** and during `tsx watch` startup. It cannot be
skipped, deferred, or reached around, and it does not depend on any request arriving.

**Why a throw and not a warning.** The failure this prevents is a deployed API that treats
every caller in the world as `usr_local_dev` — a single shared account with everybody's data
in it, returning `200` to every request. That failure is completely silent: no error, no
alarm, no unusual latency, nothing in the logs that looks wrong. A warning would be one line
in a log nobody reads. A throw during init fails every invocation immediately, trips the
`api-errors` alarm from `ObservabilityStack` on the first request, and shows up as a failed
deploy rather than as a data breach discovered later.

**Defence in depth.** Three independent mechanisms, because this is the one place in the
project where a single missed check has an unbounded consequence:

| # | Mechanism | Fails at |
| --- | --- | --- |
| 1 | This startup throw | Runtime, during init |
| 2 | `ApiStack` sets `AUTH_MODE=cognito` on every deployed function and never accepts it as a parameter | Synth |
| 3 | A CDK assertion test asserting no synthesised `AWS::Lambda::Function` has `AUTH_MODE: 'local'` in its environment | CI |

Any one of the three would probably be enough. All three together cost about forty lines.

**Edge cases.**

- The guard is one-directional. `AUTH_MODE=cognito` with `STAGE=local` is **allowed** and is
  exactly how Phase 4 lets a developer sign in against the deployed dev user pool from a
  laptop. Do not make the check symmetric.
- The guard must run before `identityProvider` is constructed. Keeping it in `lib/config.ts`
  rather than in `identity.ts` guarantees that ordering regardless of import order.
- Do not make the guard depend on `NODE_ENV`. `NODE_ENV` is `production` inside a bundled
  Lambda *and* commonly in a local production-mode build; `STAGE` is the variable that
  actually names the environment.

**Tests.** Unit, with `vi.resetModules()` between cases because the guard is at module scope:

1. `STAGE=dev`, `AUTH_MODE=local` — importing `lib/config.ts` throws, and the message
   contains both values.
2. `STAGE=prod`, `AUTH_MODE=local` — throws.
3. `STAGE=local`, `AUTH_MODE=local` — does not throw.
4. `STAGE=local`, `AUTH_MODE=cognito` — does not throw.
5. `AUTH_MODE` unset — throws from the Zod parse, naming the variable.

Plus the CDK assertion test from mechanism 3. Five unit tests and one infrastructure test is
not excessive for the guard that stands between a local convenience and a shared-account
production incident.

---

### P1-03 — `rateLimit` middleware

**Files.** `services/api/src/middleware/rateLimit.ts`,
`services/api/src/repositories/rateLimitRepository.ts`.

**Approach.** A DynamoDB counter item keyed by `c.get('userId')` for authenticated routes and
by a **SHA-256 hash** of the client IP for public ones — raw addresses are never written to
DynamoDB or logs. Fixed window of one minute with `ttl` set to window end, incremented with
`UpdateItem` and `ADD`. Over limit → `429 rate_limited` with `Retry-After`.

Limits from
[`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits):
120 req/min authenticated, 20/hour on `POST /v1/capture/*`, 60/hour on
`POST /v1/attachments/upload-url`, 30 req/min per IP on `/public/v1/*`.

The middleware reads the user ID from the context and does not care that every request in
Phase 1 carries the same one. Locally that means one shared counter, which is correct
behaviour and also a useful thing to have exercised before real users exist.

**Edge cases.** A fixed window allows a 2× burst at a window boundary. That is acceptable at
these limits and is far simpler than a sliding window; do not build a token bucket. The
counter write must not fail the request if DynamoDB errors — log and allow, because a rate
limiter that takes the API down is worse than one that occasionally lets a request through.

**Note.** Open question OQ-10, which the previous version of this phase resolved here, is
about the three `/public/v1/auth/*` endpoints. Those endpoints move to Phase 4 with the rest
of the web auth flow, and the decision moves with them. `api-contract.md` §4's other rows are
unaffected.

**Tests.** Unit with `aws-sdk-client-mock`: the 121st request in a window `429`s with
`Retry-After`; the counter's `ttl` is the window end; the public key is a hash and the raw IP
never appears in the written item or in a log line; a DynamoDB failure allows the request and
logs a warning.

---

### P1-04 — `idempotency` middleware

**Files.** `services/api/src/middleware/idempotency.ts`.

**Approach.** On `POST` routes that create, require an `Idempotency-Key` header (a UUID) or
`400`. Read `IDEM#<userId>#<key>`; on a hit, return the stored status and body unchanged. On
a miss, run the handler and, on success, write `IDEM#<userId>#<key>` with the response body,
the status, the route, the `userId`, and `ttl = now + 24 h`.

Runs **after** `rateLimit`, so a retry storm cannot write idempotency records for free.

The `userId` in the key comes from `c.get('userId')`, which in this phase is `usr_local_dev`.
**Nothing about this key changes in Phase 4.** The partition is already user-scoped; a real
Cognito `sub` simply produces a different value in the same position. There is no migration,
no dual-read, and no compatibility shim — which is the point of writing the key this way from
the start rather than adding the scope later.

**Edge cases.**

- The key must be scoped to the caller. `IDEM#<userId>#<key>` prevents one user's key from
  returning another's response. This is the form recorded in
  [`../02-architecture/data-model.md#34-lookup-partitions`](../02-architecture/data-model.md#34-lookup-partitions);
  a bare `IDEM#<key>` is a security defect, not a shorthand. It is tempting to write the bare
  form while there is only one user; do not.
- A concurrent duplicate (two in-flight requests with the same key) must not both create.
  Write a *reservation* item with `attribute_not_exists(pk)` before running the handler; a
  conditional-check failure means "in flight or done" — re-read and either return the stored
  response or `409 conflict` if the reservation has no body yet.
- Only successful responses are stored. A `500` must not be replayed for 24 hours.

**Tests.** Integration on DynamoDB Local: the same key twice creates one activity and returns
identical bodies; different keys create two; a concurrent pair (two promises, same key)
yields exactly one write; a failing handler stores nothing; a missing header `400`s; and one
test asserting the written `pk` is literally `IDEM#usr_local_dev#<key>`, so the scoping is
pinned by a test rather than by intent.

---

### P1-05 — Repository base

**Files.**

```
services/api/src/repositories/keys.ts        every pk/sk builder, and nothing else
services/api/src/repositories/cursor.ts      opaque base64 encode/decode of LastEvaluatedKey
services/api/src/repositories/tx.ts          TransactWriteItems composition helpers
services/api/src/repositories/migrate.ts     schemaVersion upgrade-on-read
services/api/src/repositories/base.ts        shared query/get/put wrappers
```

**Approach.** `keys.ts` is the **only** file in the codebase that constructs a `pk` or `sk`
string. Export one function per item type from
[`../02-architecture/data-model.md#3-key-schema`](../02-architecture/data-model.md#3-key-schema):
`activityMeta(id)`, `participant(activityId, personId)`, `occurrence(activityId, date)`,
`userProfile(userId)`, `activityIndex(userId, activityId)`, `list(userId, listId)`,
`listItem(listId, rank, itemId)`, `inviteToken(token)`, `emailLookup(email)`,
`idem(userId, key)`, and the **four** GSI1 bucket builders (`gsi1Scheduled`,
`gsi1NeedsDate`, `gsi1Anytime`, `gsi1Recurring`) — `#S`, `#P`, `#N`, `#R`, per
[`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets).
`#P` and `#N` are separate buckets and there is no single "unscheduled" one. A `pk:` template
literal anywhere else is a review rejection.

> **Amended in P1-05: `keys.ts` transcribes all of §3, not only the fourteen builders named
> above.** The named list omits item types Phase 1 itself needs — `REM#` for P1-09's reminder
> rows and `RATE#` for P1-03's counters — and both are forbidden outside this file, so
> deferring them would have meant P1-03 and P1-09 each editing the one file the product's
> tenant isolation depends on. Having found that, the cheaper and safer answer was the whole
> table at once: thirty later tasks appending a line each to a serial choke point, each
> re-deriving a key format from a table they may not have read, is worse than one
> transcription reviewed in one sitting. The keys are pure string construction with no
> behaviour, they cost a line and an assertion each, and builders for item types that do not
> exist yet carry the phase that writes them.

Every builder that identifies user-owned data takes a `userId` parameter. None of them has a
default, and none of them reads a constant. `userProfile()` with no argument returning the
dev user would be a shortcut that costs a day in Phase 4 and a tenancy bug later.

`cursor.ts` encodes `LastEvaluatedKey` to opaque base64 and decodes with validation — a
decoded cursor whose shape does not match the expected key attributes is `validation_failed`,
never passed to DynamoDB.

`tx.ts` composes `TransactWriteItems` with a compile-time cap at 100 items and a helper that
maps `TransactionCanceledException` reasons to the right `AppError`.

`migrate.ts` implements the lazy migration policy from
[`../02-architecture/data-model.md#9-migration-policy`](../02-architecture/data-model.md#9-migration-policy):
a registry of `schemaVersion → upgrade function`, applied on read, persisted on next write.
Version 1 is the identity function; the registry exists so version 2 is a one-file change.

**Edge cases.** No `Scan` in application code, ever.

> ~~Add a unit test that greps the built `services/api` bundle for `ScanCommand` and fails
> on a hit outside `infra/scripts/migrations/`.~~ **Not viable — do not add it.** Measured in
> P1-05 rather than reasoned about: the built bundle is **minified** (88 lines, mangled
> identifiers) and the AWS SDK is marked **external**, because Lambda provides it at runtime.
> `DynamoDB` appears zero times in the artifact and so does `QueryCommand` — which `base.ts`
> demonstrably uses. A grep for `ScanCommand` therefore cannot fail, in any circumstance, and
> a check that always passes is the "green check that inspected nothing" the
> `.dependency-cruiser.cjs` notes call the worst possible outcome for a rule whose job is to
> fail loudly.
>
> The control is at **source** level, where the identifier still exists, and it already
> works — verified in P1-05 by planting a `ScanCommand` in `base.ts` and watching both fire,
> each naming the file and line:
>
> - `scripts/check-forbidden.mjs no-scan`, a required CI step over `services/api/src`,
>   `apps` and `packages`, excluding `infra/scripts/migrations/`.
> - `src/lib/layering.test.ts`'s "contains no Scan", which runs on every `pnpm test`.
>
> The deeper control is that there is nothing to reach for: `base.ts` exposes `getItem`,
> `putItem`, `updateItem`, `deleteItem`, `query`, `queryAll` and `deleteAll`, and no way to
> express "read everything" — `query` has no parameter that omits the partition key.

**Tests.** Unit for every key builder against the literal strings in the data model. Cursor
round-trip and a tampered-cursor rejection. `tx.ts` rejecting a 101-item transaction.
Migration registry applying v1 → v1 as identity and a synthetic v1 → v2 correctly.

---

### P1-06 — Shared types and schemas for `User`, `Activity` and `Reminder`

**Files.**

```
packages/shared/src/types/user.ts  activity.ts  recurrence.ts  reminder.ts
                                   occurrence.ts  index.ts
packages/shared/src/schemas/user.ts  activity.ts  recurrence.ts  reminder.ts
                                     occurrence.ts  capture.ts  index.ts
packages/shared/tsconfig.test.json   new — see the note below
```

> **Amended during implementation, 2026-08-08.** Four corrections, each found by doing the
> work rather than by re-reading:
>
> 1. **`data-model.md` §4 had no `User` shape.** The Approach below said to transcribe §4.1
>    and §4.4 — Activity and type-specific details; neither is User, and the profile's fields
>    were spread across five documents. P1-06 writes **§4.0 User** into `data-model.md` and
>    transcribes from there.
> 2. **`recurrence.ts` and `occurrence.ts` were unlisted.** `Activity.recurrence` is part of
>    §4.1, so the segmented shape cannot be deferred; `Occurrence` ships as a **type only**
>    (no engine, no rows — those stay Phase 2) so P2-01 inherits the shape rather than
>    inventing it.
> 3. **`capture.ts` was in the file list but described nowhere.** It owns `CreationTarget`,
>    which has a third arm the activity inputs do not — `{ objectKind: 'listItem', listId }`
>    — plus the three request shapes P1-18 validates against.
> 4. **`expectTypeOf` was asserting nothing.** Test files are excluded from every `tsc`
>    invocation, and `expectTypeOf` is erased at runtime, so the type-level assertions this
>    task depends on — and the one already in `schemas/error.test.ts` — passed
>    unconditionally. `tsconfig.test.json` typechecks them; it emits nothing and exists to
>    fail. It immediately surfaced two long-standing type errors in `openapi.test.ts`.

**Approach.** Transcribe
[`../02-architecture/data-model.md#40-user`](../02-architecture/data-model.md#40-user),
[§4.1](../02-architecture/data-model.md#41-activity), §4.2, §4.3, §4.4 and §4.5 into
TypeScript, then write the Zod schemas beside them. The interface in `types/` is the
authoritative shape and the schema is the runtime check; neither restates the other, and a
both-ways `expectTypeOf` in each schema's test is what stops them drifting.

Two shapes cannot be spelled the way the canonical docs write them, and the tests say so:
`Activity` is **two interfaces extending `ActivityBase`** rather than
`ActivityBase & (… | …)`, because the compiler treats an intersection as distinct from the
flat object Zod infers; and the create inputs are **strict**, because a plain object strips
unknown keys and would silently accept — then drop — participants on a Task.

`createActivityInput` is the shape in
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities),
with the field-level validation from
[`../01-product/activities.md`](../01-product/activities.md) §3.6 and §4: `title` 1–200 after
trim, `notes` 0–4000, free-text sub-fields 0–120, `location.address` 0–300, `time` requires
`date`, `endTime` requires `time` and must be after it, participants ≤ 50, ingredients ≤ 60
rows, `priceCents` a non-negative integer.

**`objectKind` and `type` are both required.** There is no compatibility default or
title-based classification. `CreateActivityInput` is a discriminated union: Task is exactly
`{ objectKind: 'task', type: 'task' }`; Plan is `{ objectKind: 'plan', type: PlanType }`,
where `PlanType = Exclude<ActivityType, 'task'>`. General maps visibly to `custom`. The
global chooser or a labelled contextual entry point fixes that pair before the request is
built, so omitting either field or sending `objectKind: 'plan', type: 'task'` is
`validation_failed`. This must appear in `openapi.json`; do not add a fallback in the schema,
handler, API client or form store.

The `details` schema is a **discriminated union on `kind`**, and a refinement asserts
`details.kind === type`. This is the single most useful validation in the product: it makes
"a meal with watch fields" unrepresentable. A body with `details.kind: 'meal'` and no `type`
is rejected because the creation target is incomplete, never coerced to any type.

**`Activity` has no `reminders[]` field.** A `Reminder` is its own type and its own item,
keyed `REM#<userId>#<reminderId>` in the activity partition
([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)
§4.3). Define `reminder.ts` beside `activity.ts` with `userId` on it, and make sure nothing in
`types/activity.ts` re-adds the array — that is the shape this phase is specifically not
building, and the endpoints that manage the rows are P2-16. `CreateActivityInput.reminders`
survives as an input-only convenience that writes rows for the **creator**; it is not a field
on the stored `Activity` and the two must not share a type.

`ActivityStatus` is accepted from the client only as `cancelled`. Every other value is
derived server-side; the schema for `patchActivityInput` must not accept `saved`,
`scheduled`, `completed` or `skipped`.

`UserId` is the prefixed-string check from P1-01's decision, not `ulidId('usr')`. `ownerId`
on `Activity` uses it, which is why a seeded local activity round-trips through response
validation unchanged.

**Edge cases.** `exactOptionalPropertyTypes` is on. `schedule?: { … } | undefined` and
`schedule?: { … }` differ; be deliberate, especially for the unschedule path where
`{ date: null }` is meaningful and `undefined` is not.

**Tests.** Table-driven Zod tests: one valid and at least three invalid cases per field;
every `details.kind`/`type` mismatch rejected; a `title` of 201 characters rejected and one
of 200 accepted; `endTime` before `time` rejected; a `time` with no `date` rejected; `ownerId
= 'usr_local_dev'` accepted and `ownerId = 'local_dev'` rejected. Type-level tests with
`expectTypeOf` asserting the inferred type matches the hand-written interface in `types/`.

Plus, for the two shape changes in this task:

- `{ title: 'Buy milk' }` and `{ title, type: 'task' }` are **rejected**, naming the missing
  creation target. `{ title, objectKind: 'task', type: 'task' }` parses unchanged.
- `{ title, objectKind: 'plan', type: 'meal' }` parses; the same body with `type: 'task'`
  rejects. `{ title, details: { kind: 'meal', … } }` with no target is rejected rather than
  inventing one from `details.kind`.
- A Task body with participants rejects in schema. A Plan body may carry the field, although
  Phase 1 still rejects a non-empty array at the service boundary until Phase 6.
- A grep test asserting `reminders` appears in no file under `types/activity.ts` and in no
  `Activity` interface, so the removed array cannot be reintroduced by a merge.

---

### P1-07 — `UserRepository` and `GET`/`PATCH /v1/me`

**Files.** `services/api/src/repositories/userRepository.ts`,
`services/api/src/services/userService.ts`, `services/api/src/routes/me.ts`,
`services/api/src/handlers/getMe.ts`, `patchMe.ts`.

**Approach.** `USER#<userId>/PROFILE` read and conditional update, the profile item from
[`../02-architecture/data-model.md#32-user-partition`](../02-architecture/data-model.md#32-user-partition).
`PATCH` accepts `displayName`, `timezone`, `currency`, `weekStartsOn` and
`defaultReminderOffset` only. The reminder default is absent/Off on a real new profile;
`PATCH` accepts any integer `[-10080, 0]`—including `0` for At the time—and `null` to clear it.

Also export `newUserId()` — `usr_<ulid>` — from here, unused in Phase 1 (nothing creates a
user; the seed script writes the fixed dev ID) but written and unit-tested now so Phase 4's
post-confirmation trigger has one correct generator to call rather than inventing a second.

**`GET /v1/me` in local mode returns the seeded dev profile, not a `401`.** That falls out of
the seam rather than being special-cased: `identity` resolves `usr_local_dev`, the handler
reads `c.get('userId')`, the repository loads that profile, and the handler returns it. There
is no local branch anywhere in the path.

**Edge cases.**

- If the profile is missing — the table was created but never seeded — return
  `404 not_found` with the message `Profile not found.` and log at `warn` naming the userId.
  Do **not** add a "run the seed script" hint to the response body: the same code path serves
  a Phase 4 user whose post-confirmation trigger failed, and a production error message must
  not describe a developer workflow. Put the hint in the log line instead, where it helps
  locally and is invisible to users.
- The profile is the tenant record. Every field Phase 4 needs — `email`, `cognitoSub`,
  `onboardingState` — exists in the type from this phase and is simply absent or defaulted on
  the seeded record. Phase 4 populates them; it does not add them.

**Tests.** Integration: `GET /v1/me` against a seeded table returns the dev profile with
every default field present; against an empty table returns `404`; `PATCH` updates a subset
and bumps `updatedAt`; `PATCH` with a field outside the accepted list returns `400` naming
it. A test constructing the app with a stub identity for a different user ID asserts `GET
/v1/me` returns `404` rather than the dev profile — the first tenancy assertion in the
codebase, written while there is only one tenant.

---

### P1-09 — `ActivityRepository`

**Files.** `services/api/src/repositories/activityRepository.ts`.

**Approach.** Implements access patterns 1, 2, 3, 4, 4b, 5 and 16 from
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns).
In Phase 1 that means: put an Activity plus its owner `ActivityIndex` entry in one
transaction; query `pk = ACT#<id>` for full detail; update `ACT#/META` conditionally on
`updatedAt`; delete the whole partition plus every index entry; and query GSI1 for the flat
filtered lists.

Access patterns 4 and 4b are **the same query** with two different consumers, and the
repository serves both by serving neither specially: `getActivityPartition(activityId)`
returns every item under `ACT#<id>`, `REM#` rows included, unfiltered. The caller-scoping is
a projection rule and lives in P1-10 — see the decision there. A repository that filtered
would make the reminder scheduler (Phase 5) impossible to express without a second read.

`REM#<userId>#<reminderId>` rows are written for the **creator only** when
`CreateActivityInput.reminders` is present, in the same transaction as `META` and `IDX#`.
There is nothing in this phase that reads or fires them; the endpoints are P2-16 and the
scheduling is Phase 5. The rows exist now so the key shape is exercised from the first write
rather than retrofitted onto stored data.

The `ActivityIndex` item carries the GSI1 keys and the projected `AgendaItem` fields. Which
bucket it lands in is derived on every write:

| Condition | `gsi1pk` | `gsi1sk` |
| --- | --- | --- |
| `recurrence` present | `U#<userId>#R` | `<seriesStartDate>#<activityId>` — the first segment's `effectiveFrom` (data-model §3.5/§4.2) |
| `schedule.date` present | `U#<userId>#S` | `<localDateTime>#<activityId>` |
| otherwise, `objectKind: 'plan'` | `U#<userId>#P` | `<lastActivityAt>#<activityId>` |
| otherwise, `objectKind: 'task'` | `U#<userId>#N` | `<createdAt>#<activityId>` |

`localDateTime` is `YYYY-MM-DDTHH:mm` in the user's local wall clock, with `00:00` when there
is no time. This is not the UTC instant; `scheduledAtUtc` is stored separately on the `META`
item for reminders and `.ics`. **No timezone arithmetic is involved** — `schedule.date` and
`schedule.time` are already stored as user-local wall clock (`data-model.md` §4.1), so this is
string composition. Deriving `scheduledAtUtc` with `date-fns-tz` is P1-10's.

> **Amended in P1-09**, on the two points the original text left open:
>
> - **The index projection is written in full.** All of `GSI1_PROJECTED_ATTRIBUTES` lands on
>   the entry from the first write, so nothing needs backfilling when Phase 2's agenda starts
>   reading it. One field cannot be derived here: `today-and-tasks.md` §4 makes a **task's**
>   `subtitle` its *parent plan's title*, which this layer does not have — so the repository
>   takes it as an argument. P1-10 already loads the parent to enforce the nesting cap, so
>   the title is in hand and no extra read enters the write path.
> - **`SUB#` child pointers are written here, in Phase 1.** §3.1 says they are written when
>   an activity is given a `parentActivityId`; §7's create row listed only `META` and `IDX#`.
>   Resolved in favour of §3.1 — the same argument this task already makes for `REM#` rows,
>   that the key shape is exercised from the first write rather than retrofitted onto stored
>   data — and §7's row is amended to match.
>
> `lastActivityAt` does not exist until P2-06, which initialises it to `createdAt`. The `#P`
> sort key therefore uses `createdAt` in Phase 1, and P2-06 replaces that line rather than
> adding to it.

Every method takes `userId` as its first parameter. Every query is scoped by it. The
repository has no concept of a "current user" and no access to the Hono context.

**Edge cases.**

- A write that changes which bucket an activity belongs to must ~~**delete and re-put**~~
  **rewrite the whole** index entry, not update it — GSI keys change and a stale entry in the
  old bucket produces a ghost row on Today. Do it in the same transaction.

  > **Corrected in P1-09.** "Delete and re-put" cannot be implemented: the index entry's
  > primary key is `USER#<u>` / `IDX#<activityId>` in **every** bucket — only the `gsi1pk`
  > and `gsi1sk` attributes move — and DynamoDB rejects two operations on one item in a
  > transaction with *"Transaction request cannot include multiple operations on one item"*.
  > Found by the integration suite, not by reading.
  >
  > The half that matters is unchanged and is what the code does: a **whole-item `Put`**,
  > never an `UpdateItem`. DynamoDB maintains a GSI from the item's current attributes, so
  > replacing the item atomically moves the projection; an update that set only some
  > attributes would leave the old `gsi1pk`/`gsi1sk` in place and strand the row in its old
  > bucket for ever. Rebuilding every attribute is also what lets a cleared field — or the
  > GSI keys themselves, for §3.5's archival sweep — actually disappear.
  >
  > A real `Delete` of an index entry still exists: when a **participant is removed** in
  > Phase 6, their own entry goes. That is a different item in a different partition.
- Untimed items sort before timed ones on the same date because `00:00` sorts first. That is
  the intended order and the agenda partition logic in Phase 2 depends on it.
- The `META` item must never be larger than 400 KB. `notes` at 4000 characters plus 60
  ingredients is nowhere near it, but the validation limits are what keep it true.

**Tests.** Integration on DynamoDB Local: create → read back the exact shape; bucket
assignment for all four buckets, including the same undated title as Task (`#N`) and Plan
(`#P`); a schedule or explicit object change moving an item between buckets leaves
exactly one index entry; `GET` by id returns the whole partition in one `Query`; a create
carrying two `reminders` writes exactly two `REM#` rows and both carry the creator's
`userId`; delete removes every item under `ACT#<id>` — `REM#` rows included — and the index
entry; a conditional update with a stale
`updatedAt` throws `ConditionalCheckFailedException`. Plus the tenant-isolation case required
by [`definition-of-done.md`](definition-of-done.md) §3: write two activities under two
different user IDs and assert each user's list query returns only their own. Both IDs are
made up; neither needs to exist as a profile. Writing this test now, against a fake second
user, is what proves the keys are right before there is any way to notice they are not.

---

### P1-10 — Activity service

**Files.** `services/api/src/services/activityService.ts`,
`services/api/src/services/authz.ts`.

**Approach.** The business rules that must not live in handlers or repositories:

1. **Status derivation.** `status` is never taken from the client except `cancelled`.
   Otherwise `schedule?.date ? 'scheduled' : 'saved'`, with `completed`/`skipped` set only by
   the completion endpoints (Phase 2).
2. **`assertActivityAccess(userId, activityId, level)`** in `authz.ts`, the single place the
   owner / participant / stranger rules from
   [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
   are enforced. A stranger gets `not_found`, never `403`. Called at the top of every
   activity-scoped service method.
3. **`scheduledAtUtc` derivation** from `date` + `time` + `timezone` with `date-fns-tz`,
   recomputed on every schedule write and never trusted as authoritative over the three
   stored fields.
4. **`visibility`** starts `private` and changes to `shared` only when the user explicitly
   adds a participant or shares the Plan. It is not derived from the current count; removing
   the last participant leaves it `shared`.
5. **Nesting cap:** a `parentActivityId` pointing at an activity that itself has a
   `parentActivityId` is `validation_failed` (two levels, per
   [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §3).
6. **Reminder scoping on the detail projection.** `GET /v1/activities/:id` (P1-12) returns
   the partition P1-09 read, and the service drops every `REM#` row whose `userId` is not the
   caller's before the handler sees it. A shared plan has one schedule and many reminder
   sets, and one user's offsets are a statement about their day
   ([`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)
   access pattern 4, `../02-architecture/security-privacy.md` §1 row 15).

> **Decision:** the filter is in the service's projection, not in the repository. Access
> pattern 4b — the Phase 5 reminder scheduler — needs **every** `REM#` row from the same
> query, and a repository that had already discarded them would force a second read of a
> partition it has just loaded. One reader filters, one does not, and the difference is
> stated at the layer where it is a policy rather than a storage concern.
>
> There is exactly one client-facing serialiser for an activity, so there is exactly one
> place this can be forgotten, and criterion 22 is the test that it is not.

`authz.ts` is written in full even though every activity in Phase 1 belongs to the only user
there is. The owner / participant / stranger distinction is a rule about keys, not about
authentication, and the code that enforces it is testable today with two invented user IDs.
Deferring it to Phase 6 would mean adding an access check to eleven existing call sites.

No AWS SDK type crosses into this layer, and it knows nothing about HTTP.

**Tests.** Unit with a mocked repository: every status-derivation branch; `scheduledAtUtc`
for a timed item, an untimed item (absent), and across a DST boundary; the nesting cap;
`assertActivityAccess` returning `not_found` for a stranger and for a non-existent id, and
`forbidden` for a participant attempting an owner-only action. Plus the projection: a
partition seeded with `REM#usr_a#…` and `REM#usr_b#…` serialised for `usr_a` contains
`usr_a`'s reminder and **no trace of `usr_b`'s** — not the offset, not the id, not a count.
Both user IDs are invented; neither needs a profile, and writing the test now is what stops
the filter being added in Phase 6 to code that has shipped without it.

---

### P1-11 — `POST /v1/activities`

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/handlers/createActivity.ts`.

**Approach.** `zValidator('json', createActivityInput)`, then one service call, then a `201`
with the created `Activity` in the envelope. One `TransactWriteItems` writes `ACT#/META`,
`USER#<owner>/IDX#` and one `ACT#/REM#<owner>#<reminderId>` per supplied reminder, where
`<owner>` is `c.get('userId')`.

**The object and type are explicit, not inferred.** By the time the handler runs, validation
has required the valid `objectKind`/`type` pair chosen by the global chooser or fixed by a
labelled contextual action. There is no default, classification branch, or recovery path in
this handler. The response echoes both stored fields so the client can verify it saved the
target the user selected.

Reminders supplied at creation belong to the **creator alone**. There is no path in this phase
by which one user's create writes a reminder for another user, and there is none in any later
phase either — a joiner's reminder comes from their own default at join time (P6-13).

Participants supplied on a **Plan** at creation are **Phase 6**; in Phase 1 that union branch
accepts the field (so the contract is stable) and the service rejects a non-empty array with
`validation_failed` and the message `Sharing is coming soon.` The Task branch never accepts
participants. Do not silently drop them.

List linkage is **Phase 3**, but it is never accepted by this generic endpoint. Only
`POST /v1/lists/:id/items/:itemId/schedule` may set Activity `listId` / `listItemId` after
checking list access; `POST /v1/activities` rejects those relationship keys.

**Edge cases.** The `Idempotency-Key` header is required (P1-04). Ingredient rows arrive with
`addedToListId` absent — writing to a list is Phase 3 and nothing in this phase touches a
list. More than 3 reminders is `validation_failed`, not a silent truncation.

**Tests.** Integration: a minimal `{ objectKind, type, title }` body creates a `saved` Activity with
`participantCount: 0`, `childCount: 0`, `expenseTotalCents: 0`, `visibility: 'private'` and
`ownerId: 'usr_local_dev'`; a body with `schedule.date` creates a `scheduled` one in the `#S`
bucket; a `details.kind` mismatch `400`s with a `details[]` entry pointing at `details.kind`;
a repeat with the same `Idempotency-Key` returns the identical body with `200`.

Plus the explicit-intent path: **a body of `{ "title": "Buy milk" }` and nothing else, and a
body of `{ title, type: 'task' }`, each return `400 validation_failed` and write nothing**.
A valid case sends `{ title, objectKind: 'task', type: 'task' }` and asserts both stored
fields. A Plan case sends `{ title, objectKind: 'plan', type: 'custom' }`. This proves the
same title follows the caller's choice rather than selecting its own destination.

---

### P1-13 — `PATCH /v1/activities/:id`

**Approach.** Partial update with `If-Match: <updatedAt>`. A missing header is
`validation_failed`; a mismatch is `409 conflict` with the current `updatedAt` in the body so
the client can refetch and re-apply. Implemented as a conditional `UpdateItem` on
`updatedAt`, not a read-then-write.

Changing Plan kind, or explicitly converting Task/Plan, runs P1-17 server-side and logs the
dropped `details` payload at `info` with `activityId`, the old target and the old `details`,
so a support request can recover it from the logs inside the retention window. A cross-object
change must send a complete valid target pair; `objectKind` alone never causes the server to
choose a type.

**Edge cases.**

- A participant may not patch `title`, `schedule`, `location`, `objectKind` or `type`. Enforced in
  `authz.ts`, not in the handler.
- Task → Plan requires an explicit `PlanType`. Plan → Task is `409 conflict` while
  `participantCount`, `expenseTotalCents`, or `childCount` is non-zero; the error names the
  blocking People, Expenses, or Prep sections rather than deleting them.
- Changing object or Plan kind must not change `status`, `completedAt` or `outcome`.
- A patch that adds or clears `schedule.date` changes the GSI1 bucket, so it must go through
  the delete-and-re-put transaction from P1-09, not a bare `UpdateItem`.

**Tests.** Integration: correct `If-Match` succeeds and bumps `updatedAt`; a stale one `409`s
and the body carries the current value; a patch from a stubbed non-owner identity returns
`404`; an explicit zero-blocker change from `{ objectKind: 'plan', type: 'watch' }` to
`{ objectKind: 'task', type: 'task' }` drops `season`/`episode`/`service`, keeps `title`,
`notes` and `schedule`, leaves every `REM#` row in the partition untouched, and emits the log
line. The same request with one participant returns `409` byte-identically. A patch that sets
`schedule.date` to `null` moves a Task index entry to `#N` and sets
`status: 'saved'`.

---

### P1-14 — `DELETE /v1/activities/:id` and its cascade

**Approach.** Owner only. Query the whole `ACT#<id>` partition first, then delete every
partition item, the owner's `IDX#` entry and every participant's, and clear pointers on
anything that points back:

> **Decision, 2026-08-08: Phase 1 ships no settlement guard, and `settlement_conflict` is
> not added to the `ErrorCode` union in this phase.**
>
> The original text had this task return `409 settlement_conflict` when a child `EXP#` row
> carried a non-empty `settlementIdByPersonId`, on the reasoning that the delete contract
> should be guarded from its first implementation. Three things make that unbuildable here.
> `settlement_conflict` is **not a member of the closed union** in
> [`packages/shared/src/errors.ts`](../../packages/shared/src/errors.ts), and
> [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §1's own
> enumeration omits it while §2.3 requires it — a pre-existing contradiction between two
> architecture sections that Phase 1 is simply the first task to walk into. There is no
> `Expense` type, no `EXP#` key builder in P1-05's list, and no `settlementIdByPersonId`
> field defined anywhere in this phase. And the guard's test — "a fixture settled Expense
> returns the exact blocking ids" — would require inventing an Expense row shape in Phase 1
> that Phase 7 then has to match, which is the retrofit risk running backwards.
>
> A guard over rows that no schema defines is the same artefact this repository has twice
> refused elsewhere: the pass-through `identity` middleware Phase 0 declined to stub, and the
> `AUTH_MODE` environment variable `ApiStack` declines to set. It reads as an implemented
> control and is none.
>
> **Owner: P7-08**, which already claims this exact case — its edge cases say "the parent
> Activity delete route uses the same aggregate guard across every child Expense" and its
> tests already cover "deleting the parent returns the union of blocking ids". P7-08 adds the
> code to the union (a one-line insert, per
> [`../04-conventions/git-workflow.md`](../04-conventions/git-workflow.md) §6.2), adds the
> guard to this route, and amends `api-contract.md` §1's enumeration in the same PR.
>
> Until then the cascade below is the whole contract, and there is nothing it can fail to
> block: no task before P7-08 writes an `EXP#` row.

| Pointer | Action |
| --- | --- |
| Child activities' `parentActivityId` | **Cleared, not deleted.** Prep tasks survive their parent ([`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §5.5). |
| Viewer-local `ListItemActivityLink` rows for this Activity | Delete only rows whose `activityId` still names the Activity, derived from its `listId`, `listItemId`, owner and participants. The ListItem itself is untouched and survives. (Phase 3 supplies the link repository; before then there are no rows to delete.) |
| `EXPENSE#<expenseId>` locators | Delete each locator with its child Expense. Phase 7 starts writing them; a retry treats an already-absent locator as success. |
| Grocery items' `sourceActivityId` | **Untouched.** Provenance is not linkage; the label stays as written. |
| EventBridge schedules | Deleted (Phase 5). |

**Edge cases.** A partition with more than 100 items (many participants plus many updates)
exceeds a single transaction. Delete in batches of 25 with `BatchWriteItem` and accept that
the operation is not atomic — a partially deleted activity is recoverable by re-running the
delete, whereas a transaction that can never succeed is not. Make the handler idempotent so a
retry completes it.

**Tests.** Integration: every item under `ACT#<id>` is gone; a child activity survives with
`parentActivityId` absent; a second `DELETE` returns `404` and does not throw; a stubbed
non-owner gets `404`.

The two settlement cases — a fixture settled Expense returning the exact blocking ids and
leaving every row byte-identical, and the locator cascade — move to **P7-08** with the guard
and the Expense schema they need. Do not write a placeholder for them here.

---

### P1-17 — Object and Plan-kind change mapping

**Files.** `packages/shared/src/activity/changeActivityKind.ts`.

**Approach.** A pure function
`changeActivityKind(activity, target) → { objectKind, type, details, notes, location,
dropped: DroppedField[], blockers: ChangeBlocker[] }`
implementing the exhaustive table in
[`../01-product/activities.md`](../01-product/activities.md) §6.3. It lives in `shared`
because both the server (to apply it) and the client (to render the "this will remove"
confirmation before calling) need the identical answer.

`target` is exactly `{ objectKind: 'task', type: 'task' }` or
`{ objectKind: 'plan', type: PlanType }`; it can never be constructed from title text. A
Plan → Task result reports People, Expenses, and Prep blockers from the three stored counts
and is not writable until all are zero. Task → Plan is unblocked only after the user has
chosen one visible Plan kind.

`DroppedField` carries a stable key and a human label (`Season and episode (S2 E4)`) so the
confirmation copy is generated, not hand-written per pair.

**Edge cases.** `event → outing` appends `description` to `notes` separated by a blank line
only when `notes` is non-empty. `outing → event` moves `placeName` into `location.label`
**only if** `location.label` is empty. `any → watch` sets `details.mediaTitle` from `title`.
`task ↔ custom` drops no type-specific user data and therefore shows no destructive
confirmation, but still requires the explicit target chooser and named save action.

**Tests.** All 36 ordered type pairs, table-driven, asserting carried and dropped fields
exactly. A test that the function is pure (same input twice, deep-equal output, input not
mutated). A test that every pair in the canonical table has a case and no case exists that
the table does not list. Plan → Task is blocked separately for each non-zero count and for
all three together; Task → each of the five Plan types returns the selected target exactly.

---

### P1-18 — `/v1/capture/*` `501` stubs

**Files.** `services/api/src/routes/capture.ts`.

**Approach.** Three routes, each validating its input against the real schema from
`packages/shared/src/schemas/capture.ts` and then throwing
`new AppError('not_implemented', 'Capture is not available yet.')`, mapped to `501`.

Validating before failing is deliberate: it means the client's request shape is exercised
from Phase 1, so Phase 8 cannot discover that the client was sending the wrong body all
along.

Every request requires `creationTarget`: `{ objectKind: 'task', type: 'task' }`,
`{ objectKind: 'plan', type: PlanType }`, or `{ objectKind: 'listItem', listId }`. The stubs reject a
missing target and reject attempts to place `type`, `listId`, participants or sharing state
inside parseable fields. Reminder state is outside capture too: `reminder`, `reminders`,
`offsetMinutes` and notification actions are rejected rather than interpreted from words.
Capture may fill fields only after the destination is explicit.

**Tests.** Each route returns `501` with `code: "not_implemented"`; a malformed body returns
`400` **before** the `501`, proving validation runs first. A request with content but no
`creationTarget` is one of those `400` cases; the same content with each valid target reaches
the `501` stub unchanged.

---

### ~~P1-19~~ — the `AuthTokenProvider` seam · **delivered by P0-20**

> **Amended 2026-08-08. There is no work in this task; do not open a branch for it.** The
> client-side half of the identity seam shipped with the HTTP client in P0-20, and it shipped
> in a different shape from the one this section originally specified. The section is kept,
> corrected, because Phase 4 builds directly against it.

**What exists, and where.** The interface and the null implementation live in
[`packages/shared/src/client/http.ts`](../../packages/shared/src/client/http.ts) — the file
that consumes them — not in a separate `client/auth.ts`. Both are re-exported from
`@od/shared/client`.

```ts
// packages/shared/src/client/http.ts — as shipped
export interface AuthTokenProvider {
  getToken(): Promise<string | undefined>;
}

export const nullTokenProvider: AuthTokenProvider = {
  getToken: () => Promise.resolve(undefined),
};
```

**Three differences from the original text, and why the code is right.**

| This document said | The code says | Which wins |
| --- | --- | --- |
| `Promise<string \| null>` | `Promise<string \| undefined>` | **The code.** `exactOptionalPropertyTypes` is on repository-wide; `undefined` is the absence value the rest of the codebase uses, and a `null`/`undefined` split at this seam is exactly the kind of two-spellings problem `schemas/common.ts` exists to prevent. |
| `NullTokenProvider` | `nullTokenProvider` | **The code.** It is a value, not a type. |
| `packages/shared/src/client/auth.ts` | `client/http.ts` | **The code.** One consumer, one file; a two-line module imported by exactly one sibling is a file to keep in sync, not a seam. |

No architecture document specifies the signature — `tech-stack.md` §5.2 does not, `auth.md`
does not, and `phase-00-foundations.md` names only the identifiers. Under `CLAUDE.md`'s rule
hierarchy this phase file is the lowest-ranked of the documents involved and is the one that
was wrong, so it is the one amended.

**The behaviour the original text was protecting is intact and tested.** `http.ts` calls
`getToken()` once per request and sets `Authorization: Bearer <token>` **only when the result
is neither `undefined` nor the empty string** — no header key at all otherwise, not an empty
one, not `Bearer undefined`. That is the whole point of the seam: a header that is present
but empty produces a `401` in Phase 4 that looks like a token problem and is actually a
plumbing problem. [`apps/mobile/src/lib/apiClient.ts`](../../apps/mobile/src/lib/apiClient.ts)
already supplies `nullTokenProvider`, and that construction site is the only line Phase 4
changes on the client side beyond adding screens.

**What this phase still owes.** Verification, in whichever task next touches the client
(P1-20): confirm acceptance criterion 18 still passes, and that `getToken` is called exactly
once per request including on a retried `GET`. The existing unit suite in
`packages/shared/src/client/http.test.ts` covers this; if it does not, add the case there
rather than opening P1-19.

**Still true, and still Phase 4's:** the single-flight refresh lock and the
one-retry-on-`401` rule belong to Phase 4's *implementation* of this interface, not to
`http.ts`. Do not add a retry-on-401 hook now — an unauthenticated client that retries a
`401` retries forever. And no `process.env` and no storage API in `packages/shared`; the
provider is constructed by the app and handed in.

---

### P1-20 — Shared API client: `me`, `activities`, `capture`

**Files.** `packages/shared/src/client/endpoints/{me,activities,capture}.ts`.

**Approach.** One function per endpoint in
[`../02-architecture/api-contract.md#2-endpoints`](../02-architecture/api-contract.md#2-endpoints),
typed from the P1-06 schemas, returning parsed data or throwing `ApiError`. Register every
schema with the OpenAPI harness (P0-25) as it is written.

No function in this file knows whether a token exists. `getMe()` is the same call in Phase 1
and in Phase 4; the difference is entirely inside the `AuthTokenProvider` handed to the
client at construction.

The three capture functions are written against the real request and response schemas and
handle `not_implemented` as a first-class outcome, not an error to surface. Their callers
(P1-24) degrade silently, per
[`../01-product/ai-capture.md`](../01-product/ai-capture.md) §6.

**Tests.** Unit per endpoint with a stubbed `fetch`: request shape, response parsing, error
mapping. A test asserting `capture.parse()` surfaces `not_implemented` as a typed value the
caller can branch on rather than throwing an unhandled error.

---

### P1-21 — `seed-local.ts`: the dev profile and sample activities

**What to build.** A command that turns an empty local table into an app with something in
it. Screens built against an empty database get built wrong: empty states get all the
attention, row density and text truncation get none, and every manual check starts with five
minutes of typing.

**Files.** `services/api/scripts/seed-local.ts`, root script `seed:local`.

> **Decision:** the seed script lives in `services/api/scripts/`, not `infra/scripts/`,
> because it writes through `UserRepository` and `ActivityRepository`. That guarantees the
> seeded rows are byte-identical to what the API writes — including GSI1 bucket assignment and
> `schemaVersion` — and it keeps the "no `pk`/`sk` construction outside the repository layer"
> rule intact. `infra` may import `@od/shared` only, so a seed script there could not use the
> repositories and would have to rebuild key construction, which is exactly the duplication
> that rule exists to prevent. ~~`testing.md` §8.2 already names `services/api/scripts/` for
> the local seed; amend its filename to `seed-local.ts` in this PR.~~ **Already done — do not
> re-do it.** `testing.md` §8.2 names `services/api/scripts/seed-local.ts` in full. Verified
> 2026-08-08. The root script is `pnpm seed:local`, so the command is stable regardless of
> where the file lives.

**Approach.**

```bash
pnpm seed:local            # idempotent; safe to run any number of times
pnpm seed:local -- --reset # truncate the table first, then seed
```

It refuses to run unless `STAGE=local` **and** `DDB_ENDPOINT` is set, with the same
throw-don't-warn shape as P1-02. A seed script that can be pointed at a deployed table is a
data-loss incident waiting for a mistyped environment variable.

What it writes:

| Item | Detail |
| --- | --- |
| `USER#usr_local_dev/PROFILE` | `displayName: 'Dev'`, `timezone: 'America/New_York'`, `currency: 'USD'`, `weekStartsOn: 0`, `defaultReminderOffset: -15`, `allDayReminderHour: 9`, quiet hours 22:00–07:00, `onboardingState: 'done'`. This dev fixture explicitly configures `-15` to exercise the saved-default path; real new profiles omit the field and ship Off. Every other profile field is present so no screen hits an undefined. |
| ~24 activities | A mix of explicit Tasks and Plans across all five Plan kinds, using the builders from `packages/shared/src/testing/builders.ts` (`testing.md` §8.1). Every row supplies a valid `objectKind` + `type` pair so the seed and tests agree on the creation contract. |
| Scheduling spread | Some undated Tasks in `#N`, some undated Plans in `#P`, and some scheduled yesterday, today, tomorrow, this weekend and three weeks out in `#S`. Phase 2's agenda and Plans work then have data on day one. |
| Content spread | One activity with a 200-character title, one with 4000 characters of notes, one meal with 60 ingredient rows, one with a location label and address, one `cancelled`. These are the rows that break layouts, and they should exist before the layout does. |

Not written: participants, lists, expenses, recurrence, occurrences, attachments. Those
entities do not exist yet. Phases 2, 3, 6 and 7 each extend this script in the same PR as the
entity they add.

**Idempotency.** IDs are derived deterministically from a fixed seed, so every run writes the
same keys and a second run is a set of overwrites rather than a second set of rows. Dates are
computed **relative to today** so the data stays plausible in six weeks; only the IDs are
fixed. Running twice must produce the same item count — assert it, do not assume it.

**Edge cases.**

- Deterministic ULIDs and relative dates together mean the same activity ID moves date as the
  weeks pass. That is wanted. If a test needs a fixed date, the test builds its own row; E2E
  tests never depend on seed data (`testing.md` §8.2).
- The script must be readable as documentation. A new agent reading `seed-local.ts` should
  learn what a well-formed Activity of each type looks like faster than by reading the schema.
  Favour explicit literal objects over a clever generator loop.

**Tests.** Integration: run against an empty table, count items; run again, count again,
assert equal; assert the profile round-trips through `GET /v1/me`; assert every seeded
activity passes the `activity` Zod schema, which catches a seed that drifts from the schema
as soon as it happens.

---

### P1-22 — `packages/ui` theme, primitives and token gallery

> **Scope narrowed 2026-08-08.** The test environment these primitives are asserted in — the
> `react`/`react-native` dependencies on `packages/ui`, the jsdom environment, the `.tsx`
> include globs and `apps/mobile`'s deferred coverage floor — is **P1-31**, and this task
> depends on it. None of it existed when this section was written, and carrying it here made
> an already-L task quietly own the client test setup for two workspaces. **Do not configure
> a test environment in this task.** If `Button.test.tsx` does not run when you start,
> P1-31 has not landed and this task is not ready.

> **Completed 2026-08-09. Four deviations, recorded rather than edited into the plan.**
>
> | # | What happened | Why |
> | --- | --- | --- |
> | 1 | **The inventory built is `design-system.md` §6's, not the file list below.** No `Stack`, `Select` or `Divider`; `TextField` shipped as `Field`, and `Toast`/`Skeleton` live in `Feedback.tsx` beside `SectionHeader` and `EmptyState`. `Avatar`, `AvatarStack`, `Card`, `IconButton`, `IconTile`, `ProgressBar`, `SegmentedControl`, `Touchable`, `DatePicker` and `TimePicker` are here and are not below. | The list below predates the 2026-08-08 visual refresh. [`design-system.md`](../04-conventions/design-system.md) §6 declares itself canonical for primitives and outranks an implementation plan ([`agent-playbook.md`](../04-conventions/agent-playbook.md) §2), so it is what was built. `Stack` and `Divider` have no §6 row and no screen has asked for one — a `View` with a `gap` token is the stack, and the timeline's connector is a `Row` concern. Raised with the founder before anything was written rather than resolved inside the diff. |
> | 2 | **The date chips are `activities.md` §3.4's five**, not `design-system.md` §6's three. | Two canonical docs disagreed. The product doc owns behaviour and wins; §6's row was amended in the same pull request so it no longer names a subset. |
> | 3 | **Breakpoints live in `theme/tokens.ts`, not `theme/breakpoints.ts`**, and there is no `theme/typography.ts` — the nine type roles are `tokens.ts`'s `type`. | `tech-stack.md` §3.5 and `repo-structure.md` §1 both name `breakpoints.ts`. Left as built: the values are three lines, `useBreakpoint()` is exported from the theme barrel exactly as those docs describe, and moving a file four merged branches already import through the barrel is churn with nothing visible at the other end. Recorded so the next agent does not go looking for the file. |
> | 4 | **`Chip` gained `aria-pressed`.** | Found when `DatePicker`'s chips needed to say *which* date was chosen: React Native Web drops `accessibilityState.selected` on `role="button"`, so a selected filter chip announced nothing and its selection rested on the accent fill alone — which `design-system.md` §5.1 forbids. One attribute, one test. |
>
> The token gallery is `apps/mobile/app/(app)/gallery.tsx`, `__DEV__`-gated: every primitive
> in every state, both schemes side by side. That is the surface §5.1 asks to be eyeballed
> before screens are built on the derived dark values.

**Files.** `packages/ui/src/primitives/{Text,Stack,Button,Row,Checkbox,Sheet,TextField,
Select,Chip,Toast,Skeleton,Divider}.tsx`,
`packages/ui/src/theme/{tokens,breakpoints,typography}.ts`.

**Approach.** Pure primitives with no knowledge of activities, lists, or the API. Every one
must satisfy
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6 from the
first commit rather than in a Phase 5 remediation pass:

- 44 × 44 pt minimum hit target, ≥ 8 pt between adjacent targets.
- `allowFontScaling` is never `false`; layouts are content-sized with a 44 pt minimum, never
  fixed-height.
- Contrast ≥ 4.5:1 for body text and ≥ 3:1 for control boundaries, in light and dark.
- `accessibilityRole` on every interactive primitive; `Checkbox` is its own accessibility
  element.
- Reduce Motion honoured: transitions become cross-fades, no animation exceeds 300 ms.

`breakpoints.ts` defines `compact` / `medium` / `expanded` at 0 / 768 / 1200 with a
`useBreakpoint()` hook backed by `useWindowDimensions()`. Never `Dimensions.get()` at module
scope — it is wrong after rotation and wrong on web resize.

**Tests.** Unit render tests asserting `accessibilityRole` and label on every primitive; a
hit-target test asserting the measured layout of `Checkbox` and `Button` is ≥ 44 pt; a
contrast test computing the ratio for every token pair in both themes and failing under
threshold. Storybook is not worth its maintenance for one developer; the tests are the
contract.

---

### P1-23 — App shell: three tabs, header, FAB, placeholders

**Files.** `apps/mobile/app/(app)/_layout.tsx`, `apps/mobile/app/(app)/(tabs)/**`.

**Approach.** The three-tab shell — Today, Plans, Lists — with the header and the FAB, per
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §2. Today and
Lists render placeholders naming the phase that fills them (Phase 2 and Phase 3); Plans
renders the flat activity list from P1-16, which is the only real screen in the shell this
phase.

**There is no auth guard and no `(auth)` route group.** The app opens straight into
`(app)`. Phase 4 adds the group, the guard and the redirect. The shell is written so that
adding a guard is a change to `app/(app)/_layout.tsx` only: no screen inside it reads a
session, and no navigation call assumes it is already at the root.

**Edge cases.** The FAB opens the same global chooser modally from every tab. Wire it once in
the layout, not three times; a tab must never replace it with a title-first or inferred route.

**Tests.** A render test asserting three tabs with the exact labels and that the FAB is
present on each. Playwright: the app loads at `/` with no redirect.

---

### P1-24 — The explicit Add chooser and target routing

> **Built 2026-08-08. Three deviations, recorded rather than edited into the plan.**
>
> | # | What happened | Why |
> | --- | --- | --- |
> | 1 | **P1-23's shell was built in this task's branch**, not before it. | Neither of P1-24's declared dependencies had landed: `(app)/_layout.tsx` was a bare `Stack` with one route, so there was no FAB to open the chooser from and no way to honour "the FAB opens the same chooser from every tab". The three tabs, the header, the FAB and the placeholders are here; the Plans tab is a placeholder rather than P1-16's flat list, because P1-16 has not landed either. |
> | 2 | **P1-20 was delivered as a slice**, not in full: `createActivity` and the three `capture` functions. `me` is untouched. | Those four are what P1-24 calls. `POST /v1/activities` (P1-11) does not exist yet, so a save currently fails with the `interaction-contract.md` §5.3 banner and an intact draft — which is spec'd behaviour, and the request body is asserted by unit and render tests either way. |
> | 3 | **The Plan-kind chooser's heading is new copy**: `What kind of plan?`. | `activities.md` §2.2 drew the object chooser's heading and named none for the second step. Added to that section in the same PR; the founder confirms or replaces it. |
>
> Also moved: the Phase 0 health screen from `/` to `/health`, because the root route is
> Today once the shell exists.

**Files.** `apps/mobile/app/(app)/compose.tsx`,
`apps/mobile/src/features/compose/{hooks,components,model}/**`,
`apps/mobile/src/stores/composeDraft.ts`.

**Approach.** Exactly the explicit-intent flow in
[`../01-product/activities.md`](../01-product/activities.md) §2. Presented modally. The first
screen contains three choices with these exact labels and order: `Task`, `Plan`, `List item`.
It has no title field, parser, recent destination or pre-selected row.

- `Task` fixes `{ objectKind: 'task', type: 'task' }` and opens the Task form.
- `Plan` opens a second required chooser: `General`, `Meal`, `Watch`, `Event`, `Outing`,
  mapping respectively to `custom`, `meal`, `watch`, `event`, `outing`, then opens that form.
- `List item` is visible so the mental model is stable, but routes to the Phase 3 placeholder
  until lists exist. Phase 3 replaces that destination with an explicit list picker.

Only after a target is fixed does its form focus the title and show Camera / Photos / Link.
Those buttons are degraded per [`../01-product/ai-capture.md`](../01-product/ai-capture.md)
§6 while capture is stubbed, and every stub request carries the immutable target from P1-18.

The **degraded path is the v1 path** and must be built as the primary experience, not as an
error state:

| Mode | Behaviour while capture returns `501` |
| --- | --- |
| Type | **Silent.** No suggestion banner, no error, no toast. The typed text remains in the already-chosen Task or Plan-kind form. |
| Camera / Photos | The image is still attached (Phase 3 wires the upload; Phase 1 shows the picked image locally and disables Save-with-attachment). Copy: manual entry, per `ai-capture.md` §6.2. |
| Link | The URL is retained on `sourceUrl` regardless. The user completes the form manually. |

The draft lives in a Zustand store (client state — it would be meaningless to persist
server-side). Server data never enters Zustand.

`Save task` or `Save plan` issues one `POST /v1/activities` with an `Idempotency-Key`
generated once at `onMutate` and reused on every retry, regenerated only when the draft
changes. The request always contains the fixed `objectKind` and `type`. Then the toast in
§2.5 is anchored to where the item landed.

**Edge cases.**

- The final save action is enabled as soon as `title` is non-empty after trimming. There is
  no second required field on any chosen target.
- Back from a form returns to its chooser without losing compatible draft fields. Changing
  Plan kind applies P1-17's explicit field mapping and never happens because of typed words.
- There is no path from the global `+` to a writable title field without first selecting
  `Task` or a Plan kind, and there is no Activity request body without both `objectKind` and
  `type`.
- Closing with non-empty content prompts `Discard this?` with Discard / Keep editing.
- Nothing is written to the server until the user commits.
- The chooser does not remember, reorder or pre-select the last target. Explicit intent costs
  the same one tap every time.

**Tests.** Maestro flow: open global `+`, assert the exact three labels, choose `Task`, type a
title, tap `Save task`, and assert the request carries
`{ objectKind: 'task', type: 'task' }`. A second flow chooses `Plan` then `Watch`, taps
`Save plan`, and asserts `{ objectKind: 'plan', type: 'watch' }`. Assert that no capture
request and no create request occurs before the target choice. A timed run asserting the S1
target — under 5 seconds from FAB tap to saved — runs as a median of 10 simulator runs,
reported but not yet gating (device timing gates in Phase 5). Unit tests on the draft store:
an explicit Plan-kind change applies P1-17's mapping in memory before any write.

---

### P1-25 — Task and five Plan-kind creation forms

**Files.** `apps/mobile/src/features/compose/forms/{Task,Meal,Watch,Event,Outing,Custom}
Form.tsx`, plus shared controls in `apps/mobile/src/features/compose/controls/`.

**Approach.** One form per type, rendering **exactly** the fields in
[`../01-product/activities.md`](../01-product/activities.md) §4, in the given order. The order
is part of the spec. A field absent from a type's table does not appear, is not collapsed
behind a disclosure, and is not greyed out.

Shared controls behave identically across types (§3.4): the date picker with `Today`,
`Tomorrow`, `This weekend`, `Next week`, `Pick a date` chips; the 5-minute time picker,
enabled only when a date is set; end time shown only once a start time exists; notes at 4000
characters with no formatting; location as free text label plus address with **no** geocoding,
no autocomplete and no map.

Field-level defaults and derivations that must be implemented, not confused with target
inference:

- **Meal:** slot → time (breakfast 08:00, lunch 12:30, dinner 19:00, snack unset) and time →
  slot (< 11:00 breakfast, < 15:00 lunch, < 17:00 snack, else dinner), each applying only
  when the other is unset.
- **Watch:** Kind defaults to `Show` if a season or episode is entered, else `Movie`; season
  and episode fields render only for `Show`. The separate `Also add a list item to…` control
  is **off in every context**. Phase 3 resolves and visibly names a destination only after the
  user turns it on; a date, title, Watch kind, or capture result never enables it.
- **Outing:** `title` and `details.placeName` are kept identical; `location.label` pre-fills
  from Place; the reservation disclosure defaults its name to the user's display name and its
  time to `schedule.time`.
- **Event:** `details.description` and `notes` are distinct — description is public on the
  invite page, notes never leave the owner's view.

Fields that do not appear on a form are still reachable from the detail screen (§4.7). An
Outing having no Reminder field does not mean an Outing cannot have a reminder.

Post-create side effects (`Add selected ingredients to Groceries`, `Also add a list item to
<chosen list>`) are
**Phase 3**. The toggles render, and in Phase 1 they are disabled with the copy `Lists are
coming soon.` rather than being hidden — hiding them means the layout changes in Phase 3.

**Edge cases.** Validation errors are inline and per-field, shown on blur and again on Save,
mapping one-to-one onto the `details[]` entries of a `validation_failed` response. A
highlighted field never blocks Save.

**Tests.** One Vitest render test per form asserting the exact field list and order against a
fixture derived from the canonical table — a test that fails when a field is added, removed or
reordered. Unit tests for each inference rule including the "only when the other is unset"
condition. Playwright: fill and save one of each type on web.

---

### P1-26 — Activity detail screen: read and inline edit

> **Built 2026-08-09. Four deviations, recorded rather than edited into the plan.**
>
> | # | What happened | Why |
> | --- | --- | --- |
> | 1 | **Expenses and Updates are absent, not disabled.** This section lists Expenses among the sections that render a disabled `Add …` affordance. | [`plans-and-lists.md`](../01-product/plans-and-lists.md) §2.2 hides Expenses below two participants and zero expenses, and hides Updates on a private plan with no entries — which in Phase 1 is every plan. Two canonical sources disagreed; resolved in favour of the product doc per [`agent-playbook.md`](../04-conventions/agent-playbook.md) §2, which ranks `01-product/*` above an implementation plan. People, Prep, Lists and Attachments *do* render disabled, as written. |
> | 2 | **`ActivityDetail` is defined by this task**, in `packages/shared/src/types/activity.ts`, as `{ activity, reminders }`. It belongs to **P1-12**, which has not landed. | `api-contract.md` §2.3 described the response in prose and no schema existed. Six of the eight named collections have no schema, no key builder and no row anywhere yet; defining them would be inventing shapes against no implementation. The envelope is an object of named collections so each is **added** rather than redefined. P1-12 extends it. |
> | 3 | **No two-pane layout at `expanded`.** [`design-system.md`](../04-conventions/design-system.md) §8 puts a left rail and a master/detail split at ≥ 1200 px. | Both are shell concerns — the rail replaces the tab bar and a list pane owns selection — and P1-23 built neither. The screen instead uses §8's stated `medium` fallback at every width above `compact`: a centred column at the mock's measure, pushing as a route. "Nothing is lost, only rearranged." |
> | 4 | **`date-fns` added to `apps/mobile`**, and wall-date helpers live in `src/features/activity/model/dates.ts`. | Pre-justified in [`tech-stack.md`](../02-architecture/tech-stack.md) §2.2 but not installed; `coding-standards.md` §4.4 bans hand-rolled month arrays. `packages/shared/src/time/` and its injected `Clock` do not exist and no task owns them yet, so the helpers are local, pure, and take `today` as a parameter — they move to that module when it lands. |
>
> `GET`/`PATCH /v1/activities/:id` (P1-12, P1-13) are still unbuilt, so against the local API
> the screen renders its §5.3 failure state. Every behaviour above is asserted against the
> real shared schemas with a stubbed transport.

**Files.** `apps/mobile/app/(app)/activity/[id].tsx`,
`apps/mobile/src/features/activity/**`.

**Approach.** One `GET /v1/activities/:id`, which is one DynamoDB `Query`. Render the
sections from
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 that exist in this
phase — header, when/where, notes — with the rest present as their empty-state affordances so
the plan's capabilities stay discoverable. People, Prep, Lists, Expenses, Attachments and
Updates render their `Add …` affordance disabled with the owning phase's copy.

Editing is **in place**, with no edit mode and no per-field Save button: text commits on blur,
pickers commit on selection, each issuing a `PATCH` with `If-Match: <updatedAt>`. A `409`
refetches, shows `This plan changed. Review the update.`, and re-applies the pending edit only
when the fields do not overlap; overlapping fields are dropped and named.

**Edge cases.** Tapping the date or time anywhere opens the reschedule sheet; it never edits
in place on the row (U4).

> **Decision:** ship Phase 1's detail screen with **no** completion button. Completion is
> Phase 2, and a disabled primary action teaches users the app is unfinished. The explicit
> `Change object` / `Change Plan kind` path still appears in the `⋯` menu, so the mapping and
> blocker copy are exercised.

**Tests.** Playwright: open a seeded activity, edit the title, blur, assert the `PATCH` fired
once and the new title persists after reload. A test that a stale `If-Match` produces the
conflict copy rather than a silent overwrite.

---

### P1-28 — Repository integration-test harness on DynamoDB Local

**Files.** `services/api/test/integration/harness.ts`, `services/api/test/helpers/*.ts`.

**Approach.** Exactly
[`../04-conventions/testing.md#31-setup`](../04-conventions/testing.md#31-setup): one table
per test **file**, named for it, created from `@od/shared/table` so it cannot drift from
`DataStack`, dropped in `afterAll`, truncated in `beforeEach`. Fixtures are built per test
(§8.1), never shared.

`helpers/auth.ts` provides `authedHeaders()` — content type, request ID, client timezone,
client version, optional idempotency key — and `withUser(userId)`, which returns an app
constructed with a stub identity provider. Neither sends an identity header, because there is
no header-driven identity in this codebase (P1-01).

This harness is the phase's most reused artefact. Every repository test, every route test and
the seed test run on it, and it is the thing that makes the "no AWS in Phases 0 to 3" claim
true rather than aspirational.

**Edge cases.** Table-per-file is what allows Vitest to run files in parallel. A shared table
with a shared truncate produces failures that depend on file ordering and get blamed on the
wrong change.

**Tests.** The harness is the deliverable. Prove it by running the full integration suite
twice consecutively with `--sequence.shuffle` and getting identical results.

---

### P1-29 — Playwright and Maestro harnesses

**Files.** `e2e/specs/*.spec.ts`, `e2e/playwright.config.ts`, `apps/mobile/e2e/*.yaml`,
`.maestro/config.yaml`.

**Approach.** Both run against the **local** stack: DynamoDB Local, the API on `:3000`, and
the Expo web export or the simulator. There is no deployed environment to run against, and
building the harness locally first is what makes it usable as a pre-push check rather than
only as a CI gate.

Playwright: start the API and serve `apps/mobile/dist` with a static server, seed the table
first, then one flow — open global `+`, choose `Task`, create it with `Save task`, and assert
it appears in the flat activity list. Add
`axe-core` on every route reached, per
[`definition-of-done.md`](definition-of-done.md) §5.

Maestro runs against the simulator in a manually triggered workflow (simulator runners are
slow and must never block a PR). One flow: launch, choose `Task`, create with `Save task`,
assert it appears. Both flows assert that title text is never used to choose the target.

Neither flow signs in, because there is nothing to sign in to. Phase 4 adds a sign-in step to
the front of both; write them so that step can be prepended without restructuring the flow.

**Edge cases.** Seed before the run, and have the flow create its own row rather than
asserting on a seeded one. A flow that depends on seed content breaks every time the seed
changes (`testing.md` §8.2).

**Tests.** The harnesses are the deliverable; they run green in CI twice consecutively before
the phase is called done. A flaky E2E test is worse than no E2E test — quarantine rather than
retry-until-green.

---

### P1-30 — `routeSplit`: the per-route registry and the identity split

> **Added 2026-08-08.** Ten tasks in this phase mount a route under `/v1/` and every one of
> them assumed this work was already done. It was not, and no task owned it.

**What to build.** The conversion of `routeSplit` from Phase 0's "one route exists" shape
into the registry every later route registers itself in. This is a refactor of one file plus
its test, done once, before the first Phase 1 route is written — not a line each of ten
tasks adds to a growing `Set` while stepping on each other.

**Files.** `services/api/src/middleware/routeRegistry.ts` (new — the registry),
`services/api/src/middleware/routeSplit.ts` (the middleware), `services/api/src/app-env.ts`
(the `routeAuth` context variable), `services/api/src/app.ts` (mounting plus the
construction-time assertion), `services/api/src/middleware/routeSplit.test.ts`.

> **Amended during implementation.** This section originally said "one registry, declared in
> this file" and listed three files. The registry is a **separate module** because
> `routeSplit.ts` imports `AppEnv` and `app-env.ts` imports `RouteAuth`: declaring the type
> in either makes the two mutually dependent, and `dependency-cruiser`'s `no-circular` rule
> rejects that — type-only imports included, deliberately. A leaf module both can import is
> the fix, and it matches how `Logger` is already handled. `routeRegistry.ts` imports
> nothing, which is the right shape for the file every later task appends to.

**What is there now, and why it blocks.** Phase 0 shipped
[`routeSplit`](../../services/api/src/middleware/routeSplit.ts) with three properties that
were correct for a one-endpoint service and are wrong for this phase:

1. **`IMPLEMENTED_PATHS` is an exact-match `Set` containing only `/v1/health`.** Everything
   else under `/v1/` throws `not_implemented`. Every route P1-07 through P1-18 adds returns
   `501` until this set knows about it.
2. **Exact string matching cannot express a parameterised path.**
   `/v1/activities/act_01J8XK…` is not a literal and can never be a member of a `Set`, so
   P1-12, P1-13, P1-14 and P1-15 are unreachable by construction, not merely unregistered.
3. **`UNAUTHENTICATED_PRIVATE_PATHS` is exported and never read.** The middleware body does
   not consult it. P1-01's edge case — "`routeSplit` decides which paths need identity at
   all" — describes behaviour that was never implemented, so as things stand the `identity`
   middleware would have to re-derive the public/private decision that this file exists to
   make in one place.

**Approach.** One registry — in `routeRegistry.ts`, holding data and types and importing
nothing — in which each route states its own authentication requirement:

```ts
type RouteAuth = 'public' | 'authenticated' | 'unauthenticated-private';

interface RouteEntry {
  readonly method: string;      // or a set, for a path served by several verbs
  readonly pattern: string;     // '/v1/activities/:id' — the Hono path, verbatim
  readonly auth: RouteAuth;
}
```

Match on the **route pattern Hono resolved**, not on the raw path. Hono has already done the
parameter matching by the time middleware runs; re-implementing it here with a regex is a
second router that will disagree with the first one on a trailing slash at the worst
possible moment. Reading the matched pattern off the context keeps one matcher in the
process.

`routeSplit` then does exactly what it does today, with the decisions read from the registry
instead of hard-coded: `/public/v1/*` skips identity; an `unauthenticated-private` entry
(`/v1/health`, and only ever a short list) skips it; an `authenticated` entry sets a flag the
`identity` middleware at position 8 reads; anything matching no entry is `not_found`, and a
known prefix with no handler stays `not_implemented`. **Keep the "unrecognised path is `404`,
not `401`" rule** — it is the reason an unauthenticated caller cannot enumerate the API.

**Registering a route is part of adding one.** Each later task adds one line to the registry
in the same PR as its route file, exactly as `agent-playbook.md` §7 already requires for the
OpenAPI registration. A route that is mounted but unregistered must fail loudly rather than
silently 501 — see the tests.

**Edge cases.**

- `routeRegistry.ts` is one file that ten tasks append to, which makes it the third serial
  choke point in this phase alongside `app.ts` and `keys.ts`. It is listed as such in
  [`roadmap.md`](roadmap.md) §5.4 and
  [`../04-conventions/git-workflow.md`](../04-conventions/git-workflow.md) §6.2. **One entry
  per line, grouped by resource, in the order `api-contract.md` §2 lists them** — so two
  agents adding two routes conflict on adjacent lines, which Git resolves, rather than on a
  reformatted block, which it does not. Note that this is an argument about *line proximity
  and reviewability*, not about file size: Git does not care that the registry is small.
  `routeSplit.ts` itself is stable — adding a route never edits it.
- Do not let the registry become a second router. It answers one question per route — does
  this need identity — and never dispatches, never rewrites, never reorders.
- `/v1/health` stays `unauthenticated-private` and stays the only member of that category in
  this phase. Adding a second is a decision, not a convenience.

**Tests.** Unit, against the real app: `/v1/health` answers without identity;
`/v1/activities/act_01J8XKQ2M4N5P6R7S8T9V0W1X2` reaches its handler and its `:id` is bound
(the case an exact-match set cannot express); an unknown prefix is `404` and not `401`; a
path under `/v1/` with no registry entry is `not_implemented`. Plus the one that keeps the
registry honest: **a test that walks Hono's own route table and fails naming any mounted
route with no registry entry** — so a later task cannot add a route, forget the line, and
discover it as a `501` in a Playwright run three tasks later.

---

### P1-31 — The React Native test environment for `ui` and `mobile`

> **Added 2026-08-08**, split out of P1-22. Every `.tsx` render test P1-22, P1-23 and P1-25
> are specified to write is currently unrunnable, in ways that are configuration rather than
> component work.

**What to build.** The environment in which a React Native component test runs at all, in
both client workspaces. Nothing in this task renders a product screen or ships a primitive.

**Files.** `packages/ui/package.json`, `packages/ui/vitest.config.ts`,
`packages/ui/tsconfig.json`, `apps/mobile/vitest.config.ts`, and a shared test setup file per
workspace. Plus the `tech-stack.md` §2.5 lines the new dependencies require.

**What is there now, and why nothing runs.** Five separate blockers, none of which a P1-22
agent would expect to be holding:

| # | Blocker | Where |
| --- | --- | --- |
| 1 | `packages/ui` declares **no `react` and no `react-native` dependency**. Under pnpm's isolated linker the first `import … from 'react-native'` is *unresolvable*, which trips dependency-cruiser's `not-to-unresolvable` — the rule P0-27's notes call the one that makes every other module ban work. | `packages/ui/package.json` |
| 2 | `packages/ui`'s Vitest include is `src/**/*.test.ts` and its environment is `node`. No `.tsx` test is collected, and none could render if it were. | `packages/ui/vitest.config.ts` |
| 3 | `packages/ui`'s tsconfig excludes `src/**/*.test.ts` only, so `Button.test.tsx` compiles into `dist/`. | `packages/ui/tsconfig.json` |
| 4 | `apps/mobile` runs `environment: 'node'` with no RN transform, and its own config says in a comment that **P1-22** brings the setup — an expectation this task now discharges. | `apps/mobile/vitest.config.ts` |
| 5 | `apps/mobile`'s overall coverage floor (60/50/60/60 in `testing.md` §9) is written but commented out, deliberately, until that environment exists. | same file |

**Approach.** React Native Testing Library under Vitest with the jsdom environment, per
[`../04-conventions/testing.md`](../04-conventions/testing.md) §5, wired identically in both
workspaces so a primitive and the screen that consumes it are asserted the same way.

Add `react` and `react-native` to `packages/ui` at **exactly** the versions `apps/mobile`
already pins — `react@19.1.0`, `react-native@0.81.5`. Version drift between the two produces
invalid-hook-call errors that cost a day to diagnose, which is the failure roadmap §8 R4
names. Two related things follow from that and belong here:

- Declare them the way the package's role requires. `packages/ui` is consumed only by
  `apps/mobile`, which supplies the runtime; a peer dependency plus a dev dependency is the
  shape that expresses "I render into your React, not my own".
- **Wire `syncpack` into `ci.yml`.** It is already a devDependency with a configured
  `.syncpackrc` and is currently run by nothing — no script, no CI step — while roadmap §8
  R4 claims it runs from Phase 0. This task creates the second copy of the React version it
  is meant to police, so it is the right moment. One `pnpm exec syncpack list-mismatches`
  step in the `validate` job.

Then: `environment: 'jsdom'` and a `src/**/*.test.tsx` include in both Vitest configs; the
`.test.tsx` exclusion in `packages/ui/tsconfig.json`; and **uncomment `apps/mobile`'s
coverage floor**, which is the deliverable that proves the environment is real rather than
merely configured.

**Edge cases.**

- `react-native` ships untranspiled Flow-typed ESM that Vitest will not parse without help.
  Expect to need a transform or an alias to `react-native-web`, and prefer the alias:
  `apps/mobile` already depends on `react-native-web@0.21.2`, the web build is a first-class
  target rather than a shim (ADR-001), and Playwright asserts the same components in a real
  browser. A test environment that resolves `react-native` differently from the web build is
  a third platform to keep in sync.
- Arm the floor **last**, after one real render test exists to clear it. Arming it against an
  empty suite fails `pnpm test` on day one and the only ways to make it pass are to exclude
  the files it measures or to assert against a mocked module graph — both produce a green
  number that means nothing. That reasoning is already written out in
  `apps/mobile/vitest.config.ts` and it is still correct.
- Do not add `@testing-library/jest-dom`. Its matchers are DOM-shaped and this is a React
  Native tree; RNTL's own queries and `toBeOnTheScreen` are the vocabulary the assertions in
  P1-22 and P1-25 are written in.

**Tests.** The environment is the deliverable, so prove it with the smallest real subject
rather than a fixture: one `.tsx` render test against an existing component — `apps/mobile`'s
health screen will do — asserting a rendered string and an `accessibilityRole`. It must pass
in both workspaces' configs, and `pnpm test` must stay green with `apps/mobile`'s floor
armed. Also assert the negative: `pnpm typecheck` emits no `.test.tsx` output into
`packages/ui/dist/`.

---

## Prepared for Phase 4

Everything Phase 4 has to change in the code this phase writes. If this list ever grows past
a page, the seam is in the wrong place.

| # | What changes | Where |
| --- | --- | --- |
| 1 | Add `CognitoIdentityProvider` implementing `IdentityProvider` | `services/api/src/middleware/identity.ts` |
| 2 | Set `AUTH_MODE=cognito` and the pool/client IDs on the deployed function | `infra/lib/stacks/api-stack.ts`, `lib/config.ts` env schema |
| 3 | Replace `nullTokenProvider` with the Cognito token provider at one construction site | `apps/mobile/src/lib/apiClient.ts` |
| 4 | Add the `(auth)` route group and a guard in the app layout | `apps/mobile/app/(app)/_layout.tsx` |
| 5 | Populate `email`, `cognitoSub` and `onboardingState` on the profile, from the post-confirmation trigger | `services/api/src/triggers/post-confirm.ts` (new), writing through the existing `UserRepository` |
| 6 | Prepend a sign-in step to the Playwright and Maestro flows | `e2e/`, `apps/mobile/e2e/` |

What does **not** change: every repository, every key builder, every service, every handler,
every route, every schema, every screen built in this phase, and every endpoint function in
the shared client. None of them knows how identity is established, and none of them needs to.

Phase 4 also owns, as new work rather than as changes: the Cognito user pool and its clients,
SES and the pool's email configuration, the pre-sign-up and post-confirmation triggers, Sign
in with Apple, token storage on iOS and web, the refresh flow with its single-flight lock, the
`/public/v1/auth/*` endpoints with CSRF, the onboarding screens, and the first AWS deploy.

## Acceptance criteria

1. `pnpm dev && pnpm seed:local` from a clean clone reaches an app showing real activities,
   with no AWS credentials configured and no network access beyond package installation.
2. `GET /v1/me` returns the seeded dev profile with `userId: "usr_local_dev"` and every
   default field present.
3. Running `pnpm seed:local` twice produces the same item count in the table, asserted by a
   test rather than by inspection.
4. Setting `STAGE=dev AUTH_MODE=local` and starting the API throws at startup with a message
   naming both values, and the process exits non-zero. Demonstrated by a test and once by
   hand.
5. `grep -rn "AUTH_MODE" services/api/src apps packages --include=*.ts` returns hits in
   exactly two files: `lib/config.ts` and `middleware/identity.ts`.
6. No synthesised Lambda function has `AUTH_MODE: local` in its environment, asserted by a
   CDK test.
7. Every route handler obtains its user ID from `c.get('userId')`. No handler, service or
   repository reads an `Authorization` header, a token, or a request header for identity.
8. `POST /v1/activities` creates Task only from `{ objectKind: 'task', type: 'task' }` and
   each of the five Plan types only from `{ objectKind: 'plan', type: PlanType }`; the created
   item's `details.kind` equals its `type`, `ownerId` is `usr_local_dev`, and a missing or
   mismatched target returns `400` with a `details[]` entry naming the problem.
9. Repeating a `POST /v1/activities` with the same `Idempotency-Key` returns the identical
   body and creates exactly one item, and the stored record's `pk` is
   `IDEM#usr_local_dev#<key>`.
10. `PATCH` with a stale `If-Match` returns `409` and the current `updatedAt`; with a correct
    one it succeeds and bumps `updatedAt`.
11. `DELETE /v1/activities/:id` removes every item in the `ACT#<id>` partition and the owner's
    index entry, and a child activity created with `parentActivityId` survives with that field
    cleared.
12. Two activities written under two different user IDs are each invisible to the other user's
    list query, asserted by an integration test.
13. Explicitly changing a zero-blocker Watch Plan to Task shows a confirmation naming exactly
    `Season and episode` and `Streaming service`, and after confirming, `objectKind` and
    `type` are Task while title, date, time and notes are unchanged. The same change with a
    participant, expense, or prep child is blocked and names that section.
14. Global `+` renders exactly `Task`, `Plan`, `List item`; `Plan` then renders exactly
    `General`, `Meal`, `Watch`, `Event`, `Outing`. No title, capture call or create call is
    possible before that choice. Each of the six stored-type forms renders exactly the fields listed in
    [`../01-product/activities.md`](../01-product/activities.md) §4, in that order — asserted
    by a test that fails if a field is added, removed or reordered.
15. Choosing a meal slot with no time set fills the time (dinner → 19:00); entering 12:00 with
    no slot set selects Lunch; setting one does not overwrite an explicitly set other.
16. `POST /v1/capture/parse` requires `creationTarget`, then returns `501` with
    `code: "not_implemented"`; after choosing a target, typing text shows **no** error, no
    banner and no toast. With schedule fields held equal, adding `remind me` wording cannot
    change the visible Reminder control; only its ordinary saved-default rule can populate it.
17. Sending 121 requests in one minute returns `429` with a `Retry-After` header, and no raw
    IP address appears in the rate-limit item or in any log line.
18. A request made through the shared client with `nullTokenProvider` carries no
    `Authorization` header key at all. (Shipped in P0-20; re-checked here, not rebuilt.)
19. `pnpm verify` passes with `packages/shared` coverage at or above its threshold, and
    `docs/generated/openapi.json` regenerates with no diff.
20. One Playwright flow and one Maestro flow pass against the local stack, twice
    consecutively.
21. No `pk:` or `sk:` template literal exists outside `services/api/src/repositories/keys.ts`,
    and no `ScanCommand` exists in the API bundle.
22. `POST /v1/activities` with `{ "title": "Buy milk" }` or with
    `{ "title": "Buy milk", "type": "task" }` returns `400 validation_failed` and writes
    nothing. Choosing global Task sends `{ objectKind: "task", type: "task" }`, stores
    `details.kind: "task"` and writes `#N`; choosing Plan → Meal sends
    `{ objectKind: "plan", type: "meal" }` for the same title and writes `#P` while undated.
23. `grep -rn "reminders" packages/shared/src/types/activity.ts` returns nothing, and a create
    carrying two reminders writes two `ACT#<id>/REM#usr_local_dev#<id>` items and no field on
    `ACT#<id>/META`.
24. `GET /v1/activities/:id` against a partition seeded with reminders for two different user
    IDs returns only the caller's, and the other user's offset, id and existence appear nowhere
    in the response body — asserted by a serialised-body assertion, not by reading a field.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Cognito user pool, app clients, the hosted UI domain, SES and the pool's email configuration | Phase 4 |
| Sign-up, sign-in, verify and password-reset screens; the `(auth)` route group and the auth guard | Phase 4 |
| `CognitoIdentityProvider`, `aws-jwt-verify` wiring, the JWKS hydrate | Phase 4 |
| The pre-sign-up and post-confirmation triggers, and the `EMAIL#` lookup partition they write | Phase 4 |
| Sign in with Apple, the Apple Services ID, the private relay domain registration | Phase 4 |
| Token storage (`storage.ios.ts` / `storage.web.ts`), refresh with single-flight, one-retry-on-`401` | Phase 4 |
| `/public/v1/auth/token|refresh|logout` and the CSRF middleware | Phase 4 |
| Onboarding: timezone confirmation and display name on first run | Phase 4 |
| The first AWS deploy, `deploy-dev.yml`, the authenticated half of the smoke test | Phase 4 |
| A development build of the app (Expo Go is sufficient for this phase) | Phase 4 |
| `GET /v1/agenda`, the Today screen, the four sections, UP NEXT | Phase 2 |
| The recurrence engine, `Occurrence` rows, the Repeat sheet beyond a disabled control | Phase 2 |
| `complete`, `uncomplete`, `skip`, `snooze`, `schedule` endpoints, and the completion button | Phase 2 |
| Reminder endpoints (`GET`/`POST`/`DELETE /v1/activities/:id/reminders`) — this phase writes the creator's `REM#` rows at create time and reads them back filtered, nothing manages them | Phase 2 (P2-16) |
| Reminders firing — `REM#` rows are stored, nothing schedules them | Phase 2 (local) / Phase 5 (push) |
| Overdue roll-forward, passed-plan prompts | Phase 2 |
| Lists, list items, the Lists tab beyond a placeholder, `Also add a list item to <chosen list>`, `Add ingredients to Groceries` | Phase 3 |
| Attachments, presigned uploads, the image picker's upload path | Phase 3 |
| Prep-task UI inside a plan (the `parentActivityId` field and its cap are Phase 1) | Phase 3 |
| The updates feed | Phase 3 |
| Custom domains and public URLs of any kind | Phase 5 |
| Push notification permission, device token delivery beyond the endpoint | Phase 5 |
| Account deletion | Phase 5 |
| Participants, invitations, the public invite page, guest linking | Phase 6 |
| Expenses, balances, settlement | Phase 7 |
| The `settlement_conflict` guard on `DELETE /v1/activities/:id`, and the `settlement_conflict` member of the `ErrorCode` union — Phase 1 has no Expense schema and writes no `EXP#` row, so there is nothing to guard (see P1-14's decision) | Phase 7 (P7-08) |
| Any real capture implementation | Phase 8 |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **Local dev data is treated as data worth keeping** | Somebody proposes a migration from `USER#usr_local_dev` to a real Cognito `sub` when Phase 4 lands | There is no migration. When Phase 4 lands, delete the local table and run `pnpm seed:local` again. This data has only ever existed on one laptop, was generated by a script that regenerates it in two seconds, and every row is disposable by construction. A migration for it is code that runs once, is tested never, and exists forever. |
| Deferring identity is taken to mean deferring `ownerId` | A repository method with no `userId` parameter; a key builder with a default user | Every key builder and every repository method takes `userId` explicitly (P1-05, P1-09). The tenancy integration test in P1-09 and criterion 12 are written with two invented user IDs while there is only one real one. |
| `AUTH_MODE=local` reaches a deployed environment | Nothing. Every request succeeds, as one shared account | Three independent guards (P1-02): a startup throw, `ApiStack` never setting the value, and a CDK assertion test. The throw is the one that matters; the other two make it unlikely to be reached. |
| `AUTH_MODE` leaks out of its two files | Phase 4 becomes a search-and-replace across the API instead of a new class | The CI grep check in P1-01 and acceptance criterion 5. Add it in the same PR as the seam, not after the first violation. |
| A `dev-bypass` header is reintroduced "just for tests" | A shipped code path that reads a request header to decide who you are | Tests inject a stub provider through `createApp` (P1-01). There is no header to reintroduce; `infrastructure.md` §6.2 and `testing.md` §4.3 are amended in the same PR so the old shape is not copied back from the docs. |
| A key string is constructed outside `keys.ts` | Nothing, until a key format changes and one call site is missed | The dependency-cruiser rule, the grep check, and acceptance criterion 21. Enforce it while there are five call sites, not fifty. |
| The GSI1 bucket is updated rather than replaced on a schedule change | Ghost rows on Today, in Phase 2, with no obvious cause | Delete-and-re-put in one transaction, with an integration test asserting exactly one index entry after a bucket-changing write. |
| Screens are built against an empty database | Empty states are polished, real rows truncate badly, and nobody notices until Phase 5 | P1-21 seeds a 200-character title, 4000 characters of notes and a 60-row ingredient list before the first form is built. |
| The seed script is pointed at a deployed table | Overwritten data, no undo | The script throws unless `STAGE=local` and `DDB_ENDPOINT` is set. Same shape as the P1-02 guard, for the same reason. |
| Zod v3/v4 decision deferred from Phase 0 | Migrating schemas later touches every file in `src/schemas/` | Resolved in P0-07; if it slipped, resolve it before P1-06 writes the first real schema. |
| **`reminders[]` is re-added to `Activity`** because the input schema has a `reminders` field and the two look like they should be the same type | Nothing, in Phase 1 — there is one user. In Phase 6 it becomes a leak, and by then it is stored data | The input field and the stored item are deliberately different shapes (P1-06). Criterion 23's grep runs from this phase, when there is nothing to leak, which is the only time it is cheap to enforce. ADR-047. |
| **The reminder filter is deferred to "when sharing exists"** | A `GET /v1/activities/:id` that returns every `REM#` row it read, shipping in Phase 1 and forgotten until a Phase 6 bug report | It is P1-10 rule 6 and criterion 24, written against two invented user IDs while there is only one real one — the same argument that puts the tenancy test in P1-09. Adding a filter to a shipped serialiser is how the one call site that matters gets missed. |
| A target default or classifier is reintroduced in the schema, handler, client or capture path | The same words create different objects from different entry points, and List item / Plan / Task stops being a choice the user made | `objectKind`, `type`, and capture `creationTarget` are required; global and contextual routes set them explicitly. Contract tests reject missing or invalid pairs, and a grep/test forbids `.default('task')`, `suggestedType` and creation-time type inference. |
| The six forms drift from the canonical field tables | The product quietly becomes six half-products | The fixture-driven render tests in P1-25 fail on any field addition, removal or reorder. |
| Apple Developer enrolment is not started until it is needed | Phase 4 blocks for several days on an administrative process | It is a prerequisite of this phase precisely because no task here needs it. Start it, then forget about it. |
