# Phase 9 — Follow-up, personalisation and public launch

## Goal

At the end of this phase the lifecycle closes. Completing something offers the one contextual
next step that makes sense — update the episode, add the ingredients, review the expenses —
and never writes anything without a tap. The app remembers what a person does repeatedly:
favourite meals, custom-activity shortcuts, the next episode. It works on a subway, with
typed native SQLite state and a transactional outbox whose conflict rules are written down
rather than emergent — including for a shared grocery list two people are ticking through from two
shops, one of them with no signal. It reaches into iOS properly, with a share extension
that accepts a link, a screenshot or a photo, and a home-screen widget that shows what is next without the app
running. Performance and accessibility stop being aspirations and become measured numbers with
gates. And then it ships: App Store review passed, phased release running, crash reporting
live, alarms confirmed, and a runbook that tells one person what to do at 2 a.m.

## Prerequisites

| # | Requirement | Source |
| --- | --- | --- |
| 1 | Phases 0–7 complete and deployed to prod | Phases 0–7 |
| 2 | The completion endpoints and outcome verbs work for every type | Phase 2 |
| 3 | Watch ListItems, viewer-local `LNK#` rows, Activity `listId` / `listItemId` provenance, and meal ingredients exist | Phase 3 |
| 4 | Balances, obligation-settlement status and the `Balance` cache work | Phase 7 |
| 4a | Shared lists ship: members, roles, the leave flow, and item writes with no `If-Match` | Phase 6. The offline tasks here are the first place a second writer meets a cached copy. |
| 5 | P2-63 SQLite native-state gate, the web TanStack adapter, and `Idempotency-Key` on every creating `POST` | Phases 1 and 2.6 |
| 6 | An Apple Developer Program membership, an App Store Connect app record, and a live privacy policy URL | Phase 5 |
| 7 | EAS build and submit profiles, and an `expo-updates` channel per environment | Phase 5 |

## Deliverables

- [ ] Follow-up suggestions on completion, one at a time, never writing without a tap.
- [ ] Watch progress increment and the next-episode suggestion, which creates nothing.
- [ ] Meal favourites and custom-activity shortcuts.
- [ ] The last two recurrence modes: completion-relative and custom `rrule`.
- [ ] The opt-in monthly unsettled-expense reminder.
- [ ] Offline: specified typed native materialized rows, a transactional outbox, and written conflict
      rules — including which shared-list mutations queue safely, which are refused, and what
      happens when a shared list changes underneath a retained local copy.
- [ ] An iOS share extension accepting a URL, plain text or one image.
- [ ] A home-screen widget in two sizes, reading a snapshot, never the network.
- [ ] Performance budgets measured and gated in CI.
- [ ] An accessibility pass against
      [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6,
      with automated checks.
- [ ] Crash and error reporting, and a Log Insights query pack in place of product analytics.
- [ ] App Store submission, review passed, phased release.
- [ ] A post-launch operations runbook.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P9-01 | Follow-up suggestion presentation | mobile | — | yes | M |
| P9-02 | Watch progress increment and the next-episode suggestion | mobile/api | P9-01 | no | M |
| P9-03 | Meal follow-up and meal favourites | mobile/api | P9-01 | no | M |
| P9-04 | Custom-activity shortcuts | mobile/api | — | no | L |
| P9-05 | The monthly unsettled-expense reminder | api/infra | — | yes | M |
| P9-06 | Offline coverage allow-list: native rows and web persisted reads | mobile | — | no | L |
| P9-07 | Offline: list outbox semantics | mobile | P9-06 | no | L |
| P9-08 | Offline: conflict resolution | mobile | P9-07 | no | L |
| P9-09 | Offline: indicators, limits and undo | mobile | P9-07 | no | M |
| P9-10 | Offline: the upload queue | mobile | P9-07 | no | M |
| P9-11 | The iOS share extension target | mobile | — | yes | L |
| P9-12 | Share payload ingestion | mobile | P9-11 | no | M |
| P9-13 | The widget target and the snapshot writer | mobile | — | yes | L |
| P9-14 | Widget timelines, deep links and the privacy toggle | mobile | P9-13 | no | M |
| P9-15 | Lambda power tuning and the memory decision | infra | — | yes | M |
| P9-16 | Server performance pass: agenda, projections, round trips | api | P9-15 | no | M |
| P9-17 | Client performance pass: lists, renders, images | mobile | — | yes | L |
| P9-18 | Web bundle budget and route splitting | web/ci | — | yes | M |
| P9-19 | Accessibility audit and automated checks | mobile/ci | — | no | L |
| P9-20 | Dynamic type and AX5 layout pass | mobile | P9-19 | no | M |
| P9-21 | Contrast, dark mode and reduce-motion pass | mobile | P9-19 | no | M |
| P9-22 | VoiceOver labels and accessibility E2E | mobile/ci | P9-19 | no | M |
| P9-23 | Crash and error reporting | mobile/ci | — | yes | M |
| P9-24 | Analytics via structured logs and a query pack | api/infra | — | yes | M |
| P9-25 | App Store Connect setup, metadata and privacy labels | ops | — | yes | M |
| P9-26 | Screenshots, review notes and the demo account | ops | P9-25 | no | M |
| P9-27 | The release pipeline: EAS production build and submit | ci | P9-25 | no | M |
| P9-28 | EAS Update channel and a hotfix rehearsal | ci | P9-27 | no | M |
| P9-29 | Phased release and a rollback rehearsal | ops | P9-27 | no | M |
| P9-30 | The operations runbook | docs | — | yes | L |
| P9-31 | Launch checklist execution | ops | all | no | M |
| P9-32 | Post-launch day-1 and day-7 verification | ops | P9-31 | no | S |
| P9-33 | Retention and maintenance job hardening | api | — | yes | M |
| P9-34 | Completion-relative recurrence (`mode: 'after_completion'`) | shared/api | — | yes | L |
| P9-35 | Custom recurrence via RFC 5545 `rrule` | shared/api | P9-34 | no | L |

---

### P9-01 — Follow-up suggestion presentation

**What to build.** The single contextual next step in
[`../01-product/activities.md`](../01-product/activities.md) §5.3.

**Approach.** Completion returns, alongside the updated activity, a `followUp` object naming
**at most one** suggestion. Its presentation rules — one at a time, inline in the
confirmation toast slot, dismissible, never pre-selected, never writing on its own — are the
product-wide invariant in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a-product-wide-invariants)
§1a.2, not a rule local to this task.

| Completed | Suggestion | On tap |
| --- | --- | --- |
| `watch`, a show with season and episode | `{list name} · currently S2 E4 — Update to S2 E5?` | Updates that named item, then offers `Create a Plan for S2 E6?` as a **separate** second step |
| `meal` with ingredients | `Add ingredients to a list?` | Opens the ingredient picker, then the destination sheet (P3-43); names the destination before writing only what the user selects, where they chose |
| Any type, ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigates. No write. |
| Any type, ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the sheet. No write until saved. |
| A recurring occurrence | Nothing | The next occurrence already exists |

The selection order is fixed and the first match wins, so a completion never produces two
prompts.

**Tests.** One suggestion at most, in the documented precedence; dismissal writes nothing; each
suggestion's tap target performs exactly the stated action; a recurring occurrence produces
none.

---

### P9-02 — Watch progress increment and the next-episode suggestion

**What to build.** The behaviour in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §8.4, without the bug
the concept explicitly warns against.

**Approach.** Completing a watch session with `outcome: 'watched'` writes the Activity's
completion fields and returns at most one follow-up. It never updates a ListItem. When the
Activity's `listId` / `listItemId` provenance resolves to a Watch item the owner may access,
and the caller's `LNK#<viewer>#<itemId>` row still points to this Activity, the follow-up names
the source list and offers `Update to S2 E5?`. Only tapping that named action
issues the ListItem `PATCH`, copies the watched season and episode, and changes `want` to
`watching`; its response may then offer the separate action `Create a Plan for S2 E6?`.

Tapping `Create a Plan for S2 E6?` explicitly fixes the destination as **Plan**, then opens an unselected
Plan-kind choice: **General**, **Meal**,
**Watch**, **Event**. Only after the user chooses **Watch** does the editor show
the next episode, service, and same-time-next-week values for review. Audience is also
unselected: the user must choose **Just me** or **Choose people**. If they choose people, the
previous Plan's participants may appear as unchecked suggestions but are never preselected.
Nothing is created until the user taps **Save plan**.

> A code path that writes an Activity directly from the follow-up is a bug, not a shortcut.
> An integration test asserts that completing a watch session creates exactly zero new
> activities.

