# Coding standards

**Status:** canonical for how code is written. Layering and dependency direction are in
[`repo-structure.md`](repo-structure.md); what to install is in
[`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md). This document is
about the code inside a file.

Every rule here is checkable — by the compiler, by Biome, by `dependency-cruiser`, or by a
reviewer reading a diff. A rule that cannot be checked is not a rule; it is an opinion, and
it is not in this document.

---

## 1. TypeScript

### 1.1 Strictness

`tsconfig.base.json` is the only place these are set (`repo-structure.md` §5.3). All of
them are on, and none may be relaxed in a package config — with **one scoped exception,
recorded below**:

| Option | Value | Why it is not negotiable |
| --- | --- | --- |
| `strict` | `true` | The baseline. |
| `noUncheckedIndexedAccess` | `true` | `items[0]` is `T \| undefined`. Agenda code indexes arrays constantly; this is where off-by-one bugs get caught. |
| `exactOptionalPropertyTypes` | `true` | `{ time?: string }` cannot be set to `undefined` explicitly. DynamoDB's `removeUndefinedValues` makes the two indistinguishable at rest, so the type system must keep them apart in code. |
| `noImplicitOverride` | `true` | Error subclasses actually override what they say they do. |
| `noFallthroughCasesInSwitch` | `true` | Pairs with the exhaustive-switch rule in §1.5. |
| `verbatimModuleSyntax` | `true` | `import type` is explicit, so esbuild never bundles a type-only module. |
| `isolatedModules` | `true` | Required by esbuild and Metro; catches re-exports they cannot handle. |

> **The one exception, added in P0-15: `exactOptionalPropertyTypes` is `false` in
> `infra/tsconfig.json`.**
>
> `aws-cdk-lib` is not `exactOptionalPropertyTypes`-clean. Its construct classes resolve
> `role` to `IRole | undefined` while its own interfaces declare `role?: IRole`, so passing
> an `Alias` where CDK asks for an `IFunction` does not typecheck. It is not a TypeScript 7
> problem — the failure reproduces identically on 5.9.3 — and it recurs in every stack that
> hands a construct to a CDK API.
>
> The flag stays on everywhere else, because the reason this table gives for it is about
> **domain data**: DynamoDB's `removeUndefinedValues` makes "explicitly `undefined`" and
> "absent" indistinguishable at rest, so the type system has to keep them apart in code.
> `infra` models CloudFormation templates, not domain data, and stores nothing — so the
> flag protects nothing there.
>
> The alternative was casting at every call site. One visible line in one config is easier
> to review than a dozen scattered `as` expressions, and unlike a cast it cannot hide a
> genuine type error. `packages/shared`, `services/api` and `apps/mobile` are unchanged.

`// @ts-expect-error` is permitted with a same-line reason comment and only where an
upstream type is genuinely wrong. `// @ts-ignore` is never permitted — it does not fail when
the error goes away, so it rots silently.

### 1.2 `any` is banned; `unknown` at boundaries

`noExplicitAny` is an error in `biome.json`. There is no allowed use of `any` in this
codebase.

Data arriving from outside the process is `unknown` until a schema narrows it:

```ts
// Wrong — the shape is asserted, not checked.
const body = (await c.req.json()) as CreateActivityInput;

// Right — the shared schema is the only thing that produces the type.
const body: unknown = await c.req.json();
const input = createActivityInput.parse(body);   // CreateActivityInput, by inference
```

In practice `@hono/zod-validator` does this, and a handler receives an already-narrowed
value. The rule matters for the places the validator does not cover: DynamoDB reads, the
API client's responses, and anything read from storage on the client.

Type assertions (`as X`) are permitted in exactly four places: narrowing a `const`
assertion, satisfying a library's generic that cannot be inferred, inside a repository's
upgrade-on-read function where the raw item's shape has just been checked by a
`schemaVersion` branch, and immediately beside a `schema.parse` of the same value at a
repository read boundary when Zod's optional-property output conflicts only with
`exactOptionalPropertyTypes` absence semantics. That fourth use requires an adjacent comment
naming the modality gap. Everywhere else, `as` is a reviewer's question.

### 1.3 Discriminated unions, not optional-field soup

`ActivityDetails` (`data-model.md` §4.4) is the model: a `kind` field discriminates, and
each arm carries only the fields that arm has. Follow it for every new shape.

```ts
// Wrong — every field optional, every consumer defensive, no invalid state prevented.
interface CaptureResult {
  ok?: boolean;
  parsed?: ParsedCapture;
  errorCode?: string;
  retryAfter?: number;
}

// Right — the compiler knows which fields exist in which state.
type CaptureResult =
  | { status: 'parsed'; parsed: ParsedCapture }
  | { status: 'unavailable' }
  | { status: 'rate_limited'; retryAfterSeconds: number };
```

The test: if two optional fields are always present together or always absent together,
they belong in the same union arm.

### 1.4 No enums, no default exports

TypeScript `enum` emits runtime code, is not a subtype of `string`, and behaves differently
under `isolatedModules`. Use string literal unions, and a `const` object plus
`satisfies` when a runtime list is needed:

```ts
export const ACTIVITY_TYPES = [
  'task', 'meal', 'watch', 'event', 'custom',
] as const satisfies readonly ActivityType[];
```

Default exports are banned everywhere except the files a framework requires them in: Expo
Router route files under `apps/mobile/app/`, `app.config.ts`, and config files that a tool
loads by convention. Named exports rename consistently, autocomplete correctly, and cannot
be imported under two different names in two files.

### 1.5 Exhaustive switches with a `never` check

Every switch over a union ends with a default that cannot be reached. When a seventh
`ActivityType` is added, this is what fails the build instead of shipping a blank row.

```ts
// packages/shared/src/types/assert.ts
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
```

```ts
export function completionVerb(type: ActivityType): string {
  switch (type) {
    case 'task':   return 'Complete';
    case 'meal':   return 'Had it';
    case 'watch':  return 'Watched';
    case 'event':  return 'Attended';
    case 'event': return 'Done';
    case 'custom': return 'Done';
    default:       return assertNever(type, 'ActivityType');
  }
}
```

The same applies to `ActivityStatus`, `ListBehaviour`, `ErrorCode`, `splitMode`, and every
`details.kind` branch.

### 1.6 `satisfies` over annotation

Use `satisfies` when you want the check without widening the inferred type.

```ts
// Annotation widens: map.task is IconName, and the literal keys are lost.
const map: Record<ActivityType, IconName> = { task: 'check-square', /* … */ };

// satisfies keeps the literal types AND checks completeness.
export const ACTIVITY_TYPE_ICON = {
  task:   'check-square',
  meal:   'bowl',
  watch:  'play-rect',
  event:  'ticket',
  event: 'map-pin',
  custom: 'diamond',
} as const satisfies Record<ActivityType, IconName>;
```

Adding an `ActivityType` without adding a row here is a compile error, which is exactly what
`design-system.md` §5.2 requires.

Use this pattern only over a **genuinely closed** enum — `ActivityType`, `ListBehaviour`,
`ActivityStatus`, `DefaultSlot`. Do not build an exhaustive map over something open-ended
such as a list template key; templates are configuration and a new one must never be a
compile error (`../02-architecture/data-model.md` §4.6).

### 1.7 Branded types

Three families of value are structurally `string` or `number` but must never be
interchangeable: entity IDs, money, and wall-clock date/time strings. Brand them.

```ts
// packages/shared/src/types/brand.ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
```

```ts
// packages/shared/src/types/ids.ts
export type ActivityId = Brand<string, 'ActivityId'>;
export type UserId     = Brand<string, 'UserId'>;
export type PersonId   = Brand<string, 'PersonId'>;
export type ListId     = Brand<string, 'ListId'>;
export type ItemId     = Brand<string, 'ItemId'>;
export type ExpenseId  = Brand<string, 'ExpenseId'>;
```

Branded values are produced in exactly two ways: by a generator (§4) or by a Zod schema
that validates the format and brands the output. Never by a bare cast in feature code.

```ts
// packages/shared/src/schemas/common.ts
export const activityId = z
  .string()
  .regex(/^act_[0-9A-HJKMNP-TV-Z]{26}$/)
  .transform((v) => v as ActivityId);
```

This is what stops `getActivity(personId)` from compiling — a bug class that single-table
DynamoDB makes easy to write and hard to notice.

### 1.8 Type-only imports

`import type { Activity } from '@od/shared/types'` for anything used only in type position.
`verbatimModuleSyntax` enforces it. It keeps the Lambda bundle honest and stops a type-only
import from dragging a module into the client bundle.

---

## 2. Error handling

> **Decision: thrown typed errors, not a `Result` type.** One mechanism, everywhere.
> A `Result<T, E>` forces every intermediate function to unwrap and re-wrap, which in a
> five-layer server (route → handler → service → repository → SDK) means the same error is
> re-boxed four times. Hono's `onError` already gives us one catch point per request, and
> the AWS SDK throws. Introducing `Result` would mean converting at every SDK boundary and
> converting back at the Hono boundary — more code, more places to lose context, no more
> safety in a codebase where the compiler cannot force exhaustive error handling anyway.
> The trade-off accepted: the type signature of a function does not tell you what it can
> throw. We compensate with the closed `ErrorCode` union and the mapping table below.

### 2.1 The hierarchy

One base class, defined once in `services/api/src/lib/errors.ts` (`tech-stack.md` §4.4),
plus thin subclasses whose only job is to fix the code and make call sites readable.

```ts
import type { ErrorCode } from '@od/shared/errors';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: { path: string; message: string }[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  // `resource` is never interpolated into the message: existence must not leak.
  constructor(readonly resource: string) {
    super('not_found', "This isn't here any more.");
  }
}

export class ForbiddenError extends AppError {
  constructor(action: string) {
    super('forbidden', `Only the person who made this plan can ${action}.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, readonly currentUpdatedAt?: string) {
    super('conflict', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: { path: string; message: string }[]) {
    super('validation_failed', message, details);
  }
}
```

Rules:

- **Every thrown error in `services/` and `repositories/` is an `AppError`.** A bare
  `throw new Error(...)` in those directories is a bug: it becomes a `500` with the generic
  message, losing the intent.
- **Programmer errors are different.** An invariant violation (`assertNever`, a
  never-null field that is null) throws a plain `Error`. It *should* become a `500`, be
  logged with a stack, and be fixed.
- **The client's errors are separate.** `packages/shared/src/client/http.ts` maps the error
  envelope to `ApiError`, carrying `code`, `message`, `requestId`, and `details`. The client
  never constructs an `AppError`.

### 2.2 Error to HTTP

The mapping table is in [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md)
§4.4 and is not restated here. It is implemented in exactly one place,
`middleware/errorHandler.ts`, which also translates:

| Caught | Becomes |
| --- | --- |
| `ZodError` | `validation_failed` (400), `details[]` built from `issues` with dotted paths |
| `ConditionalCheckFailedException` | `conflict` (409) |
| `TransactionCanceledException` with a `ConditionalCheckFailed` reason | `conflict` (409) |
| `ProvisionedThroughputExceededException`, `RequestLimitExceeded` | 503 with `Retry-After: 1` |
| Anything else | `internal` (500) |

### 2.3 The user-facing message rule

> **The `message` field of an error response is written for a human user, in advance, by a
> person. It is never derived from an exception.**

```ts
// Wrong — leaks internals, unreadable, and a security finding.
throw new AppError('internal', err.message);

