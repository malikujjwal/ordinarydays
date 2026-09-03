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
| U2 | **Tap a checkbox → complete.** | Only `task` rows and List items whose state mode is `checkbox` have one. A List checkbox sets intrinsic `state` (`done`, or `open` when unchecking); it is a separate accessibility element with its own 44×44 hit target. |
| U3 | **Swipe → contextual actions.** | Right reveals the row's single positive action; left reveals up to three secondary actions. Full-swipe commits only the *first* action on that side, and never a destructive one. |
| U4 | **Tap a date or time → reschedule.** | Anywhere it is rendered: the row's time column, the plan detail's when/where block, a list item's state line. It opens the reschedule sheet; it never edits in place. |
| U5 | **Share → add people.** | One affordance and one sheet on every Plan and List. Tasks have no Share control and no direct participant roster; a prep Task is accessible only through its explicit parent Plan. On a Plan, Share also copies an invite link; a List has no link ([`sharing-and-people.md`](sharing-and-people.md#4a3-inviting-someone-who-does-not-have-an-account)). |
| U6 | **`⋯` → everything else.** | Edit, explicitly change Task/Plan or Plan kind, duplicate, mute, cancel, delete. Nothing destructive lives anywhere but here (and behind a swipe-revealed button that still requires a tap). |

Two supporting rules:

- **Long-press is reorder or an action surface, never a hidden action.** In a reorderable
  list it starts a drag. Elsewhere it opens the same actions available through swipe, an
  accessibility action or the `⋯` menu. No action exists only behind a long-press.
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
Turn "Sunday dinner" into a General plan?    ← names the object and the change

This will remove:                            ← the fields, by their user-facing labels
  Meal slot: Dinner
  Ingredients: 7
                                             ← the exact count of affected records
Keeps: title, notes, date, people and attachments.
                                             ← what survives, whenever anything does

                              [ Cancel ]  [ Change to General ]
```

1. `Cancel` sits first and is the default focus. The destructive button repeats the verb —
   never `OK`, never `Continue` — and carries the `danger` styling.
2. The count is the number of records that **actually carry the data being removed**, not
   the collection's size. A 20-item list where 7 items have progress says 7.
3. For a change that is destructive only *conditionally* — a type change,
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
| A list's item-state presentation | additive both ways | — (intrinsic state is retained when hidden or represented differently) |
| A list's Progress, Place or Sub-items feature, on or off | additive both ways | — (typed values are retained when off) |
| A list's default `slot` | additive | — (moves no items) |
| `Clear checked` on a list | destructive but reversible | **No confirmation dialog.** It applies immediately and the six-second bulk undo toast states the count — `7 items cleared` (§4). A reversible bulk action gets an undo, not a dialog, and having both would be two interruptions for one decision |
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
| Setting a plan's cover photo (P3-42) | additive | — (no confirmation; the standard undo) |
| Deleting a photo from a plan (P3-42) | destructive | The photo by position — `Delete photo 2 of 3?` — and, when it is the cover, that the plan will have none until another is set. `Keeps:` everything else on the plan |

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
| Completing an `event` created through `Plan this item` from an item with enabled Place and exposed state | Change state, move, hide or delete the item | `Mark {item title} visited in {list name}?`; completion itself leaves the item unchanged ([`plans-and-lists.md`](plans-and-lists.md) §5.10) |
| Completing a watch session | Write season or episode onto the named source-list item, or change intrinsic state | `{list name} · currently S2 E4 — Update to S2 E5?`, or an explicit `Mark done?` suggestion when state is exposed |
| Progress having just been updated | Create the next episode's session | `Create a Plan for S2 E6?`, which opens an unselected Plan-kind chooser; only after Watch is explicitly chosen may compatible fields pre-fill, and nothing is created until `Save plan` |
| Completing a meal | Add its ingredients to a user-chosen list | `Add ingredients to a list?`, which opens the ingredient picker and then visibly names the destination before any write |
| Completing a plan with open prep tasks | Complete, delete, reschedule or otherwise touch the prep tasks | When at least one is incomplete and non-recurring: `2 one-off prep tasks are still open — keep them?` — Keep / Complete all / Delete. Keeping or dismissing changes nothing; the other two write only when tapped and affect only that named non-recurring set. Recurring prep tasks are kept because no occurrence was selected ([`plans-and-lists.md`](plans-and-lists.md) §3) |
| Creating or opening a plan | Create a packing, shopping or grocery list for it | The `Add list` affordance in the LISTS section |
| Completing one occurrence of a recurring series | Alter the recurrence rule, or mutate the series row | Nothing. The next occurrence already exists by definition |
| Capture extracting compatible fields from a photo, link or text | Persist, route, classify, share, attach anything, or set a reminder on its own | A reviewable draft inside the already selected form, committed only by its named write button; Reminder remains a separate visible control or an explicitly saved default |
| Renaming a list | Change its state presentation, features, integration or slot to match the new name | Nothing. The user changes those in list settings if they want to |
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

The global `+` always opens **Task / Plan / Add list** in that fixed order, with nothing
selected. A contextual control fixes intent only by naming it: `+ Add a task`,
`+ Add an item`, or `+ Add prep task`. Plan then requires **General / Meal / Watch /
Event**, also fixed and unselected; General is an explicit choice, never a hidden
fallback. `Add list` opens the ordinary unselected seven-type List catalogue. List items are
created only from a contextual control inside the List that owns them.

In an open List, `+ Add an item` opens the List-owned rapid-entry row inline in the same
scrolling measure, with the header and current content still visible. The current List fixes
the destination, so there is no destination chooser or `New list`. One underlined field is
accessibly named `Add item to <list name>`; the visible action is `Add`, with `Done adding`
beside it. Note and typed features remain in Item details. The row must remain scrollable above
the software keyboard as the List grows. Return performs the same write, clears the title after
success, and keeps the field focused for another item.

Text, photos, links, and AI are enabled only after those choices. They may suggest
compatible field values but never object kind, Plan kind, people, sharing, destination,
reminder/notification state, or the save action. A reminder is set only by its visible
control or the user's explicitly saved default; words such as `remind me` never change it.
Final Activity controls name the write: `Save task` or `Save plan`. The rapid List-item row
names its destination on the field and uses `Add`. Every
ListItem's `Plan this item` flow additionally requires an
unselected **Just me / Choose people** choice; membership is never copied to the Plan,
whether the source list is private or shared.

General `New list` opens the fixed seven-choice catalogue with nothing selected, then a title
step for the chosen choice. A calling flow may return with the created List selected, but it
never filters, reorders or preselects the catalogue from a desired destination slot. There is
no name-first matching, recommendation, ranking or fallback.

`objectKind` persists Task versus Plan. Tasks cannot gain participants or expenses; a
coordinated to-do is explicitly **Plan → General** or another visible Plan kind. An explicit
Task → Plan conversion requires a visible Plan-kind choice. Plan → Task is blocked until
participants, expenses, and prep children are removed, then previews any type-specific
field loss. A Plan-kind-only change cannot change `objectKind`; edits and capture never
invoke conversion.

### 1a.4 Settings are configuration, not a wizard

A settings surface groups independent controls by consequence and keeps the user on the same
object. A boolean switch applies the named boolean; a segmented control changes one small
mutually exclusive mode; a row with a chevron opens one focused editor or chooser. No row
combines a switch and chevron, and no chevron is decorative.

Reversible independent settings apply immediately and optimistically, with the exact Undo
policy in §4. They do not wait behind a page-wide `Save`, `Next` or `Done`. A footer commit is
reserved for a real multi-field draft. A dependent setting is absent until its parent makes it
meaningful. First enabling a feature that needs configuration may open one focused child
surface; subsequent visits summarize the configured value on the parent row and offer `Edit`.

Destructive actions are separated into a final management section and follow §1a.1; danger
styling never substitutes for a consequence-naming confirmation. These rules apply wherever a
product spec defines settings. They do not create or specify an app-wide Settings page.

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
| Global `+` | 56 × 56 pt | Accessible label `Add`; always opens Task / Plan / Add list, never a preselected form |
| Today's `See all (n)` **ANYTIME · NO DATE** footer | Full row width, min height 44 pt | Pushes the **Anytime** screen; never expands rows in place. This is a pushed route, not a fourth tab. |

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
| Task, untimed (pushed Anytime screen) | Open task detail | Complete | `Complete` | Complete | `Schedule` · `Delete` | Schedule sheet | Preview + `⋯` menu |
| Task, overdue (rolled forward) | Open task detail | Complete | `Complete` | Complete | `Do today` · `Reschedule` · `Delete` | Sets `schedule.date` to today | Preview + `⋯` menu |
| Task, recurring occurrence | Open occurrence-scoped task detail | Complete **this occurrence** | `Complete` | Complete this occurrence | `Snooze` · `Skip` · `Edit series` | Snooze sheet | Preview + `⋯` menu |
| Meal | Open plan detail | — (no checkbox) | `Had it` | Had it | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Watch | Open plan detail | — | `Watched` | Watched | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Event | Open plan detail | — | `Attended` | Attended | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
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

| Tomorrow preview row (Today) | — | — | — | — | — | — | — |

**The Tomorrow preview has no gestures at all** — the one row in this document with a fully
empty line, and deliberately so. It is a time-and-title overview, not a row: no checkbox, no
swipe, no long-press, no resolution prompt, and **no tap**, so it is absent from the tab order
and carries no `accessibilityRole`. The day it describes is not today's to act on; tomorrow is
reached through Plans ([`today-and-tasks.md`](today-and-tasks.md) §2). Added 2026-08-12
(founder), narrowed to non-interactive 2026-08-17, built by P2-45.

The pushed **Anytime** route uses the same AgendaRow actions, swipe gestures,
accessibility actions and undo policy as an untimed Today row. Only Today's group-3
footer navigates to it; back returns to the same bounded Today list. The three-tabs-only
rule applies to the tab bar, so this pushed screen does not add a tab.

### 3.2 List rows

Rows use one common item shell. The List's state presentation controls only the state affordance;
the typed feature registry adds populated one-line summaries and actions. `templateKey` never
selects a row implementation.

| Row type | Tap body | Tap checkbox | Swipe right | Swipe right (full) | Swipe left | Swipe left (full) | Long press |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List (on the Lists index), you own it | Open the list | — | — | — | `Archive` · `Delete` | — | Open the same Archive / Delete action sheet |
| List (on the Lists index), you are a member | Open the list | — | — | — | `Leave` | — | Open the same Leave action sheet |
| Item, checkbox mode | Open item sheet | `done → open`; `open/active → done` | `Check` / `Uncheck` | Set the same explicit state | `Plan this item` · `Delete` | Plan-kind chooser | Drag to reorder within its list |
| Item, no state presentation | Open item sheet | — | `Plan this item` | Plan-kind chooser | `Delete` | — | Drag to reorder |
| Item, stages | Open item sheet | — | `Plan this item` | Plan-kind chooser | `Delete` | — | Drag within its current stage; changing stage is an explicit item-sheet action |
| Item with a state line (`Planned Saturday · 7 PM`) | Title area → item sheet; **state line → the linked Activity** | As above | As above | As above | As above | As above | Drag to reorder |

The Lists **index** is not reorderable: `ListIndex` stores no rank, and active and archived
groups render newest-created first from their stable time-sortable `listId`. Reordering applies
to the items *within* a list, never to the lists themselves. On mobile, long-pressing a List
card opens a polished action sheet that duplicates Archive / Delete or Leave; swipe and
accessibility actions remain equivalent ways to reach the same operations.

Every reorderable List item has a visible neutral grip at its trailing edge on touch layouts.
It is an affordance for the existing gesture, not a second operation: long-pressing either the
row or the grip starts the same drag, and tapping the body still opens item detail. On pointer
layouts the grip appears on row hover and focus (§7.1). The grip is the final accessibility
element, labelled `Reorder <item title>`, and exposes `Move up` / `Move down`; a grouped staged
List bounds those actions to the current populated stage.

### 3.3 Plan detail rows

| Row type | Tap | Swipe | Long press |
| --- | --- | --- | --- |
| When/where block | Reschedule sheet. Owner only; for a participant the block is not interactive | — | — |
| Address line within it | Open the platform maps app | — | Copy address |
| Reminder row within it | Your own reminder's picker. Never shows or reaches anyone else's ([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1) | — | — |
| Functional capability disclosure | Toggle its inline content; the row exposes its expanded state and the chevron communicates the same change visually | — | — |
| Unimplemented Plan capability discovery row (`Coming later`) | — (non-interactive; no chevron or disabled action) | — | — |
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
> only after a confirmation dialog and have **no** undo. A longer window exists only when a
> row below names it explicitly; List settings and List bulk actions use six seconds.

This section decides which of the two an action gets. What a confirmation must *say* when
there is one is §1a.1.

### 4.1 The table

| Action | Confirmation | Undo | Window | Mechanism |
| --- | --- | --- | --- | --- |
| Complete a task or occurrence | No | Yes | 6 s | `POST .../uncomplete` |
| Complete a plan (any type, any outcome) | No | Yes | 6 s | `POST .../uncomplete` |
| Skip an occurrence | No | Yes | 6 s | Delete the `Occurrence` |
| Skip a one-off task | No | Yes | 6 s | `POST .../uncomplete`, restoring `scheduled` when it has a date and `saved` when it does not. Added 2026-08-15: [`today-and-tasks.md`](today-and-tasks.md#54-skip) §5.4 has always put a skip on "any task", and this table named only the occurrence case, so the one write that changes an Activity's own status had no undo row |
| End a series | No | Yes | 6 s | `PATCH` clears `recurrence.endDate` ([`activities.md`](activities.md) §6.4) |
| Snooze | No | Yes | 6 s | Delete the snooze fields |
| Check / uncheck a list item | No | Yes | 6 s | `PATCH` back |
| Reschedule, where no participant has responded | No | Yes | 6 s | `POST .../schedule` with the previous values |
| Set or change the date on a plan people **have** responded to | **Yes**, naming how many replies are discarded (§1a.1) | No | — | The write resets every RSVP and notifies everyone. Undo would ask them all a second time, which is worse than the confirmation it replaces |
| RSVP change | No | Yes | 6 s | `PATCH` back |
| Suggest a date, or withdraw your own suggestion | No | Yes | 6 s | `DELETE` the suggestion, or re-create it |
| Mark a suggestion as `Works for me`, or unmark it | No | Yes | 6 s | Toggle back |
| Delete somebody else's suggestion, as the owner | **Yes**, naming whose it is | No | — | Removing something another person wrote is confirmed, never undone quietly |
| Clear checked (bulk) | No | Yes | **6 s** | Re-create the deleted items with their previous ranks and states |
| Uncheck all (bulk) | No | Yes | **6 s** | Return the affected surviving items to `done` |
| Archive a list | No | Yes | 6 s | `POST /v1/lists/:id/undo` with the settings-operation token returned by `PATCH { archived: true }` |
| Change a list's item-state presentation or feature configuration | No | Yes | 6 s | `POST /v1/lists/:id/undo` with the settings-operation token. Values are retained in both directions (§1a.1) |
| Change a list's default-destination slot | No | Yes | 6 s | `POST /v1/lists/:id/undo` with the settings-operation token. Restore a removed profile default only when no newer choice occupies that slot |
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
| Set a plan's cover photo | No | Yes | 6 s | `PATCH primaryAttachmentId` back to the previous cover, or `null` |
| Delete a photo from a plan | **Yes**, naming the photo (§1a.1) | No | — | `DELETE /v1/activities/:id/attachments/:attachmentId`; deleting the cover clears `primaryAttachmentId` in the same write |

### 4.2 Toast rules

- **A toast is for undo, not for applause** (2026-08-13). A routine mutation does **not** get a
  success toast: the screen's own state is the confirmation, and a toast that only says "done"
  interrupts to tell the user something they can already see. A toast appears when this contract
  uses it to expose **undo** — which is exactly why completion has one, and why checking a task
  is not an exception to this rule but the reason for it. The row's own check, strike and dimming
  report the change; the toast carries the six seconds in which it can be taken back.
- One toast at a time. A new action replaces the visible toast and **commits** the previous
  one immediately.
- The toast sits above the tab bar, is swipe-dismissible, and dismissing it commits.
- Undo restores the exact prior state, including sort position and scroll offset.
- The optimistic update is applied instantly; the network call fires immediately, not at the
  end of the window. Undo is a compensating call, not a delayed commit. This keeps the app
  correct when it is closed mid-window.
- For an offline-capable action, the durable coordinator — not one HTTP promise — decides the
  result. A transient request failure leaves the optimistic row projected and queued. The row
  reverts and the toast becomes an error toast with `Retry` only when durable append was
  refused or the server permanently rejected the action. Undo after dispatch is itself a
  durable dependent action, so closing the app cannot lose it.
- An API `undoExpiresAt` is the deadline for **offering a new Undo in the UI**, not a server
  replay deadline. If the user accepts while the toast is visible, the inverse is durable and
  remains replayable through `MAX_AUTOMATIC_INTENT_AGE_DAYS`; crossing the presentation
  deadline while queued or in flight never discards it.
- Toasts announce themselves to screen readers with `accessibilityLiveRegion="polite"` and
  their `Undo` button is focusable.

---

## 5. Loading, empty, error and offline states

One contract, applied identically everywhere.

### 5.1 Loading

| Situation | Presentation |
| --- | --- |
| First load of a screen with no cached data | Skeleton rows matching the real layout's shape and count (5 rows), with no spinner and no text. Minimum display 200 ms to avoid a flash. **Explicit exception:** Plans uses one centred activity indicator announced as `Loading plans` (`plans-and-lists.md` §1.3.3). |
| Refresh of a screen with cached data | Cached content stays fully visible and interactive. A 2 pt progress bar under the header. **Never** a blocking spinner over existing content. |
| Pull to refresh | Platform refresh control. Web: a `Refresh` button in the header plus `R`. |
| A mutation in flight | The affected row is optimistically updated. No spinner on the row. A spinner appears only on a modal's primary button, and only after 400 ms. |
| Pagination | A single skeleton row at the list's foot; auto-fetch at 80 % scroll depth. |
| Anything over 10 s | Becomes an error state (§5.3) with `Retry`. |

### 5.2 Empty

Every empty state is: a one-line heading stating the fact, one line of guidance, and at
most one action. No large illustrations, no congratulation, no exclamation marks. A surface
may use one compact semantic icon only where its product row below explicitly permits it.

Guidance copy says what to add. It never says what the thing will turn into later, and it
never describes a surface as somewhere things wait — `until`, `yet`, `someday`, `ready to`
and `turn into` are banned from empty-state copy for exactly that reason
([`overview.md`](overview.md#47-lists-are-destinations-not-staging-areas) §4.7).

| Screen | Heading | Guidance | Action |
| --- | --- | --- | --- |
| Today, nothing at all | `Nothing planned today` | `Add something you want to do, or check your Lists.` | `Add` |
| Anytime, no saved tasks | `No anytime tasks` | `Add a task without choosing a date.` | — |
| Plans → Needs a date, empty | `Nothing without a date` | `Plans you've started but not scheduled show up here.` | — |
| Plans → Upcoming, empty | `No upcoming plans` | `Anything with a date shows up here.` | `Add` |
| Plans → Past, empty | `Nothing here` | `Plans that have happened show up here.` | — |
| Plans, all three stages empty | `No plans` | `Add something you want to do, on its own or with someone.` | `Add` |
| Lists index | `No lists yet` | `Keep things you want to remember, track, or organise together.` | `New list` |
| A list | `Start with one item` with one compact List icon tile | The List's stored `emptyStateCopy`, seeded from the explicitly selected style, says what to add ([`plans-and-lists.md`](plans-and-lists.md) §5.9) | `Add item` |
| Search, no results | `No matches for "zahav"` | — | — |
| People | `No one yet` | `People appear here when you share a plan or list with them.` | — |
| Person, no shared plans, active shared lists or balance | `Nothing together yet` | — | `Plan something with Alice` |
| Balances | `Nothing outstanding` | — | — |
| Notification inbox | `Nothing new.` | — | — |
| Expenses on a plan | — | — | `Add expense` alone |

Every empty-state action labelled `Add` is the global Add action: it opens **Task / Plan /
Add list** with nothing selected. The screen the empty state appears on does not choose the
object. `Add item` inside an open List is deliberately different: it is a contextual action,
so it opens the List-item composer with that List visibly fixed.

Section-level empty states on Today are specified in
[`today-and-tasks.md`](today-and-tasks.md#25-empty-states).

### 5.3 Error

| Class | Presentation | Recovery |
| --- | --- | --- |
| Screen-level load failure (no cached data) | Full-screen: `Couldn't load this.` plus the request id in small text | `Try again` |
| Native local-state startup failure | Full-screen: `Couldn't open your data.` The app remains blocked so it never renders without its account-scoped SQLite state. | `Retry` repeats persisted-cache restoration and native session startup |
| Screen-level refresh failure (cached data present) | Cached content stays. A dismissible banner: `Couldn't refresh.` | `Try again` |
| Mutation failure | The optimistic change reverts; error toast naming what failed: `Couldn't complete "Gym."` | `Retry` |
| `409 conflict` on a shared plan | `This plan changed while you were editing.` Client refetches; non-overlapping edits are re-applied, overlapping ones are dropped and named. | `Review` |
| Adding ingredients whose source rows have changed | Toast: `Some of those ingredients have changed. Reopen the meal and try again.` The whole action is refused rather than partly applied, so the list is exactly as it was ([`plans-and-lists.md`](plans-and-lists.md) §7.3) | `Reopen` returns to the meal |
| `403 forbidden` | `Only the person who made this plan can change that.` | — |
| `404 not_found` | `This isn't here any more.` Navigate back. | — |
| `422 participant_limit_exceeded` | Inline in the picker: `You can add up to 50 people to a plan.` | — |
| `422 reminder_limit_exceeded` | Inline in the reminder picker: `You can add up to 3 reminders.` | — |
| `422` on a sixth date suggestion | Inline in the suggestion sheet: `You can suggest up to 5 dates.` | — |
| `429 rate_limited` | `Too many requests. Try again in <Retry-After>.` | Auto-retry once after the header's delay for `GET`s only |
| Attachment upload failure (P3-41) | The row shows the failure; error toast: `Couldn't upload that photo.` — or the envelope's own message for a `429` from the upload-url route. An expired presigned URL is retried silently once before this shows. | `Retry` runs the whole chain again from a fresh URL |
| Attachment refused before upload (P3-41) | Inline under the picker's buttons, no request made: `Photos must be JPEG, PNG, HEIC or WebP.` / `Photos must be under 10 MB.` | Pick another photo |
| Creation form with a photo still moving or failed (P3-41) | The save button waits: `Waiting for the photo to finish uploading.` / `Retry or remove the photo to save this.` — a save that silently dropped the photo would lose user content | `Retry` or `Remove` on the row |
| `426 upgrade_required` | Blocking screen: `Update Ordinary Days to keep going.` | `Update` → `updateUrl` |
| `501 not_implemented` (capture) | Silent on the text path; the manual-entry message on image/link paths | See [`ai-capture.md`](ai-capture.md#61-the-failure-matrix) |
| `500 internal` | `Something went wrong.` plus the request id | `Try again` |

Error copy never shows a stack trace, an error code, or the word "error" in the heading.
When an API failure supplies a `requestId`, it is always shown in small text and is
long-press-copyable, so a support message can name it. A local startup failure has no
request id to invent.

### 5.4 Offline

| Aspect | Behaviour |
| --- | --- |
| Detection | Connectivity state plus request failure. Connectivity only schedules sync; it never clears, reconstructs or directly changes visible native rows. |
| Indicator | A compact, non-blocking status in Today's header, between `Today` and the completion count: normal online use renders nothing; offline with no replayable writes shows cloud-off + `Offline`; offline with writes shows cloud-off + `<n> waiting`; back online with writes shows cloud-sync + `Syncing…`; after the last write lands, cloud-check + `Synced` appears for 2 seconds and then disappears. The flexible middle slot remains in layout while its contents come and go, so the title and trailing actions/count never move. `needs_attention` writes are excluded from waiting/syncing because they require Retry or Discard and already surface in the recovery banner. Amended 2026-08-19 (founder). |
| Reads | After a native domain migrates, screens query already-materialized typed SQLite rows. Today works fully offline for known local coverage and never combines a response with intents during render. Web continues to serve its last persisted TanStack response. |
| Writes | On migrated native domains, accepted state plus its durable outbox intent commit in one transaction, ordered by explicit `ordering_key`, with stable unique mutation identity and `Idempotency-Key`. A blocked N prevents N+1 for that key while unrelated work may progress. Web remains online-first and has no durable queue. |
| Queued row indicator | Cloud-off + `Pending`, in a neutral colour at the end of the row's existing metadata line. It never adds its own trailing line; metadata truncates before the status can widen or wrap the row. |
| Conflicts on reconnect | Server state wins for fields the user did not touch. A queued write that returns `409` surfaces one banner: `<n> changes couldn't be applied.` with a list. |
| Capture | Not attempted offline ([`ai-capture.md`](ai-capture.md#61-the-failure-matrix)). |
| Uploads | Queued; the attachment shows a placeholder until the upload succeeds. |
| Queue limits | 200 unacknowledged intents; beyond that, new writes are refused with `You're offline and there's a lot waiting to sync.` **Amended 2026-08-18 (P2-59):** the count is of queued *user data*, so `needs_attention` intents count — each still holds words the user typed. The refusal happens before the action is reported accepted, never after, and `refused` is never persisted. |
| Undo while offline | Works. A queued original is cancelled atomically; once the original is in flight or acknowledged, Undo is a durable inverse ordered after it. |
| Pull to refresh | Calls the one serialized `syncNow()`, coalesced with overlapping foreground/reconnect work. A window requested after an active pull snapshots its work receives one follow-up bounded pass. Failure in push, coverage pull or targeted recurrence reconciliation is shared by concurrent refresh callers, retains every committed row, records a retryable sync error and exposes Retry; Today never becomes empty merely because refresh failed. |

**Transition invariants — amended 2026-08-18 (P2-60 evidence, ADR-057 runtime).** No accepted
action visually replays or reverses during offline/online flapping; a stale response arriving
last cannot regress it; restart restores the same visible state; agenda and detail never
disagree; and failed refresh never empties Today. P2-60's read-time overlay implementation is
superseded. These are product requirements implemented by write-time SQLite transactions and
ordinary typed repository reads on native.

**A pending entity is visible and inert — amended 2026-08-17 (Phase 2.6).** *"Applied
optimistically"* above describes a write against an entity the server already knows.
Something **created** offline is different: until its create is acknowledged it renders with
the `Pending` indicator and accepts **no server-directed mutation** — it cannot be
completed, rescheduled, edited, shared, or given an expense. **Local cancellation stays
available**, because cancelling an unsent create removes an intent that never left the
device; it is offered only while the intent is still queued, since a request already on the
wire cannot be retracted. The row says why in words; disabled controls are never the only
signal (§6.4). This boundary is deliberate — acting on an unsynced entity is P2-58, parked —
and a reminder on a pending activity states its true armed state (`Armed on this device ·
waiting to sync`; local scheduling landed in P2-57).

**Queued writes are user data, not cache.** They do not expire on cache age and are never
discarded by a cache-version change; each is persisted before the action is reported as
accepted (`tech-stack.md` §3.4 mechanism 5; mechanism 4 records its P2-59 lineage). After 30 days without acknowledgement — or
whenever the device clock proves untrustworthy — an intent stops replaying automatically and
enters **`needs_attention/parked`**: no automatic write; for a create, an online read-only check
may resolve it silently in the user's favour; otherwise the row asks
`This never synced — retry or discard?` where **Retry** performs the action now as a fresh
write and **Discard** requires the explicit tap. A permanently rejected write surfaces
as structured `needs_attention/rejected` through the `<n> changes couldn't be applied.`
banner above and is removed only by the user. Display text is never parsed to decide either
case.

### 5.5 Reschedule and snooze sheet copy

Added 2026-08-14 (P2-42). The two sheets that move something in time say what they are moving
and where the move lands, so the user is never asked to decode a shortcut or guess a blast
radius before committing to one. **This table is the copy.** Where it and a design frame
disagree, this wins; a string changed anywhere else is changed here in the same pull request.

| Surface | String | Why this wording |
| --- | --- | --- |
| Reschedule, each date option | `Today` · `Wed, Aug 12` — the relative label, its resolved date on the trailing edge | `Saturday` meant at least two different days depending on who read it. The row commits to a date it has already shown. Named weekdays replace `This weekend` and `Next week` for the same reason |
| Reschedule, removal action on a **one-off task** | `Move to Anytime`, `Keeps the task, drops the date` | The task is not deleted and does not stop existing; it goes to Today’s ANYTIME · NO DATE group ([`today-and-tasks.md`](today-and-tasks.md) §2) |
| Reschedule, removal action on a **plan** | `Remove date`, `Moves this plan to “Needs a date”` | An undated plan is a plan (`plans-and-lists.md` §1.2), and the hint names the stage it lands in |
| Reschedule, removal action on a **recurring occurrence** | `Skip this occurrence`, `Keeps the series, drops this day` | One day of a series has no date to remove; dropping it is a skip (§5.4 of [`today-and-tasks.md`](today-and-tasks.md)), and the hint says the series survives |
| Reschedule, series scope step | Heading `Apply changes to`, then `6:00 PM → 7:00 PM`, then `This occurrence only` / `All future occurrences` | The two options and what each writes are unchanged ([`activities.md`](activities.md#62-editing-schedule) §6.2). The heading and the before→after line exist because the question is asked **after** the edit, so the edit has to be visible while it is answered |
| Snooze, subject line | `Call the dentist · 3:00 PM` | Reached from a swipe the row was obvious; reached from anywhere else the sheet moved something it had not named |
| Snooze, blast radius — recurring occurrence | `Today only. Tomorrow stays 6:00 PM.` | A snooze writes an occurrence override and never touches the series. The time named is the **series** time, not the value a previous snooze landed on |
| Snooze, blast radius — one-off | `Today only. Nothing else changes.` | The honest version of the same sentence when there is no series. `Tomorrow` states its own destination on its own control |
| Activity detail, occurrence actions | `Snooze` and `Skip today`, secondary, side by side beneath the completion button | Added 2026-08-15. Both are ordinary daily actions and were reachable only through a swipe or the `⋯` menu. The completion button keeps its type-derived verb; these two do not vary by type. **Offered per [`today-and-tasks.md`](today-and-tasks.md) §5.3 and §5.4, not only on a series**: `Snooze` on any timed task, the skip on any task or any recurring occurrence, each also gated on its server-authored capability |
| Activity detail, the skip's label | `Skip today` on a **concrete recurring occurrence**; `Skip` on every one-off | Amended 2026-08-15 (founder). `Skip today` came from P2-47, where it always meant one day of a series. On a one-off the write is `POST /skip` with no occurrence — `status: 'skipped'` on the Activity, permanently — so the word named a scope the write does not have, and on an undated task it named a day the task was never on. Copy follows the object, the same rule the reschedule sheet's removal action follows |
| Activity detail, a pending entity, intent **queued** | `This task is saved on this device and waiting to sync. You can cancel it before syncing starts.` (`plan` replaces `task` for a Plan.) | Amended 2026-08-19 (founder). Says where the item is saved, what is waiting, and when cancellation remains possible without asking the user to interpret "unlocks" |
| Activity detail, a pending entity, intent **in flight** | `This task is syncing now. Its actions will appear when syncing finishes.` (`plan` replaces `task` for a Plan.) | The cancel offer is gone because the request is already on the wire. The changed sentence plainly explains both the current state and why actions such as Complete are temporarily absent |
| Activity detail, a pending entity, intent **needs attention** | `This task couldn’t sync. Use Retry or Discard in the message at the top of the screen.` (`plan` replaces `task` for a Plan.) | This is not active syncing. It points to the existing recovery controls and never leaves a false `Syncing…` status in the header |
| Activity detail, cancel action on a pending entity | `Cancel this` | Cancels the unsent create and nothing else. Not `Delete`: there is nothing on the server to delete, and the word would imply a request that is never issued |
| Activity detail, Reminder row on a pending entity | `Armed on this device · waiting to sync` | P2-57 schedules the reminder locally with its client-minted id before the create is acknowledged. The row states both truths: the notification is armed on this device and the server copy is still pending (§5.4). |
| Any row whose create has not been acknowledged | Cloud-off + `Pending` at the end of the metadata line | §5.4's indicator. Not an error colour, and never the only signal — the checkbox is **absent** rather than disabled, and the row's accessible name says it is saved on this device and waiting to sync. Copy-parameterised, so Phase 3's `Plan will finish syncing` is this component with different words |
| Activity detail, a skipped activity | `Skipped`, then `It won't appear on your day.` — or `This day only. The series carries on.` on a series, in `textMuted` | Added 2026-08-15. A skip used to render the same single green line as a completion, which read as an outcome achieved rather than one declined. `textMuted` is the founder's ruling and is the token the skipped row on Today uses, so the state reads the same on both surfaces |
| Activity detail, a declined outcome | `Didn't go` / `Didn't happen`, in `textMuted`, above `Undo` | Added 2026-08-15. The user's own words back. Stored as `status: 'skipped'` with the outcome, so it is neither a completion nor a bare skip |
| Agenda row, a skipped row | `Skipped`, `subhead` in `textMuted`, beneath the title, and spoken in the row's accessible name | Added 2026-08-15. `today-and-tasks.md` §3.2's "de-emphasised" was 0.62 opacity and nothing else |
| Snooze, a rejected picked time | `Choose a time later than now.`, or `Choose a time after 6:00 PM.` when the occurrence itself is the boundary | Amended 2026-08-15. The first names a boundary that is not the one being enforced on a task that has not come due |
| Activity detail, reversing a skip | `Undo skip` | §3.1 already gives this action that label on a skipped row. `Undo` belongs to a completion, and using it for both made the two states differ only by one word of green text |

The one string this section does **not** own is `Remove the date`, the confirm button on a
shared plan's date removal: that dialog is §1a.1's shape and [`activities.md`](activities.md)
§6.2's copy, and repeating it here is how two copies drift.

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
given. The table lists each row's content controls; every reorderable List-item row then
appends the `Reorder <item title>` grip defined in §3.2. `accessibilityRole` is stated;
`accessibilityHint` is used only where the action is not obvious from the label.

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
| List item, checkbox mode | 1. Checkbox<br>2. Row body | 1. `Chicken, not checked`<br>2. `Chicken, from Sunday dinner` | `checkbox`, `button` | `Plan this item`, `Delete` |
| List item, state hidden | 1. Row body<br>2. linked Plan state line when present | 1. `Zahav`<br>2. `Planned Saturday 7:00 PM, open plan` | `button`, `button` | `Plan this item`, `Delete` |
| List item with enabled, populated Place | 1. Row body<br>2. Address line | 1. `Zahav, 237 St James Place`<br>2. `237 St James Place, open in Maps` | `button`, `button` | `Plan this item`, `Delete` |
| List item in configured Watching stage with episode Progress | 1. Row body<br>2. linked Plan state line | 1. `Severance, watching, season 2 episode 4`<br>2. `Next session Friday 8:00 PM, open plan` | `button`, `button` | `Plan this item`, `Delete` |
| Person row | 1. Row body<br>2. Balance chip | 1. `Alice, 3 upcoming together` or `Priya, in 2 lists with you`<br>2. `Alice owes you 42 dollars 50, see the expenses` | `button`, `button` | `Plan something`, `Delete` |
| Balance line | 1. Line | `Alice owes you 42 dollars 50. See the expenses behind this.` | `button` | — |
| Expense row | 1. Row body | `Hotel, 340 dollars, you paid, split 3 ways` | `button` | `Edit`, `Delete` |
| Participant row | 1. Row body | `Alice, going` / `Chloe, invited, guest` | `button` | `Resend invite`, `Copy link`, `Remove` |
| Notification row | 1. Row body | `Alice invited you. Dinner at Zahav, Saturday 9 August 7:00 PM. Unread.` | `button` | `Mark read`, `Delete` |
| Section header | 1. Header | `Up next`, `Earlier today`, `Schedule`, `Overdue`, `Today · no time`, `Anytime · no date` | `header` | — |

> **The linked Plan state line is its own element** — corrected 2026-08-28 (founder), on the
> discrepancy raised in P3-28's PR. That row used to fold `next session Friday 8:00 PM` into the
> body label while the two rows above it made the state line a separate element, and P3-35
> requires "two separate accessibility elements" because the two targets go to two different
> screens: the body opens the item, the state line opens the Activity. One label carrying both
> would announce the session twice and offer only one destination. The split above is the rule
> for **every** list-item row, whatever its state presentation or enabled features.

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
| `N` | Open the global **Task / Plan / Add list** chooser |
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
| `Alt + 1`–`3` | On the global chooser: Task, Plan, Add list |
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
