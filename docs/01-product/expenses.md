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
| Currency | A small always-tappable affix on the amount field that opens the picker — collapsed, never hidden | No | Profile currency |
| Paid by | Participant picker, single-select | Yes | The current user |
| Split between | Participant multi-select | Yes | **All** participants of the plan, including the payer, including guests |
| Split mode | Segmented: Equal / Exact / Shares | Yes | `Equal` |
| Per-person amounts | Rows, editable in Exact and Shares modes | Conditional | Computed |
| Note | Multi-line, 0–500 | No | Empty |

The sheet cannot be saved while the split does not reconcile (§3.4). The reconciliation
line is always visible: `$120.00 split · $0.00 left to assign`.

The currency affix is collapsed rather than hidden so the *first* foreign-currency expense
can be entered at all — a picker that only appears once two currencies exist can never be
reached the first time.

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
([`notifications.md`](notifications.md#7-notification-catalogue), `expense_added`). An
edit's entry keeps the before and after — `Ujjwal edited Train: $120.00 → $138.00` — and
the notification body may carry the same old → new amounts, so a changed figure is never a
silent rewrite (decision 2026-08-07).

An Expense with any settled pairwise obligation cannot be edited or deleted. The attempted
action returns `settlement_conflict` and the UI says `Undo settlement before changing this
expense`, linking to the exact Settlement rows. This keeps settlement history immutable and
prevents an expense edit from silently reopening somebody's balance. After the user
explicitly undoes those settlements, ordinary edit and delete rules apply.

Deleting the whole plan gets the same honesty: the delete-plan confirmation names how many
expenses it carries, the totals per currency, and any unsettled amounts
([`interaction-contract.md`](interaction-contract.md)).

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

A refund is not a negative expense — `amountCents <= 0` stays banned. The blessed pattern
is a mirrored expense: enter `Refund — house` with the payer and split reversed from the
original, so the correction is its own auditable line and every balance moves by ordinary
arithmetic.

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

> **Decision — the suggested settle-up is pairwise, not minimised.** Amended 2026-08-07;
> supersedes the greedy largest-debtor-pays-largest-creditor match. The plan-level summary
> shows **per-person nets**, plus a `Suggested settle-up` block whose transfers are exactly
> the pairwise nets between participants within this plan: one line per debtor → creditor
> pair with a nonzero net, ordered by ascending debtor `personId` then ascending creditor
> `personId` so rendering is stable and reproducible. Transfers are never rerouted or
> multilaterally minimised — a minimised set tells Ben to pay Alice money he never owed
> her, which is exactly the substitution §5.1 forbids everywhere, and it produces
> suggestions that `Mark settled` cannot record, because settlement is pairwise. Every
> suggested line is a real pairwise obligation, recordable as-is. The suggestion is always
> rendered *below* the per-person nets, never instead of them, and every suggested transfer
> is tappable through to the expenses that produced it.

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

> **Decision — sharing money creates the People substrate.** Confirmed 2026-08-07. §5.2's
> "every expense where both participate" includes pairs who never shared anything with each
> other directly: participant Sam pays $90 of groceries split three ways including guest
> Priya, and Priya owes Sam $30 despite there being no share-er/share-ee relationship between
> them. So when an expense is created or edited such that its payer and split set contains a
> pair of participants who do not yet have each other as People, the server creates the
> missing `Person` rows in the same transaction — the same `personId` mirrored into each
> affected app user's partition, display name copied, guest state carried, no email or other
> contact details copied — plus the directional `PLINK#` rows, and then rebuilds balances for
> both users. A guest has no partition; their mirrored side is created if and when they link
> an account ([`sharing-and-people.md`](sharing-and-people.md#61-how-people-are-derived)
> §6.1,
> [`../02-architecture/data-model.md`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items)
> §7). This is bookkeeping behind the user's explicit expense commit, not an auto-created
> contact: without it the pair has no `Balance`, no Person view and no `Mark settled` entry
> point, and their obligation could never reach settled.

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

Do not subtract a settlement a second time. Marking an obligation settled makes the
corresponding expense-person contribution zero; the `Settlement` row is the audit trail for
that status change and its computed total is display metadata, not another balance delta.

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
| The breakdown lists, per expense: the plan, the date, the description, the full amount, who paid, this person's share, this user's share, and settlement state — a settled line names **who marked it settled and when** (`settled by Alice · 2 Aug`), on whichever side of the obligation the viewer sits | Response schema, tested. |
| The breakdown reconciles visibly | A footer row shows `Total unsettled  $42.50` matching the headline figure exactly. If they disagree, the client shows the recomputed figure and reports the discrepancy, rather than showing the cached one. |
| Direction is stated in words | `Alice owes you $42.50`, never `+42.50` or a red/green number alone. |
| Zero is not rendered | A zero balance with no unsettled expenses shows no line at all. A zero balance with unsettled expenses in both directions shows `Settled up` with the drill-down still available. |

```
Alice · balance                                  Mark settled

  Alice owes you $42.50

  Movie Night          14 Jul    $36.00   you paid
    Alice's share                $18.00   unsettled
  Dinner at Zahav       2 Aug    $98.00   you paid
    Alice's share                $49.00   unsettled
  Train to NYC         14 Aug   $142.00   Alice paid
    Your share                   $24.50   unsettled

  Total unsettled                $42.50
```

> **Decision — the plan name on a drill-down line is a snapshot.** Confirmed 2026-08-07.
> Each line renders the Expense's own `activityTitle` — copied onto the Expense at write
> time and rewritten by the plan-rename write path — never a live read of the plan
> ([`../02-architecture/data-model.md`](../02-architecture/data-model.md#48-expense-balance-settlement)
> §4.8). It is one shared field: a rename rewrites it for every viewer, current and former
> alike. After someone leaves a plan, their `finance_only` link keeps these drill-downs
> working, and the title they see is whatever the snapshot field holds — a denormalised
> copy, never a live plan read, because a finance-only link must not expose the plan.

---

## 6. Settlement

The app records **which expense obligations the user considers settled**. It does not move
money and does not record how, where, or how much money changed hands outside the app (§8).

### 6.1 Semantics

A `Settlement` is an immutable audit record: `personId`, server-computed `amountCents`,
server-derived `currency` and `direction`, `settledAt`, and `coversExpenseIds[]`. The last
field contains 1–25 distinct ids. The user supplies only the person and selected obligation
ids; the server records the exact source Activity, Expense, and owner-scoped debtor behind
each id. All other values describe those source expenses and are never payment input.

> **Decision — settlements are expense-scoped status changes, not payment records.** The
> user selects which expense obligations are now settled; the app computes their total for
> history and explanation, while balance arithmetic simply makes those contributions zero.
> The total is never subtracted again. There is no free-form payment amount, payment method,
> transaction reference, cash remainder, credit or stored value. If Alice and Ujjwal settle
> outside the app, Ordinary Days only records the obligations they chose to close.

### 6.2 The flow

1. Person view → `Mark settled`, or a plan's per-person net row → `Mark settled`.
2. A sheet lists every unsettled expense between the two people, in the relevant direction,
   each with a checkbox, all checked by default.
3. The running total updates as boxes are unchecked: `Selected $42.50 of $42.50`.
4. `Mark settled` issues `POST /v1/settlements` with `personId` and 1–25 distinct
   `coversExpenseIds` only.
5. The server marks each covered expense settled **with respect to that pair**, writes the
   `Settlement`, and triggers a balance recompute.

> **Decision — every pair an expense names has these entry points.** Confirmed 2026-08-07.
> Step 1 assumes a Person view exists for the other party. Expense participation creates the
> People substrate (§5.1), so two non-owner participants linked only by an expense — Sam and
> Priya above — each get the Person view, the balance line and this `Mark settled` sheet.
> Without that rule their obligation could never reach settled.

### 6.3 Settling only some expenses

Unchecking any expense in step 2 settles only the selected obligations. It is a first-class
case, not an error state and not a claim about a partial payment.

- The covered expenses become settled; the rest stay outstanding.
- The balance drops by exactly the covered amount.
- Multiple settlement actions accumulate; the history shows each.
- There is no concept of a partially settled *expense*. An individual expense is settled
  with respect to a pair, or it is not. The user marks it settled only when they consider
  that obligation resolved. How many external transfers it took is outside this product.

### 6.4 Settled state on a multi-person expense

`Expense.settled` is a denormalised boolean over **all** debtors:

- The per-pair truth is on the Expense: *E* is settled with respect to a debtor when that
  debtor's id is in `Expense.settledPersonIds`.
- The settlement transaction recomputes `Expense.settled` to `true` only when every
  non-payer debtor in `splits[]` is in `settledPersonIds`. The stream worker recomputes the
  Balance cache from those Expense fields; it does not derive settled state from audit rows.
- The UI shows `Settled` on an expense line only when `Expense.settled` is true, and
  `Partly settled · 1 of 3` otherwise. Both are drill-downs.

### 6.5 Settlement history

`GET /v1/settlements?personId=` (access pattern 12 in
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
Reached from Person view → balance → `History`.

```
Settlement history · Alice

  2 Aug   $54.00 marked settled        3 expenses   ›
  6 Jul   $19.25 marked settled        1 expense    ›
```

> **Decision — settlement history is two-sided; undo is not.** Confirmed 2026-08-07. The
> history includes settlements where the viewer is the **counterparty**, not only the ones
> they created, and every row names who marked it settled and when. The counterparty read
> is derived from the covered Expenses' own `settlementIdByPersonId` — no second audit row
> is ever written
> ([`../02-architecture/data-model.md`](../02-architecture/data-model.md#5-access-patterns)
> access pattern 12b,
> [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md#29-expenses-and-settlement)
> §2.9). `Undo settlement` remains **creator-only**: the counterparty can see that Alice
> marked the dinner settled, and can ask her to undo it, but cannot delete her audit row.

Each row expands to the covered expenses. Settlements are **never edited**. A mistake is
corrected with `Undo settlement`, available from the row's overflow on settlements the
viewer created, which deletes the
`Settlement`, reopens exactly that Settlement's debtor obligation on each covered Expense,
leaves every other debtor's state untouched, and recomputes. The deletion is itself recorded
in the plan's updates feed for any affected plan.

### 6.6 Guests with expenses but no account

A guest can be a payer and can be in splits. Everything above works with `personId` alone;
no `userId` is required at any point.

| Aspect | Behaviour |
| --- | --- |
| Recording | The owner (or any participant, per §2.3) records the original expense payer and what the guest owes. |
| Visibility to the guest | **None.** The public invite page never shows expenses ([`sharing-and-people.md`](sharing-and-people.md#43-fields-the-public-projection-must-never-expose)). There is no expense-sharing link in v1. |
| Notifications | Guests are never emailed about expenses. |
| Settlement | The owner marks selected obligations settled, in the same sheet, on the guest's behalf. No external payment details are recorded. |
| If the guest registers later | `person.linkedUserId` is set and every existing expense and balance becomes visible to them from their side, in their own Person view of the owner ([`sharing-and-people.md`](sharing-and-people.md#5-guest--registered-user-linking)). Nothing is duplicated because the `personId` never changed. |

> **Decision — a guest is never shown their own balance, and this is settled, not pending.**
> Confirmed 2026-08-07. There is no guest balance view, no expense-sharing link, and no
> figure of any kind on the public invite page. Sending an amount owed to an email address
> that can be forwarded is a disclosure the product will not make.
>
> **State the consequence plainly:** the person who owes the money is the one the app will
> not tell. The owner is expected to tell them out of band — a message, a conversation, the
> same way the debt was incurred. An engineer who meets this gap should not close it. It is
> not an oversight, and a "helpful" read-only balance link is a product change that needs the
> founder, not a pull request
> ([`../00-open-decisions.md`](../00-open-decisions.md) #11).

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

Here the suggested lines coincide with the per-person nets because there is one creditor.
With more people paying, each nonzero debtor → creditor **pairwise** net renders as its own
line — never rerouted through a third person (§4) — and each suggested line still drills
through to the expenses behind it.

Person-level balances after the trip, before any settlement:

- `Alice owes you $75.83` — pairwise: she owes `$113.33` on the hotel and `$33.50` on
  dinner, and the user owes her `$71.00` on the train. `11333 + 3350 − 7100 = 7583`. ✓
- `Ben owes you $146.33`.

**Settling selected obligations.** Alice and the user resolve the Dinner share outside the
app. The app does not ask whether that happened by cash, transfer, favour or any other method.
The user opens `Mark settled`, selects **Dinner** (`$33.50`) and leaves Hotel outstanding:

```
POST /v1/settlements
{ personId: 'psn_b', coversExpenseIds: ['exp_dinner'] }
```

New balance: `7583 − 3350 = 4233` → `Alice owes you $42.33`. That number describes the
remaining expense obligations in Ordinary Days. It makes no claim about the amount or method
of any external payment; those facts are deliberately not captured (§6.1, §8).

---

## 8. Out of scope

Not built, not planned, and to be rejected in review.

| Not this | Note |
| --- | --- |
| Payment rails or external payment records — Venmo, PayPal, Stripe, bank links, cash, transfer amounts, transaction references | The app records that selected expense obligations are settled. It never moves money, holds funds, or records how settlement happened. |
| Budgets, spending limits, category budgets | Not a finance app. |
| Financial analytics, spend-by-category charts, monthly reports, trends | The only aggregates are per-plan totals and per-person balances. |
| Multi-currency conversion, FX rates, a base currency | Expenses keep their own currency and are shown separately. See [`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1). |
| Receipt scanning and OCR line-item extraction | Attachments on a plan can include a receipt photo. Nothing is read out of it. |
| Recurring or scheduled expenses | Recurrence is a property of activities, not of money. |
| Tax, tip, or service-charge calculators | Enter the amount that was actually charged. |
| Percentage splits | Use `exact` or `shares`. A percentage is one of those wearing a display format, plus a rounding step this product refuses to have. |
| Debt simplification across people who are not both in the same plan | Balances are pairwise (§5.1). |
| Interest, reminders escalating in tone, or any nagging beyond the single opt-in unsettled reminder in [`notifications.md`](notifications.md#7-notification-catalogue) | Money between friends is not a collections problem. |
| Exporting to accounting software | A CSV export of a plan's expenses is a reasonable later addition; it is not in v1. |