// Wrong — leaks the shape of the data model.
throw new AppError('not_found', `No item with pk=ACT#${id}`);

// Right.
throw new NotFoundError('activity');
```

Every 500 returns the literal string `"An unexpected error occurred."` The exception text
and stack go to the log line, correlated by `requestId`, which the client displays in small
text so a user can quote it (`interaction-contract.md` §5.3).

A unit test asserts that no `AppError` message in the codebase contains `pk`, `sk`, `#`, a
stack frame, or the word `DynamoDB`.

### 2.4 Catching

- Never `catch` without either re-throwing or converting to an `AppError` with a reason.
- Never `catch {}`. If a failure is genuinely ignorable, log it at `debug` with a one-line
  comment saying why.
- Catch narrowly. `catch (e) { if (e instanceof ConditionalCheckFailedException) … throw e; }`

---

## 3. Money

### 3.1 Integer cents, always

`amountCents`, `netCents`, `priceCents`, `expenseTotalCents` — every money value in the
product is an integer number of minor units. There is no `amount` field and no `price`
field anywhere.

```ts
// packages/shared/src/money/cents.ts
export type Cents = Brand<number, 'Cents'>;

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`Cents must be an integer, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new Error(`Cents out of safe range: ${n}`);
  return n as Cents;
}

export const addCents = (a: Cents, b: Cents): Cents => cents(a + b);
export const subCents = (a: Cents, b: Cents): Cents => cents(a - b);
export const sumCents = (xs: readonly Cents[]): Cents =>
  cents(xs.reduce<number>((t, x) => t + x, 0));
