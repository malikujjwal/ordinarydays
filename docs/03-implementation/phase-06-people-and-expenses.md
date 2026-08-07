# Phase 6 — People and expenses

## Goal

At the end of this phase the app can answer the question the money feature exists for: *we
did something together — who owes whom?* A shared plan carries expenses with equal, exact and
shares splits whose arithmetic reconciles to the cent every time, in integer minor units,
with no float anywhere in the path. The plan shows a per-person owes summary and a suggested
settle-up that drills through to the expenses behind it. A People layer appears — derived
only from shared plans, never from a contact import or a friend graph — with a People page, a
Person view, and pairwise net balances that are always tappable through to the individual
expenses that produced them. Settling is recorded against specific expenses, never as a bare
number. DynamoDB Streams are enabled and a worker keeps the `Balance` cache fresh, with a
dead-letter queue, a divergence alarm, and the ability to rebuild any balance from source
rows at any time. A guest with no account participates in all of it, keyed only by
`personId`.

## Prerequisites

| # | Requirement | Source |
| --- | --- | --- |
| 1 | Phase 5 complete: participants, guests, invites, the updates feed, guest linking | Phase 5 |
| 2 | `PLINK#<personId>#<sortTs>#<activityId>` rows are written and maintained on every participant and reschedule write | Phase 5 P5-27 |
| 3 | `Expense`, `Balance`, `Settlement` types exist in `packages/shared/src/types/` | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4.8 |
| 4 | The notification catalogue, inbox and quiet-hours machinery work | Phase 4, Phase 5 |
| 5 | The maintenance job (`SchedulerStack`'s daily rule) exists and runs | Phase 4 |
| 6 | `@vitest/coverage-v8` per-directory thresholds are configurable in the Vitest config | [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §2.5 |

The `Balance` sort key this phase needs is already recorded as `BAL#<personId>#<currency>`
in [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §3.2, matching
[`../01-product/expenses.md`](../01-product/expenses.md) §5.1's one row per
`(personId, currency)`; the three-segment key satisfies both access pattern 11
(`sk begins_with BAL#`) and a per-person read (`sk begins_with BAL#<personId>#`).

One canonical-document amendment is still required and must land with the code that needs it:

- **`Expense.settledPersonIds: string[]`** is added to
  [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4.8, holding the
  non-payer `personId`s that a settlement has covered. Without it, "is this expense settled
  with respect to this pair" requires reading every settlement on every balance read. It is
  additive and defaults to `[]` on read.

## Deliverables

- [ ] `packages/shared/src/money/` complete: currency minor units, parsing, formatting, the
      three split modes, the remainder rule, pairwise balance computation, and the
      settle-up suggestion — all pure, all integer, at 100% statement and branch coverage.
- [ ] A property-based test suite that makes success criterion S7 (money reconciles exactly)
      a gate rather than a claim.
- [ ] Expenses on a shared plan: add, edit, delete, with server-side split validation and
      authorship rules.
- [ ] `GET /v1/activities/:id/expenses` returning the lines plus the three-layer `owes`
      summary and the suggested settle-up.
- [ ] DynamoDB Streams enabled, a filtered event source mapping, and the balance
      recalculation worker with a DLQ, alarms and a replay script.
- [ ] `GET /v1/balances` and `GET /v1/people/:id/balance?include=expenses`, the latter
      returning the computed figure, the cached figure, a divergence flag, and every
      contributing expense line.
- [ ] `POST /v1/balances/recalculate` — a full rebuild from source rows.
- [ ] Settlements: expense-scoped, computed amounts, partial settlement, history, and undo.
- [ ] The People page, the Person view, `POST /v1/people`, `PATCH`, `DELETE` with `409`,
      and `POST /v1/people/:id/merge`.
- [ ] FREQUENT and RECENT ranking in `GET /v1/people/suggested`.
- [ ] A `<Balance>` component that cannot be rendered without a drill-down, enforced by a
      lint rule.
- [ ] Guests with expenses fully supported, and a linked guest's balances materialised on
      their side.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P6-01 | Currency table and minor units | shared | — | yes | S |
| P6-02 | Money parsing and formatting | shared | P6-01 | no | M |
| P6-03 | Split arithmetic: equal, exact, shares, and the remainder rule | shared | P6-01 | no | M |
| P6-04 | Pairwise balance computation | shared | P6-03 | no | M |
| P6-05 | Settle-up suggestion | shared | P6-04 | no | M |
| P6-06 | Property-based test suite and the coverage gate | shared | P6-02..05 | no | L |
| P6-07 | Expense schemas and validation | shared | P6-03 | no | M |
| P6-08 | Expense repository and write paths | api | P6-07 | no | L |
| P6-09 | `GET /v1/activities/:id/expenses` with the owes summary | api | P6-08, P6-05 | no | M |
| P6-10 | Enable Streams and the filtered event source mapping | infra | — | yes | M |
| P6-11 | The balance recalculation worker | api | P6-10, P6-04 | no | L |
| P6-12 | DLQ, alarms, iterator age, and the replay script | infra | P6-11 | no | M |
| P6-13 | Balance repository and the `BAL#` key change | api | P6-04 | no | M |
| P6-14 | `GET /v1/balances` and `GET /v1/people/:id/balance?include=expenses` | api | P6-13 | no | M |
| P6-15 | `POST /v1/balances/recalculate` — full rebuild | api | P6-13 | no | M |
| P6-16 | Settlements: create, list, undo | api | P6-08, P6-13 | no | L |
| P6-17 | Per-pair settled state and the `Expense.settled` rollup | api | P6-16, P6-11 | no | M |
| P6-18 | People: create, read, update, delete with `409` | api | — | yes | M |
| P6-19 | `GET /v1/people/:id` — the Person view payload | api | P6-18, P6-14 | no | M |
| P6-20 | FREQUENT and RECENT ranking | api | P6-18 | no | M |
| P6-21 | `POST /v1/people/:id/merge` | api | P6-18 | no | L |
| P6-22 | `PLINK#` and counter maintenance, plus the daily reconciliation job | api | P6-18 | no | M |
| P6-23 | Expense and settlement notifications | api | P6-08, P6-16 | no | M |
| P6-24 | The add-expense sheet | mobile | P6-07, P6-03 | no | L |
| P6-25 | Plan detail: EXPENSES section and the owes summary | mobile | P6-09 | no | M |
| P6-26 | The `<Balance>` component and its lint rule | ui/ci | P6-02 | yes | M |
| P6-27 | The balance drill-down screen | mobile | P6-14, P6-26 | no | M |
| P6-28 | The settle-up sheet, partial settlement, and history | mobile | P6-16 | no | L |
| P6-29 | People page and Person view | mobile | P6-19 | no | L |
| P6-30 | Guests with expenses, and materialising a linked guest's balances | api | P6-11, P6-13 | no | M |
| P6-31 | Multi-currency rendering rules | mobile | P6-02 | no | S |
| P6-32 | The worked-example integration fixture | ci | P6-09, P6-14, P6-16 | no | M |

---

### P6-01 — Currency table and minor units

**What to build.** The one place the app knows how many decimal places a currency has.

**Files.** `packages/shared/src/money/currency.ts`, `.../__tests__/currency.test.ts`.

**Approach.** A frozen record of ISO 4217 code → `{ minorUnits: 0 | 2 | 3, symbol?: string }`.
Ship the full ISO 4217 active list rather than a shortlist — it is a few kilobytes of static
data and a missing currency is a hard failure at the worst moment.

```ts
export const CURRENCIES = Object.freeze({
  USD: { minorUnits: 2 }, EUR: { minorUnits: 2 }, GBP: { minorUnits: 2 },
  JPY: { minorUnits: 0 }, KRW: { minorUnits: 0 }, VND: { minorUnits: 0 },
  CLP: { minorUnits: 0 }, ISK: { minorUnits: 0 },
  BHD: { minorUnits: 3 }, JOD: { minorUnits: 3 }, KWD: { minorUnits: 3 },
  OMR: { minorUnits: 3 }, TND: { minorUnits: 3 },
  // … the remainder of the active ISO 4217 list
} as const);

export const minorUnits = (code: string): number => {
  const c = CURRENCIES[code as keyof typeof CURRENCIES];
  if (!c) throw new ValidationError('currency', 'Unknown currency.');
  return c.minorUnits;
};
```

Nothing in the codebase ever assumes two decimal places. Not the parser, not the formatter,
not a test fixture, not a placeholder string.

**Edge cases.** A three-decimal currency means `amountCents` holds thousandths — the field
name is historical and the doc comment says so. A zero-decimal currency means the integer is
whole yen and the formatter emits no separator.

**Tests.** Every entry has a `minorUnits` of 0, 2 or 3. `minorUnits('XYZ')` throws
`validation_failed`. A test asserts the object is frozen.

---

### P6-02 — Money parsing and formatting

**What to build.** The only two functions permitted to convert between a display string and
an integer.

**Files.** `packages/shared/src/money/parse.ts`, `format.ts`, and their tests.

**Approach.**

```ts
// "12.34" + USD -> 1234.  "12.345" + USD -> ValidationError.  "1200" + JPY -> 1200.
export function parseAmount(input: string, currency: string): number;

// 1234 + USD + 'en-US' -> "$12.34".  1200 + JPY -> "¥1,200".
export function formatCents(cents: number, currency: string, locale?: string): string;
```

Rules, enforced by review and by a lint rule that forbids `parseFloat`, `Number.parseFloat`
and `.toFixed(` anywhere under `packages/shared/src/money/`, `services/api/src/` and
`apps/mobile/src/features/expenses/`:

- Parsing is string-based. Split on the decimal separator, validate the integer part against
  `/^\d{1,12}$/` and the fraction against `/^\d{0,N}$/` where `N = minorUnits`, then combine
  with integer arithmetic. Never `Math.round(parseFloat(s) * 100)`, which is wrong for
  `"1.005"` on every IEEE-754 implementation.
- More fraction digits than the currency allows is `validation_failed`, never a silent round.
  `"12.345"` in USD is a typo, and rounding a typo into money is how trust is lost.
- Thousands separators, leading `+`, surrounding whitespace and a leading currency symbol are
  stripped before validation. A locale that uses `,` as the decimal separator is handled by
  taking the **last** separator as decimal when both `.` and `,` are present.
- Negative input is rejected at parse time. Negative amounts do not exist in this product.
- `formatCents` uses `Intl.NumberFormat` with `style: 'currency'` and
  `minimumFractionDigits = maximumFractionDigits = minorUnits(currency)`, dividing by
  `10 ** minorUnits` **only at the final formatting step**, where the float is immediately
  consumed and never stored or compared.
- `MAX_AMOUNT_CENTS = 99_999_999_99` (about $100 million). Larger is `validation_failed`.
  This bound is what makes the multiplication in the shares split provably safe (P6-03).

**Edge cases.** `""`, `"."`, `"-0"`, `"0"`, `"0.00"` — `0` is rejected by the expense
validator, not the parser, because a zero split line is legal. `formatCents` of a
non-integer throws in dev and logs and truncates in prod.

**Tests.** A table of 60 input strings across USD, JPY and KWD. Round-trip property:
`parseAmount(formatCents(n, c), c) === n` for all `n` in `[0, MAX]` and every currency in the
table, after stripping the currency symbol and separators.

---

### P6-03 — Split arithmetic: equal, exact, shares, and the remainder rule

**What to build.** The heart of the money module. This is the function
[`../01-product/expenses.md`](../01-product/expenses.md) §3.2 specifies and the one both
client and server call.

**Files.** `packages/shared/src/money/split.ts`, `.../__tests__/split.test.ts`.

**The exact algorithms.**

```ts
type Split = { personId: string; amountCents: number; shares?: number };

// Equal
export function splitEqual(amountCents: number, personIds: string[]): Split[] {
  assertPositiveInteger(amountCents);
  const ids = [...personIds].sort(byPersonIdAscending);   // see below
  const n = ids.length;
  if (n === 0) throw new ValidationError('splits', 'Choose who this is split between.');
  const base = Math.floor(amountCents / n);
  const r = amountCents - base * n;                        // 0 <= r < n
  return ids.map((personId, i) => ({
    personId,
    amountCents: i < r ? base + 1 : base,
  }));
}

// Shares
export function splitShares(amountCents: number, entries: {personId: string; shares: number}[]): Split[] {
  assertPositiveInteger(amountCents);
  for (const e of entries) assertIntegerAtLeast(e.shares, 1);
  const ids = [...entries].sort((a, b) => byPersonIdAscending(a.personId, b.personId));
  const total = ids.reduce((s, e) => s + e.shares, 0);
  const bases = ids.map(e => Math.floor((amountCents * e.shares) / total));
  let r = amountCents - bases.reduce((s, b) => s + b, 0);  // 0 <= r < ids.length
  return ids.map((e, i) => ({
    personId: e.personId,
    shares: e.shares,
    amountCents: bases[i] + (i < r ? 1 : 0),
  }));
}

// Exact — the user's numbers are stored verbatim; the only job is validation.
export function validateExact(amountCents: number, splits: Split[]): void {
  const sum = splits.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== amountCents) throw new ValidationError('splits', difference(amountCents, sum));
}
```

Three details that are load-bearing and easy to get wrong:

> **Decision — the sort is byte-wise, never locale-aware.** `byPersonIdAscending` is
> `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`, comparing the raw strings by UTF-16 code unit.
> `String.prototype.localeCompare` is **banned** in the money module and a lint rule enforces
> it. `localeCompare` depends on the runtime's ICU data and the ambient locale, so the same
> expense would split differently on the server (Node with full ICU) and on a device (Hermes
> with a trimmed ICU), and the client's optimistic figure would visibly flip when the
> server's answer arrived. Prefixed ULIDs are ASCII, so byte-wise order is also the obvious
> order.

- **Overflow.** `amountCents * shares` is bounded by `MAX_AMOUNT_CENTS × MAX_SHARES` =
  `9.9999999e9 × 1000 ≈ 1e13`, comfortably inside `Number.MAX_SAFE_INTEGER` (≈ 9.007e15).
  `MAX_SHARES_PER_PERSON = 1000` and `MAX_TOTAL_SHARES = 10_000` are constants in
  `packages/shared/src/constants.ts`, validated before the multiplication, and a test asserts
  the product of the two maxima is safe.
- **The remainder is always strictly less than the participant count**, in both modes, because
  each `floor` discards less than one unit. A defensive assertion states this; if it ever
  fails the input violated a precondition and the correct response is to throw, not to
  distribute a remainder larger than the row count.

**Edge cases.** One participant receives the whole amount. Fifty participants and 1 cent gives
one person 1 and forty-nine people 0 — legal, and the UI shows the zeros rather than hiding
them. A participant excluded from the split appears in no `splits[]` entry and in no balance
derived from that expense. Duplicate `personId`s in the input are `validation_failed`.

**Tests.** Every worked example in
[`../01-product/expenses.md`](../01-product/expenses.md) §7 is a test case with its exact
expected output, including §7.4's `$249.99` over five shares producing
`10000 / 10000 / 4999`. Plus the property tests in P6-06.

---

### P6-04 — Pairwise balance computation

**What to build.** The pure function that turns expenses and settlements into the number a
Person view shows.

**Files.** `packages/shared/src/money/balance.ts`.

**Approach.**

```ts
export function computePairBalance(input: {
  viewerPersonId: string;
  otherPersonId: string;
  currency: string;
  expenses: Expense[];        // every expense on every shared activity, one currency
}): { netCents: number; unsettledExpenseCount: number; lines: BalanceLine[] };
```

For each expense in the given currency, exactly as
[`../01-product/expenses.md`](../01-product/expenses.md) §5.2 states:

```
if settled with respect to (viewer, other):                       contributes 0
else if paidBy == viewer and other  in splits:  net += splits[other].amountCents
else if paidBy == other  and viewer in splits:  net -= splits[viewer].amountCents
else:                                                             contributes 0
```

"Settled with respect to the pair" is `expense.settledPersonIds.includes(debtorPersonId)`,
where the debtor is whichever of the two is **not** the payer. Settlements are the audit
trail; settled-expense exclusion is the mechanism. The function does not subtract settlement
amounts again — doing both is the double-counting bug this design exists to avoid, and a test
asserts it.

`netCents > 0` means they owe the viewer. `netCents < 0` means the viewer owes them. The
direction is never rendered as a sign; the UI renders words (P6-26).

**Edge cases.** An expense where both are in `splits` but neither paid contributes zero — a
third person paid and the two of them each owe that third person, not each other. An expense
the viewer paid and is not in the splits of contributes the other's full share. Multiple
currencies are never combined; the caller passes one currency at a time.

**Tests.** The §7.5 worked example asserted to the cent from both sides. A test asserting the
sum of all pairwise nets across a plan's participants in one currency is exactly zero.

---

### P6-05 — Settle-up suggestion

**What to build.** The deterministic greedy match in
[`../01-product/expenses.md`](../01-product/expenses.md) §4.

**Approach.** Given per-person nets within one plan and one currency: repeatedly take the
largest debtor and the largest creditor, transfer `min(|debt|, credit)`, and repeat until
every net is zero. Ties broken by ascending `personId`, using the same byte-wise comparator.
Output is a list of `{ fromPersonId, toPersonId, amountCents }`.

The suggestion is always rendered **below** the per-person nets, never instead of them, and
every suggested transfer must carry the expense ids behind it so the UI can drill in.

**Edge cases.** Nets that do not sum to zero indicate a bug upstream; the function throws
rather than producing a plausible-looking wrong answer. A single creditor produces the
trivial answer. Floating point never appears, so there is no epsilon comparison anywhere.

**Tests.** Transfers ≤ `n - 1` for `n` people. Every person's transfers sum to their net.
Determinism across input orderings. A throw on non-zero-sum input.

---

### P6-06 — Property-based test suite and the coverage gate

**What to build.** The tests that make S7 a gate. `fast-check` is added as a dev dependency.

**Files.** `packages/shared/src/money/__tests__/properties.test.ts`,
`vitest.config.ts` per-directory thresholds.

**The required properties.** Each is a named test; all ten must exist.

| # | Property | Generator domain |
| --- | --- | --- |
| 1 | `sum(splitEqual(a, ids)) === a` | `a ∈ [1, MAX]`, `ids` 1–50 distinct ULIDs |
| 2 | In an equal split, `max(amount) - min(amount) ≤ 1` | as above |
| 3 | `splitEqual` is invariant under the input array's order | as above, plus a shuffle |
| 4 | `sum(splitShares(a, entries)) === a` | `a ∈ [1, MAX]`, 1–50 entries, `shares ∈ [1, 1000]`, total ≤ 10,000 |
| 5 | In a shares split, `shares_i > shares_j ⟹ amount_i ≥ amount_j` | as above |
| 6 | Every split amount is a non-negative integer | all modes |
| 7 | `parseAmount(formatCents(n, c), c) === n` | `n ∈ [0, MAX]`, `c` over every currency |
| 8 | Pairwise nets across a plan's participants sum to exactly 0 | random plans: 2–8 people, 0–30 expenses, random modes and payers |
| 9 | Settling every expense in a pair drives `netCents` to exactly 0 | as above |
| 10 | `computePairBalance` is idempotent and order-independent over its expense array | as above |

Run each with `numRuns: 2000` in CI and `200` locally. Seed failures are recorded as explicit
regression tests, not left to the generator to rediscover.

**The coverage gate.**

```ts
coverage: {
  thresholds: {
    'packages/shared/src/money/**':      { statements: 100, branches: 100, functions: 100, lines: 100 },
    'packages/shared/src/recurrence/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
}
```

`v8` coverage counts a defensive `throw` branch, so unreachable-looking guards need a test
that reaches them. That is the point: a guard nobody can trigger is either dead code to delete
or a real case to test.

**Tests.** These are the tests. Additionally, a meta-test asserts all ten property names are
present in the suite, so a future refactor cannot quietly delete one.

---

### P6-07 — Expense schemas and validation

**What to build.** The Zod schemas and the server-side validation table from
[`../01-product/expenses.md`](../01-product/expenses.md) §3.4.

**Approach.** `createExpenseInput` is `.strict()` with `description` 1–120, `amountCents` a
positive integer ≤ `MAX_AMOUNT_CENTS`, `currency` checked against the P6-01 table,
`paidByPersonId`, `splitMode`, `splits[]` and `note` 0–500. A refinement asserts
`sum(splits[].amountCents) === amountCents` in **every** mode including `equal` — the client's
arithmetic is never trusted even though it ran the identical function.

Cross-entity validation lives in the service, not the schema, because it needs the
participant list: every `personId` in `splits` and `paidByPersonId` must be a participant of
the activity, else `validation_failed`.

**Tests.** Every row of the §3.4 table produces its stated error with the stated `path`. A
`splits` array that sums correctly but contains a non-participant is rejected. Unknown keys
are rejected.

---

### P6-08 — Expense repository and write paths

**What to build.** `POST`, `PATCH` and `DELETE /v1/activities/:id/expenses[/:expenseId]`.

**Approach.** An expense is `ACT#<a>/EXP#<expenseId>`, so it is already in the partition the
plan detail reads. Each write is a transaction of two items: the `EXP#` row and an
`ADD expenseTotalCents :delta` on `ACT#/META`. Balance recalculation is **not** done here — it
is the stream worker's job (P6-11), which is what makes this write path two items regardless
of how many people are involved.

Authorship, per [`../01-product/expenses.md`](../01-product/expenses.md) §2.3: any
participant may add; the author (`expense.createdBy === callerUserId`) may edit or delete
their own; the owner may edit or delete any on their activity; a guest may do none of it; a
non-participant gets `404`.

Every write appends a system entry to the updates feed and notifies the other participants
(P6-23).

**Edge cases.** Editing an expense that has already been settled with respect to some pair
clears those `settledPersonIds` and writes a feed entry saying so — changing the number after
someone has settled must not silently leave a stale settlement. Deleting an expense that a
settlement covers removes it from that settlement's `coversExpenseIds`; a settlement left
covering nothing is deleted and the deletion is recorded. Multiple currencies on one plan are
legal and are never summed.

**Tests.** Integration tests for each actor × each verb; the counter delta on create, edit and
delete; settled-state clearing on edit; the settlement fix-up on delete; a currency mismatch
between the expense and the plan's other expenses is allowed.

---

### P6-09 — `GET /v1/activities/:id/expenses` with the owes summary

**What to build.** The three-layer response the EXPENSES section renders without navigation.

**Approach.** One `Query` over `ACT#<a>` returns the participants and the expenses together.
The handler then computes, in memory with the shared module:

```jsonc
{
  "expenses": [ /* lines, newest first */ ],
  "totals":   [ { "currency": "USD", "amountCents": 48200 } ],   // one entry per currency
  "nets":     [ { "personId": "psn_a", "currency": "USD", "netCents": 22216 } ],
  "suggested":[ { "fromPersonId": "psn_b", "toPersonId": "psn_a",
                  "currency": "USD", "amountCents": 7583,
                  "expenseIds": ["exp_hotel", "exp_dinner"] } ]
}
```

`nets` is `paid − owed` within this plan only. Totals are per currency and are never added
together. Every suggested transfer carries the expense ids behind it, so the UI's drill-down
needs no second request.

**Edge cases.** A plan with fewer than two participants and no expenses returns empty arrays,
and the client hides the section. A plan with expenses in three currencies returns three
`totals` entries and three independent `suggested` sets.

**Tests.** The §7.5 worked example asserted field by field. The sum of `nets` per currency is
exactly zero. A three-currency plan produces three independent summaries.

---

### P6-10 — Enable Streams and the filtered event source mapping

**What to build.** The plumbing, sized so the worker is invoked only for records that can
change a balance.

**Files.** `infra/lib/stacks/data-stack.ts` (enable the stream),
`infra/lib/stacks/scheduler-stack.ts` (the worker, its mapping, its DLQ),
`infra/test/stream.test.ts`.

> **Decision — the worker lives in `SchedulerStack`.** That stack already owns the
> asynchronous execution surface (the reminder Lambda, the scheduler role, the daily
> maintenance rule). Creating a new stack purely for tidiness would be free; **renaming**
> `SchedulerStack` to something more accurate would not be — a CDK stack rename destroys and
> recreates every resource in it, including the reminder schedules for every user. The name
> is slightly wrong and the resources stay put.

**Approach.**

- `DataStack`: `stream: StreamViewType.NEW_AND_OLD_IMAGES`.
- Event source mapping on `od-balance-{stage}`:

| Setting | Value | Why |
| --- | --- | --- |
| `startingPosition` | `TRIM_HORIZON` | On first deploy, process what is already there |
| `batchSize` | 100 | |
| `maxBatchingWindow` | 5 s | Batches several rapid edits into one recompute |
| `parallelizationFactor` | 1 | Ordering per partition key matters; the extra throughput does not |
| `reportBatchItemFailures` | true | Partial batch responses, so one bad record does not replay 99 good ones |
| `bisectBatchOnFunctionError` | true | Isolates a poison record in `log2(n)` retries |
| `retryAttempts` | 3 | |
| `maxRecordAge` | 1 hour | A recompute an hour late is worthless; the record goes to the DLQ instead |
| `onFailure` | `SqsDestination(dlq)` | |
| `filters` | see below | |

```jsonc
// Only expense and settlement writes can move a balance.
{ "dynamodb": { "Keys": { "sk": { "S": [ { "prefix": "EXP#" } ] } } } }
{ "dynamodb": { "Keys": { "sk": { "S": [ { "prefix": "SETTLE#" } ] } } } }
```

Filtering at the source is both a cost control and a correctness control: without it every
task completion, every list check and every RSVP invokes the worker, and the worker's first
job becomes deciding whether it should have been invoked.

**Edge cases.** The stream is enabled on an existing table, so `TRIM_HORIZON` starts from the
enable point, not from the table's history. Any expenses written before the stream existed
(there are none, because expenses are new in this phase) would need a one-off rebuild — run
`POST /v1/balances/recalculate` for every user in dev after enabling, as a rehearsal of the
recovery path.

**Tests.** CDK assertions: the stream is enabled with `NEW_AND_OLD_IMAGES`; the mapping has
`FunctionResponseTypes: ['ReportBatchItemFailures']`, a `DestinationConfig.OnFailure`, and
both filter patterns. An integration test against DynamoDB Local Streams asserting a task
write produces no invocation and an expense write produces one.

---

### P6-11 — The balance recalculation worker

**What to build.** The Lambda that keeps the `Balance` cache honest.

**Files.** `services/api/src/worker/balance.ts`, `services/api/src/worker/__tests__/`.

> **Decision — the worker recomputes from source, it never applies deltas.** A delta
> (`net += splits[x]`) requires exactly-once delivery, which DynamoDB Streams does not
> provide; a duplicated record would corrupt the balance permanently and silently. Recomputing
> the affected pair from the underlying `Expense` rows is naturally **idempotent**, so
> at-least-once delivery is sufficient, a replay is harmless, and the same code path serves
> the full-rebuild endpoint and the DLQ recovery. It costs more reads per event, and at this
> scale that is the right trade by a wide margin.

**The algorithm.**

1. **Collect.** For every record in the batch, derive the affected pairs. An `EXP#` record
   gives the `activityId` from the `pk`; the participants come from the record's new and old
   images (`paidByPersonId` and every `splits[].personId`, from **both** images so a removal
   is handled). A `SETTLE#` record gives `ownerId` and `personId` directly.
2. **Deduplicate.** Reduce the batch to a set of `(ownerUserId, personId, currency)` tuples.
   A burst of five edits to one plan becomes one recompute per affected pair.
3. **Recompute.** For each tuple: `Query USER#<owner> sk begins_with PLINK#<personId>#` to get
   the shared activity ids (access pattern 10), then one `Query pk=ACT#<a> sk begins_with EXP#`
   per activity, then `computePairBalance` from P6-04.
4. **Write.** `PutItem` on `USER#<owner>/BAL#<personId>#<currency>` with

```
ConditionExpression: attribute_not_exists(pk) OR recalcWatermark <= :watermark
```

   where `:watermark` is the maximum `ApproximateCreationDateTime` across the records that
   produced this tuple. A `ConditionalCheckFailedException` here means a newer recompute
   already landed and this one is stale — it is swallowed, counted, and is not an error.
5. **Report.** Return `{ batchItemFailures: [...] }` naming only the records whose recompute
   threw, so the rest of the batch is not replayed.

**Symmetry.** Every expense affects two sides. The worker recomputes the tuple for the
activity owner *and* for the other participant when that participant is a registered user
with a `Person` row pointing back. A guest has no user partition and therefore no `BAL#` row
of their own; their balance exists only in the owner's partition, which is exactly right
(P6-30).

**Bounds and back-pressure.** A pair with more than 200 shared activities is recomputed over
the 200 most recent and a `balance_recompute_truncated` warning is logged with the pair. This
has never happened and would represent a relationship with 200 shared plans; the guard exists
so the worker cannot time out. If it fires, the fix is a per-pair running total, not a bigger
timeout.

**Failure handling.**

| Failure | Behaviour |
| --- | --- |
| Transient DynamoDB error | Record reported in `batchItemFailures`; the mapping retries it |
| Deterministic error on one record | `bisectBatchOnFunctionError` isolates it; after 3 attempts it goes to the DLQ |
| Record older than one hour | Sent to the DLQ without further retries |
| Stale watermark | Conditional write fails, is swallowed, and increments a counter |
| Worker throws before returning | The whole batch retries; because recompute is idempotent this is safe |

**Rebuilding from scratch.** The same function, `rebuildBalancesForUser(userId)`, is called by
the worker for a single pair, by `POST /v1/balances/recalculate` for every pair, and by the
DLQ replay script. It walks `USER#<u> sk begins_with PERSON#`, recomputes each person's
balances across every currency found, writes them with a watermark of `now`, and **deletes**
any `BAL#` row it did not write — a balance that is no longer justified by any expense must
disappear, not linger at its last value.

**Tests.** Unit tests with `aws-sdk-client-mock`: a duplicated record produces the same
result as a single one; an out-of-order pair of records converges to the newer value; a batch
of 100 records touching one pair produces exactly one recompute and one write; a thrown error
on record 7 returns exactly record 7 in `batchItemFailures`. Integration tests against
DynamoDB Local: add three expenses, assert the balance; delete one, assert it changes; run the
worker twice on the same event, assert the balance is unchanged.

---

### P6-12 — DLQ, alarms, iterator age, and the replay script

**What to build.** The recovery path, and the alarms that say it is needed.

**Files.** `infra/lib/stacks/scheduler-stack.ts`,
`infra/lib/stacks/observability-stack.ts`,
`infra/scripts/replay-balance-dlq.ts`.

**Approach.** An SQS queue `od-balance-dlq-{stage}` with a 14-day retention and SSE. Alarms:

| Alarm | Condition | Meaning |
| --- | --- | --- |
| `od-{env}-balance-dlq` | `ApproximateNumberOfMessagesVisible` ≥ 1 for 1 datapoint | A recompute was abandoned. Balances may be stale. |
| `od-{env}-balance-iterator-age` | `IteratorAge` > 60,000 ms for 3 datapoints | The worker is falling behind |
| `od-{env}-balance-errors` | Lambda `Errors` ≥ 5 in 5 minutes | |
| `od-{env}-balance-divergence` | Log-metric filter on `balance_divergence` ≥ 5 in 1 hour | The cache and the computed figure disagree often enough to be a bug |

**The replay script.** A DynamoDB Streams DLQ message does **not** contain the failed items —
it contains the stream ARN, the shard id, and the failed batch's sequence-number range. There
is nothing to re-inject. So `replay-balance-dlq.ts` does the only correct thing: it reads each
message, records the failure metadata to `docs/05-operations/incidents/`, and then triggers
`rebuildBalancesForUser` for every user, because the failed records cannot be attributed to a
subset. In dev it can be scoped with `--user`; in prod it runs over every user, which at this
scale is minutes. It is idempotent, takes `--dry-run` (default true), and deletes messages only
after a successful rebuild.

**Tests.** CDK assertions for the queue, the four alarms and the SNS actions. A unit test of
the script's message parsing against a recorded DLQ payload. A rehearsal in dev, recorded in
the runbook: break the worker deliberately, watch the alarm, run the replay, assert the
balances are correct.

---

### P6-13 — Balance repository and the `BAL#` key change

**What to build.** The `Balance` read and write paths, on the corrected key.

**Approach.** `USER#<userId>` / `BAL#<personId>#<currency>`, holding `netCents`, `currency`,
`unsettledExpenseCount`, `lastRecalculatedAt` and `recalcWatermark`, as specified in
[`../02-architecture/data-model.md`](../02-architecture/data-model.md) §3.2. Access
pattern 11 (`all balances for a user`) is `sk begins_with BAL#`; a single person's balances
across currencies is `sk begins_with BAL#<personId>#`.

**Edge cases.** A zero net with zero unsettled expenses is **deleted**, not stored as zero —
otherwise the People page's balance-ordering has to filter zeros out of a growing set of dead
rows.

**Tests.** Both query shapes; the delete-on-zero rule; a tenant-isolation test asserting user
A's `BAL#` query never returns user B's rows.

---

### P6-14 — `GET /v1/balances` and `GET /v1/people/:id/balance?include=expenses`

**What to build.** The two reads behind every balance the UI renders.

**Approach.**

- `GET /v1/balances` reads the cache. It powers the People page's ordering and chips, where a
  second of staleness is invisible and correctness is restored on the next stream event.
- `GET /v1/people/:id/balance?include=expenses` **recomputes from source rows on every
  request** and returns:

```jsonc
{
  "personId": "psn_b",
  "balances": [{
    "currency": "USD",
    "computedNetCents": 4233,      // authoritative — what the client renders
    "cachedNetCents": 4233,        // what the cache says
    "divergent": false,
    "unsettledExpenseCount": 2,
    "lines": [ { "activityId": "…", "activityTitle": "Dinner at Zahav", "date": "2026-08-02",
                 "description": "Dinner", "amountCents": 9800, "currency": "USD",
                 "paidByPersonId": "psn_a", "theirShareCents": 4900,
                 "yourShareCents": 3000, "settled": false } ]
  }]
}
```

The client renders `computedNetCents` and the footer total, which therefore always reconcile
with the lines above them — the requirement in
[`../01-product/expenses.md`](../01-product/expenses.md) §5.3. When `divergent` is true the
server logs `balance_divergence` at `warn` with both figures and the delta, and repairs the
cache in the same request.

> **Decision — the drill-down never reads the cache.** A cached figure that disagrees with
> the lines beneath it is the exact failure this product forbids: an unexplained number. The
> cost is a handful of queries on a screen a user opens rarely. The cache exists to sort a
> list, not to state a fact.

**Edge cases.** A person with no shared expenses returns an empty `balances` array, and the UI
renders nothing rather than `$0.00`. A person with expenses in two currencies returns two
entries, never summed.

**Tests.** A seeded divergence (a hand-written wrong `BAL#` row) produces `divergent: true`,
a log line, and a repaired cache. The footer total equals the sum of the lines in every
fixture. Multi-currency returns separate entries.

---

### P6-15 — `POST /v1/balances/recalculate` — full rebuild

**What to build.** The user-facing and operational escape hatch.

**Approach.** Calls `rebuildBalancesForUser(callerUserId)`. Rate-limited to 3 per hour per
user. Returns the rebuilt balances and a count of rows written and deleted. Called by the
client only when the drill-down reports a divergence, and by the operator from the runbook.

**Tests.** Rate limit; a rebuild after manually corrupting three `BAL#` rows restores all
three; a rebuild deletes a `BAL#` row whose expenses were all deleted.

---

### P6-16 — Settlements: create, list, undo

**What to build.** `POST /v1/settlements`, `GET /v1/settlements?personId=`, and
`DELETE /v1/settlements/:id` (`Undo settlement`).

**Approach.** `POST` takes `{ personId, currency, coversExpenseIds, note? }`. The server
**computes** `amountCents` from the covered expenses; a client-supplied amount that disagrees
is `validation_failed`. `coversExpenseIds` must be non-empty — there is no free-form "record a
payment", because that produces exactly the unexplained number the product forbids
([`../01-product/expenses.md`](../01-product/expenses.md) §6.1).

The write is one transaction: the `SETTLE#` row plus an `ADD settledPersonIds :debtor` on each
covered `EXP#` row. At the 25-expense cap per settlement this is 26 items, inside the
transaction limit; more than 25 covered expenses is `validation_failed` with `Settle these in
two goes.`

Settlements are **never edited**. `Undo settlement` deletes the row, removes the debtor from
each covered expense's `settledPersonIds`, writes a feed entry on each affected plan, and lets
the stream recompute. It requires a confirmation and has no undo of its own.

**Edge cases.** Partial settlement is the normal case, not an error state: unchecking any
expense settles the rest. An expense is settled with respect to a pair or it is not; there is
no partially-settled expense. Settling an expense already settled for that pair is a no-op.
Two settlements racing on the same expense are safe because `ADD` on a string set is
idempotent.

**Tests.** The §7.5 partial-settlement walkthrough asserted to the cent. A client-supplied
wrong amount is rejected. An empty `coversExpenseIds` is rejected. Undo restores the exact
prior balance. 26 expense ids is rejected.

---

### P6-17 — Per-pair settled state and the `Expense.settled` rollup

**What to build.** The denormalised boolean and the `Partly settled · 1 of 3` state.

**Approach.** Per-pair truth is `settledPersonIds.includes(debtorPersonId)`.
`Expense.settled` is set to `true` by the stream worker only when every non-payer in
`splits[]` appears in `settledPersonIds`, and back to `false` when that stops being true. The
UI shows `Settled` only on the boolean and `Partly settled · n of m` otherwise; both are
drill-downs.

**Edge cases.** An expense split only with the payer (a solo record) is `settled` on creation,
because it has no debtors. Adding a participant to an existing expense's splits flips a
`settled` expense back to partly settled, which is correct and must be visible.

**Tests.** The rollup across 1, 2 and 5 debtors; the flip-back on an edit; the solo case.

---

### P6-18 — People: create, read, update, delete with `409`

**What to build.** `POST /v1/people`, `GET /v1/people?sort=relevance`, `PATCH`, `DELETE`.

**Approach.** `POST` is the one manual route into the People layer; every other route into it
is a side effect of sharing a plan. `GET` returns the flat list with the sort precedence from
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §6.3:
`upcomingCount` descending, then absolute outstanding balance descending, then
`lastActivityAt` descending, then `displayName` ascending. The alternate sorts (`Name`,
`Balance`) are client-side re-orderings of the same response.

`DELETE` returns `409 conflict` while the person participates in any non-completed activity,
with the blocking plans named in `details[]` so the UI can explain it.

Adding or changing an email that matches a registered user links immediately
(Phase 5 P5-25) and writes the `GUESTEMAIL#` row.

**Tests.** The four-level sort with a fixture that exercises every tie-break. `409` with the
blocking plan names. Email-change linking. Tenant isolation.

---

### P6-19 — `GET /v1/people/:id` — the Person view payload

**What to build.** One request that fills the whole screen.

**Approach.** Returns the person, `upcomingCount`, the next 5 upcoming shared activities
ascending, the last 5 past ones descending with outcome and settlement state, and the
**computed** balances per currency (the same computation as P6-14, not the cache). Upcoming
and recent come from `PLINK#<personId>#` (access pattern 10) in one query each, sliced
around today's sort timestamp.

**Edge cases.** A person with no shared plans returns empty lists and the UI shows
`Nothing together yet`. A deleted-account participant keeps their display name with
`linkedUserId` cleared.

**Tests.** The payload against a fixture with 12 upcoming and 30 past plans; the caps; the
balance matches `GET /v1/people/:id/balance`.

---

### P6-20 — FREQUENT and RECENT ranking

**What to build.** Fill in the `frequent` bucket Phase 5 shipped empty.

**Approach.** Per
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.2:

| Bucket | Definition | Order | Cap |
| --- | --- | --- | --- |
| FREQUENT | ≥ 3 shared activities in the last 180 days | count descending, then `lastActivityAt` descending | 8 |
| RECENT | a shared activity in the last 30 days, not already in FREQUENT | `lastActivityAt` descending | 8 |

The three constants (180 days, 3 activities, 30 days) live in one server-side module and are
tunable without a client release. Counts are computed from `PLINK#` rows, which are already
sorted by timestamp, so the query is a bounded range read per person and needs no new index.

The frequency count is **never rendered** and never leaves the picker
([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §7). It is an
ordering, not a score.

**Tests.** Boundary cases at exactly 3 activities and exactly 180 and 30 days; a person in
FREQUENT never also appears in RECENT; the caps; the response contains no count field.

---

### P6-21 — `POST /v1/people/:id/merge`

**What to build.** The fix for the same human added twice, which Phase 5's shareable links
make inevitable.

**Approach.** `{ intoPersonId }`. The surviving person keeps its `personId`. The merge moves
every reference from the source to the target: `Participant.personId` on every shared
activity, `Expense.paidByPersonId` and `splits[].personId`, `Settlement.personId` and
`settledPersonIds`, and every `PLINK#` row; then deletes the source `PERSON#` row, its
`GUESTEMAIL#` entry and its `BAL#` rows, and triggers a rebuild for the target.

It is a resumable job keyed `USER#<u>/MERGEJOB#<sourcePersonId>`, not a transaction — the
reference count is unbounded.

**Edge cases.** Merging two people who are both participants of the same activity would
produce two `PART#` rows for one `personId`; the merge collapses them, keeping the more
advanced RSVP (`going` > `maybe` > `pending` > `declined`) and the earlier `invitedAt`. If
both appear in one expense's splits, their amounts are **summed** and the split's total is
re-validated — this is the only place two split lines merge, and getting it wrong breaks
reconciliation, so it has its own test. Merging a linked user into a guest is refused;
merge into the linked one.

**Tests.** A merge across 3 activities, 5 expenses and 2 settlements leaves every balance
identical before and after. The same-activity collapse. The same-expense sum. The refusal
case. Resumption after a killed job.

---

### P6-22 — `PLINK#` and counter maintenance, plus the daily reconciliation job

**What to build.** Keep `upcomingCount`, `lastActivityAt` and the `PLINK#` sort timestamps
true, and detect it when they are not.

**Approach.** Counters are updated in the same transaction as the write that changes them:
participant add and remove, reschedule (which changes the `PLINK#` sort key and therefore
rewrites the row), completion and cancellation. The daily maintenance job recomputes
`upcomingCount` for every person from `PLINK#` rows and logs a `counter_divergence` warning
with the delta before correcting it. Divergence is a bug report, not a routine repair.

**Tests.** Each write path updates the counters; the reconciliation job corrects a
hand-corrupted counter and logs; a person whose only plan moves from future to past has their
count decremented.

---

### P6-23 — Expense and settlement notifications

**What to build.** `expense_added`, `expense_changed`, `settlement_recorded`, and the
`unsettled_monthly` catalogue entry's server side.

**Approach.** Per [`../01-product/notifications.md`](../01-product/notifications.md) §7.
`expense_added` pushes and writes an inbox entry, and its **body differs per recipient**
because it names that recipient's own share: `New York Trip · Train $142.00 · your share
$71.00`. That means the fan-out computes a per-device body, not one shared string.
`expense_changed` is inbox-only. `settlement_recorded` pushes to the other party.
`unsettled_monthly` is scheduled by the maintenance job on the 1st at the all-day hour, fires
at most once per calendar month, lists at most two balances with `and n more`, and is **off by
default**.

**Edge cases.** A recipient excluded from an expense's splits still gets the notification (it
happened on their plan) but with no share line. Guests are never emailed about expenses
([`../01-product/expenses.md`](../01-product/expenses.md) §6.6). A muted plan suppresses all
of it.

**Tests.** Per-recipient body computation; the excluded-participant case; the monthly cap; the
default-off category; no SES call on any expense path.

---

### P6-24 — The add-expense sheet

**What to build.** The form in
[`../01-product/expenses.md`](../01-product/expenses.md) §2.1.

**Approach.** Description, amount on a currency keypad, currency picker shown only once the
user has used more than one, paid-by single-select, split-between multi-select defaulting to
**all** participants including the payer and including guests, a segmented Equal / Exact /
Shares control, per-person rows, and a note. The reconciliation line is always visible:
`$120.00 split · $0.00 left to assign`. Save is disabled while it does not reconcile.

The per-person amounts are computed with the **same** `packages/shared` functions the server
runs, so the preview and the stored result are identical by construction, not by agreement.

**Edge cases.** Switching modes preserves the participant selection and recomputes. Excluding
the payer is legal. Entering an amount with too many decimals shows the parser's error inline
rather than rounding. The keypad never produces a float.

**Tests.** Component tests for each mode including the remainder display (`$15.67` /
`$15.67` / `$15.66`, never `≈`); the disabled-save condition; mode switching; a golden test
asserting the client's split equals the server's for 200 random inputs.

---

### P6-25 — Plan detail: EXPENSES section and the owes summary

**What to build.** The three layers from
[`../01-product/expenses.md`](../01-product/expenses.md) §4, all visible without navigation.

**Approach.** Total per currency; per-person nets within the plan, in words with direction;
the suggested settle-up **below** them; then the expense lines. Every layer is tappable. The
section renders only when the plan has ≥ 2 participants or ≥ 1 expense.

**Tests.** Section visibility; multi-currency rendering on separate lines; every number has an
`onPress`; the suggested block is below the nets in the accessibility reading order too.

---

### P6-26 — The `<Balance>` component and its lint rule

**What to build.** The component that makes "no unexplained numbers" structurally impossible
to violate.

**Files.** `packages/ui/src/Balance.tsx`, `biome.json` (or a small custom rule under
`scripts/lint-rules/`), `scripts/check-balance-onpress.mjs`.

**Approach.** `<Balance>` takes `netCents`, `currency`, `personDisplayName` and a **required**
`onPress`. It renders direction in words — `Alice owes you $42.50`, never `+42.50`, never a
red or green number alone — and renders nothing at all when the net is zero and there are no
unsettled expenses. Its accessibility label is
`Alice owes you 42 dollars 50. See the expenses behind this.`

Biome cannot express "this JSX prop must not be `undefined`", so the enforcement is two
layers: `onPress` is a required non-optional prop in TypeScript (which catches omission), and
a CI script greps every `<Balance` usage for a literal `onPress={undefined}` or
`onPress={noop}` and fails on a hit. That closes the loophole TypeScript leaves open.

**Tests.** Rendering for positive, negative and zero nets; the zero-with-unsettled case
showing `Settled up`; the accessibility label; a fixture file containing
`onPress={undefined}` that the CI script rejects.

---

### P6-27 — The balance drill-down screen

**What to build.** The screen in
[`../01-product/expenses.md`](../01-product/expenses.md) §5.3.

**Approach.** Headline figure in words, then one block per contributing expense showing the
plan, the date, the description, the full amount, who paid, this person's share, this user's
share and the settlement state, then a footer `Total unsettled $42.50` that matches the
headline exactly. The client renders `computedNetCents`; when `divergent` is true it renders
the computed figure, shows nothing alarming to the user, and fires
`POST /v1/balances/recalculate` in the background.

**Tests.** The footer equals the headline for every fixture; the divergent path renders the
computed figure and triggers the rebuild; each line links to its plan's expense section.

---

### P6-28 — The settle-up sheet, partial settlement, and history

**What to build.** The flow in
[`../01-product/expenses.md`](../01-product/expenses.md) §6.2 and the history in §6.5.

**Approach.** The sheet lists every unsettled expense between the two people in the relevant
direction, each checked by default, with a running `Settling $42.50 of $42.50` that updates as
boxes are unchecked. `Mark as settled` posts the ids and the computed amount. History is
reached from the balance screen, each row expands to the covered expenses, and the row's
overflow offers `Undo settlement` behind a confirmation.

**Tests.** Full and partial settlement; the running total; the expense cap message at 26;
undo restores the prior balance; history pagination.

---

### P6-29 — People page and Person view

**What to build.** The two screens in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §6.3 and §6.4.

**Approach.** People lives under **Profile → People** and in search, never in the tab bar.
The list is flat, with a one-line summary and a balance chip when non-zero, and a `Sort`
control offering Relevance / Name / Balance. The Person view shows the header, the tappable
`n upcoming together`, the balance line (always tappable, hidden when zero with nothing
unsettled), UPCOMING and RECENT capped at 5 with `See all`, and
`Plan something with <name>`, which opens Add with them pre-selected.

**Tests.** Sort ordering matches the server's; the balance chip is absent at zero; every
aggregate has a drill-down; `Plan something with` pre-selects; `Delete` shows the `409`
explanation naming the blocking plans.

---

### P6-30 — Guests with expenses, and materialising a linked guest's balances

**What to build.** The guest path, end to end, and what happens when a guest becomes a user.

**How a guest works.** Everything in this phase keys on `personId`, never on `userId`, so a
guest is a first-class participant in the money model with no special cases:

| Aspect | Behaviour |
| --- | --- |
| Payer | A guest may be `paidByPersonId`. The owner records it. |
| Splits | A guest appears in `splits[]` like anyone else. |
| Balance | A `BAL#<guestPersonId>#<currency>` row exists **in the owner's partition only**. The guest has no partition, so there is no reciprocal row and none is needed. |
| Writes | A guest can write nothing — they have no authenticated session. The owner records on their behalf. |
| Visibility | **None.** The public invite page never shows an expense, a total, or a balance. There is no expense-sharing link in v1. |
| Notifications | Guests are never emailed or pushed about money. |
| Settlement | Recorded by the owner in the same sheet, on the guest's behalf. |
| Removal from the plan | Does not delete their expenses. The arithmetic still has to reconcile. |

> **Decision (restating [`../01-product/expenses.md`](../01-product/expenses.md) §6.6):**
> there is no way to show a guest their balance in v1. A link that reveals what someone owes,
> to an address that can be forwarded, needs more design than the feature is worth.

**When a guest registers.** Phase 5's linking sets `person.linkedUserId` and creates the
reciprocal `Person` (the owner) in the new user's address book. This phase adds the last step:
the link job enqueues `rebuildBalancesForUser(newUserId)`, which materialises the new user's
own `BAL#` rows from the existing `Expense` rows. Nothing is recomputed on the owner's side and
no money changes, because `personId` never changed — the same expenses are simply now visible
from both directions.

**Edge cases.** A guest who is in expenses across three owners' plans gets three reciprocal
`Person` rows and balances toward each on linking. A guest with expenses whom the owner then
deletes is blocked by the `409` rule while any non-completed plan involves them; after
completion, deletion is allowed and the expenses keep the name.

**Tests.** A full guest lifecycle integration test: invite a guest, record two expenses and a
partial settlement, assert the owner's balance; then sign the guest up with the matching
verified email and assert their side shows the mirrored balance to the cent, with the same
`personId` and no duplicated expense. Assert the public invite response for that plan contains
no expense field before and after.

---

### P6-31 — Multi-currency rendering rules

**What to build.** The rules that stop two currencies ever being added together.

**Approach.** Every surface that shows money takes a currency-grouped structure, not a single
number. Plan totals, per-person nets, balances and the settle-up suggestion all render one
line per currency. There is no base currency, no conversion, no FX rate, and no "approximate
total" anywhere. A component that receives a bare `cents` number without a currency does not
compile.

**Tests.** A three-currency plan renders three total lines and three net blocks; a snapshot
asserts no combined figure appears; a type-level test asserts the money props always carry a
currency.

---

### P6-32 — The worked-example integration fixture

**What to build.** [`../01-product/expenses.md`](../01-product/expenses.md) §7.5 as an
executable end-to-end test.

**Approach.** Seed the New York Trip with `psn_a` (owner), `psn_b` (app user) and `psn_c`
(guest); add the hotel, train and dinner expenses exactly as specified; assert the plan nets,
the suggested settle-up, both pairwise balances, and then run the $33.50 partial settlement
and assert the resulting `$42.33`. Run the whole thing through the real API against DynamoDB
Local with the stream worker invoked synchronously, so the cache and the computed figure are
both asserted.

**Tests.** This is the test. It is the phase's canary: if it passes, the money path is right
end to end.

---

## Acceptance criteria

1. All money in storage, on the wire, and in every computation is an integer in minor units.
   A repository-wide search finds no `parseFloat`, no `toFixed` arithmetic and no `* 100` in
   the money path, and a lint rule fails a PR that adds one.
2. For any amount, any participant count from 1 to 50, and any split mode,
   `sum(splits[].amountCents) === amountCents` exactly. Property test 1 and 4 in P6-06 assert
   it over 2,000 generated cases each (S7).
3. An equal split assigns `base + 1` to the first `r` participants in **ascending byte-wise**
   `personId` order and `base` to the rest, where `base = floor(a / n)` and `r = a − base × n`.
   Re-saving an unchanged expense produces an identical split.
4. A shares split uses `floor(a × shares_i / total)` and distributes the remainder one cent
   each in the same order. The `$249.99` over `2 / 2 / 1` shares case produces
   `10000 / 10000 / 4999`.
5. `localeCompare` appears nowhere in `packages/shared/src/money/`, enforced by a lint rule,
   and the split is identical on Node and on Hermes for the same inputs.
6. `packages/shared/src/money/**` and `.../recurrence/**` are at 100% statements, branches,
   functions and lines. CI fails below it.
7. All ten named properties in P6-06 exist and pass; a meta-test fails if one is removed.
8. `parseAmount("12.345", "USD")` is `validation_failed`, not `1234` or `1235`. `parseAmount`
   and `formatCents` handle 0-, 2- and 3-decimal currencies without assuming 2.
9. The server re-validates splits in every mode including `equal` and rejects a `POST` whose
   splits do not sum exactly, whose payer is not a participant, or that names a non-participant
   in `splits`.
10. A participant may add an expense and edit or delete only ones they created; the owner may
    edit or delete any on their activity; a guest may write none; a non-participant gets `404`.
11. `GET /v1/activities/:id/expenses` returns totals per currency, per-person nets that sum
    to exactly zero per currency, and a suggested settle-up of at most `n − 1` transfers, each
    carrying the expense ids behind it.
12. DynamoDB Streams are enabled with `NEW_AND_OLD_IMAGES`, and the event source mapping
    filters to `EXP#` and `SETTLE#` prefixes. A task, list or RSVP write does not invoke the
    worker.
13. The worker recomputes from source rows and never applies a delta. Delivering the same
    record twice, or a batch of 100 records for one pair, produces exactly the same balance
    and one write.
14. An out-of-order pair of records converges to the value implied by the later watermark; the
    stale write fails its condition and is counted, not logged as an error.
15. A record that fails deterministically is isolated by bisection, retried three times, and
    lands in `od-balance-dlq-{stage}`. An alarm fires on the first message.
16. `rebuildBalancesForUser` reconstructs every balance from `Expense` and `Settlement` rows
    alone, writes what is justified, and **deletes** any `BAL#` row that is not.
17. `GET /v1/people/:id/balance?include=expenses` recomputes from source on every request,
    returns `computedNetCents`, `cachedNetCents` and `divergent`, repairs the cache when they
    disagree, and logs `balance_divergence`.
18. The drill-down's footer total equals its headline figure in every fixture, and every
    contributing expense line is present with both shares and the settlement state.
19. Every balance rendered anywhere is tappable. `<Balance>` requires `onPress` at the type
    level, and a CI script rejects `onPress={undefined}`.
20. A balance is never rendered as a bare signed number or as colour alone. Direction is
    always words. A zero net with no unsettled expenses renders nothing.
21. `POST /v1/settlements` computes `amountCents` from `coversExpenseIds`, rejects an empty
    list, rejects a disagreeing client-supplied amount, and marks each covered expense settled
    with respect to that pair only.
22. Partial settlement leaves the unchecked expenses outstanding and drops the balance by
    exactly the covered amount. `Undo settlement` restores the prior balance exactly.
23. `Expense.settled` is `true` only when every non-payer in `splits[]` has a covering
    settlement, and flips back when an edit adds a debtor.
24. A guest can be a payer and a split member, accrues a balance in the owner's partition,
    sees none of it on the public page, and is never emailed about money.
25. A guest who registers finds their balances materialised on their side, to the cent,
    against the same `personId`, with no duplicated expense.
26. `DELETE /v1/people/:id` returns `409` naming the blocking plans while the person is on any
    non-completed activity.
27. `POST /v1/people/:id/merge` leaves every balance identical before and after, collapses
    duplicate participants on one activity, and sums duplicate split lines with the total
    re-validated.
28. FREQUENT uses ≥ 3 shared activities in 180 days and RECENT a shared activity in 30 days;
    the frequency count appears in no response and no screen.
29. Two currencies are never added together on any screen or in any response.
30. The §7.5 worked example passes end to end through the real API with the stream worker
    running.

## Out of scope for this phase

| Not in Phase 6 | Why |
| --- | --- |
| Payment rails: Venmo, PayPal, Stripe, bank links, open banking, card processing | The app records that something is settled. It never moves money. |
| Budgets, spending limits, category budgets | Not a finance app. |
| Spend-by-category charts, monthly reports, trends, any analytics over money | The only aggregates are per-plan totals and pairwise balances. |
| Currency conversion, FX rates, a base currency, an approximate combined total | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §10 |
| Receipt OCR or line-item extraction from an attached photo | Phase 7 reads posters, not receipts. Not planned for receipts at all. |
| Recurring or scheduled expenses | Recurrence is a property of activities, not of money. |
| Tax, tip and service-charge calculators | Enter the amount that was charged. |
| Debt simplification across people who are not both in the same plan | Balances are pairwise by design. |
| Showing a guest their balance, or any expense surface on the public invite page | [`../01-product/expenses.md`](../01-product/expenses.md) §6.6 |
| CSV or accounting export | Reasonable later; not v1. |
| A partially settled individual expense | An expense is settled with respect to a pair, or it is not. |
| Editing a settlement | Settlements are immutable; the correction is `Undo settlement`. |
| Custom CloudWatch metrics beyond a handful of EMF counters | ADR-026 |
| Signed CloudFront URLs for media (OQ-1) | Decide after seeing what people actually upload. |

## Risks and gotchas

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **A float enters the money path once and corrupts a balance quietly.** | Integers everywhere, a lint rule banning `parseFloat`/`toFixed` in the money directories, 100% coverage, and property tests that would catch a one-cent drift. |
| 2 | **`localeCompare` in the split sort** makes the server and the device disagree, and the row visibly flips after a save. | Byte-wise comparator, lint rule, and a test that runs the split against both a full-ICU and a trimmed-ICU locale setting. |
| 3 | **A delta-based stream handler corrupts a balance permanently** on a duplicated record, and nothing detects it. | Recompute from source, never deltas. Duplicate-delivery test. Divergence detection on every drill-down read. |
| 4 | **Streams handlers that write to the same table can loop.** | The worker writes only `BAL#` items, and the event source mapping's filter excludes `BAL#` prefixes, so its own writes cannot invoke it. A CDK test asserts the filter. |
| 5 | **The DLQ contains metadata, not records** — a replay script that expects item bodies will be written and then found useless during an incident. | P6-12 states this explicitly and the replay path is a rebuild, rehearsed in dev and written into the runbook. |
| 6 | **A stale `BAL#` row is shown as fact** on the Person view. | The drill-down never reads the cache; the People page does, and is repaired within one stream event. |
| 7 | **`BAL#<personId>` without a currency segment** silently overwrites one currency's balance with another's. | The key change is a prerequisite of this phase, with the data-model amendment in the same PR. |
| 8 | **Merging two people who share an expense** breaks reconciliation if the split lines are not summed. | Explicit rule, explicit test, and the split total re-validated after the merge. |
| 9 | **Deleting an expense that a settlement covers** leaves a settlement referencing nothing. | The delete path fixes up `coversExpenseIds` and removes an empty settlement, recorded in the feed. |
| 10 | **Per-recipient notification bodies** are easy to compute once and send to everyone, leaking another person's share figure. | The share line is computed per recipient; a test asserts two recipients receive different bodies. |
| 11 | **A pair with very many shared activities** makes the recompute slow enough to time out. | 200-activity bound with a warning, sized so it has never been reached; the fix if it is reached is a running total, not a longer timeout. |
| 12 | **On-demand DynamoDB plus a stream handler** is the documented recipe for a runaway bill. | Source-side filtering, reserved concurrency on the worker, the `ddb-write-spike` alarm, and the no-self-trigger rule in row 4. |
| 13 | **Enabling Streams on an existing table starts at the enable point.** Anything written earlier is invisible to the worker. | Expenses are new in this phase, so there is nothing earlier; the full rebuild is run in dev anyway as a rehearsal. |
| 14 | **People feels like a social feature and attracts social features.** | The anti-goals table in [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §7 is the review checklist; People stays out of the tab bar. |
