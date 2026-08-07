# Phase 1 — Identity and the activity core

## Goal

At the end of this phase a real person can create an account, sign in on iOS or on the web,
and save things they want to do. Cognito issues tokens that the Lambda verifies; a
post-confirmation trigger creates the DynamoDB profile that is the tenant key for every
subsequent request. The repository layer exists — key construction, transactions, cursor
pagination, upgrade-on-read — and the Activity is fully implemented behind it: create,
read, patch with optimistic concurrency, delete with its cascade, duplicate, and the flat
filtered list. The unified Add screen and all six progressive creation forms work, writing
one `POST /v1/activities` per save. The three `/v1/capture/*` endpoints return `501` from a
handler the client is already written against, so Phase 7 changes no client code. What is
still missing is any sense of *when*: there is no agenda, no Today, no recurrence. Things
go in and can be found again; they do not yet come back to you.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phase 0 complete and its acceptance criteria passing | Particularly the dev deploy pipeline and DynamoDB Local. |
| 2 | An Apple Developer Program membership ($99/yr) | Required by P1-24 (Sign in with Apple) only. If enrolment is still pending, build P1-24 last and ship the phase with email+password; enrolment can take several days and must be started now regardless, because Phase 4 blocks on it. |
| 3 | SES domain identity verifiable | The Cognito pool sends verification mail through SES (P1-04). Dev stays in the SES sandbox, which is fine — the only recipient is the founder. |
| 4 | [`../02-architecture/auth.md`](../02-architecture/auth.md) and [`../01-product/activities.md`](../01-product/activities.md) read in full | They are the specification for this phase; this document does not restate them. |

## Deliverables

- [ ] `AuthStack` deployed: user pool `od-users-{env}`, two public PKCE clients, hosted UI
      domain, Apple identity provider, both Lambda triggers.
- [ ] Sign-up with email verification, sign-in, sign-out, refresh with single-flight and
      rotation, on iOS and on web with the two different token-storage strategies.
- [ ] Sign in with Apple working on a physical device, including Hide My Email.
- [ ] `GET`/`PATCH /v1/me`, `POST`/`DELETE /v1/me/devices`.
- [ ] Onboarding: timezone confirmation and display name, reaching a usable app in under
      three minutes on a clean install.
- [ ] A repository layer with key construction confined to it, `TransactWriteItems` helpers,
      opaque cursors, and upgrade-on-read.
- [ ] Full Activity CRUD: `POST`, `GET /:id`, `PATCH` with `If-Match`, `DELETE` with
      cascade, `duplicate`, `GET /v1/activities?filter=`.
- [ ] `auth`, `rateLimit` and `idempotency` middleware live, replacing the Phase 0 stubs.
- [ ] Zod schemas for every shape above, defined once in `packages/shared` and imported by
      both sides; `docs/generated/openapi.json` regenerated.
- [ ] The unified Add screen with the six type chips, and all six progressive creation
      forms with the exact fields, order, defaults and validation from
      [`../01-product/activities.md`](../01-product/activities.md) §4.
- [ ] The activity detail screen: read, inline edit with commit-on-blur, change type with
      the loss confirmation, duplicate, delete.
- [ ] `/v1/capture/parse|extract|link` returning `501 not_implemented` with the stable error
      envelope; the client's capture paths degrade exactly as
      [`../01-product/ai-capture.md`](../01-product/ai-capture.md) §6 specifies.
- [ ] `packages/ui` primitives sufficient for every screen in this phase.
- [ ] Playwright and Maestro harnesses running one real flow each in CI.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P1-01 | `AuthStack`: user pool, clients, domain | infra | P0-21 | no | L |
| P1-02 | SES domain identity and Cognito email configuration | infra | P1-01, P0-05 | no | M |
| P1-03 | Pre-sign-up trigger | api | P1-01 | no | M |
| P1-04 | Post-confirmation trigger | api | P1-03, P1-10 | no | L |
| P1-05 | `auth` middleware with `aws-jwt-verify` | api | P1-01 | no | M |
| P1-06 | `rateLimit` middleware | api | P1-05 | yes | M |
| P1-07 | `idempotency` middleware | api | P1-05 | yes | M |
| P1-08 | Repository base: keys, cursors, transactions, upgrade-on-read | api | P0-16 | no | L |
| P1-09 | Shared types and schemas for `User` and `Activity` | shared | P0-09 | no | L |
| P1-10 | `UserRepository` and `GET`/`PATCH /v1/me` | api | P1-08, P1-09 | no | M |
| P1-11 | Device registration endpoints | api | P1-10 | yes | S |
| P1-12 | `ActivityRepository` | api | P1-08, P1-09 | no | L |
| P1-13 | Activity service: status derivation, authz, transactions | api | P1-12 | no | L |
| P1-14 | `POST /v1/activities` | api | P1-13, P1-07 | no | M |
| P1-15 | `GET /v1/activities/:id` | api | P1-13 | yes | M |
| P1-16 | `PATCH /v1/activities/:id` with `If-Match` | api | P1-13 | no | M |
| P1-17 | `DELETE /v1/activities/:id` and its cascade | api | P1-13 | no | M |
| P1-18 | `POST /v1/activities/:id/duplicate` | api | P1-14 | yes | S |
| P1-19 | `GET /v1/activities?filter=` with cursors | api | P1-12 | yes | M |
| P1-20 | Type-change field mapping (pure, in `shared`) | shared | P1-09 | yes | M |
| P1-21 | `/v1/capture/*` `501` stubs | api | P0-16 | yes | S |
| P1-22 | Web auth endpoints on `/public/v1/auth/*` with CSRF | api | P1-01, P1-05 | no | L |
| P1-23 | Shared API client: `me`, `activities`, `capture` | shared | P1-09, P0-23 | no | M |
| P1-24 | Sign in with Apple: Apple setup, Cognito IdP, client | infra/mobile | P1-01 | no | L |
| P1-25 | Token storage: `storage.ios.ts` / `storage.web.ts` | mobile | P0-22 | no | M |
| P1-26 | Session: sign-in, sign-up, verify screens and the auth guard | mobile | P1-25, P1-23 | no | L |
| P1-27 | Refresh with single-flight and one-retry-on-401 | mobile | P1-26 | no | M |
| P1-28 | Onboarding: timezone confirmation and display name | mobile | P1-26, P1-10 | no | M |
| P1-29 | `packages/ui` primitives | shared | P0-10 | yes | L |
| P1-30 | App shell: three tabs, header, FAB, placeholders | mobile | P1-26, P1-29 | no | M |
| P1-31 | The unified Add screen | mobile | P1-30, P1-23 | no | L |
| P1-32 | Six progressive creation forms | mobile | P1-31, P1-29 | no | L |
| P1-33 | Activity detail screen: read and inline edit | mobile | P1-32, P1-15 | no | L |
| P1-34 | Change type, duplicate, delete in the UI | mobile | P1-33, P1-20 | no | M |
| P1-35 | Repository integration-test harness on DynamoDB Local | ci | P1-12, P0-25 | yes | M |
| P1-36 | Playwright and Maestro harnesses with one flow each | ci | P1-32 | no | M |
| P1-37 | Authenticated half of `scripts/smoke.mjs` | ci | P1-01, P1-14 | yes | S |