```

### 3.2 Forbidden arithmetic

Inside `packages/shared/src/money/**` and anywhere a `Cents` value is handled:

| Banned | Instead |
| --- | --- |
| `/` producing a non-integer | `Math.floor` plus explicit remainder distribution (§3.3) |
| `*` by a fractional factor | Multiply by an integer numerator, then divide with remainder |
| `parseFloat`, `Number('1.50')` on a money string | Parse to cents at the input boundary with a Zod transform |
| `toFixed`, `Math.round` on a money value | Never needed — the value is already an integer |
| `+` on a `Cents` and a plain `number` | `addCents` |
| Any currency conversion | Not modelled in v1 (`data-model.md` §10) |

Formatting for display is the **only** place a decimal appears, and it happens once:

```ts
// packages/shared/src/money/format.ts
export function formatCents(value: Cents, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency })
    .format(value / 100);
}
```

That division is safe because its output is a string for a human, never a value that is
stored or compared.

### 3.3 The remainder-distribution helper

`api-contract.md` §2.9: remainder cents go to the first N participants in `personId` sort
order, so a total always reconciles exactly. It lives in
`packages/shared/src/money/split.ts` and nowhere else — the server validates with it and
the client previews with it.

```ts
// packages/shared/src/money/split.ts
export interface Share { personId: PersonId; shares?: number }
export interface SplitLine { personId: PersonId; amountCents: Cents }

/**
 * Splits `total` across `people` so the parts sum to exactly `total`.
 * Remainder cents are given to the lowest `personId`s in ascending sort order —
 * deterministic, so the server and an optimistic client agree without coordination.
 */
export function splitEqual(total: Cents, people: readonly PersonId[]): SplitLine[] {
  if (people.length === 0) throw new Error('splitEqual: no participants');
  const sorted = [...people].sort();
  const base = Math.trunc(total / sorted.length);
  let remainder = total - base * sorted.length;          // sign follows `total`
  const step = remainder >= 0 ? 1 : -1;

  return sorted.map((personId) => {
    const extra = remainder !== 0 ? step : 0;
    remainder -= extra;
    return { personId, amountCents: cents(base + extra) };
  });
}

export function splitByShares(
  total: Cents,
  people: readonly Share[],
): SplitLine[] { /* same shape: floor each, then distribute the remainder by sort order */ }

/** The invariant every split must satisfy. Called by the API before any write. */
export function assertSplitsReconcile(total: Cents, lines: readonly SplitLine[]): void {
  const sum = sumCents(lines.map((l) => l.amountCents));
  if (sum !== total) {
    throw new ValidationError('The split has to add up to the total.', [
      { path: 'splits', message: `Splits sum to ${sum}, expected ${total}` },
    ]);
  }
}
```

Negative totals are handled (a refund line) because `Math.trunc` rounds toward zero and the
step follows the remainder's sign. That is a property-based test case, not a comment
(`testing.md` §7).

### 3.4 Where money code lives

| Concern | File |
| --- | --- |
| `Cents` brand, arithmetic | `packages/shared/src/money/cents.ts` |
| Splitting, reconciliation | `packages/shared/src/money/split.ts` |
| Net balance from unsettled expense obligations; settlement rows are audit-only | `packages/shared/src/money/balance.ts` |
| Display formatting | `packages/shared/src/money/format.ts` |

Nothing in `services/api` or `apps/mobile` does money arithmetic. They call these.

---

## 4. Dates and times

### 4.1 The two kinds of time

`data-model.md` §3.5 draws the line and it is the single most important distinction in this
codebase. Every date/time value is one of these, and they are branded so they cannot be
mixed:

| Kind | Type | Format | Means | Used for |
| --- | --- | --- | --- | --- |
| Wall-clock date | `WallDate` | `YYYY-MM-DD` | A day on a calendar, with no zone | `schedule.date`, segment `effectiveFrom`, occurrence keys, agenda windows |
| Wall-clock time | `WallTime` | `HH:mm` | A time on a clock, with no zone | `schedule.time`, `endTime`, `overrideTime` |
| Wall-clock stamp | `WallStamp` | `YYYY-MM-DDTHH:mm` | The GSI1 sort key | `gsi1sk` for the scheduled bucket |
| Zone | `TimeZone` | IANA string | Where the wall clock is | `schedule.timezone` |
| Instant | `Instant` | ISO 8601 with offset | An absolute moment | `scheduledAtUtc`, `createdAt`, `updatedAt`, reminders, `.ics` |

```ts
// packages/shared/src/time/types.ts
export type WallDate  = Brand<string, 'WallDate'>;   // 2026-08-06
export type WallTime  = Brand<string, 'WallTime'>;   // 19:30
export type WallStamp = Brand<string, 'WallStamp'>;  // 2026-08-06T19:30
export type Instant   = Brand<string, 'Instant'>;    // 2026-08-06T23:30:00.000Z
export type TimeZone  = Brand<string, 'TimeZone'>;   // America/New_York
```

### 4.2 Which to use where

| Situation | Use |
| --- | --- |
| "Does this belong on Today?" | `WallDate`. Compare strings. Never construct a `Date`. |
| Sorting a day's schedule | `WallTime` string comparison. `'09:00' < '19:30'` is correct. |
| Expanding a recurrence | `WallDate` arithmetic in the activity's `TimeZone` (`data-model.md` §6) |
| Scheduling a reminder | `Instant`, derived from `WallDate` + `WallTime` + `TimeZone` |
| `.ics` export, push delivery time | `Instant` |
| `createdAt` / `updatedAt` | `Instant` |
| Anything a user reads | Formatted from the wall-clock value in the activity's zone |

The conversion happens in exactly one module, `packages/shared/src/time/zone.ts`, using
`date-fns-tz`:

```ts
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';

