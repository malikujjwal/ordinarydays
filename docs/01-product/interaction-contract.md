# Interaction contract

**Status:** canonical for gestures, states, undo and accessibility across every screen, and
for the three product-wide invariants in §1a. A component that deviates from this document is
wrong even if it looks better. One codebase serves iOS and web (Expo + React Native Web), so
every rule here has a stated web equivalent in §7.

---

## 1. The universal rules

Six rules. Everything in §3 is a consequence of them.

| # | Rule | Consequence |
| --- | --- | --- |
| U1 | **Tap the body of a row → open its detail.** | A row tap never mutates. Not a toggle, not a completion, not a reschedule. See [`overview.md`](overview.md#43-tap-a-row-opens-detail-never-mutates). |
| U2 | **Tap a checkbox → complete.** | Only `task` rows and checkable list items have one. The checkbox is a separate accessibility element with its own 44×44 hit target. |
| U3 | **Swipe → contextual actions.** | Right reveals the row's single positive action; left reveals up to three secondary actions. Full-swipe commits only the *first* action on that side, and never a destructive one. |
| U4 | **Tap a date or time → reschedule.** | Anywhere it is rendered: the row's time column, the plan detail's when/where block, a list item's state line. It opens the reschedule sheet; it never edits in place. |
| U5 | **Share → add people.** | One affordance and one sheet on every Plan and List. Tasks have no Share control and no direct participant roster; a prep Task is accessible only through its explicit parent Plan. On a Plan, Share also copies an invite link; a List has no link ([`sharing-and-people.md`](sharing-and-people.md#4a3-inviting-someone-who-does-not-have-an-account)). |
| U6 | **`⋯` → everything else.** | Edit, explicitly change Task/Plan or Plan kind, duplicate, mute, cancel, delete. Nothing destructive lives anywhere but here (and behind a swipe-revealed button that still requires a tap). |

Two supporting rules:

- **Long-press is reorder or preview, never a hidden action.** In a reorderable list it
  starts a drag. Elsewhere it opens a preview (iOS context menu) whose items duplicate the
  `⋯` menu. No action exists only behind a long-press.
- **Nothing important is behind a gesture alone.** Every swipe action is also reachable from
  the detail screen or the `⋯` menu. Gestures are accelerators.

---

## 1a. Product-wide invariants

Three rules that are larger than any one screen or feature. They are stated once, here,
because every place they apply has previously been specified locally and the local copies
drifted. A feature spec may point at this section; it may not restate it differently.

> **Decision — the section is numbered `1a`.** Six other documents cite this file's sections
> by number (§2 controls, §3 gestures, §4 undo, §5 states, §6 accessibility, §7 web).
> Renumbering to insert a section would silently break every one of those citations, which
> is a worse outcome than an unusual heading. The `1a` form follows
> [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.1a and §2.7a.

### 1a.1 Additive changes happen immediately; destructive changes explain what will be lost

An **additive** change adds a capability, a field, or an option, and loses nothing. It
applies immediately, optimistically, with no dialog, and gets the standard undo (§4).

A **destructive** change removes stored data. It applies only after a confirmation, and that
confirmation must say what disappears and how much of it. A dialog that reads
`Are you sure?`, `This can't be undone.` alone, or `Delete items?` is a defect, not a style
choice: the user cannot weigh a decision they have not been told the size of.

The required shape:

```
Turn "Watchlist" into a plain list?          ← names the object and the change

This will remove:                            ← the fields, by their user-facing labels
  Watch status, season and episode from 7 items
                                             ← the exact count of affected records
Keeps: every item, its title, its note, and its order.
                                             ← what survives, whenever anything does

                              [ Cancel ]  [ Turn into a plain list ]
```

1. `Cancel` sits first and is the default focus. The destructive button repeats the verb —
   never `OK`, never `Continue` — and carries the `danger` styling.
2. The count is the number of records that **actually carry the data being removed**, not
   the collection's size. A 20-item list where 7 items have progress says 7.
3. For a change that is destructive only *conditionally* — a type change, a behaviour
   change, a move — no confirmation is shown when nothing would be lost. A conditional
   confirmation that can appear with a count of 0 is a bug. Deletions always confirm, even
   when the thing being deleted is empty.
4. The fields are named the way the user sees them, not the way they are stored:
   `Season and episode`, not `details.season`.

Where the rule applies. This table is exhaustive for v1; a change not listed here needs a
line added to it in the same pull request.

| Change | Class | The confirmation must name |
| --- | --- | --- |
| Changing a Plan's kind, nothing dropped | additive | — (no confirmation) |
| Changing a Plan's kind, `details` dropped | destructive | Each dropped field with its current value, plus the `Keeps:` line ([`activities.md`](activities.md#63-changing-object-or-plan-kind) §6.3) |
| Task → Plan | additive explicit conversion | No confirmation; requires an unselected General / Meal / Watch / Event choice and review before `Save changes` |
| Plan → Task with participants, expenses, or prep children | blocked | No confirmation or write; name each blocking section and count so the user can remove them explicitly first |
| Plan → Task after blockers are removed, with Plan-specific details | destructive | Every dropped field and value, plus the common fields that remain |
| A list's `checkable` capability, on or off | additive both ways | — (`checked` is retained when off) |
| A list's `supportsLocation` capability, on or off | additive both ways | — (locations are retained when off) |
| A list's default `slot` | additive | — (moves no items) |
| List behaviour `collection` → `watch` or `meals` | additive | — (every item gains the new fields at their defaults) |
| List behaviour `watch` or `meals` → `collection` | destructive | The typed fields, and the exact number of items carrying them |
| `Clear checked` on a list | destructive but reversible | **No confirmation dialog.** It applies immediately and the 10-second bulk undo toast states the count — `7 items cleared` (§4). A reversible bulk action gets an undo, not a dialog, and having both would be two interruptions for one decision |
| Deleting a list | destructive | The item count, how many of those items have a linked activity — those activities survive — and, on a shared list, the number of other members who lose it |
| Leaving a shared list, or removing someone from one | destructive | That the items they added stay on the list, with counts, and who keeps it ([`plans-and-lists.md`](plans-and-lists.md) §5.11.4) |
| Deleting a Plan reached from a ListItem | destructive | That the ListItem survives byte-identical and caller-specific `LNK#` pointers are removed |
| Deleting a shared Plan | destructive | The people who lose access **and the money**: the expense count, the total per currency, and any unsettled amount — `Deletes 4 expenses · $875.00 · $385.00 still unsettled`. An active shared plan is cancelled before it can be deleted — see the decision below the table |
| Clearing the date on a shared plan | destructive | That it comes off everyone's day and returns to Plans → Needs a date, plus the `Keeps:` line — the plan, everyone on it, and their replies, which are **not** reset ([`plans-and-lists.md`](plans-and-lists.md) §1.4) |
| Clearing an Activity's time while keeping its date | retained-data/additive normalisation | No confirmation. Reminder rows are kept; sub-day offsets become the nearest whole-day multiple (half-day ties choose the earlier reminder). The reschedule surface states this before save, and the response reports that normalisation ran without exposing another person's reminders. |
| Setting or changing the date on a plan people have already responded to | destructive | The number of participants whose reply is discarded, and that everyone will be asked again ([`plans-and-lists.md`](plans-and-lists.md) §1.4). Nobody has responded → **no confirmation**, per rule 3 above |
| Deleting somebody else's date suggestion, as the plan's owner | destructive | Whose it is and its date — `Remove Alice's suggestion of Saturday 9 August?` Deleting your own is additive-in-reverse and gets the standard undo instead ([`plans-and-lists.md`](plans-and-lists.md) §2.3) |
| Deleting a whole recurring series | destructive | The series and the count of stored past completions — `Delete "Gym"? This removes: the series and its 40 past completions.` ([`activities.md`](activities.md) §6.4). `End series` is the gentler primary alternative and needs no confirmation (§4) |
| Deleting a person, an expense, or a settlement | destructive | Per [`expenses.md`](expenses.md) and [`sharing-and-people.md`](sharing-and-people.md). Deleting a Person with an outstanding balance names it: `Priya still owes you $215.00 — deleting removes this balance.` |
| Deleting the account | destructive | The 30-day window, with a typed confirmation |

> **Decision (2026-08-07) — a shared plan with participants is cancelled before it is
> deleted.** The delete action on an active shared plan runs cancellation first — which
> notifies everyone, per the cancel row in §4.1 — and only then allows delete. A solo or
> never-shared plan deletes directly. Nobody discovers by silence that a plan they were on
> is gone: the cancellation tells them, and the delete confirmation puts the numbers — the
> people, the expenses, the totals, the unsettled amount — in front of the owner before
> anything is removed.

§4 decides **whether** an action gets a confirmation, an undo, or both. This section decides
**what the confirmation says** when there is one. Neither substitutes for the other.

### 1a.2 Cross-object state changes are always suggestions

Acting on one object never changes another object's stored state. Where a second change is
likely, the app offers it as a single dismissible follow-up in the confirmation slot
(§4.2) and writes only if the user taps it.

This is one rule, not six special cases. Everywhere it already applies:

| Trigger | What the app must not do | What it offers instead |
| --- | --- | --- |
| Completing an activity created from a list item | Check, uncheck, move, hide or delete the item | `Mark {item title} visited in {list name}?`, and only when completion is evidence about the item ([`plans-and-lists.md`](plans-and-lists.md) §5.10) |
| Completing a watch session | Write season or episode onto the named source-list item, or move it from `want` to `watching` | `{list name} · currently S2 E4 — Update to S2 E5?` |
| Progress having just been updated | Create the next episode's session | `Create a Plan for S2 E6?`, which opens an unselected Plan-kind chooser; only after Watch is explicitly chosen may compatible fields pre-fill, and nothing is created until `Save plan` |
| Completing a meal | Add its ingredients to a user-chosen list | `Add ingredients to a list?`, which opens the ingredient picker and then visibly names the destination before any write |
| Completing a plan with open prep tasks | Complete, delete, reschedule or otherwise touch the prep tasks | `2 prep tasks are still open — keep them?` — Keep / Complete all / Delete. Keeping or dismissing changes nothing; the other two write only when tapped ([`plans-and-lists.md`](plans-and-lists.md) §3) |
| Creating or opening a plan | Create a packing, shopping or grocery list for it | The `Add list` affordance in the LISTS section |
| Completing one occurrence of a recurring series | Alter the recurrence rule, or mutate the series row | Nothing. The next occurrence already exists by definition |
| Capture extracting compatible fields from a photo, link or text | Persist, route, classify, share, attach anything, or set a reminder on its own | A reviewable draft inside the already selected form, committed only by its named write button; Reminder remains a separate visible control or an explicitly saved default |
| Renaming a list | Change its behaviour or capabilities to match the new name | Nothing. The user changes those in list settings if they want to |
| A list or plan going quiet | Archive it, hide it, or prompt about it | Nothing |

Rules for the follow-up itself:

- **One at a time.** If two would apply, the more specific one wins and the other is not
  queued for later.
- **Never pre-selected, never modal, never blocking.** It sits in the same slot as the
  confirmation toast, with a visible `✕`.
- **Dismissing is a complete and correct outcome.** The app does not ask again for the same
  event, and does not record the dismissal as a decision to be revisited.
- **An accepted follow-up is its own action**: it gets its own undo toast, and reversing the
  original action later — un-completing the activity — does not reverse it.
- Offline, the follow-up is still offered and its write queues like any other (§5.4).

### 1a.3 Creation intent is selected before assistance

The global `+` always opens **Task / Plan / List item** in that fixed order, with nothing
selected. A contextual control fixes intent only by naming it: `+ Add a task`,
`+ Add an item`, or `+ Add a prep task`. Plan then requires **General / Meal / Watch /
Event**, also fixed and unselected; General is an explicit choice, never a hidden
fallback. List item requires an explicit destination unless the current list already names
it.

Text, photos, links, and AI are enabled only after those choices. They may suggest
compatible field values but never object kind, Plan kind, people, sharing, destination,
reminder/notification state, or the save action. A reminder is set only by its visible
control or the user's explicitly saved default; words such as `remind me` never change it.
Final controls name the write: `Save task`, `Save plan`, or
`Add to <list name>`. Every ListItem's `Plan this item` flow additionally requires an
unselected **Just me / Choose people** choice; membership is never copied to the Plan,
whether the source list is private or shared.

General `New list` opens the fixed style catalogue with nothing selected, then a title step
for the chosen style. A typed destination already chosen by the user may constrain eligible
rows—for Watch, exactly Watchlist / Movies to watch / TV shows in canonical relative order—
but nothing is selected. There is no name-first matching, recommendation, ranking, or fallback.

`objectKind` persists Task versus Plan. Tasks cannot gain participants or expenses; a
coordinated to-do is explicitly **Plan → General** or another visible Plan kind. An explicit
Task → Plan conversion requires a visible Plan-kind choice. Plan → Task is blocked until
participants, expenses, and prep children are removed, then previews any type-specific
field loss. A Plan-kind-only change cannot change `objectKind`; edits and capture never
invoke conversion.

---

## 2. Controls and their targets

| Control | Hit target | Notes |
| --- | --- | --- |
| Row body | Full row width minus the checkbox and any trailing control, min height 44 pt | One `Pressable` |
| Checkbox | 44 × 44 pt, visually 24 × 24 | Separate element |
| Time column | 44 pt tall, ≥ 56 pt wide | Separate element; opens reschedule |
| Trailing prompt chip (`How did it go?`) | 44 pt tall | Separate element |
| Avatar stack | Not interactive on a row | Interactive on plan detail |
| `⋯` | 44 × 44 pt | |
| Swipe action button | Full row height, ≥ 72 pt wide | |
| Global `+` | 56 × 56 pt | Accessible label `Add`; always opens Task / Plan / List item, never a preselected form |

Adjacent hit targets are separated by at least 8 pt of non-interactive space.

---

## 3. Gesture table

Rows appear in these forms across the product. `—` means the gesture does nothing and the
row does not move under the finger.

### 3.1 Today and agenda rows

| Row type | Tap body | Tap checkbox | Swipe right (partial) | Swipe right (full) | Swipe left (partial) | Swipe left (full) | Long press |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task, timed | Open task detail | Complete | `Complete` | Complete | `Snooze` · `Reschedule` · `Delete` | Snooze sheet | Preview + `⋯` menu |
| Task, untimed (Anytime) | Open task detail | Complete | `Complete` | Complete | `Schedule` · `Delete` | Schedule sheet | Preview + `⋯` menu |
| Task, overdue (rolled forward) | Open task detail | Complete | `Complete` | Complete | `Do today` · `Reschedule` · `Delete` | Sets `schedule.date` to today | Preview + `⋯` menu |
| Task, recurring occurrence | Open task detail (series) | Complete **this occurrence** | `Complete` | Complete this occurrence | `Snooze` · `Skip` · `Edit series` | Snooze sheet | Preview + `⋯` menu |
| Meal | Open plan detail | — (no checkbox) | `Had it` | Had it | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Watch | Open plan detail | — | `Watched` | Watched | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Event | Open plan detail | — | `Attended` | Attended | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Event | Open plan detail | — | `Done` | Done | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| General | Open plan detail | — | `Done` | Done | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Prep task (on Today) | Open task detail | Complete | `Complete` | Complete | `Open plan` · `Reschedule` · `Delete` | Opens the parent plan | Preview + `⋯` menu |
| Any row with a pending RSVP | Open plan detail | — | `Going` | Sets RSVP going | `Maybe` · `Decline` | Sets RSVP maybe | Preview + `⋯` menu |
| UP NEXT card | Open detail | Complete (tasks only) | Same as the underlying row | Same | Same | Same | Same |
| Completed row (EARLIER TODAY) | Open detail | Un-complete | `Undo` | Un-complete | `Delete` | — | Preview + `⋯` menu |

**On a shared Plan you do not own, every completion affordance in the table above is
absent** — no checkbox, no `Complete` / `Had it` / `Watched` / `Attended` / `Done` on either
swipe, no `Skip`, no `Snooze`. Completion is global and owner-only
([`today-and-tasks.md`](today-and-tasks.md#41-a-plan-you-did-not-create-carries-no-completion-control)
§4.1). The swipe actions that remain are `Reschedule`-free too: a participant's left swipe
offers `Leave plan` alone, and their right swipe offers their RSVP. Prep tasks are
unaffected — any participant of the parent plan may complete them, whoever created them
([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
§3).

Additional taps available on these rows:

| Element | Behaviour |
| --- | --- |
| Time column | Reschedule sheet (U4) |
| `How did it go?` chip | Resolution sheet ([`today-and-tasks.md`](today-and-tasks.md#82-resolution-prompts)) |
| Overdue date chip | Reschedule sheet, pre-set to today |
| `+n more overdue` | Expands in place |

### 3.2 List rows

Rows are keyed on the list's **behaviour** and its **capabilities**
([`plans-and-lists.md`](plans-and-lists.md) §5.2, §5.3), never on a list type. `Groceries`
and `Packing` are the same row because they are the same thing with the same flags.

| Row type | Tap body | Tap checkbox | Swipe right | Swipe right (full) | Swipe left | Swipe left (full) | Long press |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List (on the Lists index), you own it | Open the list | — | — | — | `Archive` · `Delete` | — | — |
| List (on the Lists index), you are a member | Open the list | — | — | — | `Leave` | — | — |
| `collection` item, `checkable` | Open item sheet | Toggle `checked` | `Check` / `Uncheck` | Toggle | `Plan this item` · `Delete` | Plan-kind chooser | Drag to reorder |
| `collection` item, not `checkable` | Open item sheet | — (no checkbox) | `Plan this item` | Plan-kind chooser | `Delete` | — | Drag to reorder |
| `watch` item | Open item sheet | — (status replaces the checkbox) | `Plan this item` | Plan-kind chooser | `Mark watched` · `Delete` | Mark-watched confirm | Drag to reorder |
| `meals` item | Open item sheet | — | `Plan this item` | Plan-kind chooser | `Delete` | — | Drag to reorder |
| Item with a state line (`Planned Saturday · 7 PM`) | Title area → item sheet; **state line → the linked Activity** | As above | As above | As above | As above | As above | Drag to reorder |

The Lists **index** is not reorderable: `ListIndex` stores no rank, and the index renders in
server pointer order. Reordering applies to the items *within* a list, never to the lists
themselves.

### 3.3 Plan detail rows

| Row type | Tap | Swipe | Long press |
| --- | --- | --- | --- |
| When/where block | Reschedule sheet. Owner only; for a participant the block is not interactive | — | — |
| Address line within it | Open the platform maps app | — | Copy address |
| Reminder row within it | Your own reminder's picker. Never shows or reaches anyone else's ([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1) | — | — |
| Date suggestion row | `Works for me` toggles your availability; `Use this date` (owner only) opens the reschedule sheet pre-filled ([`plans-and-lists.md`](plans-and-lists.md) §2.3) | Author or owner: `Delete` | — |
| Participant row | Open that Person's view | Owner only: `Resend invite` · `Copy link` · `Remove` | — |
| Prep task row | Open task detail (checkbox completes) | `Complete` / `Reschedule` · `Delete` | — |
| Related list row | Open the list | `Detach` (clears `sourceActivityId`) | — |
| Expense row | Open expense detail | Author or owner: `Edit` · `Delete` | — |
| Per-person owes row | Balance drill-down filtered to this plan | — | — |
| Attachment thumbnail | Open viewer | — | `Set as cover` · `Delete` |
| Update entry | — (not interactive) | Author only: `Delete` | Copy text |
| Completion button | Complete with the type's verb. **Owner only** — a participant has no completion control anywhere on the screen | — | — |

### 3.4 Other rows

| Row type | Tap | Swipe | Long press |
| --- | --- | --- | --- |
| Needs-a-date plan row (Plans), you own it | Open plan detail | Right: `Set date`, opening the reschedule sheet. Left: `Delete` | Preview + `⋯` menu |
| Needs-a-date plan row (Plans), you are a participant | Open plan detail | Right: `Suggest a date`, opening the suggestion sheet ([`plans-and-lists.md`](plans-and-lists.md) §2.3). Left: `Leave plan` | Preview + `⋯` menu |
| List member row (a list's share sheet) | Row body is not interactive | — (sheets have no swipe actions) | — |
| Person row (People page) | Open Person view | `Plan something` · `Delete` | — |
| Balance line (anywhere) | Balance drill-down. **Always interactive** ([`expenses.md`](expenses.md#53-the-mandatory-drill-down)) | — | — |
| Expense line in a drill-down | Open the plan at its expense section | — | — |
| Settlement history row | Expand covered expenses | `Undo settlement` — on rows the viewer created only; counterparty rows show no undo ([`expenses.md`](expenses.md) §6.5) | — |
| Notification row | Navigate to the subject | `Mark read` · `Delete` | — |
| Invitation notification row | Navigate; inline `Going · Maybe · Decline` | Same | — |
| Search result | Open the subject | — | — |

Two notes on the rows above:

- **A needs-a-date row carries no checkbox, on any type**, including `task`. Nothing in that
  stage is due, and a checkbox is an obligation to tick it
  ([`plans-and-lists.md`](plans-and-lists.md) §1.3.1). Its RSVP summary line is part of the
  row body, not a second hit target — there is nothing behind it that the row does not
  already open.
- **A list member row's only interactive element is its trailing control**: `✕` for the owner
  on anyone but themselves, `Leave list` on your own row, `Resend` on a pending invite. Both
  `✕` and `Leave list` confirm, per §1a.1. A member sees no `✕` on anyone else's row — the
  control is absent, not disabled, because a disabled control invites a tap that teaches
  nothing.

---

## 4. Undo policy

> **Decision — the undo model.** Reversible actions are performed immediately with a
> **6-second** undo toast and no confirmation dialog. Irreversible actions are performed
> only after a confirmation dialog and have **no** undo. Bulk reversible actions get a
> **10-second** window because there is more to notice.

This section decides which of the two an action gets. What a confirmation must *say* when
there is one is §1a.1.

### 4.1 The table

| Action | Confirmation | Undo | Window | Mechanism |
| --- | --- | --- | --- | --- |
| Complete a task or occurrence | No | Yes | 6 s | `POST .../uncomplete` |
| Complete a plan (any type, any outcome) | No | Yes | 6 s | `POST .../uncomplete` |
| Skip an occurrence | No | Yes | 6 s | Delete the `Occurrence` |
| End a series | No | Yes | 6 s | `PATCH` clears `recurrence.endDate` ([`activities.md`](activities.md) §6.4) |
| Snooze | No | Yes | 6 s | Delete the snooze fields |
| Check / uncheck a list item | No | Yes | 6 s | `PATCH` back |
| Reschedule, where no participant has responded | No | Yes | 6 s | `POST .../schedule` with the previous values |
| Set or change the date on a plan people **have** responded to | **Yes**, naming how many replies are discarded (§1a.1) | No | — | The write resets every RSVP and notifies everyone. Undo would ask them all a second time, which is worse than the confirmation it replaces |
| RSVP change | No | Yes | 6 s | `PATCH` back |
| Suggest a date, or withdraw your own suggestion | No | Yes | 6 s | `DELETE` the suggestion, or re-create it |
| Mark a suggestion as `Works for me`, or unmark it | No | Yes | 6 s | Toggle back |
| Delete somebody else's suggestion, as the owner | **Yes**, naming whose it is | No | — | Removing something another person wrote is confirmed, never undone quietly |
| Clear checked (bulk) | No | Yes | **10 s** | Re-create the deleted items with their previous ranks |
| Uncheck all (bulk) | No | Yes | **10 s** | `PATCH` back |
| Archive a list | No | Yes | 6 s | `PATCH archived: false` |
| Toggle a list capability (`Show checkboxes`, `Add a place to items`) | No | Yes | 6 s | `PATCH` back. Additive both ways (§1a.1) |
| Upgrade a list's behaviour to `watch` or `meals` | No | Yes | 6 s | `PATCH` back — the added fields are still at their defaults |
| Downgrade a list's behaviour to `collection` | **Yes**, naming the fields and the item count (§1a.1) | No | — | `?confirmDataLoss=true` |
| Accept a follow-up suggestion (§1a.2) | No | Yes | 6 s | `PATCH` back. Independent of the action that offered it |
| Remove a participant | **Yes** | No | — | Revokes their token; re-adding sends a new invitation |
| Delete an activity | **Yes** | No | — | Cascades per [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items) |
| Delete a list | **Yes** | No | — | On a shared list the confirmation also names the other members (§1a.1) |
| Add someone to a list | No | Yes | 6 s | `DELETE /v1/lists/:id/members/:personId`. The invitee's `added_to_list` notification is suppressed until the window closes |
| Leave a list, or remove someone from one | **Yes** | No | — | Re-joining is a fresh invite from the owner |
| Delete a list item | No | Yes | 6 s | Re-create with the previous rank |
| Delete an expense | **Yes** | No | — | Balances recompute |
| Delete a settlement (`Undo settlement`) | **Yes** | No | — | Un-settles the covered expenses |
| Cancel a plan | **Yes** | Yes, from the plan | — | `PATCH status` back; participants are notified again |
| Delete a person | **Yes** | No | — | Blocked with `409` while they are on a live Plan or an invited/active shared List; name and type every blocker |
| Change Task/Plan or Plan kind | **Yes**, when fields would be dropped, in the §1a.1 shape | No | — | [`activities.md`](activities.md#63-changing-object-or-plan-kind) |
| Discard an unsaved draft | **Yes** | No | — | |
| Delete the account | **Yes**, typed confirmation | 30 days, by signing back in | 30 d | Soft delete, then purge |

### 4.2 Toast rules

- One toast at a time. A new action replaces the visible toast and **commits** the previous
  one immediately.
- The toast sits above the tab bar, is swipe-dismissible, and dismissing it commits.
- Undo restores the exact prior state, including sort position and scroll offset.
- The optimistic update is applied instantly; the network call fires immediately, not at the
  end of the window. Undo is a compensating call, not a delayed commit. This keeps the app
  correct when it is closed mid-window.
- If the original call failed, the row reverts and the toast becomes an error toast with
  `Retry` instead of `Undo`.
- Toasts announce themselves to screen readers with `accessibilityLiveRegion="polite"` and
  their `Undo` button is focusable.

---

## 5. Loading, empty, error and offline states

One contract, applied identically everywhere.

### 5.1 Loading

| Situation | Presentation |
| --- | --- |
| First load of a screen with no cached data | Skeleton rows matching the real layout's shape and count (5 rows), with no spinner and no text. Minimum display 200 ms to avoid a flash. |
| Refresh of a screen with cached data | Cached content stays fully visible and interactive. A 2 pt progress bar under the header. **Never** a blocking spinner over existing content. |
| Pull to refresh | Platform refresh control. Web: a `Refresh` button in the header plus `R`. |
| A mutation in flight | The affected row is optimistically updated. No spinner on the row. A spinner appears only on a modal's primary button, and only after 400 ms. |
| Pagination | A single skeleton row at the list's foot; auto-fetch at 80 % scroll depth. |
| Anything over 10 s | Becomes an error state (§5.3) with `Retry`. |

### 5.2 Empty

Every empty state is: a one-line heading stating the fact, one line of guidance, and at
most one action. No illustrations, no congratulation, no exclamation marks.

Guidance copy says what to add. It never says what the thing will turn into later, and it
never describes a surface as somewhere things wait — `until`, `yet`, `someday`, `ready to`
and `turn into` are banned from empty-state copy for exactly that reason
([`overview.md`](overview.md#47-lists-are-destinations-not-staging-areas) §4.7).

| Screen | Heading | Guidance | Action |
| --- | --- | --- | --- |
| Today, nothing at all | `Nothing planned today` | `Add something you want to do, or check your Lists.` | `Add` |
| Plans → Needs a date, empty | `Nothing without a date` | `Plans you've started but not scheduled show up here.` | — |
| Plans → Upcoming, empty | `No upcoming plans` | `Anything with a date shows up here.` | `Add` |
| Plans → Past, empty | `Nothing here` | `Plans that have happened show up here.` | — |
| Plans, all three stages empty | `No plans` | `Add something you want to do, on its own or with someone.` | `Add` |
| Lists index | `No lists yet` | `Keep things you want to remember, track, or organise together.` | `New list` |
| A list | `Nothing here` | The List's stored `emptyStateCopy`, seeded from the explicitly selected style, says what to add ([`plans-and-lists.md`](plans-and-lists.md) §5.9) | The inline add row |
| Search, no results | `No matches for "zahav"` | — | — |
| People | `No one yet` | `People appear here when you share a plan or list with them.` | — |
| Person, no shared plans, active shared lists or balance | `Nothing together yet` | — | `Plan something with Alice` |
| Balances | `Nothing outstanding` | — | — |
| Notification inbox | `Nothing new.` | — | — |
| Expenses on a plan | — | — | `Add expense` alone |

Every empty-state action labelled `Add` is the global Add action: it opens **Task / Plan /
List item** with nothing selected. The screen the empty state appears on does not choose the
object.

Section-level empty states on Today are specified in
[`today-and-tasks.md`](today-and-tasks.md#25-empty-states).

### 5.3 Error

| Class | Presentation | Recovery |
| --- | --- | --- |
| Screen-level load failure (no cached data) | Full-screen: `Couldn't load this.` plus the request id in small text | `Try again` |
| Screen-level refresh failure (cached data present) | Cached content stays. A dismissible banner: `Couldn't refresh.` | `Try again` |
| Mutation failure | The optimistic change reverts; error toast naming what failed: `Couldn't complete "Gym."` | `Retry` |
| `409 conflict` on a shared plan | `This plan changed while you were editing.` Client refetches; non-overlapping edits are re-applied, overlapping ones are dropped and named. | `Review` |
| `403 forbidden` | `Only the person who made this plan can change that.` | — |
| `404 not_found` | `This isn't here any more.` Navigate back. | — |
| `422 participant_limit_exceeded` | Inline in the picker: `You can add up to 50 people to a plan.` | — |
| `422 reminder_limit_exceeded` | Inline in the reminder picker: `You can add up to 3 reminders.` | — |
| `422` on a sixth date suggestion | Inline in the suggestion sheet: `You can suggest up to 5 dates.` | — |
| `429 rate_limited` | `Too many requests. Try again in <Retry-After>.` | Auto-retry once after the header's delay for `GET`s only |
| `426 upgrade_required` | Blocking screen: `Update Ordinary Days to keep going.` | `Update` → `updateUrl` |
| `501 not_implemented` (capture) | Silent on the text path; the manual-entry message on image/link paths | See [`ai-capture.md`](ai-capture.md#61-the-failure-matrix) |
| `500 internal` | `Something went wrong.` plus the request id | `Try again` |

Error copy never shows a stack trace, an error code, or the word "error" in the heading.
The `requestId` is always shown in small text and is long-press-copyable, so a support
message can name it.

### 5.4 Offline

| Aspect | Behaviour |
| --- | --- |
| Detection | Connectivity state plus request failure. A single connectivity change does not clear the queue. |
| Indicator | A persistent 20 pt bar under the header: `Offline — changes will sync.` No modal, no blocking. |
| Reads | The last agenda, list and plan responses are cached and served. Today works fully offline for the current day. |
| Writes | Queued in order, per entity, with their `Idempotency-Key` preserved so a retry cannot duplicate. Applied optimistically. |
| Queued row indicator | A small `Pending` dot in the row's trailing slot. Not an error colour. |
| Conflicts on reconnect | Server state wins for fields the user did not touch. A queued write that returns `409` surfaces one banner: `<n> changes couldn't be applied.` with a list. |
| Capture | Not attempted offline ([`ai-capture.md`](ai-capture.md#61-the-failure-matrix)). |
| Uploads | Queued; the attachment shows a placeholder until the upload succeeds. |
| Queue limits | 200 pending mutations; beyond that, new writes are refused with `You're offline and there's a lot waiting to sync.` |
| Undo while offline | Works — it is a compensating local operation and a queued call. |

---

## 6. Accessibility

Requirements, not aspirations. Each is checkable.

### 6.1 Targets and layout

| Requirement | Value |
| --- | --- |
| Minimum hit target | 44 × 44 pt on iOS, 44 × 44 CSS px on web, for every interactive element without exception |
| Spacing between adjacent targets | ≥ 8 pt |
| Text truncation | Titles wrap to 2 lines before truncating; they never truncate at 1 line at default type size |
| Layout at 320 pt width | No horizontal scrolling, no clipped controls |

### 6.2 VoiceOver / screen reader labels

Every row is **one** accessibility element per interactive control, in the reading order
given. `accessibilityRole` is stated; `accessibilityHint` is used only where the action is
not obvious from the label.

| Row type | Elements, in order | Label | Role | Actions |
| --- | --- | --- | --- | --- |
| Task, timed | 1. Checkbox<br>2. Row body<br>3. Time | 1. `Gym, not completed`<br>2. `Gym, 6:00 PM, repeats on weekdays`<br>3. `6:00 PM, change time` | `checkbox`, `button`, `button` | Custom actions on the body: `Complete`, `Snooze`, `Reschedule`, `Delete` |
| Task, untimed | 1. Checkbox<br>2. Row body | 1. `Submit insurance form, not completed`<br>2. `Submit insurance form, today, no time` | `checkbox`, `button` | `Complete`, `Schedule`, `Delete` |
| Task, overdue | 1. Checkbox<br>2. Row body<br>3. Date chip | 1. `Call apartment office, not completed`<br>2. `Call apartment office, was due Tuesday 4 August`<br>3. `Was due Tuesday, reschedule` | `checkbox`, `button`, `button` | `Complete`, `Do today`, `Reschedule`, `Delete` |
| Meal | 1. Row body<br>2. Time | 1. `Chicken tacos, meal, dinner, 7:30 PM`<br>2. `7:30 PM, change time` | `button`, `button` | `Had it`, `Reschedule`, `Delete` |
| Watch | 1. Row body<br>2. Time | 1. `Severance, watch, season 2 episode 4, 8:00 PM, with Alice` | `button`, `button` | `Watched`, `Reschedule`, `Delete` |
| Event | 1. Row body<br>2. Time | 1. `Dentist appointment, event, 2:30 PM, at Dr Patel` | `button`, `button` | `Attended`, `Reschedule`, `Delete` |
| General | 1. Row body<br>2. Time | 1. `Practice guitar, general plan, 9:00 PM` | `button`, `button` | `Done`, `Reschedule`, `Delete` |
| Passed, unresolved | 1. Row body<br>2. Prompt chip | 2. `How did it go? Choose an outcome for Dentist appointment` | `button`, `button` | `Attended`, `Didn't go` |
| Completed row | 1. Row body | `Overnight oats, had it, 8:00 AM` | `button` | `Undo` |
| Pending RSVP | 1. Row body<br>2–4. RSVP buttons | 1. `Dinner at Zahav, Saturday 7:00 PM, from Alice, awaiting your reply` | `button` ×4 | — |
| Needs-a-date row | 1. Row body | `Dinner at Zahav, event, no date. Alice is interested. Ben hasn't replied. 2 dates suggested.` | `button` | Owner: `Set date`, `Delete`. Participant: `Suggest a date`, `Leave plan` |
| Needs-a-date row, no participants | 1. Row body | `Poconos trip, event, no date. Just you.` | `button` | `Set date`, `Delete` |
| Date suggestion row | 1. Row body<br>2. `Works for me` toggle<br>3. `Use this date` (owner only) | 1. `Saturday 9 August, 7:00 PM, suggested by Alice, before the show. Works for you and Ben.`<br>2. `Works for me, on`<br>3. `Use this date` | `text`, `switch`, `button` | `Delete` on your own |
| List member row | 1. Row body<br>2. Trailing control | 1. `Alice, member` / `Ben, invited, we emailed them`<br>2. `Remove Alice from this list` / `Leave this list` | `text`, `button` | — |
| UP NEXT card | 1. Card body | `Up next. Pick up groceries, in 2 hours, 5:30 PM` | `button` | Same as the row |
| List item, list is `checkable` | 1. Checkbox<br>2. Row body | 1. `Chicken, not checked`<br>2. `Chicken, from Sunday dinner` | `checkbox`, `button` | `Plan this item`, `Delete` |
| List item, list is not `checkable` | 1. Row body<br>2. State line | 1. `Zahav`<br>2. `Planned Saturday 7:00 PM, open plan` | `button`, `button` | `Plan this item`, `Delete` |
| List item with a place (`supportsLocation`) | 1. Row body<br>2. Address line | 1. `Zahav, 237 St James Place`<br>2. `237 St James Place, open in Maps` | `button`, `button` | `Plan this item`, `Delete` |
| `watch` list item | 1. Row body | `Severance, watching, season 2 episode 4, next session Friday 8:00 PM` | `button` | `Plan this item`, `Mark watched`, `Delete` |
| Person row | 1. Row body<br>2. Balance chip | 1. `Alice, 3 upcoming together` or `Priya, in 2 lists with you`<br>2. `Alice owes you 42 dollars 50, see the expenses` | `button`, `button` | `Plan something`, `Delete` |
| Balance line | 1. Line | `Alice owes you 42 dollars 50. See the expenses behind this.` | `button` | — |
| Expense row | 1. Row body | `Hotel, 340 dollars, you paid, split 3 ways` | `button` | `Edit`, `Delete` |
| Participant row | 1. Row body | `Alice, going` / `Chloe, invited, guest` | `button` | `Resend invite`, `Copy link`, `Remove` |
| Notification row | 1. Row body | `Alice invited you. Dinner at Zahav, Saturday 9 August 7:00 PM. Unread.` | `button` | `Mark read`, `Delete` |
| Section header | 1. Header | `Up next`, `Schedule`, `Anytime`, `Earlier today` | `header` | — |

Rules:

- Non-interactive type markers (the diamond on non-task rows) are
  `accessibilityElementsHidden` and contribute their meaning to the row label instead
  (`, meal,`).
- Every swipe action is exposed as an `accessibilityAction` on the row so it is reachable
  without swiping.
- State is spoken, not implied by colour: `not completed`, `checked`, `unread`, `pending`.
- Counts are spoken in full: `with Alice and 2 others`, never `+2`.
- Money is spoken as words per the platform's currency formatter, never as digits with a
  symbol.

### 6.3 Dynamic type

- Every text style uses the platform's scalable type. `allowFontScaling` is never `false`.
- The layout is verified at the largest non-accessibility size **and** at the largest
  accessibility size (`AX5`).
- Above `xxxLarge`, row layouts reflow from horizontal to vertical: the time moves above the
  title, avatars move below, badges wrap.
- Fixed-height rows do not exist. Every row is content-sized with a 44 pt minimum.
- Icons paired with text scale with it. Icon-only controls have a fixed 44 pt target and do
  not scale.

### 6.4 Contrast and colour

| Requirement | Value |
| --- | --- |
| Body and label text | ≥ 4.5:1 against its background |
| Large text (≥ 24 pt, or ≥ 19 pt bold) | ≥ 3:1 |
| Interactive control boundaries and focus rings | ≥ 3:1 |
| De-emphasised text (subtitles, overdue chips, completed rows) | ≥ 4.5:1 — de-emphasis is achieved with weight and size, not by dropping contrast below the threshold |
| Colour as the only carrier of meaning | **Never.** Completion also uses a checkmark and struck text. Pending RSVP also uses the word `Awaiting reply`. Overdue also uses the date chip's text. Balance direction is always words. |
| Dark mode | Full support, contrast verified independently |
| Increase Contrast setting | Honoured: borders become opaque, de-emphasised text moves to full contrast |

### 6.5 Motion

| Setting | Behaviour |
| --- | --- |
| Reduce Motion on | Screen transitions become cross-fades. Row insert/remove animations are removed; rows appear and disappear immediately. The toast appears without a slide. Swipe actions still track the finger (that is direct manipulation, not decorative motion) but do not spring. |
| Reduce Motion off | Standard platform transitions. No animation exceeds 300 ms. |
| Parallax, auto-playing motion, looping animation | Do not exist anywhere in the product. |
| Haptics | Light impact on completion and on swipe-action commit only. Respects the system haptics setting. Never used for errors alone — an error is always also visible and announced. |

---

## 7. Web equivalents

The web build is the same codebase. These rules translate touch gestures rather than
replacing them; touch gestures continue to work on touch-capable web devices.

### 7.1 Hover and pointer

| Touch gesture | Web equivalent |
| --- | --- |
| Swipe right (positive action) | A trailing action button appears on row hover, at the row's right edge: the same single positive action, labelled with its verb |
| Swipe left (secondary actions) | A `⋯` button appears on row hover, opening the same menu the long-press preview shows |
| Long press to reorder | Drag handle appears on hover in reorderable lists; drag with the pointer |
| Long press for preview | No equivalent; the `⋯` menu carries every item |
| Pull to refresh | `Refresh` button in the header, plus `R` |
| Tap and hold to copy | Right-click context menu (native) |

Hover-revealed controls are always **also** reachable by keyboard (§7.2) and are never the
only path to an action.

### 7.2 Keyboard shortcuts

Global, active when focus is not in a text field:

| Key | Action |
| --- | --- |
| `N` | Open the global **Task / Plan / List item** chooser |
| `T` / `P` / `L` | Today / Plans / Lists |
| `/` | Focus search |
| `R` | Refresh the current screen |
| `?` | Show the shortcut sheet |
| `G` then `I` | Notification inbox |
| `G` then `E` | People |

Within a list:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus between rows |
| `Home` / `End` | First / last row |
| `Return` | Open the focused row's detail |
| `Space` | Toggle the focused row's checkbox, if it has one |
| `E` | Complete the focused row with its type's verb |
| `S` | Snooze (timed Tasks), set a date (undated Tasks), or `Plan this item` (ListItems) |
| `D` | Reschedule |
| `Backspace` / `Delete` | Delete, with the standard confirmation |
| `Cmd/Ctrl + Z` | Undo, while the undo toast is visible |

Within forms and sheets:

| Key | Action |
| --- | --- |
| `Return` | Submit, when a single-line field is focused and the form is valid |
| `Cmd/Ctrl + Return` | Submit, from anywhere in the form |
| `Esc` | Cancel, with the discard prompt if dirty |
| `Tab` / `Shift + Tab` | Move through fields in visual order |
| `Alt + 1`–`3` | On the global chooser: Task, Plan, List item |
| `Alt + 1`–`4` | On the Plan-kind chooser: General, Meal, Watch, Event |

The shortcut sheet (`?`) lists every shortcut and is the discovery mechanism. Shortcuts are
never the only way to do anything.

### 7.3 Focus order and management

| Rule | Detail |
| --- | --- |
| Order | DOM order equals visual order equals reading order. No positive `tabIndex` anywhere. |
| Skip link | `Skip to content` as the first focusable element on every page. |
| Row composition | A row is a single tab stop; its checkbox, time and trailing chip are reachable with `←`/`→` inside the row (a composite widget), so `Tab` moves between rows and not within them. |
| Modals and sheets | Focus moves to the sheet's first control on open, is trapped inside while open, and returns to the triggering element on close. |
| Route changes | Focus moves to the new screen's `<h1>`, which is announced. |
| Focus ring | Always visible, ≥ 2 px, ≥ 3:1 contrast, never removed. `:focus-visible` is used so pointer users do not see it on click. |
| Toasts | Not focus-stealing. The `Undo` button is inserted into the tab order immediately after the currently focused element for the duration of the window. |
| Dynamic content | Live regions: `polite` for toasts and section updates, `assertive` only for errors that block the current action. |
| Landmarks | `banner`, `navigation`, `main`, `contentinfo` on every page. Today's sections are `region`s labelled by their headings. |

### 7.4 What web does not have in v1

Stated so nobody builds it by accident:

- Push notifications, service worker, browser permission prompt — see
  [`notifications.md`](notifications.md#62-web).
- Camera capture. `Photos` on web is a file picker only.
- iOS share-sheet ingestion.
- Offline write queueing beyond the session — the web build keeps the queue in memory and
  warns on unload if it is non-empty; it does not persist it to IndexedDB.
