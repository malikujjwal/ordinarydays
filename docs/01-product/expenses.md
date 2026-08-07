# Expenses and settlement

**Status:** canonical for shared-plan money. Entities are owned by
[`../02-architecture/data-model.md#48-expense-balance-settlement`](../02-architecture/data-model.md#48-expense-balance-settlement);
endpoints by
[`../02-architecture/api-contract.md#29-expenses-and-settlement`](../02-architecture/api-contract.md#29-expenses-and-settlement).

The question the feature answers is exactly one sentence: **we did something together — who
owes whom?** Everything beyond that is out of scope (§8).

---

## 1. Where expenses live

Expenses belong to an Activity. There is no standalone expense, no expense inbox, and no
way to record spending that is not attached to something that happened.

| Rule | Detail |
| --- | --- |
| Storage | `ACT#<activityId>` / `EXP#<expenseId>` — in the plan's own partition, so the plan detail screen still loads in one `Query`. |
| Visibility of the section | The plan's EXPENSES section renders when the plan has ≥ 2 participants **or** ≥ 1 expense. A solo plan does not show it. |
| Personal expense tracking | Not a feature. An expense on a plan with one participant is legal (the owner recording what a solo trip cost) but the app offers no reporting over it. |
| Currency | `expense.currency` defaults to the user's profile currency. A different currency is allowed and stored as-is. It is **never converted**. |

---

## 2. Adding an expense

### 2.1 The form

`Add expense` in the plan's EXPENSES section opens a sheet:

| Field | Control | Required | Default |
| --- | --- | --- | --- |
| Description | Single-line text, 1–120 chars | Yes | Empty |
| Amount | Currency keypad, minor units | Yes | Empty. Must be > 0. |
| Currency | Picker, shown only when the user has ever used more than one | No | Profile currency |
| Paid by | Participant picker, single-select | Yes | The current user |
| Split between | Participant multi-select | Yes | **All** participants of the plan, including the payer, including guests |
| Split mode | Segmented: Equal / Exact / Shares | Yes | `Equal` |
| Per-person amounts | Rows, editable in Exact and Shares modes | Conditional | Computed |
| Note | Multi-line, 0–500 | No | Empty |

The sheet cannot be saved while the split does not reconcile (§3.4). The reconciliation
line is always visible: `$120.00 split · $0.00 left to assign`.

### 2.2 Split modes

| Mode | User enters | Server stores | Reconciliation |
| --- | --- | --- | --- |
| `equal` | Nothing beyond the participant selection | `splits[]` with computed `amountCents` per person | Guaranteed by the remainder rule (§3.2) |
| `exact` | A cent amount per person | `splits[]` exactly as entered | The sum must equal `amountCents`; otherwise `validation_failed` |
| `shares` | An integer share count per person (default 1) | `splits[]` with computed `amountCents` **and** the `shares` used | Guaranteed by the remainder rule applied to the share-weighted division |

The server always validates that `sum(splits[].amountCents) === amountCents`, in every
mode, including `equal`. The client's arithmetic is never trusted; the same pure function
from `packages/shared` runs on both sides.

A participant may be excluded from a split entirely by deselecting them. They then appear
in neither the `splits[]` array nor any balance derived from that expense.

### 2.3 Who can add and edit

| Actor | Add | Edit / delete own | Edit / delete others' |
| --- | --- | --- | --- |
| Owner | Yes | Yes | Yes |
| Participant (app user) | Yes | Yes | No |
| Guest | No | No | No |
| Non-participant | No — `404` | No | No |

"Own" means `expense.createdBy === callerUserId`, not `paidByPersonId`. Someone who records
"Alice paid for the train" owns that record and can correct it; Alice cannot silently
change what someone else wrote about her.

Guests appear in splits and accrue balances but have no way to write, because they have no
authenticated session. The owner records on their behalf.

Every add, edit and delete writes a system entry to the plan's updates feed
(`Ujjwal added Hotel · $340.00`) and notifies the other participants
([`notifications.md`](notifications.md#7-notification-catalogue), `expense_added`).

---

## 3. Money arithmetic

### 3.1 Cents only

**All money is stored and computed as integer minor units.** `amountCents: number`, always
an integer, never a float, never a string, never a decimal type.

Rules enforced everywhere:

- No `parseFloat`, no `toFixed` arithmetic, no `*100` on a user-entered decimal without an
  explicit rounding step in the one input-parsing function.
- Input parsing lives in `packages/shared/src/money/parse.ts`. `"12.34"` → `1234`.
  `"12.345"` → `validation_failed`, not a silent round.
- Formatting lives in `packages/shared/src/money/format.ts` and is the only place a cents
  integer becomes a display string.
- Zero-decimal currencies (JPY, KRW) have `minorUnits: 0`; the same integer field holds
  whole yen. The formatter reads the currency's minor-unit count; it never assumes 2.
- Division always produces integers plus an explicit remainder. There is no rounding mode
  to choose because there is no rounding.

This module has mandatory near-100 % test coverage (brief §12).

### 3.2 The remainder rule

An equal split of an amount that does not divide evenly produces a remainder of
`amountCents mod n` cents.

> **The rule:** compute `base = floor(amountCents / n)` and `r = amountCents - base * n`.
> Assign `base + 1` to the first `r` participants when their `personId` values are sorted
> ascending as strings, and `base` to the rest.

This is the rule stated in
[`../02-architecture/api-contract.md#29-expenses-and-settlement`](../02-architecture/api-contract.md#29-expenses-and-settlement).
Properties it gives:

- Totals reconcile exactly, always.
- The result is deterministic and reproducible on client and server from the same inputs.
- It is stable: re-saving an unchanged expense produces the identical split.
- It is not "fair" in the sense of rotating who absorbs the extra cent. It does not need to
  be — the amounts are one cent.

For `shares`, the same rule applies to the weighted division:
`base_i = floor(amountCents * shares_i / totalShares)`, then distribute the
`amountCents - sum(base_i)` remaining cents one each to participants in ascending
`personId` order.

### 3.3 The UI never hides a remainder

Per-person rows in the expense detail show the exact stored cents. If Alice owes $16.67 and
Ben owes $16.66, the screen says so. The app never displays a rounded average and never
prints "≈".

### 3.4 Validation

| Condition | Result |
| --- | --- |
| `amountCents <= 0` | `validation_failed` — `Amount must be more than zero.` |
| `splits` empty | `validation_failed` — `Choose who this is split between.` |
| `sum(splits[].amountCents) !== amountCents` | `validation_failed` with `path: 'splits'` and a message naming the difference |
| A `personId` in `splits` that is not a participant of the activity | `validation_failed` |
| `paidByPersonId` not a participant | `validation_failed` |
| `shares[i] < 1` or non-integer | `validation_failed` |
| Currency not ISO 4217 | `validation_failed` |

---

## 4. The plan-level owes summary

`GET /v1/activities/:id/expenses` returns the expense lines plus a computed `owes` summary.
The plan's EXPENSES section renders it as three layers, all visible without navigation:

```
EXPENSES                                          Add expense

  Total $482.00                                          ›     (1)

  You are owed $121.50                                   ›     (2)
  Alice owes you  $121.50
  You owe Ben     $0.00     — settled

  Hotel           $340.00    you paid · split 3 ways     ›     (3)
  Train           $142.00    Alice paid · split 2 ways   ›
```

| Layer | Contents | Drill-down |
| --- | --- | --- |
| 1 — Total | `sum(amountCents)` per currency. Multiple currencies render on separate lines, never summed. | Opens the full expense list |
| 2 — Per-person net **within this plan** | For each participant: `paid − owed` for this plan only | Each row opens the per-person breakdown filtered to this plan |
| 3 — Lines | Every expense with payer and split summary | Opens expense detail with per-person amounts |

Definition of the plan-level net for person *p*:

```
net_p = sum(amountCents of expenses where paidByPersonId == p)
      − sum(splits[p].amountCents across all expenses of this plan)
```

Positive means the plan owes them; negative means they owe the plan. The sum of all
`net_p` in a single currency is always exactly zero, which is the arithmetic check the
tests assert.

> **Decision:** the plan-level summary shows **per-person nets**, plus a `Suggested
> settle-up` block that reduces those nets to the fewest transfers using a deterministic
> greedy match (largest debtor pays largest creditor, repeat; ties broken by ascending
> `personId`). The suggestion is always rendered *below* the per-person nets, never instead
> of them, and every suggested transfer is tappable through to the expenses that produced
> it. A minimised transfer set on its own would be an unexplained number.

---

## 5. Balances

### 5.1 What a balance is

A `Balance` is a **pairwise** net between the signed-in user and one other person, across
every shared plan, in one currency.

```
netCents > 0  =>  they owe the user
netCents < 0  =>  the user owes them
```

It is deliberately pairwise. The app never nets Alice's debt against Ben's credit, because
Alice and Ben have no relationship in this app and would not accept the substitution.

Multi-currency: a `Balance` row exists per `(personId, currency)`. The Person view renders
one line per currency. They are never added together and never converted
([`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1)).

### 5.2 How it is computed

For every expense on every activity where both the user and the person participate:

```
if expense is settled with respect to (user, person):  contributes 0
else if paidBy == user   and person in splits:  += splits[person].amountCents
else if paidBy == person and user   in splits:  −= splits[user].amountCents
else:                                            contributes 0
```

Then subtract the sum of `Settlement.amountCents` already recorded in the direction of
payment. Settlements and settled expenses are two views of the same fact; the recompute
uses settled-expense exclusion as the primary mechanism and settlements as the audit trail.

`Balance` is a **cache**, refreshed asynchronously by the DynamoDB stream handler on every
expense or settlement write, and recomputable from scratch at any time. A stale cache is a
display bug, never a source of truth.

### 5.3 The mandatory drill-down

**No unexplained balance number** (concept §26,
[`overview.md`](overview.md#45-no-unexplained-numbers)).

| Requirement | Enforcement |
| --- | --- |
| Every balance rendered anywhere is tappable | The shared `<Balance>` component requires an `onPress` prop; a lint rule fails the build if it is passed `undefined`. |
| The tap target reaches the underlying expenses | `GET /v1/people/:id/balance?include=expenses` returns the net **and** every contributing expense line. |
| The breakdown lists, per expense: the plan, the date, the description, the full amount, who paid, this person's share, this user's share, and settlement state | Response schema, tested. |
| The breakdown reconciles visibly | A footer row shows `Total unsettled  $42.50` matching the headline figure exactly. If they disagree, the client shows the recomputed figure and reports the discrepancy, rather than showing the cached one. |
| Direction is stated in words | `Alice owes you $42.50`, never `+42.50` or a red/green number alone. |
| Zero is not rendered | A zero balance with no unsettled expenses shows no line at all. A zero balance with unsettled expenses in both directions shows `Settled up` with the drill-down still available. |

```
Alice · balance                                    Settle up

  Alice owes you $42.50

  Movie Night          14 Jul    $36.00   you paid
    Alice's share                $18.00   unsettled
  Dinner at Zahav       2 Aug    $98.00   you paid
    Alice's share                $49.00   unsettled
  Train to NYC         14 Aug   $142.00   Alice paid
    Your share                   $24.50   unsettled

  Total unsettled                $42.50
```

---

## 6. Settlement

The app records that a debt was settled. It does not move money (§8).

### 6.1 Semantics

A `Settlement` is an immutable record: `personId`, `amountCents`, `currency`, optional
note, `settledAt`, and `coversExpenseIds[]`. The last field is required and non-empty.

> **Decision — settlements are expense-scoped, and the amount is computed, not typed.**
> The user selects which expenses a payment covers; the app computes the total. There is no
> free-form "record a payment of $50" with nothing behind it, because that produces exactly
> the unexplained number the product forbids. A user who was handed a round number selects
> the expenses it actually covers and leaves the remainder outstanding.

### 6.2 The flow

1. Person view → `Settle up`, or a plan's per-person net row → `Settle up`.
2. A sheet lists every unsettled expense between the two people, in the relevant direction,
   each with a checkbox, all checked by default.
3. The running total updates as boxes are unchecked: `Settling $42.50 of $42.50`.
4. `Mark as settled` issues `POST /v1/settlements` with `coversExpenseIds` and the computed
   `amountCents`.
5. The server marks each covered expense settled **with respect to that pair**, writes the
   `Settlement`, and triggers a balance recompute.

### 6.3 Partial settlement

Unchecking any expense in step 2 is a partial settlement. It is a first-class case, not an
error state.

- The covered expenses become settled; the rest stay outstanding.
- The balance drops by exactly the covered amount.
- Multiple partial settlements accumulate; the history shows each.
- There is no concept of a partially settled *expense*. An individual expense is settled
  with respect to a pair, or it is not. To split one expense across two payments, the user
  settles it in whichever payment they choose; a $0.01-level reconciliation is not a
  problem this product solves.

### 6.4 Settled state on a multi-person expense

`Expense.settled` is a denormalised boolean over **all** debtors:

- The per-pair truth is derived: expense *E* is settled with respect to `(user, person)`
  when some `Settlement` for that person lists `E` in `coversExpenseIds`.
- `Expense.settled` is set to `true` by the stream handler only when every non-payer in
  `splits[]` has such a settlement.
- The UI shows `Settled` on an expense line only when `Expense.settled` is true, and
  `Partly settled · 1 of 3` otherwise. Both are drill-downs.

### 6.5 Settlement history

`GET /v1/settlements?personId=` (access pattern 12 in
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
Reached from Person view → balance → `History`.

```
Settlement history · Alice

  2 Aug   Alice paid you $54.00        3 expenses   ›
  6 Jul   You paid Alice $19.25        1 expense    ›
```

Each row expands to the covered expenses. Settlements are **never edited**. A mistake is
corrected with `Undo settlement`, available from the row's overflow, which deletes the
`Settlement`, un-settles exactly the expenses it covered, and recomputes. The deletion is
itself recorded in the plan's updates feed for any affected plan.

### 6.6 Guests with expenses but no account

A guest can be a payer and can be in splits. Everything above works with `personId` alone;
no `userId` is required at any point.

| Aspect | Behaviour |
| --- | --- |
| Recording | The owner records what the guest paid and owes. |
| Visibility to the guest | **None.** The public invite page never shows expenses ([`sharing-and-people.md`](sharing-and-people.md#43-fields-the-public-projection-must-never-expose)). There is no expense-sharing link in v1. |
| Notifications | Guests are never emailed about expenses. |
| Settlement | Recorded by the owner, in the same sheet, on the guest's behalf. |
| If the guest registers later | `person.linkedUserId` is set and every existing expense and balance becomes visible to them from their side, in their own Person view of the owner ([`sharing-and-people.md`](sharing-and-people.md#5-guest--registered-user-linking)). Nothing is duplicated because the `personId` never changed. |

> **Decision:** there is no way to show a guest their balance in v1. Sending someone a link
> that reveals what they owe, to an address that could be forwarded, is a privacy exposure
> that needs more design than the feature is worth right now.

---

## 7. Worked numeric examples

All amounts in USD cents. Participant `personId` values are shown as `psn_a`, `psn_b`,
`psn_c`; ascending string order is `psn_a < psn_b < psn_c`.

### 7.1 Equal split, divides evenly

Dinner, $90.00, paid by the user (`psn_a`), split equally between `psn_a`, `psn_b`,
`psn_c`.

| Step | Value |
| --- | --- |
| `amountCents` | `9000` |
| `n` | `3` |
| `base` | `floor(9000 / 3) = 3000` |
| `r` | `9000 − 3000×3 = 0` |
| `splits` | `psn_a 3000`, `psn_b 3000`, `psn_c 3000` |
| Check | `3000 + 3000 + 3000 = 9000` ✓ |

Balances after: `psn_b` owes the user `$30.00`; `psn_c` owes the user `$30.00`. The user's
own share creates no balance.

### 7.2 Equal split with a remainder

Taxi, $47.00, paid by `psn_b`, split equally three ways.

| Step | Value |
| --- | --- |
| `amountCents` | `4700` |
| `n` | `3` |
| `base` | `floor(4700 / 3) = 1566` |
| `r` | `4700 − 1566×3 = 2` |
| First `r` participants by ascending `personId` | `psn_a`, `psn_b` |
| `splits` | `psn_a 1567`, `psn_b 1567`, `psn_c 1566` |
| Check | `1567 + 1567 + 1566 = 4700` ✓ |

Rendered:

```
Taxi                  $47.00    Ben paid · split 3 ways
  You                            $15.67
  Ben                            $15.67
  Chloe                          $15.66
```

The user owes Ben `$15.67`. Chloe owes Ben `$15.66`. Nothing is rounded and nothing is
described as "about".

### 7.3 Exact split

Groceries for a shared house weekend, $120.40, paid by the user, but Chloe only ate two
meals.

| Person | Entered | Stored |
| --- | --- | --- |
| `psn_a` (user) | `$50.20` | `5020` |
| `psn_b` | `$50.20` | `5020` |
| `psn_c` | `$20.00` | `2000` |
| Sum | `$120.40` | `12040` ✓ |

If the user had entered `$50.00` for `psn_b`, the sheet would show
`$0.20 left to assign` and `Save` would stay disabled; a `POST` forced past the client
would return `validation_failed` on `splits`.

### 7.4 Shares split with a remainder

Hotel room, $250.00, paid by the user. The user and `psn_b` share a double (2 shares each);
`psn_c` has the sofa (1 share). Total 5 shares.

| Step | Value |
| --- | --- |
| `amountCents` | `25000`, `totalShares` `5` |
| `base_a` | `floor(25000 × 2 / 5) = 10000` |
| `base_b` | `floor(25000 × 2 / 5) = 10000` |
| `base_c` | `floor(25000 × 1 / 5) = 5000` |
| Sum of bases | `25000` |
| Remainder | `0` |
| `splits` | `psn_a 10000 (2 shares)`, `psn_b 10000 (2)`, `psn_c 5000 (1)` |

Now the same room at $249.99 — the case that produces a remainder:

| Step | Value |
| --- | --- |
| `amountCents` | `24999`, `totalShares` `5` |
| `base_a` | `floor(24999 × 2 / 5) = floor(9999.6) = 9999` |
| `base_b` | `9999` |
| `base_c` | `floor(24999 × 1 / 5) = floor(4999.8) = 4999` |
| Sum of bases | `24997` |
| Remainder | `24999 − 24997 = 2` |
| Distribution | One cent each to `psn_a`, `psn_b` (first two by ascending `personId`) |
| `splits` | `psn_a 10000`, `psn_b 10000`, `psn_c 4999` |
| Check | `10000 + 10000 + 4999 = 24999` ✓ |

### 7.5 A whole plan, end to end

**New York Trip**, participants `psn_a` (the user, owner), `psn_b` (Alice), `psn_c` (Ben,
a guest with no account).

| Expense | Amount | Paid by | Split | Result |
| --- | --- | --- | --- | --- |
| Hotel | `$340.00` | `psn_a` | equal, 3 ways | `34000 / 3` → base `11333`, r `1` → `psn_a 11334`, `psn_b 11333`, `psn_c 11333` |
| Train | `$142.00` | `psn_b` | equal, `psn_a` + `psn_b` | `14200 / 2` = `7100` each, r `0` |
| Dinner | `$96.50` | `psn_a` | exact: `psn_a 3000`, `psn_b 3350`, `psn_c 3300` | sums to `9650` ✓ |

Plan-level nets (paid − owed):

| Person | Paid | Owed | Net |
| --- | --- | --- | --- |
| `psn_a` | `34000 + 9650 = 43650` | `11334 + 7100 + 3000 = 21434` | `+22216` (`$222.16`) |
| `psn_b` | `14200` | `11333 + 7100 + 3350 = 21783` | `−7583` (`−$75.83`) |
| `psn_c` | `0` | `11333 + 3300 = 14633` | `−14633` (`−$146.33`) |
| **Sum** | `57850` | `57850` | `0` ✓ |

Rendered on the plan:

```
Total $578.50

You are owed $222.16
  Alice owes you   $75.83
  Ben owes you    $146.33

Suggested settle-up
  Alice pays you   $75.83
  Ben pays you    $146.33
```

Here the suggestion is trivial because there is one creditor. With two creditors the greedy
match runs, and each suggested line still drills through to the expenses behind it.

Person-level balances after the trip, before any settlement:

- `Alice owes you $75.83` — pairwise: she owes `$113.33` on the hotel and `$33.50` on
  dinner, and the user owes her `$71.00` on the train. `11333 + 3350 − 7100 = 7583`. ✓
- `Ben owes you $146.33`.

**Partial settlement.** Alice hands over $40 in cash. There is no expense worth exactly
$40, so the user opens `Settle up` with Alice, unchecks Dinner, and settles Hotel only —
but the pairwise hotel amount is $113.33, more than she paid. The correct action is to
settle **Dinner** (`$33.50`) alone:

```
POST /v1/settlements
{ personId: 'psn_b', amountCents: 3350, currency: 'USD',
  coversExpenseIds: ['exp_dinner'], note: 'cash' }
```

New balance: `7583 − 3350 = 4233` → `Alice owes you $42.33`. The remaining $6.50 of her
cash is not recorded anywhere, because the app tracks settled expenses, not a running cash
ledger. This is the deliberate limit described in §6.1 and §8.

---

## 8. Out of scope

Not built, not planned, and to be rejected in review.

| Not this | Note |
| --- | --- |
| Payment rails — Venmo, PayPal, Stripe, bank links, card processing, open banking | The app records that something is settled. It never moves money and never holds funds. |
| Budgets, spending limits, category budgets | Not a finance app. |
| Financial analytics, spend-by-category charts, monthly reports, trends | The only aggregates are per-plan totals and per-person balances. |
| Multi-currency conversion, FX rates, a base currency | Expenses keep their own currency and are shown separately. See [`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1). |
| Receipt scanning and OCR line-item extraction | Attachments on a plan can include a receipt photo. Nothing is read out of it. |
| Recurring or scheduled expenses | Recurrence is a property of activities, not of money. |
| Tax, tip, or service-charge calculators | Enter the amount that was actually charged. |
| Debt simplification across people who are not both in the same plan | Balances are pairwise (§5.1). |
| Interest, reminders escalating in tone, or any nagging beyond the single opt-in unsettled reminder in [`notifications.md`](notifications.md#7-notification-catalogue) | Money between friends is not a collections problem. |
| Exporting to accounting software | A CSV export of a plan's expenses is a reasonable later addition; it is not in v1. |