export function toInstant(date: WallDate, time: WallTime, tz: TimeZone): Instant {
  return fromZonedTime(`${date}T${time}:00`, tz).toISOString() as Instant;
}

export function toWallDate(instant: Instant, tz: TimeZone): WallDate {
  return formatInTimeZone(instant, tz, 'yyyy-MM-dd') as WallDate;
}
```

A 6 PM daily task stays 6 PM local across a DST boundary because the recurrence expands in
wall-clock space and only converts to an `Instant` at the very end, per activity occurrence.
Converting first and then adding 24 hours is the DST bug, and it is a required test case.

### 4.3 The `new Date()` ban

> **`new Date()`, `Date.now()`, and `dayjs()`-style implicit-now calls are banned inside
> pure logic.** A `Clock` is injected.

```ts
// packages/shared/src/time/clock.ts
export interface Clock {
  now(): Instant;
  todayIn(tz: TimeZone): WallDate;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString() as Instant,
  todayIn: (tz) => formatInTimeZone(new Date(), tz, 'yyyy-MM-dd') as WallDate,
};

export const fixedClock = (at: Instant): Clock => ({ /* … for tests … */ });
```

| Layer | Where the clock comes from |
| --- | --- |
| `packages/shared` pure functions | A `Clock` parameter. Always explicit. |
| `services/api` services | Injected at construction from `lib/clock.ts`; `systemClock` in prod |
| `apps/mobile` hooks | `useClock()` from a provider, so tests and Storybook can freeze time |
| `apps/mobile` UI ticker (UP NEXT) | The provider's clock, read on a one-minute interval |

Biome's `noRestrictedGlobals` flags `Date` inside `packages/shared/src/{recurrence,money,
rank,time}/**` except `time/clock.ts`. Without this rule, "what does Today show?" becomes
untestable, and every agenda test would depend on the day it ran.

### 4.4 Formatting

All user-facing formatting is `date-fns` with `formatInTimeZone`, in the user's profile
timezone unless the activity carries its own. No manual string slicing of a date, no
`toLocaleDateString` without an explicit locale and zone, no month-name arrays.

> **P2-03 deterministic recurrence-description exemption — 2026-08-10.**
> `packages/shared/src/recurrence/describe.ts` keeps its fixed English `MONTH_NAMES` table.
> Recurrence descriptions are canonical product copy whose output must be byte-identical
> across runtimes, ambient locales and timezones; delegating those names to host locale data
> would undo P2-03's determinism decision. This is the sole month-name-array exemption and
> does not permit hand-formatted calendar dates elsewhere.

---

## 5. IDs

### 5.1 Prefixed ULIDs

`data-model.md` §8 fixes the prefixes. One generator, one file:

```ts
// packages/shared/src/ids/generate.ts
import { ulid } from 'ulid';

const PREFIXES = {
  activity: 'act', user: 'usr', list: 'lst', item: 'itm', person: 'psn',
  expense: 'exp', settlement: 'stl', device: 'dev', attachment: 'att',
  update: 'upd', reminder: 'rem',
} as const;

export type EntityKind = keyof typeof PREFIXES;

export function newId<K extends EntityKind>(kind: K, seedTime?: number): string {
  return `${PREFIXES[kind]}_${ulid(seedTime)}`;
}

export const newActivityId = (t?: number) => newId('activity', t) as ActivityId;
export const newPersonId   = (t?: number) => newId('person', t)   as PersonId;
// … one typed wrapper per branded ID type
```

`seedTime` exists so tests can produce deterministic, ordered IDs. Production callers never
pass it.

Invite tokens are **not** ULIDs — `crypto.randomBytes(16)` base62-encoded, generated in
`services/api/src/services/inviteService.ts` (`data-model.md` §4.9, `security-privacy.md`
§1 row 3).

### 5.2 Never expose storage keys

The API speaks in IDs. `pk`, `sk`, `gsi1pk`, `gsi1sk`, and `entity` never appear in a
response body, a cursor's decoded contents shown to a client, a log line, or an error
message.

Repositories strip them on the way out. The mechanism is a single `toDomain` function per
repository, not a spread:

```ts
// Wrong — ships pk, sk, entity, gsi1pk, gsi1sk to the client.
return { ...item } as Activity;

// Right — field by field, so a new storage attribute cannot leak by accident.
return {
  activityId: item.activityId,
  ownerId: item.ownerId,
  type: item.type,
  // …
};
```

Cursors are base64 of a `LastEvaluatedKey` and are opaque; on decode they are schema-checked
**and** verified to belong to the requesting user (`security-privacy.md` §4.1 rule 8).

---

## 6. Async

### 6.1 No floating promises

Biome's `noFloatingPromises` is an error. Every promise is awaited, returned, or explicitly
discarded with `void` plus a comment saying why the result does not matter.

```ts
void logAnalytics(event);  // fire-and-forget: a failed analytics ping must not fail a write
```

In Lambda, a floating promise is worse than a lint smell — the execution environment freezes
at handler return, so the work may never complete and may resume on an unrelated invocation.

### 6.2 `Promise.all` vs sequential

| Situation | Do |
| --- | --- |
| Independent reads (activity detail's participants, expenses, updates) | `Promise.all` |
| Reads where one's result is another's key | Sequential `await` |
| Writes that must be atomic | `TransactWriteItems`, never `Promise.all` of writes |
| Writes that must be ordered but not atomic | Sequential, with a comment naming the ordering constraint |
| Fan-out over a user-controlled list | `Promise.all` with a bounded chunk size, never unbounded |

Use `Promise.all` when every branch must succeed; `Promise.allSettled` only when partial
failure is genuinely acceptable and the failures are logged individually.

The activity-detail read is a single `Query` on the `ACT#` partition
(`data-model.md` §5 pattern 4), not four parallel calls. Parallelism is the answer when the
data model forces separate calls, not a substitute for a correct key design.

### 6.3 Timeouts

Nothing waits forever. The Lambda's own timeout is 15 seconds
(`infrastructure.md` §1.3); every outbound call gets a tighter one so the function can
return a useful error instead of being killed.

| Call | Timeout |
| --- | --- |
| DynamoDB (SDK `requestHandler`) | 3 s per attempt, 2 attempts |
| SES, Scheduler, SSM | 3 s |
| Anthropic API (Phase 8) | 20 s, with the Lambda timeout raised on that route only |
| Client → API (`shared/client/http.ts`) | 10 s via `AbortSignal.timeout(10_000)` |

### 6.4 Retry with jitter

Retries are **full jitter**, never a fixed backoff — a fixed backoff synchronises retries
from every client that failed at the same moment.

```ts
// packages/shared/src/client/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 200, capMs = 4_000, isRetryable }: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
      await sleep(Math.random() * ceiling);   // full jitter: uniform in [0, ceiling)
    }
  }
  throw lastError;
}
```

Retryable: network failures, 429 (honouring `Retry-After`), 503, and DynamoDB throughput
exceptions. **Not** retryable: any 4xx other than 429, and any error from a non-idempotent
call that lacks an `Idempotency-Key`.

### 6.5 Idempotency

Every mutating `POST` explicitly named replay-protected by
`api-contract.md` §1, carries a client-generated `Idempotency-Key`. Two rules follow, and both
are commonly got wrong:

1. **The key is generated once when the mutation is enqueued, outside `mutationFn`, and reused
   on every retry** — including retries that happen after an app restart, which is why it is
   persisted with the queued mutation variables (`tech-stack.md` §3.4).
2. **The server stores the original response status and body, not just a marker.** A repeat
   returns both unchanged (`201` remains `201`), so the client gets exactly the response and
   `activityId` it would have got the first time. A marker-only implementation returns an
   empty success and the client loses the ID.

---

## 7. Logging

### 7.1 Structure

`pino`, one JSON object per event, created once at module scope
(`services/api/src/lib/logger.ts`). Never `console.log` — it produces unparseable text in
CloudWatch Logs Insights.

Every log line, without exception, carries:

| Field | Source | Why |
| --- | --- | --- |
| `requestId` | `requestId` middleware | Correlates a user's report to a line |
| `stage` | `process.env.STAGE` | dev and prod share a log account |
| `version` | Build SHA, injected at bundle time | Which code produced this |
| `route` | Hono's matched route pattern, not the raw path | `/v1/activities/:id`, so lines group |
| `method` | — | — |
| `userId` | Set by the `identity` middleware once known | Scope of an incident (`security-privacy.md` §9.4) |

The completion line adds `status` and `durationMs`. A repository line adds `op`
(`Query`/`GetItem`/`TransactWriteItems`), `entity`, and `consumedCapacity` when returned.

```ts
logger.info({ route, method, status, durationMs, itemCount }, 'request completed');
```

The message is a short fixed string. Variable data goes in the object, never interpolated
into the message — interpolated messages cannot be grouped or queried.

### 7.2 Levels

| Level | Use | Example |
| --- | --- | --- |
| `error` | A 5xx, an unhandled exception, a failed transaction. Includes the stack. | `internal` |
| `warn` | A 4xx that indicates a client bug or an abuse signal; a degraded path taken | `series_limit_exceeded`, rate limit hit |
| `info` | One line per request; significant state changes (activity created, invite sent) | — |
| `debug` | Repository operations, cache hits, decision points. **Off in prod** (`infrastructure.md` §1.3). | — |
| `trace` | Not used. | — |

A 4xx never logs a stack. A 5xx always does.

### 7.3 PII redaction

`security-privacy.md` §1 row 8 is the requirement; this is the implementation. The list is
exhaustive and adding a field that could carry user content means adding it here in the
same PR.

```ts
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'email', '*.email', '*.*.email',
      'displayName', '*.displayName', '*.*.displayName',
      'title', '*.title', '*.*.title',
      'notes', '*.notes',
      'description', '*.description',
      'mediaTitle', '*.mediaTitle',
      'location', '*.location', 'location.*',
      'address', '*.address',
      'lat', 'lng', '*.lat', '*.lng',
      'phone', '*.phone',
      'expoPushToken', '*.expoPushToken',
      'authorization', 'req.headers.authorization', 'req.headers.cookie',
      'req.headers', 'body', 'rawModelOutput',
    ],
    censor: '[redacted]',
  },
});
```

What **is** logged: `userId`, `activityId`, `listId`, `personId`, `requestId` — all opaque
ULIDs. Where an email must be correlated (guest → account linking), log
`sha256(lowercased email)`. IP addresses are hashed before they touch anything.

A unit test builds an object containing every redacted key with a recognisable sentinel
value and asserts the serialised output contains none of them (`testing.md` §2).

---

## 8. React and React Native

### 8.1 Component file structure

One component per file, in this order, no exceptions:

```tsx
// 1. Imports: node/react, third-party, @od/*, relative — Biome sorts them.
import { memo, useCallback } from 'react';
import { View } from 'react-native';
import { Text, Row } from '@od/ui';
import type { AgendaItem } from '@od/shared/types';
import { useCompleteActivity } from '../hooks/useCompleteActivity';

// 2. Props type, exported only if another module needs it.
interface AgendaRowProps {
  item: AgendaItem;
  onOpen: (activityId: ActivityId) => void;
}

// 3. The component. Named export. No default.
export const AgendaRow = memo(function AgendaRow({ item, onOpen }: AgendaRowProps) {
  // 3a. Hooks, all of them, unconditionally, before any early return.
  const complete = useCompleteActivity();
  const handlePress = useCallback(() => onOpen(item.activityId), [onOpen, item.activityId]);

  // 3b. Derived values.
  // 3c. Early returns.
  // 3d. JSX.
  return <Row onPress={handlePress}>{/* … */}</Row>;
});

