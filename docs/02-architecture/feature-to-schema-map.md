# Feature-to-schema map

The connective tissue between `../01-product/` (what the app does) and `data-model.md`
(how it is stored). Read this when you want to check that a product flow actually works
against the schema, or when a feature feels like it needs a new table.

Nothing here is new information. If this document and `data-model.md` disagree,
`data-model.md` wins.

---

## 1. The three nouns are four key ranges

The entire user-facing mental model — Today · Plans · Lists — reduces to a handful of
key-range queries against one table. There are **four** GSI1 buckets, not three, and the
fourth is what lets a plan exist before anybody has picked a day.

> **A Plan is an Activity with explicit `objectKind: 'plan'`. A date changes its scheduling
> state, not its identity.** Canonical in
> [`data-model.md`](data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity)
> §1, recorded as ADR-045. Every trace below is an expression of it: a date moves an index
> entry between buckets, and nothing else about the activity changes.

| Product surface | Query | Bucket |
| --- | --- | --- |
| **Today**, timed and dated-untimed | `GSI1` `gsi1pk = U#<uid>#S`, `gsi1sk BETWEEN <today>T00:00 AND <today>T23:59` | `#S` |
| **Today → ANYTIME**, undated | `GSI1` `gsi1pk = U#<uid>#N` — explicit undated Task only | `#N` |
| **Today**, recurring | `GSI1` `gsi1pk = U#<uid>#R`, expanded at read time | `#R` |
| **Plans → Upcoming / Past** | The *same* `#S` query, wider date bounds, either side of today | `#S` |
| **Plans → Needs a date** | `GSI1` `gsi1pk = U#<uid>#P`, `ScanIndexForward=false` | `#P` |
| **Lists** | `pk = USER#<uid>`, `sk begins_with LIST#` → pointers, then one `BatchGetItem` | — |

Today and Plans' Upcoming stage are still not two features. They are one query with
different bounds, and that remains the strongest single piece of evidence that the model
matches the product.