P1-11, P1-18 and P1-21 are mechanical; follow the contract and skip the design discussion.

---

### P1-01 — `AuthStack`

**Files.** `infra/lib/stacks/auth-stack.ts`.

**What to build.** The pool configuration in
[`../02-architecture/auth.md#1-user-pool-configuration`](../02-architecture/auth.md#1-user-pool-configuration),
implemented exactly: email-only sign-in alias, case-insensitive, `autoVerify.email`,
`keepOriginal.email`, the two custom attributes with `app_user_id` **immutable**, the
12-character password policy with no symbol requirement, `Mfa.OPTIONAL` with TOTP only and
SMS disabled, `AccountRecovery.EMAIL_ONLY`, and the two public clients with no secret,
SRP + refresh only, `ALLOW_USER_PASSWORD_AUTH` disabled, and
`preventUserExistenceErrors: true`.

Token lifetimes: ID and access 60 minutes; refresh 90 days on mobile, 30 days on web.

**Edge cases.**

- `custom:app_user_id` must be in the clients' **read** attribute list and absent from the
  write list. A user-writable tenant key is an account-takeover primitive.
- Refresh token rotation (open question OQ-4) is newer than the `UserPoolClient` L2
  construct. Resolve it here: check the CDK version in the lockfile, and if the L2 has no
  property, use the `CfnUserPoolClient` escape hatch shown in
  [`../02-architecture/auth.md#16-token-lifetimes`](../02-architecture/auth.md#16-token-lifetimes)
  with a 60-second retry grace period. Do not skip rotation.
- Set the verification code validity explicitly to 15 minutes rather than relying on the
  Cognito default.
- The hosted UI domain (`od-{env}.auth.us-east-1.amazoncognito.com`) must exist before
  P1-24 configures Apple's return URLs, and both dev and prod domains must be listed on the
  Apple Services ID.

**Tests.** CDK assertions: `MfaConfiguration: OPTIONAL`, `EnabledMfas` containing only
`SOFTWARE_TOKEN_MFA`, password policy minimum length 12 with `RequireSymbols: false`,
`ExplicitAuthFlows` containing SRP and refresh and **not** `ALLOW_USER_PASSWORD_AUTH`, both
clients with no `ClientSecret`, and `custom:app_user_id` with `Mutable: false`.

---

### P1-03 — Pre-sign-up trigger

**Files.** `services/api/src/triggers/pre-signup.ts`,
`services/api/src/triggers/lib/disposable-domains.ts`.

**Approach.** The four behaviours in
[`../02-architecture/auth.md#19-lambda-triggers`](../02-architecture/auth.md#19-lambda-triggers):
lowercase and trim the email and write it back; reject a small disposable-domain blocklist
with a clear message; on a federated (Apple) sign-up where a Cognito-native user already
exists with the same **verified** email, call `AdminLinkProviderForUser` instead of letting
a second account be created; never set `autoConfirmUser`.

**Edge cases.**

- Plus-addressing (`alice+plans@example.com`) is **not** stripped. It is a distinct
  deliverable address.
- The linking branch must only fire when the existing user's email is verified. Linking on
  an unverified address is an account-takeover path.
- The blocklist is small and hand-maintained. Do not pull a 100,000-entry list into the
  bundle; it costs cold-start time for a marginal benefit.
- Cognito's trigger timeout is 5 seconds. No unbounded work.

**Tests.** Unit tests against the trigger event shape: mixed-case email is normalised; a
blocklisted domain throws with the user-facing message; an Apple sign-up with an existing
verified native user calls `AdminLinkProviderForUser` once (asserted with
`aws-sdk-client-mock`); an Apple sign-up with an existing **unverified** native user does
not; `autoConfirmUser` is never set true.

---

### P1-04 — Post-confirmation trigger

**Files.** `services/api/src/triggers/post-confirm.ts`.

**What to build.** The only place a user profile is created. It runs once, after the email
is verified.

**Approach.** Steps 1–5 of
[`../02-architecture/auth.md#19-lambda-triggers`](../02-architecture/auth.md#19-lambda-triggers):
generate `usr_<ulid>`; one `TransactWriteItems` putting `USER#<userId>/PROFILE` and
`EMAIL#<lowercased-email>/USER`, both with `attribute_not_exists(pk)`; then
`AdminUpdateUserAttributes` to write `custom:app_user_id` back onto the Cognito user; any
failure throws.

Profile defaults: `timezone` from `custom:tz` or `America/New_York`, `currency: 'USD'`,
`weekStartsOn: 0`, `defaultReminderOffset: -15`, `allDayReminderHour: 9`, quiet hours
enabled 22:00–07:00, notification preferences at the defaults in
[`../01-product/notifications.md`](../01-product/notifications.md) §2, `onboardingState:
'new'`.

**Edge cases.**

- **Idempotency is not optional.** Cognito retries triggers. The conditional puts make a
  retry a no-op; a `ConditionalCheckFailedException` on the profile put must be caught and
  treated as success, not rethrown.
- Guest linking (step 4 in the canonical doc) is **Phase 5**. Leave a single clearly marked
  extension point and a `TODO(P5)`; do not build a partial version.
- A confirmed Cognito user with no DynamoDB profile is a broken account that 500s on every
  request. Throwing on failure is correct: Cognito reports sign-up as failed and the user
  retries.
- `AdminUpdateUserAttributes` failing after the transaction succeeded leaves a profile with
  no token claim pointing at it. Retry it three times with backoff inside the 5-second
  budget; if it still fails, throw — the orphan profile is harmless and the next sign-up
  attempt re-runs cleanly because the conditional puts are idempotent.

**Tests.** Integration against DynamoDB Local: a first invocation writes exactly two items;
a second invocation with the same event writes none and does not throw; the profile carries
every default field; the `EMAIL#` item points at the same `userId`. Unit: a trigger event
with `email_verified: 'false'` still creates the profile but takes no linking path.

---

### P1-05 — `auth` middleware

**Files.** `services/api/src/middleware/auth.ts`.

**Approach.** Verbatim the implementation in
[`../02-architecture/auth.md#51-the-verifier`](../02-architecture/auth.md#51-the-verifier):
a module-scope `CognitoJwtVerifier` with `tokenUse: 'id'` and both client IDs, hydrated
during init, verifying on every request with no result cache. Reject a missing or malformed
header, a failed verification, and a token whose `custom:app_user_id` is absent or does not
start with `usr_`, all as `unauthenticated`.

Set `c.set('user', { userId, email, emailVerified, cognitoSub })`. Nothing downstream reads
a user ID from anywhere else.

Replace the Phase 0 pass-through stub and delete it.

**Edge cases.**

- Creating the verifier inside the handler adds 50–200 ms to **every** request. This is the
  single most common Cognito performance mistake; the module-scope singleton is the whole
  point.
- The middleware must also `401` a token whose profile has `deletedAt` set (account
  deletion, Phase 4). Add the hook now — a `TODO(P4)` on the profile read the request needs
  anyway — so it is not bolted on later.
- `AUTH_MODE=dev-bypass` remains guarded by the `STAGE === 'local'` assertion from P0-25.

**Tests.** Unit with a locally generated RSA key pair and a stubbed JWKS: valid token
passes and sets the context; expired, wrong `aud`, wrong `iss`, `token_use: 'access'`, and
tampered-signature tokens each `401`; a valid token missing `custom:app_user_id` `401`s
with the "Account setup incomplete" message. A test asserting the verifier is constructed
exactly once across 100 requests.

---

### P1-06 — `rateLimit` middleware

**Files.** `services/api/src/middleware/rateLimit.ts`,
`services/api/src/repositories/rateLimitRepository.ts`.

**Approach.** A DynamoDB counter item keyed by `userId` for authenticated routes and by a
**SHA-256 hash** of the client IP for public ones — raw addresses are never written to
DynamoDB or logs. Fixed window of one minute with `ttl` set to window end, incremented with
`UpdateItem` and `ADD`. Over limit → `429 rate_limited` with `Retry-After`.

Limits from
[`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits):
120 req/min authenticated, 20/hour on `POST /v1/capture/*`, 60/hour on
`POST /v1/attachments/upload-url`, 30 req/min per IP on `/public/v1/*`.

> **Decision:** resolve open question OQ-10 here. The three web auth endpoints
> (`/public/v1/auth/token|refresh|logout`) get their own limit of **10 requests per minute
> per IP**, separate from the invite surface's 30/min, and `refresh` additionally gets
> **60 per hour per IP**. A refresh loop is the most likely accidental hammer and the
> invite surface's limit is too loose for it. Both rows are recorded in
> [`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits).

**Edge cases.** A fixed window allows a 2× burst at a window boundary. That is acceptable
at these limits and is far simpler than a sliding window; do not build a token bucket. The
counter write must not fail the request if DynamoDB errors — log and allow, because a
rate limiter that takes the API down is worse than one that occasionally lets a request
through.

**Tests.** Unit with `aws-sdk-client-mock`: the 121st request in a window `429`s with
`Retry-After`; the counter's `ttl` is the window end; the public key is a hash and the raw
IP never appears in the written item or in a log line; a DynamoDB failure allows the
request and logs a warning.

---

### P1-07 — `idempotency` middleware

**Files.** `services/api/src/middleware/idempotency.ts`.

**Approach.** On `POST` routes that create, require an `Idempotency-Key` header (a UUID) or
`400`. Read `IDEM#<userId>#<key>`; on a hit, return the stored status and body unchanged. On
a miss, run the handler and, on success, write `IDEM#<userId>#<key>` with the response body,
the status, the route, the `userId`, and `ttl = now + 24 h`.

Runs **after** `rateLimit`, so a retry storm cannot write idempotency records for free.

**Edge cases.**

- The key must be scoped to the caller. `IDEM#<userId>#<key>` prevents one user's key from
  returning another's response. This is the form recorded in
  [`../02-architecture/data-model.md#34-lookup-partitions`](../02-architecture/data-model.md#34-lookup-partitions);
  a bare `IDEM#<key>` is a security defect, not a shorthand.
- A concurrent duplicate (two in-flight requests with the same key) must not both create.
  Write a *reservation* item with `attribute_not_exists(pk)` before running the handler;
  a conditional-check failure means "in flight or done" — re-read and either return the
  stored response or `409 conflict` if the reservation has no body yet.
- Only successful responses are stored. A `500` must not be replayed for 24 hours.

**Tests.** Integration on DynamoDB Local: the same key twice creates one activity and
returns identical bodies; different keys create two; a concurrent pair (two promises,
same key) yields exactly one write; a failing handler stores nothing; a missing header
`400`s.

---

### P1-08 — Repository base

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
`idem(userId, key)`, and the three GSI1 bucket builders (`gsi1Scheduled`,
`gsi1Unscheduled`, `gsi1Recurring`). A `pk:` template literal anywhere else is a review
rejection.

`cursor.ts` encodes `LastEvaluatedKey` to opaque base64 and decodes with validation —
a decoded cursor whose shape does not match the expected key attributes is
`validation_failed`, never passed to DynamoDB.

`tx.ts` composes `TransactWriteItems` with a compile-time cap at 100 items and a helper
that maps `TransactionCanceledException` reasons to the right `AppError`.

`migrate.ts` implements the lazy migration policy from
[`../02-architecture/data-model.md#9-migration-policy`](../02-architecture/data-model.md#9-migration-policy):
a registry of `schemaVersion → upgrade function`, applied on read, persisted on next write.
Version 1 is the identity function; the registry exists so version 2 is a one-file change.

**Edge cases.** No `Scan` in application code, ever. Add a unit test that greps the built
`services/api` bundle for `ScanCommand` and fails on a hit outside
`infra/scripts/migrations/`.

**Tests.** Unit for every key builder against the literal strings in the data model. Cursor
round-trip and a tampered-cursor rejection. `tx.ts` rejecting a 101-item transaction.
Migration registry applying v1 → v1 as identity and a synthetic v1 → v2 correctly.

---

### P1-09 — Shared types and schemas for `User` and `Activity`

**Files.**

```
packages/shared/src/types/user.ts  activity.ts  index.ts
packages/shared/src/schemas/user.ts  activity.ts  capture.ts
```

**Approach.** Transcribe
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity)
and §4.4 into TypeScript, then write the Zod schemas that produce those types by
inference — never hand-write a type beside a schema.

`createActivityInput` is the shape in
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities),
with the field-level validation from
[`../01-product/activities.md`](../01-product/activities.md) §3.6 and §4: `title` 1–200
after trim, `notes` 0–4000, free-text sub-fields 0–120, `location.address` 0–300, `time`
requires `date`, `endTime` requires `time` and must be after it, participants ≤ 50,
ingredients ≤ 60 rows, `priceCents` a non-negative integer.

The `details` schema is a **discriminated union on `kind`**, and a refinement asserts
`details.kind === type`. This is the single most useful validation in the product: it
makes "a meal with watch fields" unrepresentable.

`ActivityStatus` is accepted from the client only as `cancelled`. Every other value is
derived server-side; the schema for `patchActivityInput` must not accept `saved`,
`scheduled`, `completed` or `skipped`.

**Edge cases.** `exactOptionalPropertyTypes` is on. `schedule?: { … } | undefined` and
`schedule?: { … }` differ; be deliberate, especially for the unschedule path where
`{ date: null }` is meaningful and `undefined` is not.

**Tests.** Table-driven Zod tests: one valid and at least three invalid cases per field;
every `details.kind`/`type` mismatch rejected; a `title` of 201 characters rejected and one
of 200 accepted; `endTime` before `time` rejected; a `time` with no `date` rejected. Type-
level tests with `expectTypeOf` asserting the inferred type matches the hand-written
interface in `types/`.

---

### P1-12 — `ActivityRepository`

**Files.** `services/api/src/repositories/activityRepository.ts`.

**Approach.** Implements access patterns 1, 2, 3, 4, 5 and 16 from
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns).
In Phase 1 that means: put an Activity plus its owner `ActivityIndex` entry in one
transaction; query `pk = ACT#<id>` for full detail; update `ACT#/META` conditionally on
`updatedAt`; delete the whole partition plus every index entry; and query GSI1 for the flat
filtered lists.

The `ActivityIndex` item carries the GSI1 keys and the projected `AgendaItem` fields. Which
bucket it lands in is derived on every write:

| Condition | `gsi1pk` | `gsi1sk` |
| --- | --- | --- |
| `recurrence` present | `U#<userId>#R` | `<recurrence.startDate>#<activityId>` |
| `schedule.date` present | `U#<userId>#S` | `<localDateTime>#<activityId>` |
| otherwise | `U#<userId>#N` | `<createdAt>#<activityId>` |

`localDateTime` is `YYYY-MM-DDTHH:mm` in the user's local wall clock, with `00:00` when
there is no time. This is not the UTC instant; `scheduledAtUtc` is stored separately on the
`META` item for reminders and `.ics`.

**Edge cases.**

- A write that changes which bucket an activity belongs to must **delete and re-put** the
  index entry, not update it — GSI keys change and a stale entry in the old bucket produces
  a ghost row on Today. Do it in the same transaction.
- Untimed items sort before timed ones on the same date because `00:00` sorts first. That is
  the intended order and the agenda partition logic in Phase 2 depends on it.
- The `META` item must never be larger than 400 KB. `notes` at 4000 characters plus 60
  ingredients is nowhere near it, but the validation limits are what keep it true.

**Tests.** Integration on DynamoDB Local: create → read back the exact shape; bucket
assignment for all three cases; a schedule change moving an item between buckets leaves
exactly one index entry; `GET` by id returns the whole partition in one `Query`; delete
removes every item under `ACT#<id>` and the index entry; a conditional update with a stale
`updatedAt` throws `ConditionalCheckFailedException`.

---

### P1-13 — Activity service

**Files.** `services/api/src/services/activityService.ts`,
`services/api/src/services/authz.ts`.

**Approach.** The business rules that must not live in handlers or repositories:

1. **Status derivation.** `status` is never taken from the client except `cancelled`.
   Otherwise `schedule?.date ? 'scheduled' : 'saved'`, with `completed`/`skipped` set only
   by the completion endpoints (Phase 2).
2. **`assertActivityAccess(userId, activityId, level)`** in `authz.ts`, the single place the
   owner / participant / stranger rules from
   [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
   are enforced. A stranger gets `not_found`, never `403`. Called at the top of every
   activity-scoped service method.
3. **`scheduledAtUtc` derivation** from `date` + `time` + `timezone` with `date-fns-tz`,
   recomputed on every schedule write and never trusted as authoritative over the three
   stored fields.
4. **`visibility`** is `shared` iff `participantCount > 0`.
5. **Nesting cap:** a `parentActivityId` pointing at an activity that itself has a
   `parentActivityId` is `validation_failed` (two levels, per
   [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §3).

No AWS SDK type crosses into this layer, and it knows nothing about HTTP.

**Tests.** Unit with a mocked repository: every status-derivation branch; `scheduledAtUtc`
for a timed item, an untimed item (absent), and across a DST boundary; the nesting cap;
`assertActivityAccess` returning `not_found` for a stranger and for a non-existent id, and
`forbidden` for a participant attempting an owner-only action.

---

### P1-14 — `POST /v1/activities`

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/handlers/createActivity.ts`.

**Approach.** `zValidator('json', createActivityInput)`, then one service call, then a
`201` with the created `Activity` in the envelope. One `TransactWriteItems` writes
`ACT#/META` and `USER#<owner>/IDX#`.

Participants supplied at creation are **Phase 5**; in Phase 1 the schema accepts the field
(so the contract is stable) and the service rejects a non-empty array with
`validation_failed` and the message `Sharing is coming soon.` Do not silently drop it.

`fromListItem` is **Phase 3**; same treatment.

**Edge cases.** The `Idempotency-Key` header is required (P1-07). Ingredient rows arrive
with `addedToListId` absent — writing to a list is Phase 3 and nothing in this phase touches
a list.

**Tests.** Integration: a minimal `{ type, title }` body creates a `saved` activity with
`participantCount: 0`, `childCount: 0`, `expenseTotalCents: 0`, `visibility: 'private'`;
a body with `schedule.date` creates a `scheduled` one in the `#S` bucket; a `details.kind`
mismatch `400`s with a `details[]` entry pointing at `details.kind`; a repeat with the same
`Idempotency-Key` returns the identical body with `200`.

---

### P1-16 — `PATCH /v1/activities/:id`

**Approach.** Partial update with `If-Match: <updatedAt>`. A missing header is
`validation_failed`; a mismatch is `409 conflict` with the current `updatedAt` in the body
so the client can refetch and re-apply. Implemented as a conditional `UpdateItem` on
`updatedAt`, not a read-then-write.

Changing `type` runs the mapping from P1-20 server-side and logs the dropped `details`
payload at `info` with `activityId`, the old type and the old `details`, so a support
request can recover it from CloudWatch inside the retention window.

**Edge cases.**

- A participant may not patch `title`, `schedule`, `location` or `type`. Enforced in
  `authz.ts`, not in the handler.
- Changing type must not change `status`, `completedAt` or `outcome`.
- A patch that adds or clears `schedule.date` changes the GSI1 bucket, so it must go through
  the delete-and-re-put transaction from P1-12, not a bare `UpdateItem`.

**Tests.** Integration: correct `If-Match` succeeds and bumps `updatedAt`; a stale one
`409`s and the body carries the current value; a participant's patch of `title` is
`403`; a type change from `watch` to `task` drops `season`/`episode`/`service`, keeps
`title`, `notes`, `schedule` and `reminders`, and emits the log line; a patch that sets
`schedule.date` to `null` moves the index entry to `#N` and sets `status: 'saved'`.

---

### P1-17 — `DELETE /v1/activities/:id` and its cascade

**Approach.** Owner only. Query the whole `ACT#<id>` partition, delete every item in it,
delete the owner's `IDX#` entry and every participant's, and clear pointers on anything that
points back:

| Pointer | Action |
| --- | --- |
| Child activities' `parentActivityId` | **Cleared, not deleted.** Prep tasks survive their parent ([`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §5.5). |
| `ListItem.linkedActivityId` | Cleared. The list item survives. (Phase 3 — write the branch now behind a capability check, so Phase 3 only removes the guard.) |
| Grocery items' `sourceActivityId` | **Untouched.** Provenance is not linkage; the label stays as written. |
| EventBridge schedules | Deleted (Phase 4). |

**Edge cases.** A partition with more than 100 items (many participants plus many updates)
exceeds a single transaction. Delete in batches of 25 with `BatchWriteItem` and accept that
the operation is not atomic — a partially deleted activity is recoverable by re-running the
delete, whereas a transaction that can never succeed is not. Make the handler idempotent so
a retry completes it.

**Tests.** Integration: every item under `ACT#<id>` is gone; a child activity survives with
`parentActivityId` absent; a second `DELETE` returns `404` and does not throw; a non-owner
gets `404`.

---

### P1-20 — Type-change field mapping

**Files.** `packages/shared/src/activity/changeType.ts`.

**Approach.** A pure function
`changeType(activity, newType) → { details, notes, location, dropped: DroppedField[] }`
implementing the exhaustive table in
[`../01-product/activities.md`](../01-product/activities.md) §6.3. It lives in `shared`
because both the server (to apply it) and the client (to render the "this will remove"
confirmation before calling) need the identical answer.

`DroppedField` carries a stable key and a human label (`Season and episode (S2 E4)`) so the
confirmation copy is generated, not hand-written per pair.

**Edge cases.** `event → outing` appends `description` to `notes` separated by a blank line
only when `notes` is non-empty. `outing → event` moves `placeName` into `location.label`
**only if** `location.label` is empty. `any → watch` sets `details.mediaTitle` from `title`.
`task ↔ custom` drops nothing and therefore shows no confirmation.

**Tests.** All 36 ordered type pairs, table-driven, asserting carried and dropped fields
exactly. A test that the function is pure (same input twice, deep-equal output, input not
mutated). A test that every pair in the canonical table has a case and no case exists that
the table does not list.

---

### P1-21 — `/v1/capture/*` `501` stubs

**Files.** `services/api/src/routes/capture.ts`.

**Approach.** Three routes, each validating its input against the real schema from
`packages/shared/src/schemas/capture.ts` and then throwing
`new AppError('not_implemented', 'Capture is not available yet.')`, mapped to `501`.

Validating before failing is deliberate: it means the client's request shape is exercised
from Phase 1, so Phase 7 cannot discover that the client was sending the wrong body all
along.

**Tests.** Each route returns `501` with `code: "not_implemented"`; a malformed body returns
`400` **before** the `501`, proving validation runs first.

---

### P1-22 — Web auth endpoints on `/public/v1/auth/*`

**Files.** `services/api/src/routes/public/auth.ts`,
`services/api/src/middleware/csrf.ts`.

**What to build.** The three endpoints ADR-015 requires so the web client never holds a
refresh token in JavaScript:
`POST /public/v1/auth/token`, `/refresh`, `/logout`, exactly as
[`../02-architecture/auth.md#42-web`](../02-architecture/auth.md#42-web) specifies.

**Approach.** `token` exchanges a PKCE `code` + `code_verifier` with Cognito, returns the ID
token in the body, and sets the refresh token as
`HttpOnly; Secure; SameSite=Lax; Domain=.ordinarydays.app; Path=/public/v1/auth`.
`refresh` reads the cookie, calls `REFRESH_TOKEN_AUTH`, returns a new ID token and rotates
the cookie. `logout` calls `GlobalSignOut` and clears the cookie with `Max-Age=0`.

All three require a double-submit CSRF token: a non-`HttpOnly` cookie whose value must be
echoed in an `X-CSRF-Token` header. `SameSite=Lax` alone does not protect a `POST` from a
top-level cross-site navigation in every browser.

Add these three rows to
[`../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface`](../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface)
in the same pull request, with the rate limits decided in P1-06.

**Edge cases.**

- CORS must allow credentials for the web origins and must never use `*` — browsers reject
  the combination anyway.
- The `Path` scoping means the refresh cookie is not sent on ordinary API calls, which is
  what keeps it out of the blast radius of a normal request log.
- Cookie domain scoping to `.ordinarydays.app` is what lets `ordinarydays.app` and
  `api.ordinarydays.app` share it. It also means localhost development needs a different
  path; use the in-memory-only fallback locally rather than a localhost cookie hack.

**Tests.** Integration: `token` sets the cookie with the exact attributes; `refresh` without
the cookie `401`s; `refresh` without the CSRF header `403`s; `logout` clears the cookie and
calls `GlobalSignOut`; a rotated refresh token invalidates the previous one.

---

### P1-24 — Sign in with Apple

**Files.** `infra/lib/stacks/auth-stack.ts` (identity provider),
`apps/mobile/app/(auth)/sign-in.tsx`,
`apps/mobile/src/features/auth/appleSignIn.ts`,
`apps/mobile/app.config.ts` (plugin entry).

**Approach.** The seven setup steps in
[`../02-architecture/auth.md#22-setup-steps`](../02-architecture/auth.md#22-setup-steps),
in order. Register the App ID `app.ordinarydays.ios` with the Sign In with Apple
capability; register the Services ID `app.ordinarydays.signin` with **both** the dev and
prod Cognito hosted-UI domains and both `/oauth2/idpresponse` return URLs; create the key
and download the `.p8` **once**; put the team ID, key ID and private key into SSM
SecureString at `/od/{env}/auth/apple/*` and delete the local file; add
`UserPoolIdentityProviderApple` reading those parameters with attribute mapping
`email → email`, `name → name` and scopes `email name`; add `expo-apple-authentication` to
the plugins array so prebuild adds the entitlement.

**Edge cases — all three of these are discovered at review time if missed.**

1. **Register the sending domain with Apple's private email relay service** (Certificates,
   Identifiers & Profiles → More → Configure). Without it, SES mail to
   `@privaterelay.appleid.com` addresses bounces.
2. **Apple returns the full name only on the very first authorisation, never again.**
   Capture `credential.fullName` on that first response and immediately
   `PATCH /v1/me { displayName }`. If it is dropped there is no way to retrieve it short of
   the user revoking the app in iOS Settings.
3. A user who signed up with Apple has no password. The password-reset screen must detect
   this and say `This account signs in with Apple` rather than reporting a generic success
   and leaving the user retrying forever.

**Tests.** Manual on a **physical device** with a real Apple ID, both the share-email and
Hide My Email paths, on dev. Automated: a unit test that `fullName` present on the
credential triggers exactly one `PATCH /v1/me`, and absent triggers none. A Playwright test
of the web leg is not worth building — the Apple sheet is native.

---

### P1-25 — Token storage

**Files.** `apps/mobile/src/lib/storage.ios.ts`, `storage.web.ts`, `storage.ts` (types).

**Approach.** iOS: `expo-secure-store` with
`keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which excludes the item from iCloud
Keychain and from encrypted backups. Web: the ID token in a module-scope variable only; the
refresh token is never visible to JavaScript (P1-22 owns it).

`AsyncStorage` is never used for tokens; it is an unencrypted file in the app container. Add
a lint rule or a test that fails on `AsyncStorage` in any file whose name contains `token`
or `auth`.

**Tests.** Unit per platform file with the platform API mocked: `set`/`get`/`del` round-trip;
the iOS options object is exactly the specified accessibility constant; the web store holds
nothing across a module reload.

---

### P1-27 — Refresh with single-flight and one-retry-on-401

**Files.** `packages/shared/src/client/http.ts` (retry hook),
`apps/mobile/src/features/auth/session.ts`.

**Approach.** Two rules from
[`../02-architecture/auth.md#33-authenticated-request-and-refresh`](../02-architecture/auth.md#33-authenticated-request-and-refresh),
both load-bearing:

1. **Single-flight refresh.** One shared promise. An app resuming from background fires six
   queries at once; without the lock all six call `REFRESH_TOKEN_AUTH` with the same refresh
   token, and with rotation enabled five get an invalid-token error and the user is signed
   out.
2. **At most one retry on `401`.** Force one refresh, retry once, and on a second failure
   sign out and route to `(auth)`. An unconditional retry loop against an expired session
   generates thousands of requests per minute.

Refresh proactively when the token has under 60 seconds remaining, rather than waiting for
the `401`.

**Tests.** Unit with a fake clock and a stubbed token endpoint: six concurrent calls with an
expired token produce exactly one refresh call; a `401` produces exactly one refresh and one
retry; a second `401` signs out; a refresh failure while offline does not sign out (the
mutation queue must survive).

---

### P1-29 — `packages/ui` primitives

**Files.** `packages/ui/src/{Text,Stack,Button,Row,Checkbox,Sheet,TextField,Select,Chip,
Toast,Skeleton,Divider}.tsx`, `packages/ui/src/theme/{tokens,breakpoints,typography}.ts`.

**Approach.** Pure primitives with no knowledge of activities, lists, or the API. Every one
must satisfy
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6 from the
first commit rather than in a Phase 4 remediation pass:

- 44 × 44 pt minimum hit target, ≥ 8 pt between adjacent targets.
- `allowFontScaling` is never `false`; layouts are content-sized with a 44 pt minimum, never
  fixed-height.
- Contrast ≥ 4.5:1 for body text and ≥ 3:1 for control boundaries, in light and dark.
- `accessibilityRole` on every interactive primitive; `Checkbox` is its own accessibility
  element.
- Reduce Motion honoured: transitions become cross-fades, no animation exceeds 300 ms.

`breakpoints.ts` defines `compact` / `medium` / `expanded` at 0 / 768 / 1200 with a
`useBreakpoint()` hook backed by `useWindowDimensions()`. Never `Dimensions.get()` at
module scope — it is wrong after rotation and wrong on web resize.

**Tests.** Unit render tests asserting `accessibilityRole` and label on every primitive; a
hit-target test asserting the measured layout of `Checkbox` and `Button` is ≥ 44 pt; a
contrast test computing the ratio for every token pair in both themes and failing under
threshold. Storybook is not worth its maintenance for one developer; the tests are the
contract.

---

### P1-31 — The unified Add screen

**Files.** `apps/mobile/app/(app)/compose.tsx`,
`apps/mobile/src/features/compose/{hooks,components,model}/**`,
`apps/mobile/src/stores/composeDraft.ts`.

**Approach.** Exactly the screen in
[`../01-product/activities.md`](../01-product/activities.md) §2. Presented modally. The text
field is focused with the keyboard up on open. Six type chips in a horizontally scrollable
row, always visible, in the order Task, Meal, Watch, Event, Outing, Custom. Camera / Photos
/ Link buttons present but degraded per §2.3 and
[`../01-product/ai-capture.md`](../01-product/ai-capture.md) §6 while capture is stubbed.

The **degraded path is the v1 path** and must be built as the primary experience, not as an
error state:

| Mode | Behaviour while capture returns `501` |
| --- | --- |
| Type | **Silent.** No suggestion banner, no error, no toast. The typed text becomes the title; the chips are how the user proceeds. |
| Camera / Photos | The image is still attached (Phase 3 wires the upload; Phase 1 shows the picked image locally and disables Save-with-attachment). Copy: manual entry, per `ai-capture.md` §6.2. |
| Link | The URL is retained on `sourceUrl` regardless. The user completes the form manually. |

The draft lives in a Zustand store (client state — it would be meaningless to persist
server-side). Server data never enters Zustand.

Save issues one `POST /v1/activities` with an `Idempotency-Key` generated once at
`onMutate` and reused on every retry, regenerated only when the draft changes. Then the
toast in §2.5, anchored to where the item landed.

**Edge cases.**

- Save is enabled as soon as `title` is non-empty after trimming. There is no second
  required field on any type.
- Closing with non-empty content prompts `Discard this?` with Discard / Keep editing.
- Nothing is written to the server until the user commits.
- The screen remembers the last type the user chose **via a chip** and shows that chip
  first; it does **not** pre-select it.

**Tests.** Maestro flow: open Add from Today's FAB, type a title, Save, assert the toast and
that the item is retrievable. A timed run asserting the S1 target — under 5 seconds from FAB
tap to saved — as a median of 10 runs on a simulator, reported but not yet gating (device
timing gates in Phase 4). Unit tests on the draft store: type change applies the P1-20
mapping in memory before any write.

---

### P1-32 — Six progressive creation forms

**Files.** `apps/mobile/src/features/compose/forms/{Task,Meal,Watch,Event,Outing,Custom}
Form.tsx`, plus shared controls in `apps/mobile/src/features/compose/controls/`.

**Approach.** One form per type, rendering **exactly** the fields in
[`../01-product/activities.md`](../01-product/activities.md) §4, in the given order. The
order is part of the spec. A field absent from a type's table does not appear, is not
collapsed behind a disclosure, and is not greyed out.

Shared controls behave identically across types (§3.4): the date picker with `Today`,
`Tomorrow`, `This weekend`, `Next week`, `Pick a date` chips; the 5-minute time picker,
enabled only when a date is set; end time shown only once a start time exists; notes at
4000 characters with no formatting; location as free text label plus address with **no**
geocoding, no autocomplete and no map.

Type-specific inference that must be implemented, not skipped:

- **Meal:** slot → time (breakfast 08:00, lunch 12:30, dinner 19:00, snack unset) and time
  → slot (< 11:00 breakfast, < 15:00 lunch, < 17:00 snack, else dinner), each applying only
  when the other is unset.
- **Watch:** Kind defaults to `Show` if a season or episode is entered, else `Movie`; season
  and episode fields render only for `Show`; `Save to Watchlist` defaults **on** when there
  is no date and **off** when there is.
- **Outing:** `title` and `details.placeName` are kept identical; `location.label`
  pre-fills from Place; the reservation disclosure defaults its name to the user's display
  name and its time to `schedule.time`.
- **Event:** `details.description` and `notes` are distinct — description is public on the
  invite page, notes never leave the owner's view.

Fields that do not appear on a form are still reachable from the detail screen (§4.7). An
Outing having no Reminder field does not mean an Outing cannot have a reminder.

Post-create side effects (`Add selected ingredients to Groceries`, `Save to Watchlist`) are
**Phase 3**. The toggles render, and in Phase 1 they are disabled with the copy `Lists are
coming soon.` rather than being hidden — hiding them means the layout changes in Phase 3.

**Edge cases.** Validation errors are inline and per-field, shown on blur and again on Save,
mapping one-to-one onto the `details[]` entries of a `validation_failed` response. A
highlighted field never blocks Save.

**Tests.** One Vitest render test per form asserting the exact field list and order against
a fixture derived from the canonical table — a test that fails when a field is added,
removed or reordered. Unit tests for each inference rule including the "only when the other
is unset" condition. Playwright: fill and save one of each type on web.

---

### P1-33 — Activity detail screen: read and inline edit

**Files.** `apps/mobile/app/(app)/activity/[id].tsx`,
`apps/mobile/src/features/activity/**`.

**Approach.** One `GET /v1/activities/:id`, which is one DynamoDB `Query`. Render the
sections from
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 that exist in
this phase — header, when/where, notes, and the completion button — with the rest present as
their empty-state affordances so the plan's capabilities stay discoverable. People, Prep,
Lists, Expenses, Attachments and Updates render their `Add …` affordance disabled with the
owning phase's copy.

Editing is **in place**, with no edit mode and no per-field Save button: text commits on
blur, pickers commit on selection, each issuing a `PATCH` with `If-Match: <updatedAt>`. A
`409` refetches, shows `This plan changed. Review the update.`, and re-applies the pending
edit only when the fields do not overlap; overlapping fields are dropped and named.

**Edge cases.** Tapping the date or time anywhere opens the reschedule sheet; it never edits
in place on the row (U4). The completion button's label comes from the type's verb table;
completion itself is Phase 2, so in Phase 1 the button is present and disabled with
`Coming soon` — or, preferably, the screen ships without it and Phase 2 adds it. Choose the
latter: a disabled primary button teaches users the app is unfinished.

> **Decision:** ship Phase 1's detail screen with **no** completion button. Disabled primary
> actions are worse than absent ones. The type's verb still appears in the `⋯` menu's
> `Change type` confirmation copy, so the mapping is exercised.

**Tests.** Playwright: open a saved activity, edit the title, blur, assert the `PATCH` fired
once and the new title persists after reload. A test that a stale `If-Match` produces the
conflict copy rather than a silent overwrite.

---

### P1-36 — Playwright and Maestro harnesses

**Files.** `e2e/web/*.spec.ts`, `playwright.config.ts`,
`e2e/ios/*.yaml`, `.maestro/config.yaml`.

**Approach.** Playwright runs against the deployed dev static export in
`deploy-dev.yml`, not against a local dev server, so it exercises CloudFront's URI rewrite
and the real API. One flow: sign in with a dedicated test user, open Add, create a task,
assert it appears in the activities list.

Maestro runs against the simulator in a manually triggered workflow (simulator runners are
slow and must never block a deploy). One flow: launch, sign in, create a task.

A dedicated dev test user is created once and its credentials stored as GitHub environment
secrets. The authenticated smoke assertion in P1-37 uses `AdminInitiateAuth` with the same
user.

**Edge cases.** The Cognito hosted-UI redirect crosses origins, which is why Playwright and
not Cypress. Keep the test user's password out of the repository and out of logs.

**Tests.** The harnesses are the deliverable; they run green in CI twice consecutively
before the phase is called done. A flaky E2E test is worse than no E2E test — quarantine
rather than retry-until-green.

## Acceptance criteria

1. A new person can sign up with an email address, receive a verification code from
   `no-reply@dev.ordinarydays.app` (not an `amazonaws.com` sender), confirm, and land in the
   app, on both iOS and web.
2. After confirmation, `USER#<userId>/PROFILE` and `EMAIL#<email>/USER` exist in
   `od-main-dev`, and the Cognito user's `custom:app_user_id` matches the profile's id.
3. Re-running the post-confirmation trigger with the same event creates no second profile
   and throws nothing.
4. `GET /v1/me` with a valid token returns the profile; with an expired token, a token from
   the other environment's pool, or an access token instead of an ID token, it returns `401`
   with `code: "unauthenticated"`.
5. Sign in with Apple completes on a physical device, including the Hide My Email path, and
   the display name captured on first authorisation appears in `GET /v1/me`.
6. On web, the browser's JavaScript context has no access to a refresh token: `document.
   cookie` does not contain it, and a `POST /public/v1/auth/refresh` without the
   `X-CSRF-Token` header returns `403`.
7. Signing out invalidates the session server-side: the previous refresh token fails, and
   the persisted query cache is empty on the next launch.
8. `POST /v1/activities` creates each of the six types; the created item's `details.kind`
   equals its `type`, and a mismatched body returns `400` with a `details[]` entry naming
   `details.kind`.
9. Repeating a `POST /v1/activities` with the same `Idempotency-Key` returns the identical
   body and creates exactly one item, verified by counting items in the table.
10. `PATCH` with a stale `If-Match` returns `409` and the current `updatedAt`; with a
    correct one it succeeds and bumps `updatedAt`.
11. `DELETE /v1/activities/:id` removes every item in the `ACT#<id>` partition and the
    owner's index entry, and a child activity created with `parentActivityId` survives with
    that field cleared.
12. Changing an activity's type from Watch to Task shows a confirmation naming exactly
    `Season and episode` and `Streaming service`, and after confirming, the title, date,
    time and notes are unchanged.
13. Each of the six creation forms renders exactly the fields listed in
    [`../01-product/activities.md`](../01-product/activities.md) §4, in that order — asserted
    by a test that fails if a field is added, removed or reordered.
14. Choosing a meal slot with no time set fills the time (dinner → 19:00); entering 12:00
    with no slot set selects Lunch; setting one does not overwrite an explicitly set other.
15. `POST /v1/capture/parse` returns `501` with `code: "not_implemented"`, and typing text
    into the Add screen shows **no** error, no banner and no toast.
16. Sending 121 requests in one minute returns `429` with a `Retry-After` header, and no
    raw IP address appears in the rate-limit item or in any log line.
17. Reaching a usable app from a clean install takes under three minutes with no
    configuration screen beyond timezone confirmation (success criterion S10).
18. `pnpm turbo run test` passes with `packages/shared` coverage at or above its threshold,
    and `docs/generated/openapi.json` regenerates with no diff.
19. One Playwright flow and one Maestro flow pass in CI, twice consecutively.
20. No `pk:` or `sk:` template literal exists outside
    `services/api/src/repositories/keys.ts`, and no `ScanCommand` exists in the API bundle.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| `GET /v1/agenda`, the Today screen, the four sections, UP NEXT | Phase 2 |
| The recurrence engine, `Occurrence` rows, the Repeat sheet beyond a disabled control | Phase 2 |
| `complete`, `uncomplete`, `skip`, `snooze`, `schedule` endpoints | Phase 2 |
| Reminders firing — the `reminders[]` field is stored, nothing schedules it | Phase 2 (local) / Phase 4 (push) |
| Overdue roll-forward, passed-plan prompts | Phase 2 |
| Lists, list items, the Lists tab beyond a placeholder, `Save to Watchlist`, `Add ingredients to Groceries` | Phase 3 |
| Attachments, presigned uploads, the image picker's upload path | Phase 3 |
| Prep-task UI inside a plan (the `parentActivityId` field and its cap are Phase 1) | Phase 3 |
| The updates feed | Phase 3 |
| Participants, invitations, the public invite page, guest linking in the post-confirmation trigger | Phase 5 |
| Expenses, balances, settlement | Phase 6 |
| Any real capture implementation | Phase 7 |
| Push notification permission, device token registration beyond the endpoint | Phase 4 |
| Account deletion | Phase 4 |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The post-confirmation trigger is not idempotent | Duplicate profiles appear intermittently under retry | Conditional puts with `attribute_not_exists(pk)`, and a test that runs the same event twice. Cognito *will* retry. |
| The `CognitoJwtVerifier` is constructed inside the handler | Every request is 50–200 ms slower and nobody notices | Module scope plus a test asserting one construction across 100 requests. |
| Apple Developer enrolment blocks the phase | P1-24 cannot start | Start enrolment on day one of Phase 1. Build every other task first; the phase ships without Apple sign-in if necessary and adds it in a follow-up, because Phase 4 blocks on the membership anyway. |
| Apple's full name is dropped on first authorisation | Users have no display name and there is no way to get it back | Capture and `PATCH /v1/me` in the same handler as the credential response, and a unit test asserting it. |
| The Apple private email relay domain is never registered | Invite emails to `@privaterelay.appleid.com` bounce, silently, months later | Registered as step 1 of P1-24's edge cases; verified by sending one test email to a relay address on dev. |
| A key string is constructed outside `keys.ts` | Nothing, until a key format changes and one call site is missed | A lint rule plus the acceptance criterion. Enforce it while there are five call sites, not fifty. |
| The GSI1 bucket is updated rather than replaced on a schedule change | Ghost rows on Today, in Phase 2, with no obvious cause | Delete-and-re-put in one transaction, with an integration test asserting exactly one index entry after a bucket-changing write. |
| Refresh without a single-flight lock | Users are randomly signed out when the app returns from background | One shared promise, plus the six-concurrent-callers test. Rotation makes this failure certain, not occasional. |
| Zod v3/v4 decision deferred from Phase 0 | Migrating schemas later touches every file in `src/schemas/` | Resolved in P0-09; if it slipped, resolve it before P1-09 writes the first real schema. |
| The six forms drift from the canonical field tables | The product quietly becomes six half-products | The fixture-driven render tests in P1-32 fail on any field addition, removal or reorder. |
</content>