// 4. Styles last, module scope, never inside the component.
const styles = StyleSheet.create({ /* … */ });
```

A route file under `apps/mobile/app/` stays under ~150 lines and contains no data-fetching
logic (`tech-stack.md` §3.2). If it grows, the screen body moves to
`src/features/<f>/components/`.

### 8.2 Hooks rules

- Hooks are called unconditionally, at the top, before any early return. Biome's
  `useHookAtTopLevel` enforces it.
- `useExhaustiveDependencies` is an **error**, not a warning. A dependency that genuinely
  should be excluded gets an inline `// biome-ignore` with a reason. Silencing it without a
  reason is a rejection.
- `useQuery` and `useMutation` appear **only** in `src/features/*/hooks/**`
  (`tech-stack.md` §3.2). A component that calls `useQuery` directly is a layering
  violation.
- Query keys come from a `keys.ts` factory, never an inline array literal — two spellings of
  the same key is a cache-invalidation bug that only shows up under a slow network.
- Custom hooks return an object, not a positional tuple, once there are more than two values.
- A hook never renders; a component never fetches.

### 8.3 When to memoise, and when not

Memoisation has a cost: a comparison on every render, plus the mental cost of a dependency
array that can go stale. Apply it where the profiler says it matters, which in this app is
exactly three places.