**`#N` and `#P` both hold undated activities and mean opposite things.** `#N` is *today,
whenever* — `Submit the insurance form`. `#P` is *someday, undecided* — `Dinner at Zahav
with Alice, date TBD`. One attribute decides which, computed by one pure function
(`deriveGsi1Bucket`, [`data-model.md`](data-model.md#bucket-derivation)): recurrence and a
date win, then the stored `objectKind` chooses `#P` or `#N`. Collapsing the two would send an
undecided group plan to Today's Anytime list next to a solo errand, which is the error the
split exists to prevent.

**Two timestamps, two jobs.** `#P` sorts on `lastActivityAt`, which an RSVP, a posted update
or an added expense bumps, so the plan people are talking about floats to the top rather than
the oldest one. `updatedAt` backs `If-Match` and is bumped only by edits to the activity
itself. One field for both would make a participant's RSVP fail an owner's open edit sheet
with a `409` about nothing.

---

## 2. Explicit target → the correct create endpoint → Today, Plans, or Lists

Global Add chooses a `CreationTarget` before it calls capture or creates anything. Contextual
entry points state the same decision in their label and path. There is no generic write that
classifies an ambiguous title:

| Target | Endpoint | Stored result |
| --- | --- | --- |
| `{ objectKind: 'task', type: 'task' }` | `POST /v1/activities` | Activity + owner index |
| `{ objectKind: 'plan', type: <chosen PlanType> }` | `POST /v1/activities` | Activity + owner/participant indexes |
| `{ objectKind: 'listItem', listId }` | `POST /v1/lists/:listId/items` | ListItem only |

Capture receives and echoes this target. It may extract compatible fields but cannot replace
the target, choose people, or write. A Task or Plan creation then converges on the same core
Activity writes:

```
POST /v1/activities
  │
  ├─ ACT#act_x  | META          the record itself
  └─ USER#usr_u | IDX#act_x     the index entry that carries the GSI1 keys
```

The index entry decides where the thing shows up, and it is a single attribute:

| The user did this | `gsi1pk` on the index entry | Where it appears |
| --- | --- | --- |
| Saved an explicit Task with no date | `U#usr_u#N` | Today's **ANYTIME** section |
| Saved an explicit Plan with no date, private or shared | `U#usr_u#P` | Plans → **Needs a date**. Never Today. |
| Gave it a date | `U#usr_u#S` | Today, or Plans → Upcoming / Past, at that date |
| Made it repeat | `U#usr_u#R` | Expanded per date at read time (§6) |

So "save it for later" versus "commit to a date" — the distinction the whole product turns
on — is one attribute on one item. It is not a different entity, a different table, or a
different code path. Row two is the same statement about a plan that exists before its date
does: `Alice and I want to try Zahav` is a real, undated `event` Plan because the user
explicitly chose **Plan → Event**. It is shared only because the user separately chose Alice;
the server infers neither decision from Alice's name or the title.

Scheduling something later is `POST /v1/activities/:id/schedule`, which rewrites the same
index entry into a different bucket. Nothing moves between tables.

---

## 3. Five types, one record

`type` plus a discriminated `details` sub-document (`data-model.md` §4.4).
`task` is the Task target's type. Plans use `PlanType = Exclude<ActivityType, 'task'>`:
General (`custom`), Meal, Watch, Event. This keeps every Plan kind visible in the
creation UI.

| Type | What lives in `details` | Where the UI branches |
| --- | --- | --- |
| `task` | nothing | renders a checkbox |
| `meal` | meal slot, ingredients | subtitle, ingredient→groceries action |
| `watch` | media title, season, episode, service | subtitle `S2 E4`, progress action |
| `event` | description, price, ticket URL, organiser, reservation | tickets/details and reservation blocks |
| `custom` | shortcut reference | generic |

The branch is in the **row renderer and the creation form**, and nowhere else. The API
does not branch on type. The repository does not branch on type. The agenda query does not
branch on type.

This is what makes "types guide creation rather than restrict it" implementable rather
than aspirational: changing a Watch into a Custom is a field update, not a migration.

---

## 4. Lists are independent collections; scheduling is optional

A list is a finished thing on its own. "Favourite restaurants" is not an unfinished
"Restaurants to try", and most items in most lists never become an Activity. The schema
makes that the cheap, ordinary case and treats the bridge to Activities as an addition.

### 4.1 The ordinary case: an item that links to nothing

`Bars to try` is one canonical list row, one pointer per active person — which is the owner's
single pointer for a private list — and one item row per bar. It has no `MEMBER#` row: those
rows exist only for non-owners. That is the whole storage cost.

```
LIST#lst_bars | META                { behaviour: "collection",          ← the canonical list
                                      templateKey: "bars-to-try",
                                      capabilities: { checkable: true,
                                                      supportsLocation: true },
                                      slot: null, title: "Bars to try",
                                      memberCount: 1 }

USER#usr_u    | LIST#lst_bars       { role: "owner", addedAt: ... }     ← a pure pointer

LIST#lst_bars | ITEM#a0#itm_kimo    { title: "Kimo's",
                                      location: { label: "Kimo's, Fishtown" } }
```

**The canonical list is in the `LIST#` partition, not the owner's.** The `USER#` row is an
index entry, one for the owner and each active non-owner, exactly as `IDX#` works for
activities — and unlike `IDX#` it
carries `role` and `addedAt` and nothing else. The asymmetry is deliberate and is justified
in [`data-model.md`](data-model.md#33-list-partition): an activity feed is time-ranged and
sorted, so its index must carry sortable denormalised display data; a user's lists are a
small unordered set, so one `BatchGetItem` is cheap. What that buys is in §5.2.

No caller-visible `LNK#` row, no `ACT#` partition, no index entry, no GSI1 write, nothing on
Today. A ListItem with no viewer link is a row and nothing more, and it may stay that way for
the life of the list.

This is why `List` is a separate entity rather than a view over Activities: an Activity
carries a status, an index entry, a schedule and a lifecycle that a bar on a wishlist has
no use for.

### 4.2 Behaviour, capabilities and template are data, not code paths

Three lists a user might reasonably keep, and what distinguishes them in storage:

| List | `behaviour` | `templateKey` | `capabilities` | `slot` |
| --- | --- | --- | --- | --- |
| Groceries — Costco | `collection` | `groceries` | `checkable: true`, `supportsLocation: false` | `groceries` |
| Bars to try | `collection` | `bars-to-try` | `checkable: true`, `supportsLocation: true` | `null` |
| Gift ideas | `collection` | `gift-ideas` | `checkable: false`, `supportsLocation: false` | `null` |

All three are the same behaviour, stored in the same partition shape, read by the same
query, rendered by the same item renderer. They differ by **data on the row** — capability
flags, an enum and a slot — and by nothing else. There is no `if (list.templateKey ===
'groceries')` anywhere in the system.

The user selects a template/style before naming the list, and `POST /v1/lists` requires that
exact `templateKey`. The selected template is a **seed**: the server copies its behaviour,
capabilities, slot, icon, and empty-state copy onto the `List` and then forgets it. It never
ranks templates from the title and never substitutes `simple-list`. `templateKey` survives
only as provenance and analytics. Nothing re-resolves a template at read time, so the list in the shop
today renders from its own row and not from a catalogue that has since been edited.

Two behaviours exist beyond `collection`, and only because the application genuinely does
something different: `watch` groups its items under status headings, and `meals` carries
structured `ingredients`. See
[`data-model.md`](data-model.md#46-list-and-listitem) for the full test.

### 4.3 The optional bridge: a list item becomes a plan

Traced exactly, because a shared ListItem and a Plan have different audiences. List
membership does not grant Plan access.

**Before.** A watchlist entry:

```
LIST#lst_watch | ITEM#a0#itm_severance
  { title: "Severance",
    details: { behaviour: "watch", watchStatus: "want", season: 2, episode: 4 } }
```

**The action.** Ujjwal chooses **Just me** and confirms a `watch` Plan:

```json
POST /v1/lists/lst_watch/items/itm_severance/schedule
{
  "creationTarget": { "objectKind": "plan", "type": "watch" },
  "audience": { "mode": "just_me" },
  "schedule": { "date": "2026-08-14", "time": "20:00", "timezone": "America/New_York" }
}
```

**After.** The ListItem is unchanged. The transaction creates the Plan, its user index, and
one viewer pointer:

```
ACT#act_x      | META               type: watch
                                    objectKind: plan
                                    listItemId: itm_severance
                                    listId: lst_watch
                                    schedule: { date: 2026-08-14, time: 20:00 }
                                    details: { mediaTitle: "Severance", season: 2, episode: 5 }

USER#usr_u     | IDX#act_x          gsi1pk: U#usr_u#S
                                    gsi1sk: 2026-08-14T20:00#act_x

LIST#lst_watch | LNK#usr_u#itm_severance
                                    activityId: act_x              ← visible to usr_u only
```

The list item is neither copied nor rewritten. Both screens now read the truth from their own
records:

- The Watchlist renders "Severance · Planned Fri 14 Aug, 8 PM" by following
  Ujjwal's `LNK#usr_u#itm_severance` pointer.
- Another list member receives no pointer and sees the ordinary Severance item with no state
  line. They cannot discover or navigate to Ujjwal's private Plan.
- Today on the 14th shows it because the index entry falls in the date range.

If Ujjwal chooses **Choose people** and selects Alice, the same request carries
`audience: { mode: 'selected_people', participants: [...] }`. Alice receives Activity access.
She receives `LNK#alice#itm_severance` only if she is also an active member of `lst_watch`.
A selected guest or person outside the list can use the Plan but cannot see the list, so no
list pointer is written. No list member is selected automatically.

Alice can later schedule her own private session from the same item. Her fixed-key pointer
then changes to her Plan; Ujjwal's pointer does not. One viewer has one current link per item,
not one global link for the shared object.

**Afterwards.** Marking it watched writes `outcome: 'watched'` on `ACT#act_x | META`. The
follow-up suggestion (`../01-product/plans-and-lists.md`) offers to advance the list item's
`details.episode` from 5 to 6. The user confirms; one item updates. Nothing is auto-created.

**Deleting either side clears only matching pointers and back-pointers.** It never cascades.
A deleted Plan leaves the watchlist entry intact. Deleting the ListItem clears the Activity's
`listId` / `listItemId` but leaves the Activity alive.

The same three-write shape covers a `Bars to try` item becoming an Event and a
`Meals to try` item becoming a Meal. The request carries the type the caller confirmed; the
server never derives it from behaviour, capabilities, template, or title. The ListItem title
seeds the Plan title once, then they are independently editable so a list member cannot
rename an inaccessible private Plan.

### 4.4 Resolving a default destination

"Add these ingredients to a shopping list" is a cross-entity flow with no obvious target
once `Groceries`, `Costco` and `Packing for Lisbon` are all `behaviour: 'collection'`.
Behaviour cannot answer it. The `slot` on the list can.

```
USER#usr_u | PROFILE          { defaultLists: { groceries: "lst_costco",
                                                watch:     "lst_watch" } }

USER#usr_u | LIST#lst_costco  { role: "owner" }   ─┐
USER#usr_u | LIST#lst_corner  { role: "owner" }    ├ pointers: one Query
USER#usr_u | LIST#lst_lisbon  { role: "member" }  ─┘

LIST#lst_costco | META        { slot: "groceries", … }  ─┐
LIST#lst_corner | META        { slot: "groceries", … }   ├ one BatchGetItem
LIST#lst_lisbon | META        { slot: null,        … }  ─┘
```

The flow is a query for the user's list pointers plus one batch get for their `META` rows
(access pattern 7), a filter on `slot`, and then the four-step rule in
[`data-model.md`](data-model.md#default-slots):

| Eligible lists | What happens | What is written |
| --- | --- | --- |
| Exactly one | Use it, do not ask | The items only |
| Several, `defaultLists.<slot>` set | Use the default, show it, allow a one-off override | The items only — an override is not remembered |
| Several, no default | Ask once | The items, plus `defaultLists.<slot>` on the profile |
| None | Offer `New list`; open the ordinary full catalogue with no style selected. If the user explicitly chose a typed Watch destination, show only the three Watch templates in canonical relative order, still unselected | First `Create list`, then—only after the new destination is visibly named—the separate item write |

Two properties fall out of storing the answer on the profile rather than deriving it.
Opening a list writes nothing, so browsing `Costco` cannot change where tomorrow's
ingredients go. And a one-off override in the sheet is a parameter to that request, not a
profile write, so it cannot silently become the new default. Most-recently-used would break
both, which is why it is rejected in `data-model.md` §4.6.

---

## 5. Plans can create related lists, after explicit choices

**A user adds a Packing list to a trip.** Plan detail's named `Add list` action opens the full
fixed-order template catalogue with nothing selected. Only after the user explicitly chooses
Packing, reviews the editable title, and activates `Create list` does the ordinary List gain a
back-pointer:

```
LIST#lst_pack | META   { behaviour: "collection", templateKey: "packing",
                         icon: "suitcase", emptyStateCopy: "Add something to pack.",
                         capabilities: { checkable: true,
                                          supportsLocation: false },
                         slot: null, sourceActivityId: "act_trip" }
```

The plan detail screen shows "Packing · 3 items" because it queries lists by
`sourceActivityId`. The list screen shows "From: New York Trip" from the same field.

`sourceActivityId` is the **only** link, and it is a label rather than ownership. Deleting
the trip clears the back-pointer and leaves the list and its items; completing the trip does
not archive it. A list of things you own is not owned by the trip that prompted you to write
it down.

**A user adds selected Meal ingredients to a visibly named list.** Every ingredient starts
unchecked. After the user selects rows, the destination is resolved by §4.4's slot rule, shown
before the write, and remains changeable. Only `Add <n> to <list>` (or the combined named Plan
save action) authorises the item writes. The target is never chosen from Meal/title words.
Provenance is then stored per item, not recomputed:

```
LIST#lst_groceries | ITEM#c4#itm_chicken
  { title: "Chicken", sourceActivityId: "act_tacos", sourceLabel: "Sunday dinner" }
```

That `sourceLabel` is exactly the `Chicken — Sunday dinner` line in the concept. It is
computed once at creation and frozen, so renaming or rescheduling the meal does not
silently rewrite a grocery list the user is standing in a shop reading.

**Prep tasks are ordinary Activities** with `parentActivityId` set, plus a thin `SUB#`
pointer in the parent's partition:

```
ACT#act_trip | SUB#act_hotel   { title: "Book hotel", status: "scheduled", rank: "a0" }
ACT#act_hotel | META           { objectKind: "task", type: "task",
                                 parentActivityId: "act_trip", ... }
USER#usr_u   | IDX#act_hotel   { gsi1pk: "U#usr_u#S", ... }
```

So "Book hotel" appears **under the trip** (via `SUB#`, in the same single query as the
rest of the plan detail screen) *and* **on Today** (via its own index entry) if it has a
date. One record, two surfaces, no copy.

---

## 6. Recurring tasks

The place where a naive schema goes wrong, so it is worth being explicit.

`Gym, every day, 6 PM` is **one row**:

```
ACT#act_gym  | META          recurrence: { freq: "daily" }, schedule.time: "18:00"
USER#usr_u   | IDX#act_gym   gsi1pk: U#usr_u#R
```

There are no rows for tomorrow's gym, or next Tuesday's. The agenda endpoint reads the
`#R` bucket (a small set), expands each series in memory for the requested dates, and
merges the results with the `#S` bucket.

The same holds for every frequency, `yearly` included. `Mum's birthday, every 3 September`
is one row, with the anchor written explicitly:

```
ACT#act_bday | META   recurrence: { mode: "fixed", segments: [{ freq: "yearly",
                                    byMonth: [9], byMonthDay: [3],
                                    effectiveFrom: "2026-09-03" }] }
```

The client always writes `byMonth` + `byMonthDay` for `yearly` and `byMonthDay` for
`monthly`, so rescheduling one occurrence cannot move the rest of the series
([`data-model.md#42-recurrence`](data-model.md#42-recurrence)).

**Completing today's gym writes exactly one item:**

```
ACT#act_gym | OCC#2026-08-07   { status: "completed", completedAt: ... }
```

**Snoozing today's gym writes exactly one item:**

```
ACT#act_gym | OCC#2026-08-07   { status: "snoozed", snoozedUntil: "20:00" }
```

Neither touches `ACT#act_gym | META`. That is the whole mechanism behind the product rule
"snooze today, tomorrow is still 6 PM" — tomorrow was never a row, so there is nothing to
have shifted.

Absence of an `OCC#` item means "scheduled, not yet acted on". Only modified occurrences
cost storage, so a daily task the user has completed 400 times has 400 small items and a
daily task they have never touched has none.

---

## 7. Passed plans and "Earlier today"

No storage at all. The agenda endpoint compares each item's effective local time to now
and sets `isPast`, which puts it in the `earlier` bucket. The `Done / Didn't happen`
prompt writes `outcome` when the user answers, and writes nothing when they don't.

That is the schema expression of "users should not have to manually clean up every event".
An item that is never answered simply stops being rendered prominently. It does not
accumulate as debt because nothing was ever written that needs clearing.

---

## 8. Sharing puts a plan on someone else's Today

Adding Alice to a dinner:

```
ACT#act_dinner | PART#psn_alice        rsvp: "pending", displayName: "Alice"
USER#usr_alice | IDX#act_dinner        gsi1pk: U#usr_alice#S      ← the key move
USER#usr_me    | PLINK#psn_alice#...#act_dinner
USER#usr_alice | PLINK#psn_me#...#act_dinner
```

Alice gets **her own index entry, in her own partition**. Her Today query is byte-for-byte
the same query as for her own activities — it has no idea she is not the owner. There is
no "shared with me" feed, no second code path, no join.

The `PLINK#` items are what answer "what are Alice and I doing together?" in one query
with no filtering.

**The cost of this design, stated plainly:** rescheduling a shared plan changes the GSI1
sort key, so every participant's index entry must be rewritten. That is why participants
are capped at 50 (`data-model.md` §7) — it keeps the fan-out inside DynamoDB's transaction
limits. It is the one place the model pays for its query simplicity, and it is a bounded,
deliberate payment.

**Guests get no index entry**, because they have no user partition. They get a
`PART#` record, an `INVITE#<token>` for the public page, and a `GUESTEMAIL#` reverse index
so that if they sign up later, one query finds every guest record that belongs to them.

### 8.1 An undated shared plan, traced end to end

The case the fourth bucket exists for: two people agree on an idea, nobody has picked a day,
and the thing is real from the moment it is said.

**Creation.** The user chose Plan, then `event`: `Alice and I want to try Zahav`, no date,
one participant. Capture may fill the title but does not choose either target or Alice.

```
ACT#act_zahav  | META            objectKind: "plan", type: "event", status: "saved",
                                 schedule: absent,
                                 participantCount: 1,
                                 visibility: "shared",
                                 createdAt:      2026-08-07T14:02,
                                 lastActivityAt: 2026-08-07T14:02   ← seeded from createdAt
                                 updatedAt:      2026-08-07T14:02

ACT#act_zahav  | PART#psn_alice  rsvp: "pending", rsvpForDate: absent

USER#usr_me    | IDX#act_zahav   gsi1pk: U#usr_me#P                 ← not #N, not #S
                                 gsi1sk: 2026-08-07T14:02#act_zahav
USER#usr_alice | IDX#act_zahav   gsi1pk: U#usr_alice#P              ← her own entry
```

The bucket is `#P` for two independent reasons — it has a participant, and its type is not
`task` — and either alone would be enough. A solo, undated `Poconos trip` lands in the same
place. Both users' Plans tabs show it under **Needs a date**; neither user's Today shows it,
because the agenda never queries `#P`.

**Alice responds.** She taps `Interested` — the word, not a stored value.

```
ACT#act_zahav  | PART#psn_alice  rsvp: "going"          ← the stored value is unchanged
                                 respondedAt: 2026-08-09T09:14
ACT#act_zahav  | META            lastActivityAt: 2026-08-09T09:14   ← bumped
                                 updatedAt:      2026-08-07T14:02   ← NOT bumped
USER#usr_me    | IDX#act_zahav   gsi1sk: 2026-08-09T09:14#act_zahav ← resorts
USER#usr_alice | IDX#act_zahav   gsi1sk: 2026-08-09T09:14#act_zahav
```

Two things happen here that are easy to get wrong. `Interested` is `going` in storage —
there is no `interested` enum value, because the word depends on whether a date exists and
storing it would force a migration on the day one is picked. And the RSVP bumps
`lastActivityAt` only: the plan moves to the top of Needs a date, and an owner with an open
edit sheet still holds a valid `If-Match`.

**The date lands.** `POST /v1/activities/act_zahav/schedule { date: "2026-08-15", time:
"19:30" }` — one transaction:

```
ACT#act_zahav  | META            schedule: { date: 2026-08-15, time: 19:30, tz: … }
                                 status: "scheduled", icsSequence: 1,
                                 updatedAt: 2026-08-11T20:41        ← now it moves

ACT#act_zahav  | PART#psn_alice  rsvp: "pending"                    ← RESET
                                 respondedAt: removed
                                 rsvpForDate: "2026-08-15"

USER#usr_me    | IDX#act_zahav   gsi1pk: U#usr_me#S                 ← bucket changes
                                 gsi1sk: 2026-08-15T19:30#act_zahav ← sort key changes
USER#usr_alice | IDX#act_zahav   gsi1pk: U#usr_alice#S
                                 gsi1sk: 2026-08-15T19:30#act_zahav

ACT#act_zahav  | UPD#…           kind: "system", code: "schedule_changed"
```

Both the partition key and the sort key of every index entry change, for every participating
user — the fan-out from §8, now firing on a transition that did not previously exist. The
plan leaves Needs a date on both tabs and appears in Upcoming, and on Today on the 15th.

**Why the reset.** Alice agreed to the idea, not to a Saturday. Carrying `going` forward
would claim consent she never gave. She is asked again, her row on Today shows the pending
control, and the response tells the owner it happened (`rsvpReset: true`) rather than letting
them discover it. `rsvpForDate` is what makes the reset provable rather than inferred, and
it is why a **time-only** change on the same date keeps every response: the date she agreed
to has not moved. The full transition table is in
[`data-model.md`](data-model.md#71-rsvp-consent-does-not-survive-a-date-change).

The owner's own `PART#` row is never reset. Asking somebody whether they are going to the
plan they just scheduled is absurd.

### 8.2 The plan detail screen is one Query, read two ways

Everything that hangs off a plan lives in the plan's own partition, so the detail screen is
`Query pk = ACT#<a>` and nothing else. Two of those sort-key prefixes are newer than the rest
and are the reason the same query now has **two** callers with different rules.

```
ACT#act_zahav | META                          the activity
ACT#act_zahav | PART#psn_alice                Alice's RSVP
ACT#act_zahav | PART#psn_ben                  Ben's RSVP
ACT#act_zahav | SUB#act_book_table            a prep task pointer
ACT#act_zahav | UPD#2026-08-09T09:14#upd_1    the updates feed
ACT#act_zahav | EXP#exp_1                     an expense
ACT#act_zahav | REM#usr_me#rem_1              my reminder      ← mine
ACT#act_zahav | REM#usr_alice#rem_7           Alice's reminder ← not mine
ACT#act_zahav | SUGG#2026-08-09T18:02#sug_1   Ben: 15 Aug, 19:30
ACT#act_zahav | SUGG#2026-08-10T08:40#sug_2   Alice: 16 Aug, "before the show"
```

| Caller | Access pattern | What it does with `REM#` |
| --- | --- | --- |
| `GET /v1/activities/:id` — the detail screen | 4 | **Filters to the caller's `userId`** before serialising. I see `rem_1`. Alice sees `rem_7`. Neither of us learns the other has one. |
| The reminder scheduler (Phase 5) | 4b | **Keeps all of them** and fans out one push per user, each at that user's own offset. |

One query, one partition, two projections. The scheduler is not a second read path and there
is no reverse index from a user to their reminders — the `userId` is inside the sort key,
which is what makes both readings cheap.

> **Decision:** the filter lives in the **projection**, not the repository. A repository that
> silently dropped other users' rows would make access pattern 4b impossible to express, and
> the scheduler would need its own query to get back what the repository threw away.

`REM#<userId>#<reminderId>` is why a shared plan has **one schedule and many reminder sets**.
Ujjwal's "leave in 15 minutes" is about Ujjwal's journey; Alice, who lives next door, should
not receive it because he created the plan. When Ben joins, his own explicitly set
`User.defaultReminderOffset` writes his own `REM#usr_ben#…` row. An unset default writes none
(`0` remains a valid At-the-time reminder). Nobody inherits anybody else's, and the leak
vector — a handler that returns what it read — is
[`security-privacy.md`](security-privacy.md#1-threat-model) §1 row 15.

`SUGG#` is the other half of §8.1's story. The plan above has no date; Ben proposes the 15th,
Alice proposes the 16th and marks Ben's as workable:

```
ACT#act_zahav | SUGG#…#sug_1   { suggestedBy: usr_ben,   date: 2026-08-15, time: 19:30,
                                 worksFor: [usr_alice] }
```

`worksFor` is an array on the suggestion, not a row per person, because it is bounded by the
participant cap and is only ever read with the suggestion itself. The owner then schedules
from one:

```
POST /v1/activities/act_zahav/schedule { fromSuggestionId: "sug_1" }
```

which copies the date and time and runs the §8.1 transaction unchanged — bucket move,
sort-key rewrite for every participating user, RSVP reset, system update — and then
**deletes every `SUGG#` row**. Marking a suggestion as workable is availability, not
consent, so the reset applies exactly as it would to a hand-typed date. The plan detail loses its suggestions
section because the question it answered has been answered.

Only the owner may schedule, and guests cannot suggest at all
([`data-model.md`](data-model.md#43a-datesuggestion) §4.3a). Both are authorisation rules in
the middleware, not affordances hidden in the client.

---

## 8a. A shared grocery list, traced end to end

The second shareable object, using the same People layer. One sharing system, two things it
can be pointed at.

**Sharing.** The list already exists (§4.1). Explicitly adding a registered housemate writes
up to seven items; existing People rows are reused:

```
LIST#lst_groc | MEMBER#psn_sam   { userId: "usr_sam", reciprocalPersonId: "psn_owner",
                                   role: "member", status: "active", joinedAt: … }
USER#usr_sam  | LIST#lst_groc    { role: "member", addedAt: … }   ← access pointer
USER#usr_me   | PERSON#psn_sam   create or reuse
USER#usr_sam  | PERSON#psn_owner create or reuse
USER#usr_me   | LLINK#psn_sam#…#lst_groc     { status: "active" }
USER#usr_sam  | LLINK#psn_owner#…#lst_groc   { status: "active" }
LIST#lst_groc | META             ADD memberCount :one
```

The pointer is what makes the list appear on Sam's Lists tab, and it is also the access
check: every list route loads `USER#<caller>` / `LIST#<id>` first, and its absence is a
`404`, never a `403`. `LLINK#` is People discovery data and cannot substitute for that
pointer. A person invited by email who has no account yet gets the `MEMBER#` row and an
owner-side `LLINK#` with `status: 'invited'`, but **no pointer or recipient-side row at all**
— there is no partition to write one into — so they can read nothing. The invitation counts
toward `memberCount` and the cap, but not `sharedListCount`. Verified signup follows the
Person's invited links, writes the pointer, creates the reciprocal Person and activates both
sides. Merely being a non-owner co-member never creates a Person relationship.

**Renaming is one write.** `LIST#lst_groc | META` is canonical, so `Groceries` →
`Groceries — Costco` is a single `UpdateItem` whether the list has one member or twenty. If
the title were denormalised onto the pointers, it would be one write per member, and a list
two people tick through would fan out on every tick.

**Two people ticking, which is the whole point.** Sam is in the shop, the owner is at home,
and both check `Milk` within the same minute:

```
LIST#lst_groc | ITEM#c4#itm_milk    SET checked = true      ← Sam
LIST#lst_groc | ITEM#c4#itm_milk    SET checked = true      ← the owner, seconds later
```

Both succeed. Neither carries `If-Match`, neither returns `409`, and the item ends `true`.
The rule that makes this work is one word: `checked` is **set, not toggled**. `SET checked =
NOT checked` would read identically in one client and would flip the item back in two — and
would also break the offline queue, where the same intent may be delivered twice. Setting a
field is idempotent and commutative; toggling it is neither.

The same three concurrency rules cover the rest ([`data-model.md`](data-model.md#shared-lists)):

| Both members | Result | Why |
| --- | --- | --- |
| Check the same item | One row, `checked: true` | Set, not toggled |
| Insert at the same position | Two rows with distinct server ranks; `(rank, itemId)` remains the defensive read order | Both race on `List.rankVersion`; one conditional write wins and the other re-reads neighbours before retrying. The `itemId` tie-break keeps Undo-restored, legacy or seeded duplicate ranks deterministic within one committed generation; a repair marker gates item reads until the next generation commits. |
| Add the same title | Two rows | Never auto-merged. Silently swallowing somebody's entry is worse than a visible duplicate they can delete. |

**Sam leaves.** Five access/relationship items change in the membership transaction, and no
contact record or authored ListItem does:

```
LIST#lst_groc | MEMBER#psn_sam   deleted
USER#usr_sam  | LIST#lst_groc    deleted        ← access ends here, immediately
USER#usr_me   | LLINK#psn_sam#…#lst_groc        deleted
USER#usr_sam  | LLINK#psn_owner#…#lst_groc      deleted
LIST#lst_groc | META             ADD memberCount :minus_one
```

Every item Sam added stays, with its title, rank, note and checked state. A grocery list does
not forget the milk because the person who typed it moved out — the same rule as expenses
surviving a participant's removal. Both `PERSON#` rows remain. Access ends the instant the
pointer is gone, because the pointer is the check; there is no cached grant on the server to
expire. Deleting the whole list removes every `LLINK#` in its cascade and still preserves the
People records.

---

---

## 9. People are derived, not declared

There is no friend graph. `USER#usr_me | PERSON#psn_alice` is a contact in *your* address
book — it says nothing about Alice's account.

The Person view combines three bounded relationship projections:

| Question | Query |
| --- | --- |
| What are we doing together? | `pk = USER#usr_me`, `sk begins_with PLINK#psn_alice#` |
| Do we owe each other anything? | `pk = USER#usr_me`, `sk begins_with BAL#psn_alice#` |
| What Lists did one of us explicitly share with the other? | `pk = USER#usr_me`, `sk begins_with LLINK#psn_alice#`; retain `active`, verify each exact `USER#/LIST#` pointer, then `BatchGetItem` current `LIST#/META` rows |

They are derived from explicit shared objects and their expenses. Nobody sends a friend
request, words in a title never create a relationship, and two non-owner co-members do not
silently become People — unless an expense links them. When an expense's payer and split set
pairs two participants who do not yet hold each other as People, the expense transaction
writes the missing `PERSON#` rows — the same `personId` mirrored into each affected app
user's partition, display name only, no contact details — plus the directional `PLINK#` rows
([`data-model.md`](data-model.md#7-write-paths-that-touch-multiple-items) §7). A pairwise
balance needs a Person on each side; without one the obligation would have no `BAL#` row, no
Person view and no settle entry point
([`../01-product/expenses.md`](../01-product/expenses.md#51-what-a-balance-is) §5.1). List
links supply `sharedListCount` and `LISTS TOGETHER`, but do not
affect the four-key People relevance sort.

---

## 10. Expenses live inside the plan

```
ACT#act_festival | EXP#exp_1   { amountCents: 7500, paidByPersonId: "psn_me", splits: [...] }
```

Same partition as the activity, so the plan detail screen already has the expenses from
its single query. No extra read.

Balances are a **cache**, one row per person per currency:

```
USER#usr_me | BAL#psn_alice#USD   { netCents: 700, unsettledExpenseCount: 2 }
```

A DynamoDB Streams worker recomputes it **from the source expenses**, never by applying
deltas — which is what makes at-least-once stream delivery safe. A pairwise contribution is
zero when its debtor is in that Expense's `settledPersonIds`; otherwise it contributes with
its ordinary sign.

Marking selected obligations settled makes one request with no caller-entered payment data:

```json
POST /v1/settlements
{ "personId": "psn_alice", "coversExpenseIds": ["exp_dinner"] }
```

The server resolves the globally unique id through `EXPENSE#exp_dinner`, authorises the
source Activity, and derives the pairwise obligation, currency, direction, exact
owner-scoped debtor, and display total. It adds that debtor to
`EXP#exp_dinner.settledPersonIds`, stores the reverse `debtor → settlementId` reference, and
writes immutable `SETTLE#` history plus a `SETTLEMENT#<id>` undo locator. The history row
also stores the exact `(activityId, expenseId, debtorPersonId)` coverage. Its `amountCents`
explains history; it is **not** a second balance delta. Recalculation excludes the now-settled
Expense-person contribution and never subtracts the Settlement row. That is what prevents
double counting and lets Undo reopen only this obligation.

Because the drill-down endpoint recomputes from those same `EXP#` items, "no unexplained
balance number" is a property of the schema, not a promise in a spec.

---

## 11. Where the model is under real tension

Being honest about the seams is more useful than claiming there are none.

| Tension | Why it exists | When it would bite |
| --- | --- | --- |
| **Index-entry fan-out** on reschedule of a shared plan | Buys a single-partition Today query for every participant | Large participant counts with frequent time changes. Capped at 50. |
| **The same fan-out now also fires on an RSVP reset**, and on the `#P` → `#S` bucket move | A date landing rewrites every participant's index entry *and* every `PART#` row in one transaction | At the 50-participant cap that is 103 items, past DynamoDB's 100-item limit. Handled by a threshold and a two-phase write; see below. |
| **Read-time recurrence expansion** | Avoids materialising infinite future rows | A user with hundreds of active series makes the agenda endpoint do real CPU. Capped at 200 with a warning. |
| **`SUB#` pointers duplicate a child's title and status** | Buys a one-query plan detail screen | Two writes on every prep-task rename. Must stay in the same transaction. |
| **`lastActivityAt` duplicates part of `updatedAt`'s job** | Keeps `If-Match` from failing on changes the editor did not make | Two timestamps to keep straight, and a write path that bumps the wrong one produces either a spurious `409` or a Needs-a-date list that does not resort. |
| **Template-seeded List fields are frozen at creation** | A list renders its stored behaviour, capabilities, slot, icon and empty-state copy, so a catalogue edit cannot change a list a user is standing in a shop reading | Two users who each made a "Groceries" list six months apart can hold different seeded values. A template improvement reaches new lists only; later user settings changes affect only the fields explicitly changed. |
| **Shared lists trade `If-Match` on items for usability** | A checkbox that returns `409` is worse than a lost keystroke | Two members editing the same item's *title* in the same minute: one silently wins. There is no conflict banner for item fields, by design. |
| **The list partition contains per-viewer `LNK#` rows** | A shared item can lead to private or selectively shared Plans without one global inaccessible link | The list-detail query reads other viewers' opaque pointers internally. Its projection must filter to the caller before Activity lookup or serialisation; history is not queryable. |
| **One user's reminders sit in a partition every participant may read** | Keying on `userId` inside `ACT#<a>` keeps the detail screen and the reminder scheduler on **one** query (§8.2) | A detail handler that returns what it read leaks Alice's reminder offset to Ben. The filter is the mitigation and it is a test, not a review item — `security-privacy.md` §1 row 15. |
| **Completion is global, so an `OCC#` row answers for everybody** | One occurrence key, one expansion, one answer to "did it happen" | Five people at a dinner, one of whom did not go. They set their RSVP to `declined` or leave; there is no per-person completion. Deferred, with its cost, in `../00-open-decisions.md` item 31. |
| **Multi-day plans** have no `endDate` | Upheld, not merely deferred: a trip is one activity on the start date with prep tasks (ADR-050) | A three-day festival **does not appear on Today on days two and three.** That is the stated consequence, not a bug to be papered over. See `../00-open-decisions.md` item 8. |

The first four are deliberate denormalisation with a bounded cost.

**The second row is new and is the largest bound in the model.** Rescheduling used to write
`ACT#/META` plus one index entry per participating app user — 52 items at the cap, comfortably
inside the limit. Resetting every RSVP adds one `PART#` write per participant, and a system
update, which takes it to 103. The reset cannot simply be dropped: a date that lands without
resetting responses is exactly the consent problem the rule exists to prevent. So the write is
one transaction up to a threshold and a two-phase write above it, with a marker on
`ACT#/META` that makes every read return `pending` while the second phase runs — the
intermediate state is never visible as a stale `going`. That is a real piece of machinery
bought by a product rule, and it is stated here rather than discovered at fifty participants.

**The fifth** is two fields for what looks like one concept. It is worth the eight bytes:
`updatedAt` is a concurrency token and `lastActivityAt` is a sort key, and the moment they
share a field, a participant's RSVP starts failing an owner's unrelated open edit with a
`409`. The cost is that every write path must know which one it is bumping — an edit moves
`updatedAt`, a discussion moves `lastActivityAt` — and a path that bumps both is wrong in a
way that only shows up under concurrent use.

**The seventh is the honest cost of shared lists.** Item writes carry no `If-Match`, so last
write wins on a field with no signal to either party. For `checked` this is not a compromise
at all — setting a boolean is idempotent and commutative, so two members converge with no
merge logic and the offline queue needs nothing special. For a *title* edit it genuinely
loses one person's text, silently. That is accepted because the alternative is optimistic
concurrency on every checkbox in a grocery list, which would produce constant spurious
`409`s and would park half a shopping trip in the offline queue's conflict banner. List-level
edits — title, capabilities, behaviour — do carry `If-Match`, because those are the changes
worth protecting and nobody makes them in a shop. The boundary is deliberate and it is drawn
in exactly one place.

The sixth is a deliberate consistency cost, and it is worth being exact about it. Freezing
buys the guarantee that a list never changes shape underneath its owner, which is the same
guarantee `sourceLabel` buys for provenance. It costs a fleet of lists that drift apart from
the catalogue and from each other, with no backfill and no intention of one. That is the
right trade for a list the user can edit directly, and it would be the wrong trade for
anything the user cannot see or change.

The per-viewer link is a deliberate privacy boundary inside a shared partition. Keying by
viewer prevents write contention and makes member cleanup queryable, but the full list query
still reads all `LNK#` rows. The projection filters first and tests with two list members:
Alice's private Plan id and schedule must never appear in Ben's response. A future history
view adds Activity-specific link rows; it does not widen the ListItem.

**The ninth and tenth are the same trade made twice: personal data inside a shared
partition.** A reminder belongs to one person and lives in a partition several people may
read, and the alternative — a `USER#<u>` / `REM#<activityId>` range — costs the detail
screen a second query and the scheduler a reverse index. Keeping it in `ACT#<a>` keeps both readers on
one query, and the price is that correctness now depends on a filter somebody has to remember.
That price is paid once, in the projection function, with a test. Completion is the mirror
image: it is *not* per person, so an `OCC#` row needs no user key at all — and the cost is
that a shared plan has exactly one answer to whether it happened, which is the owner's. Both
are cases where the schema is deliberately simpler than the general case, and both are honest
about what that costs.

The last is the one place the schema is genuinely thinner than the product concept implies.
It is not an oversight and no longer an open question: ADR-050 re-litigated it and upheld it,
and the consequence — no Today row on days two and three — is written down rather than
designed around.

**What is no longer a tension.** Lists used to be stored twice — canonical in the owner's
partition with a mirror at `LIST#<id>` — and that cost two writes on every rename. The
canonical row now lives at `LIST#<id>` / `META` alone, with owner-and-active-member pointers carrying
`role` and `addedAt`, so a rename is one write however many members there are. The inversion
was made for sharing and it removed a denormalisation on the way.

---

## 12. The cohesion test

If someone proposes a change, these are the questions that check it still fits.

1. Does it need a new table? If yes, it is almost certainly a new `type`, a new `details`
   variant, or a new sort-key prefix in an existing partition.
2. Does it need a new **list behaviour**, or is it a **template**? A behaviour is code —
   items render differently, carry different typed fields, or take part in a flow no other
   list has. A template is a row in `packages/shared/src/lists/templates.ts`. If the only
   difference is the label, the icon and which capability flags are on, it is a template.
   `Groceries`, `Packing`, `Restaurants` and `Bars to try` are all templates over
   `collection`.
3. Does it need a new GSI? If yes, can it be a new sort-key prefix under `USER#<uid>`
   instead? Every GSI is a second write on every mutation.
4. Does it write rows into the future? If yes, it should be expanded at read time.
5. Does it copy user-entered content from one place to another? If yes, it should be a
   pointer plus a stored provenance label.
6. Does it resolve a preset at read time? If yes, it should be copied at creation instead,
   so the stored row is the whole truth and an edit to the preset cannot rewrite history.
7. Does it create something the user did not confirm? If yes, it violates the product's
   central rule regardless of how clean the schema is.
8. Does it decide which GSI1 bucket something belongs in? If yes, it belongs in
   `deriveGsi1Bucket` and nowhere else — not in a service, not in a filter, not in a client
   type check. There is one implementation and one caller.
9. Does it denormalise anything onto a **list** index entry? If yes, ask what it costs on a
   twenty-member list: the pointer carries `role` and `addedAt` precisely so that renaming is
   one write and a ticked checkbox is not a fan-out.
10. Does it make a second object shareable? If yes, it uses the existing People layer,
    `personId` keys and the pointer-is-the-access-check pattern. Two shareable objects, one
    sharing system.