For a movie, the follow-up is `Update {list name} item to Watched?`; only tapping it flips
that named item to `watched`.

**Tests.** Completion leaves the ListItem byte-identical. Accepting the progress follow-up
updates only that item and is undoable; declining it writes nothing. Zero activities are
created by completion or progress update; Plan kind and audience start unselected; no
participant is preselected; cancellation leaves nothing behind.

---

### P9-03 — Meal follow-up and meal favourites

**What to build.** The ingredients-to-groceries follow-up, and the lightest possible
personalisation on top of it.

**Approach.** The follow-up opens the ingredient picker with every ingredient unchecked;
`Add selected` resolves the destination through the `groceries` slot rule
([`../02-architecture/data-model.md#default-slots`](../02-architecture/data-model.md#default-slots),
implemented in P3-12), shows it, and posts there with `sourceActivityId` and a `sourceLabel`
so the item reads `Chicken — Sunday dinner`. There is no single "the Groceries list" to post
to; the destination is whichever list holds the slot, and the user can change it for that one
operation.

**Favourites** are derived, not a new entity: a meal title the user has completed **three or
more times** appears in a `FAVOURITES` group at the top of the Add → Meal title suggestions and
at the top of the Meals list's add row, pre-filling the slot and the ingredients from the most
recent instance. It is computed server-side from completed `meal` activities and returned by
`GET /v1/me/suggestions?kind=meal`, cached for an hour. The `Meals list` here means any list
with `behaviour: 'meals'`; where the user has several, the `meals` slot picks the one the add
row belongs to, by the same rule.

> **Decision:** favourites are a derived ordering, never a stored favourite flag and never a
> star the user has to maintain. There is no "add to favourites" affordance, because a list a
> user must curate is a chore, and the product's whole stance is that structure should emerge
> from use. The threshold (three completions) is a server-side constant.

**Edge cases.** A meal title that differs by case or trailing whitespace is the same favourite;
matching is on the normalised title. Favourites never appear before a user has three
completions of anything, so a new user's Add screen is unchanged.

**Tests.** The threshold boundary; normalisation; the pre-fill copies slot and ingredients from
the most recent instance; no favourite entity exists in the data model.

---

### P9-04 — Custom-activity shortcuts

**What to build.** Concept §30's reusable shortcuts, using the `details.shortcutId` field that
has been in the model since Phase 1 and unwritten until now.

**Approach.** A shortcut stores a title, a default time, a recurrence and a reminder offset —
never participants or sharing. It is created **from an existing General Plan** — the `⋯` menu
on a completed or scheduled `custom` Plan offers `Make this a shortcut` — never from a blank
form, so a shortcut always describes something the user has actually done.

Storage: `USER#<u>` / `SHORTCUT#<shortcutId>`, a new item type added to
[`../02-architecture/data-model.md`](../02-architecture/data-model.md) §3.2 in the same pull
request. Endpoints: `GET`/`POST`/`PATCH`/`DELETE /v1/shortcuts`. Cap: **12 per user**, which is
more than anyone will use and small enough that the list is a `Query` with no pagination.

Shortcuts appear only after the user explicitly chooses **Plan**, then **General**, and only
once the user has at least one. Tapping one opens the Plan form with its compatible fields
visible for review; audience remains unselected and no person is preselected. It creates
nothing until **Save plan**.

> **Decision:** shortcuts are limited to `custom` activities. Extending them to the five guided
> types would overlap with those types' own defaults and with meal favourites, and the concept
> introduces shortcuts specifically as the escape hatch for the repeated custom case (study
> session, meditation, practise guitar).

**Edge cases.** Deleting a shortcut does not touch activities created from it;
`details.shortcutId` is left pointing at a deleted id and is treated as absent on read.
Renaming a shortcut does not rename past activities.

**Tests.** Creation from a General Plan copies only the allowed fields; the cap; shortcuts
appear only after the explicit Plan → General choices; no shortcut stores or preselects people
or sharing; a deleted shortcut leaves activities intact; a shortcut creates nothing until
**Save plan**.

---

### P9-05 — The monthly unsettled-expense reminder

**What to build.** `unsettled_monthly` from
[`../01-product/notifications.md`](../01-product/notifications.md) §7 — the one money nudge,
**off by default**.

**Approach.** The daily maintenance job, on the 1st of each month, finds users with the
`unsettled` category enabled and at least one non-zero balance, and schedules a push at their
all-day reminder hour in their timezone. It fires at most once per calendar month regardless of
how many balances exist, lists at most two with `and n more` appended, writes no inbox entry,
and is held by quiet hours.

**Edge cases.** A user whose only balances are in a currency with a zero net gets nothing. A
user in a timezone where the 1st has already passed when the job runs is scheduled for the next
month, not immediately. The copy never escalates in tone across months — money between friends
is not a collections problem.

**Tests.** Off by default; once per month; the two-balance cap; quiet-hours holding; timezone
handling at the month boundary; no inbox entry.

---

### P9-06 — Offline coverage allow-list: native rows and web persisted reads

**What to build.** Exactly what survives a cold start with no network.

**Approach — amended 2026-08-18 (ADR-057).** The table below is the data-coverage allow-list,
not the native storage mechanism. On native, eligible domains are materialized into
typed/indexed SQLite tables and read through repositories; money keeps the same explicit
offline-unavailable policy. On web, TanStack Query's cache is persisted to `localStorage`,
opt-in per query key through `shouldDehydrateQuery`.

| Query | Persisted | Window | Reason |
| --- | --- | --- | --- |
| `agenda` | Yes | today − 7 to today + 30 | Today must work fully offline |
| `activity detail` | Yes | Any opened in the last 7 days | The plan you are standing in front of |
| `lists` index and items | Yes | All non-archived lists, **shared ones included** | A shopping list in a shop with no signal is the canonical case, and it is usually the shared one |
| `list-templates` | Yes | — | Static, and the creation sheet must work offline |
| `me`, `notification-preferences` | Yes | — | Small, and needed to render anything |
| `people` index | Yes | — | Small, and the picker needs it |
| `balances`, `people/:id/balance`, `activities/:id/expenses` | **No** | — | See the decision below |
| `notifications` inbox | No | — | Meaningless stale |
| Any `capture` result | No | — | Never persisted anywhere |
| Public invite data | No | — | Not part of the authenticated app |

> **Decision — money is never served from a stale cache.** Offline, a balance renders as
> `Balance unavailable offline` rather than a figure that may be wrong. Every other screen
> degrades to last-known data because a stale plan title is harmless; a stale figure that
> someone acts on is not, and it would be an unexplained number by another route.

**A shared list can change underneath its retained copy, and the client does not pretend
otherwise.** Another member may have added, checked, reordered or deleted items since the
copy was taken, and there is no push channel that tells the device so. What the client does
about it:

- A retained shared list renders normally. There is no warning banner, because the list being
  slightly out of date is the ordinary condition of a shared list, online or off, and a
  banner that is always up says nothing.
- The list detail screen schedules a coverage-aware sync on focus and reconnect. On native,
  canonical rows and any retained local state are reconciled in a transaction before
  repository subscribers observe them; there is no read-time "queue reapplies on top" step.
  Web keeps its online-first response replacement.
- A retained list the caller has been **removed** from syncs to `404`/`403`. The client hides
  it from the index, marks its unresolved intents structured `needs_attention/rejected`, and
  shows one banner reading `You're no longer on "Groceries".` It does not auto-retry or keep
  visible orphan rows; the user resolves the retained rejected work through the standard
  attention surface.
- `memberCount` and the members list are retained with the list and are the most likely field
  to be stale. Nothing is gated on them, so a wrong count is a cosmetic error for one
  refetch.

> **Decision — no CRDT or generic local merge of item sets.** Native reconciliation is an
> explicit sync transaction; web remains "refetch wins". This is honestly weaker than a
> convergent data type: an item
> another member **deleted** while this device was offline reappears if this device had a
> queued edit to it, and an item added by both members with the same title exists twice
> (which is the canonical rule anyway — duplicates are never auto-merged). Both outcomes are
> visible, are what the user would see if the two edits had happened a second apart online,
> and are fixed by deleting a row. A CRDT would cost a second storage engine on the client,
> a merge implementation the server does not share, and a class of bug that only appears on
> two devices at once — for a household grocery list. The limits are stated here so nobody
> discovers them and calls them a defect.

The **web** persisted cache is capped at **2 MB**, throttled to 1 s between writes and
versioned by an app-version `buster`; on exceed it evicts activity details oldest-first, then
agenda days outside today ± 3. It persists **no** mutations (P9-07). Native retention is
table/coverage-specific and never age-deletes a database with unresolved outbox work.

**Tests.** Airplane-mode cold start renders Today, Plans, Lists and a recently-opened plan; a
balance renders the unavailable state; typed native coverage and web cache stay within their
budgets; a web buster discards the cache while a native migration preserves rows/outbox; a
capture result is never written to storage. Plus: a retained shared list renders with no
banner; a native sync returning a changed item set commits canonical/materialized rows once;
a `404`/`403` hides the list, preserves structured rejected intents and shows the removal
banner exactly once.

---

### P9-07 — Offline: list outbox semantics

**What to build.** The queueing rules in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §5.4,
extended to the list and shared-list mutations that exist by this phase.

**Approach — amended 2026-08-18 (ADR-057).** This task does not build a second queue. Native
Lists/ListItems already use the SQLite outbox/coordinator established by P2-62 and adopted in
Phase 3: accepted visible rows and intent commit together, and the serialized sync engine owns
transport/reconciliation. TanStack is not native list state or persistence. What this task
adds is the **semantics layer** for list mutations riding that outbox:

- **Push adapters must be registered before sync starts** for every durable list mutation
  kind. The SQLite outbox, not a rehydrated TanStack mutation, is the record of what must
  reach the server.
- **The `Idempotency-Key` is generated once and persisted in the intent** at enqueue,
  exactly as P2-48 already does for activity writes. It is never regenerated on retry.
- **Serialisation is explicit.** Every intent carries an `ordering_key`; FIFO and dependency
  barriers hold within that domain while unrelated work may progress. Cross-entity concurrent
  dispatch is not required.
- **No implicit compaction.** Same-`ordering_key` intents preserve their durable order.
  Compaction is a separate optimization only after it proves dependencies, receipts, Undo and
  reconciliation remain equivalent; this task does not infer that last intent is sufficient.
- **Date values are captured in the transactional action input**, never derived at sync time.
  A completion queued on Tuesday and flushed on Wednesday still names Tuesday.
- **Cap: 200 pending mutations.** Beyond it, new writes are refused with `You're offline and
  there's a lot waiting to sync.`

**Which shared-list mutations are safe to queue, and which are not.** A list with one member
has no concurrency, so this table is about shared lists; the client does not branch on
`memberCount`, it applies the stricter rule everywhere, because a private list can become
shared between the queue and the flush.

| Mutation | Queueable | Why |
| --- | --- | --- |
| Set an item's state (`done` / `open` / `active`) | **Yes** | State is **set, not toggled**, so each operation is idempotent. Two members setting the same value converge whatever order the writes land in, and a replay is a no-op. This is the one that had to be safe, because it is the whole point of an offline grocery List. |
| Add an item | **Yes** | A create with an `Idempotency-Key`. Two members adding the same title produce two rows, which is the canonical rule — duplicates are never auto-merged — and is what would happen online. |
| Edit an item's title, note or typed feature | **Yes** | Last write wins on a field. No `If-Match` on item writes, by design. |
| Delete an item | **Yes** | Idempotent. A delete of an item another member already deleted returns `404`, which rule 5 treats as success. |
| **Reorder an item** | **No** | Not commutative. `afterItemId` is resolved against neighbours **at flush time**, so a rank computed against a list that has since changed puts the item somewhere the user did not mean, silently and with no error. |
| Rename the list | Yes, but `If-Match` applies | List-level edits carry `If-Match` (rule 2). A `409` names the field, as for an activity. |
| Change item-state mode, typed-feature configuration or slot | Yes, `If-Match`, owner only | P3-33 makes these non-destructive and independently undoable; values stay retained, while `If-Match` protects the owner-managed shared configuration. |
| Add or remove a member | **No** | Membership changes need a server round trip to resolve an address to an account or a `status`, and the sheet's per-person result is the user's feedback. The share sheet is disabled offline with `Sharing needs a connection.` |

**Reordering offline.** The drag is refused, not queued: the row springs back and a toast
reads `Reordering needs a connection.` This is the honest failure. The alternative — queue
the reorder and resolve it at flush — produces a list whose order changed while nobody was
looking, which is worse than not being able to drag for a minute. On a private list the same
rule applies, because the client does not know at drag time whether the list will still be
private at flush time.

> **Decision — refuse rather than resolve.** A queued reorder could be made to work by
> storing the computed rank rather than `afterItemId`, which would make it a plain
> last-write-wins field edit. It is rejected because the client would then be computing
> ranks, and the rule that the server owns ranks and the client sends `afterItemId` (P3-03)
> is what keeps one implementation of the ordering. One offline gesture is a smaller loss
> than a second rank generator.

> **Decision — web has no persisted mutation queue** (ADR-024, upheld by ADR-055). A browser
> tab is closed, not backgrounded, so a queue that never flushes is worse than an error at the
> moment of failure. Web keeps the queue in memory for the session and warns on unload when it
> is non-empty — a session-scoped refinement, not a durable log; nothing survives the tab.

**Tests.** A queued mutation survives an app kill and flushes on relaunch; push adapters are
registered before claims begin; the idempotency key is stable across three retries; two edits
with one `ordering_key` apply in order while unrelated work may progress; the 200 cap refuses
with the specified copy.

Plus one test per row of the queueable table: a `done` state write queued offline flushes and
lands exactly once even when the same intent is delivered twice; two devices queueing the
same state value both flush without a `409` and converge; a drag offline is refused
with the specified copy and enqueues nothing; the share sheet is disabled offline; a queued
delete of an item another member already deleted is dropped silently under rule 5.

---

### P9-08 — Offline: conflict resolution

**What to build.** The rules, written down, so that reconnection is predictable — including
for the two objects more than one person can write to, a shared plan and a shared list.

**The rules.**

1. **Creates never conflict.** Every creating `POST` carries an `Idempotency-Key`; a replay
   returns the stored response. A duplicate is impossible by construction.
2. **`PATCH /v1/activities/:id` carries `If-Match: <updatedAt>` captured when the user made
   the edit**, not when the queue flushes. A `409` means the server changed underneath the
   user's edit, which is exactly what we want to know.
3. **On `409`, a field-level three-way merge.** Refetch the server state, then for each field
   in the queued patch: if `server.value === base.value` (the field has not changed since the
   user's base), re-apply the user's value; if it has changed, **drop** the user's value and
   name the field in the conflict banner. This is
   [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §5.3's
   "non-overlapping edits are re-applied, overlapping ones are dropped and named", made
   precise.
4. **State-setters are last-write-wins with no `If-Match`.** Completion, un-completion, skip,
   snooze, RSVP change and **every list-item write** are idempotent settings of a state, not
   merges. Re-applying one is harmless, and a `409` on them would be noise. List-item `state`
   in particular is set, never toggled, which is what makes it survive the queue with no merge
   logic — a toggle would flip twice on a duplicate delivery and land on the wrong value.
   List-*level* edits — title, item-state mode, typed-feature configuration, slot — are rule
   2, not rule 4.
5. **A `404` on a queued mutation is success.** The thing is already gone; drop it silently
   and count it.
6. **A `403` is rejected and named.** The user lost permission — usually they were removed
   from a plan while offline. The intent becomes structured `needs_attention/rejected`; it is
   not auto-replayed or silently discarded.
7. **A `429` is retried after `Retry-After`,** up to three times.
8. **A `5xx` retries with exponential backoff up to six attempts**, then parks in an
   `Unsent changes` list the user can retry or discard from Settings. Nothing is discarded
   without the user seeing it.
9. **Any other `4xx` is rejected and named.** The intent becomes structured
   `needs_attention/rejected`. A validation failure that only appears at sync time is a bug;
   it is logged with the payload shape (never the content) so it can be found.
10. **One banner per reconnection**, not one per failure: `<n> changes couldn't be applied.`
    with an expandable list naming each item and the reason.
11. **Undo works offline.** It is a compensating local operation plus a dependent intent, and
    its `ordering_key`/dependency barrier guarantees it lands after the operation it
    compensates.
12. **A shared object is reconciled explicitly, not generically merged.** Native sync pushes
    eligible intents, pulls canonical rows and commits the affected materialized rows plus
    intent settlement in a transaction before subscribers observe them. Web refetches. There
    is no render-time overlay, generic item-set merge or CRDT (P9-06).
13. **Losing access hides rows and preserves rejected work.** A `404` on a list route, or a
    `403`, means the caller was removed while offline. The list leaves visible native rows or
    the web cache; its unresolved native intents become structured
    `needs_attention/rejected`; and one banner names the list. This rule stops twelve grocery
    items producing twelve lines while retaining P2-59's user-data semantics.

**What this honestly does not do.** Stated so nobody meets it and files it as a bug:

| Situation | Outcome |
| --- | --- |
| Another member deleted an item this device edited offline | The edit recreates nothing — the `PATCH` `404`s and is dropped (rule 5). The item stays deleted. |
| Another member deleted an item this device **added a duplicate of** | Both exist. Duplicates are never auto-merged, online or off. |
| Both members added the same title offline | Two rows, visible, deletable. This is the canonical rule, not a sync artefact. |
| Another member reordered while this device was offline | This device's order is replaced by the server's on refetch. No local reorder was queued (P9-07), so nothing is lost. |
| Two members checked the same item | Converges. This is the case that had to work and the only one the design optimises for. |

**Edge cases.** A queued edit to an activity that was deleted server-side hits rule 5. A queued
RSVP for a plan the user was removed from hits rule 6. A queued expense on a plan whose
participants changed can fail validation at flush time (rule 9) — the banner names the expense
and the user re-enters it, which is the honest outcome. A queued RSVP for a plan whose date
changed while the device was offline **still applies**: it sets the participant's response
against the current date, and the reset (Phase 6 P6-15) already moved them to `pending`, so
the queued answer is a fresh answer to the new date rather than a stale one to the old.

**Tests.** Each rule as a named test. A three-way merge test where the user changed the title
and the server changed the time: both survive. A test where both changed the title: the
server's wins and the banner names it. A test that the base value used is the one captured at
edit time, not at flush time. For rule 12: a shared list with three queued checks reconnects,
flushes, refetches, and ends with the server's item set plus all three checks applied, in one
render pass. For rule 13: a member removed while offline with twelve queued item writes gets
**one** banner and zero error toasts, and no request is retried. Plus one test per row of the
"does not do" table, asserting the stated outcome rather than a better one.

---

### P9-09 — Offline: indicators, limits and undo

**What to build.** The visible surface of the above.

**Approach.** A compact status occupies the flexible middle of Today's header without moving
the title or completion count: cloud-off + `Offline` or `<n> waiting`, cloud-sync + `Syncing…`,
then cloud-check + `Synced` for 2 seconds before becoming quiet. No modal, nothing blocking. A
queued row shows cloud-off + `Pending` at the end of its existing metadata line, in a neutral
colour, never an error colour. Undo behaves normally. The 200-mutation cap produces the
specified refusal. A single connectivity blip does not clear the queue: the queue is cleared
only by successful flushes.

**Tests.** The header states follow connectivity and replayable queue depth without shifting
the title or action slot; the inline pending marker; the cap copy; a connectivity flap does
not lose queued items; the indicator is announced to screen readers once, politely, not on
every state change.

---

### P9-10 — Offline: the upload queue

**What to build.** Attachments taken offline.

**Approach.** An image picked offline is copied into the app's document directory, the
attachment renders as a local placeholder, and a queued job requests a presigned URL, uploads,
and confirms when connectivity returns. The activity is created with `attachmentIds` referring
to client-generated ids that the confirm step reconciles.

**Edge cases.** A presigned URL expires between issue and use; the job requests a fresh one. An
upload that fails three times leaves the placeholder with a `Retry` affordance rather than
silently dropping the photo. Local copies are deleted after a successful confirm and reaped on
launch if older than 7 days.

**Tests.** Offline photo attach, reconnect, upload, confirm, placeholder replaced; expired URL
refresh; the reaper.

---

### P9-11 — The iOS share extension target

**What to build.** The iOS share sheet entry point.

**Scope, stated narrowly.**

| In scope | Out of scope |
| --- | --- |
| `public.url`, `public.plain-text`, `public.image` | Video, files, PDFs, multiple attachments |
| Exactly one attachment per share | Batch import |
| Hand off to the main app and open Global Add with **Task**, **Plan**, and **List item** unselected | Any compose UI inside the extension |
| ≤ 10 MB image, matching the upload cap | Saving without opening the app |

> **Decision — a non-UI extension that hands off, not a compose UI.** A UI extension means a
> second React Native runtime in a memory-constrained process, a second copy of the auth
> state, and a second creation path to keep in sync with the Add screen. Handing the payload
> to the main app and opening Global Add reuses everything and takes about a second longer
> for the user. The extension's whole job is: accept, write to the App Group, open the app.

**Approach.** A local Expo config plugin, `apps/mobile/plugins/withShareExtension.ts`, adds the
target during prebuild: the extension's `Info.plist` with `NSExtensionActivationRule` limited to
the three types and one item each, the App Group `group.app.ordinarydays` entitlement on both
targets, and a small Swift `ShareViewController` that writes
`{ kind, text?, url?, imageFilename?, receivedAt }` as JSON into the group container, copies
the image beside it, and calls `openURL("ordinarydays://compose?share=<id>")` before completing
the request.

> **Decision — a local plugin rather than a community one.** The share extension is native
> configuration on the App Store submission path; a third-party plugin that breaks on an SDK
> bump would block a release. The plugin is about 150 lines and the Swift controller about 60,
> both reviewable.

**Edge cases.** The extension has no keychain access to the app's tokens and does not need any
— it writes a file and exits. A share arriving while the app is already open is handled by the
same deep-link handler. A payload older than 10 minutes is discarded on read, so a stale share
never appears days later.

**Tests.** A Maestro flow sharing a URL from Safari and asserting all three Global Add choices
start unselected; unit tests for the payload writer and reader; a test asserting the extension
target requests no network entitlement and no keychain group.

---

### P9-12 — Share payload ingestion

**What to build.** What the app does with the handed-off payload.

**Approach.** The deep-link handler reads the group container, deletes the payload, retains it
in a local draft, and opens Global Add with **Task**, **Plan**, and **List item** all unselected.
The payload cannot start capture yet. The user first chooses the destination; **Plan** then
requires an unselected **General / Meal / Watch / Event** choice, and **List item**
requires an explicit destination list. Only then may the app call `POST /v1/capture/link`,
`POST /v1/capture/parse`, or `POST /v1/capture/extract` with that immutable
`CreationTarget`. Capture may suggest compatible, visible fields for review, but it never
chooses or changes the target, Plan kind, list, people, audience, sharing, or
reminder/notification state, and it never writes. With capture disabled or `501`, the payload still lands in the same chosen form. A
write happens only through the named final action: **Save task**, **Save plan**, or
**Add to {list}**.

**Tests.** Each payload kind; all choices initially unselected; capture is never called before
the complete `CreationTarget` exists; each capture request echoes that target; capture enabled
and disabled; no capture response can set target, Plan kind, list, people, audience, sharing,
or reminder/notification state; no write before the named final action; the payload is deleted after read; a stale payload is
discarded.

---

### P9-13 — The widget target and the snapshot writer

**What to build.** A home-screen widget that shows what is next.

**Scope.**

| In scope | Out of scope |
| --- | --- |
| `systemSmall`: the next item plus a count of what remains today | `systemLarge`, Live Activities, StandBy |
| `systemMedium`: the next three items | Interactive completion from the widget |
| Deep link into the tapped item | Any network call from the widget |
| Empty state: `Nothing planned today` | Multiple configurable widgets |

> **Decision — the widget never calls the API and holds no credential.** The main app writes a
> trimmed `TodaySnapshot` JSON (≤ 16 KB: for each of up to five items, the title, the time, the
> type and the activity id) into the App Group container after every successful agenda fetch and
> after every completion. The widget reads that file and nothing else. A widget that
> authenticates would need a token in a second process, a refresh path in an extension with a
> few seconds of budget, and a second set of failure modes on a surface with no error UI.

**Approach.** A WidgetKit target added by a second local config plugin, sharing the App Group.
The snapshot writer lives in `apps/mobile/src/lib/widgetSnapshot.ts` and is called from the
agenda hook's `onSuccess` and from the completion mutation's `onSettled`.

**Edge cases.** A snapshot older than 24 hours renders the empty state rather than yesterday's
plans. The file is written atomically (write to a temp name, rename) so the widget never reads
a half-written file. Account sign-out clears the snapshot immediately.

**Tests.** Snapshot shape and size cap; atomic write; staleness; sign-out clears it; a
snapshot test of both widget sizes at default and largest dynamic type.

---

### P9-14 — Widget timelines, deep links and the privacy toggle

**What to build.** Keeping the widget current, and not putting a private plan on a lock screen
without permission.

**Approach.** The timeline has an entry at each of the next four item boundaries plus one at
midnight, so the widget advances without the app running. `WidgetCenter.reloadAllTimelines()`
is called from the app after an agenda change or a completion. Tapping the small widget opens
`ordinarydays://activity/<id>`; the medium widget uses per-row `Link`s.

> **Decision — a `Hide plan titles on the widget` setting, defaulting off.** iOS can render
> widget content on the lock screen, where a passer-by can read it. Defaulting to hidden would
> make the widget useless for most people; not offering the option at all would be wrong for
> the person whose Tuesday afternoon is a medical appointment. With the setting on, the
> snapshot writer stores the type and time only and the widget renders `Event · 2:30 PM`.

**Tests.** Timeline entries at the right instants; midnight rollover; deep links open the right
screen; the privacy toggle changes what the writer stores, not just what the widget renders.

---

### P9-15 — Lambda power tuning and the memory decision

**What to build.** The measurement that closes OQ-3.

**Approach.** Deploy the AWS Lambda Power Tuning state machine against the dev API function
with a realistic `GET /v1/agenda` payload and a seeded month of data, sweeping 512, 768, 1024,
1536 and 2048 MB, optimising for balanced cost and speed. Record the curve in
`docs/05-operations/perf/lambda-power-tuning.md` and set `memorySize` from it. Delete the
state machine afterwards.

**Tests.** The recorded curve, plus the cold-start budget test already in the deploy job
(init p95 under 400 ms).

---

### P9-16 — Server performance pass

**What to build.** The measured version of the budgets.

**Approach.** Measure and, where needed, fix: the number of DynamoDB round trips per endpoint
(the agenda must be at most four); the GSI1 `INCLUDE` projection covering every `AgendaItem`
field so the hottest read never fetches from the base table; the `ETag` path on `/v1/agenda`
returning `304` for an unchanged window; and response sizes, with an assertion that a 30-day
agenda for a heavy user stays under 200 KB.

Targets, asserted in a load test against dev with a seeded heavy user:

| Measure | Budget |
| --- | --- |
| Cold `GET /v1/agenda`, end to end | ≤ 700 ms |
| Warm `GET /v1/agenda`, server-side p95 | ≤ 60 ms |
| Init duration p95 | ≤ 400 ms |
| DynamoDB round trips per agenda request | ≤ 4 |
| Any endpoint's round trips | ≤ 3 without a written justification in the PR |

**Tests.** A `k6` or `autocannon` script in `scripts/perf/` run in the nightly workflow against
dev, failing the job on a budget breach.

---

### P9-17 — Client performance pass

**What to build.** A Today screen that scrolls at 60 fps with a hundred rows on an older
device.

**Approach.** `FlashList` (or `FlatList` with a measured `getItemLayout`) for every list;
`React.memo` on row components with a stable key and props compared by value; no inline arrow
functions or object literals in row props; `expo-image` with `recyclingKey` and blurhash
placeholders for attachments; images requested at the rendered size through CloudFront rather
than full-size; and no animation on a row that is scrolling.

Targets:

| Measure | Budget |
| --- | --- |
| App launch to first painted row, warm cache | ≤ 1.0 s |
| App launch to first painted row, cold | ≤ 2.0 s |
| Today scroll, 100 rows, iPhone 11 | ≥ 58 fps average, no frame over 32 ms |
| Add screen open to keyboard-ready | ≤ 300 ms |
| Time to interactive after a tab switch | ≤ 150 ms |

**Tests.** A Maestro flow with the launch timing recorded across 10 runs (criterion S3); a
React DevTools profiler snapshot asserting a row re-render count of 1 per data change; a
scroll-performance measurement recorded in `docs/05-operations/perf/`.

---

### P9-18 — Web bundle budget and route splitting

**What to build.** A web build that loads quickly on the one route strangers see.

**Approach.** The invite route is the priority: it must not pull in the authenticated app's
graph. Verify with a bundle analysis that `/invite/[token]` shares only the design-system
primitives and the shared types. Route-level code splitting for the rest via Expo Router's
static output.

| Measure | Budget |
| --- | --- |
| `/invite/[token]` initial JS, gzipped | ≤ 120 KB |
| Any authenticated route's initial JS, gzipped | ≤ 350 KB |
| Total JS for a first authenticated load, gzipped | ≤ 900 KB |
| Lambda artifact, zipped | ≤ 5 MB (already gated) |

**Tests.** A CI step running the bundle analysis and failing on a budget breach, with the
per-route numbers written to the job summary.

---

### P9-19 — Accessibility audit and automated checks

**What to build.** A pass over every screen against
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6, and the
automated part of it in CI.

**Approach.** Manual pass with VoiceOver on device and with a keyboard on web, screen by
screen, recorded as a checklist in `docs/05-operations/accessibility-audit.md` with the date and
the build. Automated: `axe-core` through Playwright on every web route with **zero** violations
allowed at the `serious` and `critical` levels; a custom test that walks the component tree of
every screen and asserts every `Pressable` has an `accessibilityRole` and either an
`accessibilityLabel` or accessible text children; and a hit-target test asserting no
interactive element is smaller than 44 × 44.

**Tests.** As above, all in CI.

---

### P9-20 — Dynamic type and AX5 layout pass

**What to build.** Layouts that survive the largest accessibility text size.

**Approach.** `allowFontScaling` is never `false`, anywhere. Every screen is verified at the
largest non-accessibility size and at `AX5`. Above `xxxLarge`, row layouts reflow from
horizontal to vertical: the time moves above the title, avatars move below, badges wrap. No
fixed-height rows exist; every row is content-sized with a 44 pt minimum. Icons paired with
text scale with it; icon-only controls keep a fixed 44 pt target.

**Tests.** Snapshot tests at three type sizes for every row type and every screen header; a
lint rule forbidding `allowFontScaling={false}`; a test at 320 pt width asserting no horizontal
overflow.

---

### P9-21 — Contrast, dark mode and reduce-motion pass

**What to build.** The colour and motion requirements, verified rather than assumed.

**Approach.** A contrast test over the design tokens asserting every foreground/background pair
in use meets 4.5:1 for body text, 3:1 for large text and for control boundaries, in **both**
light and dark themes independently. De-emphasis is achieved with weight and size, never by
dropping below the threshold. Colour is never the only carrier of meaning: completion also uses
a checkmark and struck text, pending RSVP also uses the words `Awaiting reply`, overdue also
uses the date chip's text, balance direction is always words. Reduce Motion turns transitions
into cross-fades, removes insert and remove animations, and stops the toast sliding — while
swipe actions still track the finger, because that is direct manipulation, not decoration.

**Tests.** A programmatic contrast test over the token pairs; a snapshot per theme; a test that
Reduce Motion disables the animation config; a review checklist item for the colour-alone rule.

---

### P9-22 — VoiceOver labels and accessibility E2E

**What to build.** The label table in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2, verified.

**Approach.** Every row type's elements, order, labels, roles and custom actions are asserted
against the table. Every swipe action is exposed as an `accessibilityAction` so it is reachable
without swiping. State is spoken, not implied by colour. Counts are spoken in full
(`with Alice and 2 others`, never `+2`). Money is spoken through the platform's currency
formatter.

**Tests.** A table-driven test per row type; Maestro flows performed entirely through
accessibility actions — complete a task, snooze an occurrence, RSVP, and **Mark selected
obligations settled** — with no swipe and no coordinate tap. The settlement action records
status only; it never asks for or stores an external payment amount, method or reference.

---

### P9-23 — Crash and error reporting

**What to build.** Enough visibility to fix what breaks on other people's phones.

> **Decision — Sentry for client crashes and errors; no third-party product analytics; no
> error-reporting SDK in the Lambda.** The server already emits structured logs into
> CloudWatch with a `requestId` on every line, and adding an SDK there would cost cold-start
> time against a 400 ms budget for information already available. On the client there is no
> equivalent, and a crash nobody can see is a crash nobody fixes.

**Approach.** `@sentry/react-native` with `sendDefaultPii: false`, `tracesSampleRate: 0.1`, and
a `beforeSend` hook applying the same redaction list as `pino` — titles, notes, descriptions,
locations, emails, display names and tokens are scrubbed from breadcrumbs, from the event, and
from the request context. The user identifier is a random install id stored in `AsyncStorage`;
it does not survive a reinstall, which keeps it off the App Store privacy label as a tracking
identifier. Source maps are uploaded from the release build so stack traces are readable.

The declared privacy labels stay as they are: crash data and performance data, **not linked to
you**, no tracking.

**Tests.** A forced crash produces a readable, symbolicated stack; a `beforeSend` test asserting
an event containing every redacted key emits none of the values; a test asserting the install
id changes after a simulated reinstall.

---

### P9-24 — Analytics via structured logs and a query pack

**What to build.** Answers to product questions without a tracking SDK.

**Approach.** No Firebase, no Amplitude, no Mixpanel, no PostHog, no advertising identifier,
nothing that persists across a reinstall. The questions worth answering are answered from the
structured logs already emitted: activities created per user per week, capture usage and
outcome distribution, invite-to-RSVP conversion, agenda latency percentiles, error rates by
route. These live as Log Insights queries in `infra/observability/queries/` with a one-line
description each, plus a handful of EMF counters where a query is too slow to be useful.

**Tests.** Each query is executed in the nightly workflow against dev and fails the job if it
errors — a broken query discovered during an incident is a query that does not exist.

---

### P9-25 — App Store Connect setup, metadata and privacy labels

**What to build.** Everything App Store Connect asks for, filled in accurately.

**The list.** App record and bundle identifier; primary and secondary category; age rating
questionnaire; app name, subtitle, promotional text, description, keywords; support URL and
marketing URL; the **live** privacy policy URL; copyright; contact information; export
compliance (`ITSAppUsesNonExemptEncryption: false`, since only standard HTTPS is used).

Privacy nutrition labels, exactly as in
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §8.1:
**data used to track you: none**; data linked to you: email address, name, other user contact
info, user content, photos, coarse location (user-entered addresses only), financial info
(expense amounts), device id (the Expo push token); data not linked to you: crash and
performance diagnostics. If Phase 8 shipped, the model-provider disclosure is reflected here
and in the policy.

**Tests.** A checklist in `docs/05-operations/app-store-submission.md`, walked before
submission, with each item initialled and dated.

---

### P9-26 — Screenshots, review notes and the demo account

**What to build.** The material a reviewer needs to approve on the first attempt.

**Approach.** Screenshots for every required device size, generated from a seeded simulator with
realistic but fictional data — never a real person's name, address or photograph. Review notes
explaining: the invite-link surface and why a route is unauthenticated; that Sign in with Apple
is present because a third-party sign-in exists; that account deletion is in Settings →
Account; and how to reach every feature. A demo account with seeded data, credentials in the
review notes, that is not the founder's account and does not expire.

**Edge cases.** The demo account must have a shared plan with a guest, an expense with a
balance, and a recurring task, or the reviewer cannot see half the app. Its data is reset by a
scheduled job before each submission.

**Tests.** The seed script runs in CI against dev to prove it still works.

---

### P9-27 — The release pipeline: EAS production build and submit

**What to build.** A repeatable release, not a laptop ritual.

**Approach.** `mobile.yml` extended: on a `v*.*.*` tag, run `eas build --profile production
--platform ios --non-interactive`, upload source maps to Sentry, then `eas submit`. The build
number auto-increments. The workflow is separate from the AWS deploy so a slow EAS queue never
blocks or fails an infrastructure deploy.

The prod API must be deployed **before** the build is submitted, so a build cannot reach a
reviewer pointing at an API that does not have its endpoints yet.

**Tests.** A dry run producing a TestFlight build from a release-candidate tag, installed and
smoke-tested on a device before the real submission.

---

### P9-28 — EAS Update channel and a hotfix rehearsal

**What to build.** The ability to fix a JavaScript bug in minutes instead of days.

**Approach.** `expo-updates` with a `production` channel matched to the production build
profile. A JS-only fix is published to the channel and reaches users on their next launch; a
native change goes through App Store review. The rule is written into the runbook: **if the fix
touches native code, a config plugin, or a permission string, it is not an OTA fix.**

Rehearse it before launch: publish a trivial visible change to a TestFlight build, confirm it
lands, then publish the revert.

**Tests.** The rehearsal, recorded. A test asserting the update channel matches the build
profile so a production build cannot receive dev updates.

---

### P9-29 — Phased release and a rollback rehearsal

**What to build.** A launch that can be stopped.

**Approach.** App Store phased release over 7 days, which can be paused from App Store Connect
at any point. Rollback options, in order of speed, all rehearsed in dev before launch:

1. **Pause the phased release** — stops new users receiving the build.
2. **EAS Update revert** — fixes a JS bug on installed builds within minutes.
3. **Lambda alias repoint** — `aws lambda update-alias --function-name od-api-prod --name live
   --function-version <n-1>`, seconds, followed within the hour by a revert commit and a real
   deploy.
4. **Deploy the previous tag** — `git checkout v1.2.3 && cdk deploy 'od-*-prod'`, minutes,
   leaves CDK and reality in agreement.
5. **Throttle the API to zero** — the emergency stop from
   [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §9.3.

**Tests.** Each of 2, 3, 4 and 5 rehearsed against dev and timed, with the timings written into
the runbook.

---

### P9-30 — The operations runbook

**What to build.** `docs/05-operations/runbook.md` — the document the founder reads at 2 a.m.

**Contents**, each a command or a numbered procedure, not prose:

| Section | Contents |
| --- | --- |
| Contacts and access | AWS sign-in, App Store Connect, the provider console, the domain registrar, where the MFA seeds are backed up |
| Alarm index | Every alarm, what it means, what to check first, and what to do |
| Take the API offline | The three commands from `security-privacy.md` §9.3, with the reversal for each |
| Roll back | The five options from P9-29 with timings |
| Revoke a user's tokens; revoke everyone's | §9.1, including the `min-token-issued-at` kill switch |
| Rotate a secret | §9.2, with the ordering warning |
| Capture kill switch | Set `/od/prod/capture/enabled=false`; expected user-visible effect; how to verify |
| Balance divergence | Read the alarm, run the DLQ replay, run `POST /v1/balances/recalculate` |
| SES trouble | Bounce and complaint response, suppression list, what to do if sending is paused |
| Restore from PITR | The command, **plus the step everyone forgets: re-run the deletion queue against the restored table before it serves traffic** |
| Run a migration | The `--dry-run` default, the backup command, dev first |
| Suspected data exposure | §9.4's six steps |
| Cost spike | Where to look in Cost Explorer, which guardrail to tighten first |
| Post-incident | The write-up template and where incidents live |

**Tests.** Every command in the runbook is executed once against dev during P9-31 and the
output pasted in. A command in a runbook that has never been run is a guess.

---

### P9-31 — Launch checklist execution

**What to build.** The gate. Every item verified, dated and initialled in
`docs/05-operations/launch-checklist.md`.

**Product**

- [ ] Every screen has its empty, loading and error states, per
      [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §5.
- [ ] No placeholder copy, no lorem ipsum, no `Coming soon`, no disabled feature teaser.
- [ ] Every success criterion S1–S10 in
      [`../01-product/overview.md`](../01-product/overview.md) §7 verified and recorded.
- [ ] Onboarding reaches a populated Today in under three minutes on a clean install.

**Technical**

- [ ] Prod deployed from a tag, smoke tests green, `X-Client-Version` and the `426` path
      tested against a real old build.
- [ ] Cold start p95 under 400 ms; agenda p95 under 60 ms server-side; launch to first row
      under 1.0 s warm.
- [ ] Bundle budgets met; the Lambda artifact under 5 MB.
- [ ] Every log group has an explicit retention; no VPC or NAT gateway exists in any
      synthesised template.
- [ ] DynamoDB PITR on in prod, deletion protection on, and an on-demand backup taken.
- [ ] Every alarm wired to a **confirmed** SNS subscription — test one end to end.
- [ ] AWS Budgets and Cost Anomaly Detection active; the provider's own spend alert set.
- [ ] SES out of the sandbox, DKIM/SPF/DMARC passing, bounce and complaint alarms live.
- [ ] The capture kill switch, the auth kill switch and the API throttle all rehearsed.

**Legal and store**

- [ ] Privacy policy live at `/privacy`, accurate, and linked from Settings and the listing.
- [ ] Privacy nutrition labels match what the app actually collects.
- [ ] Account deletion works in the app and purges after 30 days.
- [ ] Data export works and delivers a presigned link.
- [ ] Sign in with Apple works, including the private relay address.
- [ ] Export compliance answered; screenshots, description and keywords in place.
- [ ] Demo account seeded and its credentials in the review notes.

**Operations**

- [ ] The runbook is complete and every command in it has been run against dev.
- [ ] Rollback rehearsed and timed.
- [ ] The OTA hotfix path rehearsed.
- [ ] An incident write-up template exists in `docs/05-operations/incidents/`.

---

### P9-32 — Post-launch day-1 and day-7 verification

**What to build.** The two checks that catch what launch day hides.

**Approach.** At 24 hours and at 7 days: crash-free session rate (target ≥ 99.5%), error rate
by route, agenda p95, the actual AWS bill against the model in
[`../02-architecture/cost-model.md`](../02-architecture/cost-model.md), capture spend against
the ceiling, SES bounce and complaint rates, DLQ depth, and the first cohort's onboarding
completion. Record the figures in `docs/05-operations/launch-report.md` and **replace the
estimates in `cost-model.md` §1 with the measured values**, as that document instructs.

**Tests.** The report itself.

---

### P9-33 — Retention and maintenance job hardening

**What to build.** The scheduled work that keeps the table honest, made reliable now that there
are real users.

**Approach.** The daily maintenance job gains: notification-inbox retention at 90 days;
the 60-day GSI1 archival sweep, whose scope is **exempting past `#S` items** (decision
locked 2026-08-07): a scheduled plan whose date has passed keeps its index attributes
forever, because Plans → Past is a permanent surface, not a cache — the sweep's remaining
scope is **completed and cancelled items only** (removing the index attributes, keeping
the item); soft-deleted account purge at 30 days; orphaned `tmp/` S3 object reaping; stale
`DELJOB#`, `LINKJOB#` and `MERGEJOB#` detection with an alarm; person counter reconciliation
from Phase 7; and a sampled balance-divergence check over 1% of users. Each step is independent,
idempotent, logs a count, and a failure in one does not stop the others.

**Tests.** Each step against a seeded table; a past `#S` plan older than 60 days is
untouched by the sweep and still appears in Plans → Past, while a completed item of the
same age loses its index attributes; idempotency; a failing step does not abort the
job; the alarm fires on a stale job item.

---

### P9-34 — Completion-relative recurrence

**What to build.** `Recurrence.mode: 'after_completion'` — "three days after I last watered
the plants" — which the model has carried since Phase 1 and which
[`../02-architecture/data-model.md`](../02-architecture/data-model.md) §6 explicitly defers
to this phase.

**Files.** `packages/shared/src/recurrence/expand.ts`, `describe.ts`, their tests, and the
Repeat sheet in `apps/mobile/src/features/activities/`.

**Approach.** The next occurrence is `last completion date + interval`. If the series has
never been completed, it is the active segment's `effectiveFrom` (data-model §4.2). It produces **at most one future occurrence** — a
completion-relative series is not projected forward, because the second occurrence's date
depends on when the first is completed and inventing it would put a wrong date on the agenda.

The expansion therefore branches once, at the top: `fixed` mode expands the window as it
does today; `after_completion` mode reads the series' most recent `Occurrence` with
`status: 'completed'` and emits zero or one date.

`describe.ts` renders it as `3 days after each time you do it`, never as `Every 3 days`,
which would be a different rule.

**Edge cases.** A completion recorded for a past date moves the next occurrence backwards,
possibly into the past — clamp the emitted date to today rather than showing it as overdue,
because the user has just told the app they did it. Un-completing removes the occurrence and
the next date reverts to the previous completion or to the active segment's `effectiveFrom`. Switching an existing
series between modes is allowed and recomputes from the same completion history. A
completion-relative series never appears more than once in a 62-day window, which is the
assertion that catches a regression into the `fixed` path.

**Tests.** Never completed; completed today; completed 10 days ago with a 3-day interval
(the next occurrence is today, not seven occurrences ago); un-complete reverts; a mode switch
in both directions; the one-occurrence bound over a 62-day window; 100% branch coverage, as
this module requires.

---

### P9-35 — Custom recurrence via RFC 5545 `rrule`

**What to build.** `Recurrence.freq: 'custom'` with an `rrule` string, the last unimplemented
member of the recurrence enum.

**Approach.** The `rrule` string is parsed and expanded by the same pure function, with a
tightly bounded subset of RFC 5545 accepted: `FREQ` of `DAILY`, `WEEKLY`, `MONTHLY` or
`YEARLY`; `INTERVAL`; `BYDAY`; `BYMONTHDAY`; `BYMONTH`; `COUNT`; `UNTIL`. Everything else —
`BYSETPOS`, `BYYEARDAY`, `BYWEEKNO`, `WKST`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, and any
`EXDATE`/`RDATE` companion property — is rejected at the schema boundary with
`validation_failed`, because each one adds expansion cases the agenda, the reminders and the
UI description would all have to handle.

> **Decision — the subset is a closed allow-list, not "whatever the parser accepts".** An
> `rrule` the app can store but cannot describe in a sentence is an unexplained rule, and an
> `rrule` that expands differently in the agenda than in the reminder scheduler is a missed
> reminder. The allow-list is exactly what the Repeat sheet can construct and `describe.ts`
> can render.

This is also the only construct that can produce **two occurrences of one series on one
date** (for example `FREQ=WEEKLY;BYDAY=MO,MO` after normalisation, or a monthly rule
interacting with a snoozed override). The expansion deduplicates by date and emits the
`series_limit_exceeded`-style warning already carried by the agenda response rather than
rendering a duplicate row.

**Edge cases.** `UNTIL` is stored and compared in UTC while the series expands in local
wall-clock time; the boundary case at a DST transition has its own test. `COUNT` interacts
with skipped occurrences: a skip consumes a count, because the occurrence happened and the
user declined it. An `rrule` producing no dates in the requested window is legal and emits
nothing.

**Tests.** Each accepted property; each rejected property returning `validation_failed`;
`UNTIL` at a DST boundary; `COUNT` with skips; the same-date duplicate case; round-trip
between the Repeat sheet's construction and `describe.ts`'s rendering; 100% branch coverage.

---

## Acceptance criteria

1. Completion presents at most one follow-up, from the documented precedence, and dismissing
   it writes nothing.
2. Completing a watch session leaves its source ListItem unchanged and creates **zero**
   activities. Tapping the separately named progress action updates only that item. `Create a
   Plan for S2 E6?` fixes only the **Plan** destination; Plan kind and audience remain
   unselected, no participant is preselected, and nothing exists until **Save plan**.
3. The explicit progress action may apply `want → watching`, and that item update is
   undoable. Dismissing it writes nothing.
4. Meal favourites are derived from three or more completions, require no curation, and add no
   entity to the data model.
5. Custom shortcuts are created only from an existing General Plan, are capped at 12, appear
   only after explicit Plan → General choices, store no people or sharing, and create nothing
   until **Save plan**.
6. `unsettled_monthly` is off by default, fires at most once per calendar month, lists at most
   two balances, writes no inbox entry, and is held by quiet hours.
7. With no network and a cold start, Today, Plans, Lists and any plan in retained coverage
   render from committed typed native rows (or the web persisted read cache); a balance
   renders `Balance unavailable offline` rather than a figure.
8. Native coverage stays within its table-specific policy and migrates transactionally;
   unresolved outbox work is never age-deleted. The web cache stays under its 2 MB deployment
   cap and may be discarded on an app-version buster.
9. A mutation queued offline survives an app kill and flushes on reconnect with the **same**
   `Idempotency-Key` it was created with.
10. Every durable mutation kind has a push adapter before the sync engine may claim it.
11. Intents sharing an `ordering_key` apply in durable order; unrelated work may progress,
    with no cross-entity concurrency or implicit-compaction requirement.
12. A queued `PATCH` uses the `If-Match` value captured at edit time. On `409` the client
    performs a field-level three-way merge, re-applying non-overlapping fields and naming the
    dropped ones in one banner.
13. A queued mutation returning `404` is dropped silently; `403` and other `4xx` are dropped and
    named; `429` retries after `Retry-After`; `5xx` retries with backoff up to six attempts and
    then parks in an `Unsent changes` list the user can see.
14. Completion, RSVP, skip, snooze and every ListItem write are last-write-wins with no
    `If-Match`. No code path implements ListItem state as an invert/toggle, asserted by a grep.
15. The 200-mutation cap refuses new writes with the specified copy, and web persists no
    mutation queue.
16. Setting an item to `done` offline lands exactly once even when the same intent is
    delivered twice, and two devices queueing that state converge with no `409`.
17. Reordering a list item offline is refused with `Reordering needs a connection.`,
    enqueues nothing, and the row springs back. The list share sheet is disabled offline.
18. On reconnect, a shared list sync transaction installs canonical server rows and resolves
    retained local intents according to the written policy before subscribers observe it —
    no render-time overlay or generic client-side merge of item sets exists.
19. A member removed from a shared list while offline gets **one** banner naming the list,
    has every unresolved native intent for it retained as structured
    `needs_attention/rejected` without a per-intent banner, and the list leaves visible rows
    or the web cache.
20. The share extension accepts a URL, plain text or one image up to 10 MB, hands off to Global
    Add with **Task**, **Plan**, and **List item** unselected, has no compose UI, requests no
    keychain access, and discards a payload older than 10 minutes. Capture waits for a complete,
    explicit `CreationTarget`, never chooses target/type/people/sharing/reminder state, and
    never writes.
21. The widget renders from an App Group snapshot, never calls the API, holds no credential,
    shows `Nothing planned today` when empty, renders the empty state for a snapshot older than
    24 hours, and is cleared on sign-out.
22. The widget's `Hide plan titles` setting changes what the **writer stores**, not just what
    the widget renders.
23. Lambda memory is set from a recorded power-tuning curve; OQ-3 is closed.
24. Cold `GET /v1/agenda` ≤ 700 ms, warm server-side p95 ≤ 60 ms, init p95 ≤ 400 ms, ≤ 4
    DynamoDB round trips per agenda request.
25. App launch to first painted row ≤ 1.0 s warm and ≤ 2.0 s cold (S3); Today scrolls at ≥ 58
    fps average with 100 rows on an iPhone 11.
26. `/invite/[token]` initial JS ≤ 120 KB gzipped; any authenticated route ≤ 350 KB; total first
    authenticated load ≤ 900 KB; the Lambda artifact ≤ 5 MB.
27. `axe-core` reports zero `serious` or `critical` violations on every web route.
28. Every interactive element is at least 44 × 44 with 8 pt of separation, verified by an
    automated test.
29. Every screen is verified at the largest accessibility text size with no clipping and no
    horizontal scrolling at 320 pt; `allowFontScaling={false}` appears nowhere.
30. Every foreground/background pair meets 4.5:1 (3:1 for large text and control boundaries) in
    both light and dark themes.
31. Colour is never the sole carrier of meaning, verified against the four documented cases.
32. Every swipe action is reachable as an accessibility action; four Maestro flows complete
    core journeys using only accessibility actions.
33. Crash reporting produces symbolicated stacks with no user content in any event, and the
    install id does not survive a reinstall.
34. No third-party product-analytics SDK, no advertising identifier, and no cross-reinstall
    identifier exists in the app.
35. Every declared privacy label matches what the app actually collects.
36. The launch checklist is complete, dated and initialled; every command in the runbook has
    been run against dev at least once.
37. Rollback and the OTA hotfix path are both rehearsed and timed, with the timings in the
    runbook.
38. Day-1 and day-7 reports are recorded, and `cost-model.md` §1's estimates are replaced with
    measured values.
39. `mode: 'after_completion'` produces **at most one** future occurrence, computed as the last
    completion date plus the interval, or the active segment's `effectiveFrom` when never completed. Un-completing
    reverts it. It is described as `3 days after each time you do it`, never `Every 3 days`.
40. `freq: 'custom'` accepts only the allow-listed RFC 5545 properties and rejects every other
    one with `validation_failed`. The expansion deduplicates two occurrences of one series on
    one date rather than rendering a duplicate row.
41. The recurrence module remains at 100% statements, branches, functions and lines after both
    modes land.

## Out of scope for this phase

| Not in Phase 9 | Why |
| --- | --- |
| A generic local-first framework, DynamoDB mirror, generic entity table, CRDT, SQLite web adapter, or local expansion of a server-known recurrence series | ADR-057. Domain-specific native SQLite is already the bounded architecture; recurrence authority remains server-side. |
| A convergent merge for shared lists — an OR-set of items or generic client-side three-way merge | ADR-044 and ADR-057. Phase 6 may add a durable change feed/conflict policy when shared offline edits require it; it is not a Phase 2.6 prerequisite and no half-CRDT is introduced here. |
| Queued reordering of list items, and any client-side rank computation | P9-07. The server owns ranks; the client sends `afterItemId`. Reordering offline is refused, not deferred. |
| A real-time channel for shared lists — WebSockets, polling, or a push on another member's edit | Not in v1. Refetch on focus and on reconnect is the whole reconciliation. |
| Web push, a service worker, a browser permission prompt (OQ-8) | Only worth it if web becomes a primary surface rather than the invite surface. |
| Android | One platform, one queue, one review process at a time. |
| iPad-specific layouts beyond the responsive breakpoints | The `medium` and `expanded` breakpoints already work; a bespoke iPad experience is a separate project. |
| Interactive widgets, Live Activities, StandBy, lock-screen widgets, watch app, Siri intents, App Shortcuts | Each is its own surface with its own failure modes. The home-screen widget is the one with clear value. |
| A share extension with a compose UI | A second runtime and a second creation path. |
| Two-way calendar sync | [`../01-product/overview.md`](../01-product/overview.md) §6. |
| A paid tier, in-app purchase, or capture quota billing (OQ-6) | A product decision that needs launch data first. |
| Localisation beyond English | The strings module makes it a swap later; doing it now doubles the review surface. |
| Referral, growth or re-engagement mechanics of any kind | [`../01-product/notifications.md`](../01-product/notifications.md) §1. |
| Moving prod to its own AWS account (OQ-7) | Triggered by a second person getting access, not by launch. |

## Risks and gotchas

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **An outbox intent has no registered push adapter**, and the bug looks like "sync doesn't work sometimes". | Register every durable mutation kind before the serialized engine may claim work; a startup test enumerates stored kinds against adapters. |
| 2 | **An idempotency key regenerated on retry** creates duplicates on a flaky network — the exact failure the key exists to prevent. | Generated once in the transactional action input and persisted with the intent; a test asserts stability across three retries. |
| 3 | **Deriving a date at sync time** completes the wrong day when the queue drains overnight. | Dates are captured in the transactional action input; tested explicitly. |
| 4 | **Serving money from a stale cache** produces an unexplained number, which the product forbids. | Balances and expenses are never persisted; offline shows an explicit unavailable state. |
| 5 | **A conflict policy that is emergent rather than written** produces different behaviour per screen and is impossible to test. | Thirteen numbered rules, each with a named test, plus a table of what the policy honestly does not do. |
| 6 | **A queued reorder resolves `afterItemId` against a list that changed**, so the item lands somewhere the user did not mean, silently. | Reordering is refused offline, not queued (P9-07), with copy that says why. The alternative — a client-computed rank — would put a second rank generator in the product. |
| 7 | **`checked` is treated as a toggle in the optimistic path** even though the server sets it, so a duplicate queue delivery flips it back. | Set, never toggle, on both sides; criterion 14's grep and criterion 16's double-delivery test. |
| 8 | **A shared list grows an ad-hoc local merge** because one reconciliation case loses an edit, and the fix becomes a half-CRDT nobody can test. | ADR-057 keeps typed transaction materializers bounded and leaves a durable change feed/conflict policy to Phase 6 if shared offline evidence requires it. |
| 9 | **Losing access to a shared list produces one error per queued mutation**, so a user removed from a grocery list sees twelve toasts. | Rule 13 hides the list, marks its unresolved intents rejected and emits one banner; criterion 19 counts banners and asserts zero retries. |
| 10 | **A UI share extension** means a second RN runtime in a memory-limited process and a second creation path to keep in sync. | Non-UI hand-off. |
| 11 | **A widget that authenticates** needs a token in a second process and a refresh path in an extension with seconds of budget. | Snapshot file only; no network, no credential. |
| 12 | **Lock-screen widget content** exposes plan titles to anyone holding the phone. | An explicit setting that changes what is written, not just what is rendered. |
| 13 | **Native changes cannot be hot-fixed.** Assuming otherwise during an incident wastes the first hour. | The OTA rule is in the runbook, and the hotfix path is rehearsed before launch. |
| 14 | **A PITR restore reintroduces deleted users' data.** | The runbook's restore procedure has the re-run-the-deletion-queue step next to the command, because it is the step that gets forgotten. |
| 15 | **An unconfirmed SNS subscription** means every alarm goes nowhere, silently, and is only discovered during an incident. | The launch checklist tests one alarm end to end. |
| 16 | **App Review rejections that are entirely predictable**: missing account deletion, missing Sign in with Apple, a demo account with no data, a privacy label that does not match. | Each is a checklist item with a named guideline; the demo account is seeded with a shared plan, an expense and a recurring task. |
| 17 | **Screenshots containing real data.** | Generated from a seeded simulator with fictional content; a review step before submission. |
| 18 | **Launching without measured performance** means the budgets are aspirations and the first bad review is the measurement. | Every budget is a CI gate or a recorded measurement before the checklist can be signed. |
| 19 | **A crash reporter that captures user content** turns a debugging tool into a privacy incident. | `sendDefaultPii: false`, `beforeSend` scrubbing on the same list as `pino`, and a test that asserts none of the redacted values are emitted. |
| 20 | **Post-launch drift**: the cost model, the perf budgets and the runbook are written once and never revisited. | Day-1 and day-7 reports are tasks with owners, and the cost model explicitly instructs replacing its estimates with measurements. |