| Memoise | Why |
| --- | --- |
| Every row component rendered inside a list (`AgendaRow`, `ListItemRow`, `PersonRow`) | `React.memo`. A list re-render otherwise re-renders every row on every keystroke or tick. |
| Callbacks and objects passed **into** a memoised row | `useCallback` / `useMemo`. Without them the `memo` is defeated and you have paid the cost for nothing. |
| Genuinely expensive derivations: agenda partitioning, balance aggregation, recurrence description | `useMemo`, and only after the pure function is in `model/` where it can be measured. |

| Do not memoise | Why |
| --- | --- |
| A component that renders once per screen | The comparison costs more than the render. |
| A string concatenation, a boolean, a `.length` | Cheaper than the memo's bookkeeping. |
| A callback passed to a non-memoised child | No effect. |
| Anything, "to be safe" | Reviewer removes it. |

The UP NEXT one-minute ticker (`today-and-tasks.md` §2.1) is the specific case where a
missing `memo` is visible: without it, the whole agenda re-renders every 60 seconds.

### 8.4 List virtualisation

| List | Component |
| --- | --- |
| Today's sections (bounded: ANYTIME capped at 20, EARLIER capped at 10) | `SectionList` |
| Plans, list items, notifications, search results, balance drill-down — anything paginated | `FlatList` with `keyExtractor`, `getItemLayout` where rows are fixed-height, `initialNumToRender={12}`, `windowSize={7}`, `removeClippedSubviews` on native only |
| Anything under ~30 rows with a known ceiling | `map` inside a `ScrollView` is acceptable and simpler |

> **Decision:** no `@shopify/flash-list` in v1. `FlatList` is adequate for lists of this
> size, and FlashList requires accurate size estimates that are wrong the moment dynamic
> type reflows a row (`interaction-contract.md` §6.3) — reflowing rows are precisely what
> this app has. **Revisit if** a profiled list drops frames on a device we support.

`getItemLayout` is only correct for genuinely fixed-height rows. Rows in this product are
content-sized with a 44 pt minimum, so it is used only where a row cannot wrap.

### 8.5 No inline styles in hot lists

An inline style object is a new object identity on every render, which defeats `React.memo`
on the child and forces a style recalculation on web.

```tsx
// Wrong, inside a list row.
<View style={{ paddingHorizontal: 16, flexDirection: 'row' }} />

// Right.
<View style={styles.row} />
const styles = StyleSheet.create({
  row: { paddingHorizontal: tokens.space[5], flexDirection: 'row' },
});

// Conditional: compose from static entries, never build a new object.
<View style={[styles.row, isPast && styles.rowPast]} />
```

Outside list rows an inline style is tolerated for a genuinely one-off value, but the value
must still come from a token (§8.7).

### 8.6 Platform-specific files

`tech-stack.md` §3.5 sets the policy: fork a file only where the platforms genuinely differ,
use `Platform.select()` inline for one- or two-line divergences.

| Rule | Detail |
| --- | --- |
| Suffix order | `.ios.tsx` → `.native.tsx` → `.tsx`; web resolves `.web.tsx` first |
| Always ship a base file | `storage.ts` must exist even when `storage.ios.ts` and `storage.web.ts` do — the base is what the type checker and any future platform resolve to |
| Identical public surface | Every fork exports the same names with the same signatures. A test imports both and asserts the export sets match. |
| No `Platform.OS` in a forked file | If you have forked, the branch is already taken |
| Web no-ops are explicit | `push.web.ts` exports a function that returns `undefined` and logs at `debug`, never a silent empty function |

### 8.7 Styling

> **Decision: `StyleSheet.create` with tokens imported from `@od/ui/theme`.** Not NativeWind,
> not Tamagui, not a runtime CSS-in-JS library.
>
> - **Zero build-time cost.** No Babel plugin, no Metro transformer, no compiler step that
>   can break on an Expo SDK bump. The Expo upgrade path is the highest-risk recurring
>   maintenance in this project (`tech-stack.md` §6) and the styling layer must not add to
>   it.
> - **Static objects are the fastest thing available in both renderers.** `StyleSheet.create`
>   registers once; on web, React Native Web hoists them into real CSS classes rather than
>   inline attributes.
> - **Tokens stay typed.** `tokens.space[5]` is a number the compiler knows. A string class
>   name (`"px-4"`) is not checkable, and the enforcement rule in `design-system.md` §9 —
>   no value outside the tokens — becomes a lint plugin instead of a type error.
> - **One idiom for an agent to follow.** Every component in the repo looks the same.
>
> The cost accepted: no co-located conditional style syntax, and theme-dependent styles need
> a hook. That is handled with one helper:

```ts
// packages/ui/src/theme/useStyles.ts
export function useStyles<T extends NamedStyles<T>>(factory: (t: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => StyleSheet.create(factory(theme)), [theme, factory]);
}
```

Pass a module-scope `factory` function so the `useMemo` actually memoises. A factory defined
inline in the component body is a new identity every render and the memo does nothing.

### 8.8 Accessibility in components

Not optional and not a later pass. `interaction-contract.md` §6 is the specification; the
coding rule is that every interactive element ships with `accessibilityRole`,
`accessibilityLabel`, and its state (`accessibilityState={{ checked }}`), and that swipe
actions are also exposed as `accessibilityActions`. A component test asserts the label
(`testing.md` §5).

---

## 9. Fractional indexing (`lexoRank`)

List reordering must be a single-item write, never a renumber of the list
(`data-model.md` §3.3). The rank is a string; a new item's rank is a string that sorts
strictly between its neighbours.

> **Decision: a small pure implementation in `packages/shared/src/rank/lexoRank.ts`, no
> library.** The candidates (`lexorank`, `fractional-indexing`) are each a dependency, a
> supply-chain surface, and an API to learn, for an algorithm that is one function. Ours is
> pure, has no dependencies, and is covered by property-based tests (`testing.md` §7).

**Algorithm.** Ranks are strings over base62 in ASCII collation order —
`0-9` < `A-Z` < `a-z` — which is also DynamoDB's byte order for the `sk`, so the sort the
database performs and the sort the code performs are the same sort. Two strategies, chosen by
whether the gap is bounded on both sides:

- **Two neighbours — midpoint subdivision.** Walk both strings one character at a time. At
  the first position where the two characters are more than one apart, emit their midpoint
  and stop. Where they are adjacent, copy `prev`'s character and descend a place; if that
  branch cannot fit inside the cap, take `next`'s character alone instead, which is itself a
  rank whenever `next` continues past it.
- **An open end — step by one.** Appending increments `prev`'s last character (`V` → `W`);
  once it is `z`, a `1` is appended (`z` → `z1`). Prepending decrements `next`'s last
  character (`V` → `U`); once it is `1`, that character becomes `0` and a `z` is appended
  (`1` → `0z`). At the cap, where nothing can be appended, the step carries (or borrows) into
  the nearest earlier position that can still move — `A` + `z` × 63 is followed by `B`. No
  neighbours at all gives the midpoint `V`, leaving equal room on both sides.

Bisecting an open end would spend a character every ~6 appends and put a list built one
item at a time into repair at item ~385 — inside the 500-item cap. Stepping spends a
character every ~61, so sequential head or tail creation never reaches repair.

**Overflow means "nothing fits", not "the first strategy ran out of room."** Every rank
between two bounds either takes a character strictly between theirs, copies `prev`'s and
exceeds its remainder, or takes `next`'s character; the search tries each, so
`LexoRankOverflowError` is thrown only when no valid rank of at most `MAX_LEXO_RANK_LENGTH`
characters exists.

```ts
// packages/shared/src/rank/lexoRank.ts
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RADIX = ALPHABET.length;   // 62
const BASE62 = /^[0-9A-Za-z]*$/;

export type LexoRank = Brand<string, 'LexoRank'>;

/**
 * Returns a rank strictly between `prev` and `next`.
 * A missing bound — `null`, `undefined` or omitted — means "no neighbour on that side":
 * lexoRankBetween() for the first item, lexoRankBetween(last) to append,
 * lexoRankBetween(null, first) to prepend.
 *
 * The emitted final character always has an index >= 1, so no rank ever ends in '0'.
 * That invariant is what makes padding a short `prev` with '0' safe — and why a supplied
 * bound ending in '0' is rejected: `lexoRankBetween('V', 'V0')` would have no answer.
 */
export function lexoRankBetween(prev?: string | null, next?: string | null): LexoRank {
  const lower = prev ?? null;
  const upper = next ?? null;
  // Validated up front. The walk stops at the first position with room, so a lazy check
  // inside it never sees a bad character past that point.
  if (lower !== null) assertWellFormed(lower);   // non-empty, base62, no terminal '0'
  if (upper !== null) assertWellFormed(upper);
  if (lower !== null && upper !== null && lower >= upper) {
    throw new LexoRankError(`lexoRankBetween: prev must sort before next (${lower} >= ${upper})`);
  }
  const out =
    lower !== null && upper === null ? stepAfter(lower)       // 'V' → 'W', 'z' → 'z1', carry at the cap
    : lower === null && upper !== null ? stepBefore(upper)    // 'V' → 'U', '1' → '0z', borrow at the cap
    : between(lower ?? '', upper, MAX_LEXO_RANK_LENGTH);
  if (out === null) throw new LexoRankOverflowError(/* … */);  // a distinct class: the repair signal
  return out as LexoRank;
}

/** Shortest rank above `lower` and below `upper` (null = unbounded) within `budget`, or null. */
function between(lower: string, upper: string | null, budget: number): string | null {
  if (budget === 0) return null;
  const la = lower === '' ? 0 : ALPHABET.indexOf(lower.charAt(0));
  const hb = upper === null ? RADIX : ALPHABET.indexOf(upper.charAt(0));
  const restA = lower.slice(1);
  const restB = upper === null ? null : upper.slice(1);
  if (hb - la > 1) return ALPHABET.charAt(la + ((hb - la) >> 1));
  if (hb === la) {                                             // equal: copy, both bounds still bind
    const tail = between(restA, restB, budget - 1);
    return tail === null ? null : ALPHABET.charAt(la) + tail;
  }
  const descend = between(restA, null, budget - 1);            // adjacent: copy prev's, descend
  if (descend !== null) return ALPHABET.charAt(la) + descend;
  return restB === null || restB === '' ? null : ALPHABET.charAt(hb);   // or next's alone
}

export const FIRST_RANK = lexoRankBetween();   // 'V'
```

Two error classes, because the caller's branch must not depend on parsing a message:
`LexoRankError` is a programming error (bounds not strictly ordered, a malformed rank) and is
never a rank; `LexoRankOverflowError` means no rank of at most `MAX_LEXO_RANK_LENGTH`
(64, in `constants.ts`) characters fits between the bounds and is the signal for the
repository to run the bounded list repair, re-read the neighbours and retry. The module itself
never repairs.

Properties, asserted as tests:

| Property | Assertion |
| --- | --- |
| Betweenness | `prev < result < next` for every valid pair, and no result ends in `0` |
| Idempotent ordering | Inserting between the same pair repeatedly always yields a strictly-between value |
| Bounded growth, open ends | At least 500 sequential appends and 500 sequential prepends stay under 64 chars (measured: 9 chars at 500; the cap is reached at 3,874) |
| Bounded growth, one gap | 200 sequential inserts into the same bounded gap stay under 64 chars (measured: 42) |
| Ends | `lexoRankBetween(null, null)` is stable; append and prepend both work and roll over at `z` / `1` |
| Order-preserving | A shuffled sequence of inserts, sorted by rank, matches the intended order |
| Typed overflow | Pathological repeated insertion into one bounded gap throws `LexoRankOverflowError`, not `LexoRankError` |
| Complete | A 64-character bound with prefix room still yields a short rank (`A` + `z` × 63 → `B`); overflow only when nothing of at most 64 characters exists |

Operational notes:

- **Growth has two regimes, and they are not the same number.** An open end costs about one
  character per 61 inserts, so a list built by appending (the common case) is 9 characters
  at 500 items and cannot reach the cap inside the 500-item limit. A bounded gap is bisected
  and costs about one character per 6 inserts, so repeatedly inserting into *one* gap — for
  example, always dropping a new item directly after the same neighbour — reaches the
  64-character cap after roughly 315 inserts. That is inside the 500-item cap: repair is
  exceptional, but it is not mathematically unreachable, which is why the overflow is a
  typed error and the repair protocol is a runtime recovery path rather than a
  maintenance-script-only contract. A list item's `sk` is `ITEM#<rank>#<itemId>` and
  DynamoDB's sort-key limit is 1,024 bytes, so the cap is about the repair protocol, not
  storage.
- Rank allocation is server-owned. The client sends `afterItemId`, never a rank. It may move
  the row optimistically in its local array while awaiting the authoritative response.
- Single create and reorder read the neighbours plus `List.rankVersion`, then conditionally
  advance that version in the same transaction as the ranked-row/locator mutation. Bulk
  allocates its ordered sequence under one version advance. A conflict re-reads neighbours
  and retries, so concurrent callers do not publish the same rank from a stale gap.
- Reordering changes **one logical ListItem**: conditionally delete its old ranked row at the
  storage-only `itemRevision` read, put the freshly read row at its new rank with the next
  revision, conditionally move the locator from the same rank/revision, and advance META
  `rankVersion`. Field PATCHes update only supplied fields while conditionally advancing the
  same row/locator revision. A race retries against current truth, so a stale reorder image
  cannot replace a concurrent edit. No client `If-Match` is exposed and no other ListItem is
  rewritten during a normal drag.
- All readers sort by `(rank, itemId)`, not rank alone. This is defensive for Undo-restored,
  legacy or seeded duplicate ranks within one committed generation; it is not the allocation
  strategy. If equal-rank neighbours prevent a valid between-rank calculation, run the
  bounded list repair, re-read, and retry rather than calling `lexoRankBetween(a, a)`.
- `rankRepairId` and `behaviourMigrationId` are read gates, not sort hints. Every list-item
  page strongly reads META, rejects either marker, runs its item Query with
  `ConsistentRead: true`, then strongly rereads META before serialisation. Both reads must have
  the same `rankVersion` and no marker; otherwise the service drains bounded work when
  applicable and returns `503 internal` with `Retry-After: 1` and no item rows. Cursors bind
  that fenced version; final repair/migration transactions clear their marker and advance the version, so
  an old cursor restarts at page one. A reader never exposes a page containing mixed rank or
  behaviour generations, including when an operation begins between the first META read and
  the Query.

---

## 10. Comments

> **Comment why, not what.** The code says what it does. A comment exists to record a
> decision, a constraint, or a surprise that the next reader — human or agent — would
> otherwise have to rediscover.

| Write a comment when | Example |
| --- | --- |
| A non-obvious decision was made | `// Sorted by personId so the server and an optimistic client agree without coordination.` |
| An external constraint drives the code | `// DynamoDB transactions cap at 100 items; participants are capped at 50 so fan-out fits.` |
| Something looks wrong but is right | `// Math.trunc, not Math.floor: negative totals (refunds) must round toward zero.` |
| A workaround exists | `// Metro cannot resolve this subpath export on SDK 54; import the file directly.` |
| A rule from a doc is being enforced | `// data-model.md §4.5: completing an occurrence must never mutate the series.` |

| Do not write a comment when | |
| --- | --- |
| It restates the code | `// increment the counter` |
| It is a section banner in a 40-line file | |
| It is commented-out code | Delete it; git remembers |
| It is a TODO without an owner and a task ID | `// TODO(P6-11): …` or nothing |

Every non-obvious decision gets **one line**. A paragraph of prose in a source file usually
belongs in a doc, with the source carrying a one-line pointer to it.

JSDoc is used on exported functions in `packages/shared` — they are the cross-package API and
the doc string is what an agent sees on hover. Elsewhere, a good name beats a doc block.

---

## 11. Code smells that get a PR rejected

Each of these is an automatic rejection, not a discussion. Most map to a rule above or to a
canonical doc.

1. A `Plan`, `Meal`, `Watch`, or `Task` table, entity, or repository
   (`data-model.md` §1).
2. `Scan` in application code (`data-model.md` §5).
3. A `pk`/`sk` template literal outside `repositories/keys.ts`.
4. A DynamoDB call outside `repositories/`.
5. A float, `toFixed`, `parseFloat`, or a division in the money path (§3.2).
6. `new Date()` or `Date.now()` inside pure logic (§4.3).
7. `any`, `as any`, or `@ts-ignore`.
8. A schema, type, or constant defined twice — once in `shared`, once in a consumer
   (`tech-stack.md` §5.1).
9. Business logic in a route handler, or a Hono/HTTP type inside a service.
10. Materialising future occurrences of a recurring series (`data-model.md` §4.2).
11. Mutating a series' `Recurrence` when snoozing, skipping, or completing an occurrence
    (`data-model.md` §4.5).
12. Duplicating a `ListItem` when scheduling it instead of linking it
    (`data-model.md` §4.6).
13. A second GSI, or a new access pattern, without a row added to `data-model.md` §5 in the
    same PR.
14. Raw exception text in a user-facing `message` (§2.3).
15. `pk`, `sk`, or `entity` in a response body or a log line (§5.2, §7.3).
16. A floating promise (§6.1).
17. A hard-coded colour, spacing value, radius, or font size in a component
    (`design-system.md` §9).
18. `useQuery` or `fetch` outside the layers allowed to have it (§8.2).
19. A `useEffect` that fetches data — that is what TanStack Query is for.
20. Server data copied into a Zustand store (`tech-stack.md` §2.2).
21. A new dependency without the justification block in the PR description
    (`security-privacy.md` §7).
22. A commented-out block, a `console.log`, or a TODO without a task ID.
23. A test that asserts nothing, or is skipped without a linked issue.
24. An interactive element without `accessibilityRole` and `accessibilityLabel`.
25. Toggling a list item's `checked` — `SET checked = NOT checked` — instead of setting it.
    Lists are shared and edited offline, so a toggle is not idempotent and flips the item
    back when two members tick it (`data-model.md` §4.6, `plans-and-lists.md` §5.11.5).
