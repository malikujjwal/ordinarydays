# Plans and lists

**Status:** canonical for plan detail, lists, and the bridge between them. Entities are
owned by
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem);
endpoints by
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).

---

## 1. What makes an Activity a Plan

**A Plan is an Activity whose `schedule.date` is set.** That is the entire definition.
There is no `Plan` entity, no `isPlan` flag, and no promotion step. Setting a date turns a
saved thing into a plan; clearing the date turns it back.

| Property | Consequence |
| --- | --- |
| `schedule.date` present | `status` becomes `scheduled`. The Activity appears in Plans, in the agenda for that date, and on Today when that date is today. |
| `schedule.time` present | It occupies a slot in Today's SCHEDULE rather than ANYTIME. |
| `participants.length > 0` | `visibility` becomes `shared`. Sharing rules apply — see [`sharing-and-people.md`](sharing-and-people.md). |
| `type` | Only changes which fields the detail screen renders and which verb completes it. Every type can be a plan. |

The word "Plan" never appears in the data model and appears in the UI only as a tab name
and in copy. Do not build a screen that lists "plans" separately from "activities with
dates" — they are the same query.

### 1.1 Creation routes

Every route ends at one `POST /v1/activities`. None of them is privileged.

| Route | Entry point | Pre-fills |
| --- | --- | --- |
| Manual | Add → type chip → form | Date if launched from a dated context |
| Natural language | Add → type text → parse | Whatever the parse returned, subject to review ([`ai-capture.md`](ai-capture.md)) |
| From a photo or screenshot | Add → Camera / Photos | Extracted fields + the image as an attachment |
| From a pasted link | Add → Link | Extracted fields + `sourceUrl` |
| **From a list item** | List item → Schedule | Title, type inferred from `list.kind`, `fromListItem` link (§5) |
| From a person | Person view → `Plan something with Alice` | Alice as a participant |
| Duplicate | Plan overflow → Duplicate | Everything except schedule, participants, expenses, attachments ([`activities.md`](activities.md#71-quick-add-behaviours)) |
| From an invitation | Accepting an in-app invite | Nothing is created; an `ActivityIndex` entry is added for the invitee |

---

## 2. Plan detail screen

One screen, one `GET /v1/activities/:id`, which is one DynamoDB `Query` over the
`ACT#<id>` partition (access pattern 4 in
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
Sections render in this fixed order and a section with nothing in it collapses to a single
"add" affordance rather than disappearing, so the plan's capabilities stay discoverable.

### 2.1 Anatomy

```
┌─────────────────────────────────────────────────────────┐
│ ‹ Back                              Share    ⋯          │
│                                                         │
│  [ attachment image, if primaryAttachmentId ]           │
│                                                         │
│  New York Trip                                    (1)   │
│  Outing · Shared with 3 people                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Fri 14 Aug – Sun 16 Aug                          │  │  (2)
│  │  Manhattan                                        │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  PEOPLE                                    Add people   │  (3)
│    Alice      Going                                     │
│    Ben        Maybe                                     │
│    Chloe      Invited · guest                           │
│                                                         │
│  PREP                                     3 of 5 done   │  (4)
│    ☑ Book hotel                                 2 Aug   │
│    ☐ Buy tickets                                8 Aug   │
│    + Add prep task                                      │
│                                                         │
│  LISTS                                       Add list   │  (5)
│    Packing            8 items · 3 checked               │
│    Places to visit    6 items                           │
│                                                         │
│  EXPENSES                                 Add expense   │  (6)
│    Total $482.00 · You are owed $121.50                 │
│    Hotel            $340.00   paid by you               │
│    Train            $142.00   paid by Alice             │
│                                                         │
│  NOTES                                                  │  (7)
│    Check-in is after 3 PM.                              │
│                                                         │
│  ATTACHMENTS                                    Add     │  (8)
│    [ thumb ] [ thumb ]                                  │
│                                                         │
│  UPDATES                                                │  (9)
│    Alice is going                          2 days ago   │
│    Time changed to 8:00 PM                 3 days ago   │
│    + Write an update                                    │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                    Done                           │  │  (10)
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

| # | Section | Contents | Rules |
| --- | --- | --- | --- |
| 1 | **Header** | Title, type label, share state, primary attachment as a hero image | Title is inline-editable by the owner. Tapping the hero opens the attachment viewer. `Share` opens the participant picker; `⋯` opens the overflow (edit, change type, duplicate, cancel, delete). |
| 2 | **When / where** | Date, time range, timezone if it differs from the profile, location label and address | The whole block is one tap target and opens the reschedule sheet ([`interaction-contract.md`](interaction-contract.md#3-gesture-table)). The address row, tapped separately, opens the platform maps app. Never inline-editable. |
| 3 | **People** | Participants with RSVP state, guest badge, invite links | Owner-only add and remove. Each row opens that Person's view. See [`sharing-and-people.md`](sharing-and-people.md#2-adding-people-to-a-plan). |
| 4 | **Prep** | Child activities (`parentActivityId` = this plan) | §3. The `3 of 5 done` counter is tappable and reveals the full list including completed items. |
| 5 | **Lists** | Lists whose `sourceActivityId` is this plan, plus any list explicitly attached | §4. `Add list` offers the suggested kinds for this plan's type; it creates nothing until the user picks one. |
| 6 | **Expenses** | Expense lines and the plan-level owes summary | Only rendered when the plan has ≥ 2 participants **or** ≥ 1 expense. See [`expenses.md`](expenses.md). Every number drills down. |
| 7 | **Notes** | `activity.notes`, private to the owner's view | Distinct from `details.description` on an `event`, which *is* shown publicly. Notes never appear on the invite page. |
| 8 | **Attachments** | Images linked to the activity | Tap opens a viewer; long-press offers Set as cover / Delete. Owner-only add and delete. |
| 9 | **Updates** | The plan's activity feed, newest first | System entries (RSVP changes, time changes, expense additions) are written server-side with `kind: 'system'`. Participants may post entries; nobody may delete another's. See [`../02-architecture/api-contract.md#25-updates-the-plans-activity-feed`](../02-architecture/api-contract.md#25-updates-the-plans-activity-feed). |
| 10 | **Completion** | One primary button with the type's verb ([`activities.md`](activities.md#52-completion-verbs)) | For a passed plan the button is replaced by the resolution prompt ([`today-and-tasks.md`](today-and-tasks.md#82-resolution-prompts)). For a recurring series it completes today's occurrence and says so. |

### 2.2 Section visibility

| Section | Hidden when |
| --- | --- |
| Hero image | No `primaryAttachmentId` |
| When / where | Never hidden. If unscheduled it renders `Not scheduled` with a `Schedule` action. |
| People | Never hidden. Empty state is the `Add people` affordance alone. |
| Prep | Never hidden. Empty state is `+ Add prep task` alone. |
| Lists | Never hidden. Empty state is `Add list` alone. |
| Expenses | Hidden when the plan has < 2 participants and 0 expenses |
| Notes | Empty state is a tappable `Add notes` placeholder |
| Attachments | Empty state is `Add` alone |
| Updates | Hidden when `visibility === 'private'` and there are no entries |
| Completion button | Hidden when `status` is `completed`, `skipped` or `cancelled`; replaced by the outcome and an `Undo` affordance |

---

## 3. Prep tasks

Prep tasks are ordinary Activities of type `task` with `parentActivityId` set to the plan.
They are not a sub-entity and have no reduced capability.

| Property | Behaviour |
| --- | --- |
| Creation | Inline `+ Add prep task` inside the plan, or from the Add screen's `Related plan` field |
| Own schedule | Yes. A prep task can be dated before the plan, on the plan's day, or undated. |
| Own reminders and recurrence | Yes. |
| Appears on Today | Yes, on its own date, with the plan's title as its subtitle ([`today-and-tasks.md`](today-and-tasks.md#5-tasks)) |
| Checkbox | Yes, everywhere — it is a `task` |
| Storage / retrieval | Access pattern 16 in [`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns) — queried from the parent's partition, not by a GSI filter |
| Counter | `activity.childCount` on the parent, maintained on write |
| On parent deletion | `parentActivityId` is cleared; the task survives ([`today-and-tasks.md`](today-and-tasks.md#55-related-plan)) |
| Shared plans | Prep tasks on a shared plan are visible to participants and completable by any participant. Their completion writes to the updates feed. |

A prep task may itself have a prep task. Nesting is capped at **2 levels** (a plan, and its
prep tasks). A `POST` that would create a third level returns `validation_failed`.

> **Decision:** the nesting cap is 2. Arbitrary nesting turns the product into an outliner,
> which is on the non-goals list in [`overview.md`](overview.md#6-non-goals).

---

## 4. Lists generated from a plan

A plan can produce lists. The plan never creates them by itself.

### 4.1 The suggestion

When a plan is created or opened, the LISTS section shows `Add list`. Tapping it opens a
sheet with suggested kinds, ranked for this plan, plus all eight kinds below a divider.

| Plan shape | Suggested kinds, in order |
| --- | --- |
| `outing` or `event` spanning ≥ 2 days | Packing, General (`To do`), Places, Shopping |
| `outing` or `event` on one day, with participants | General, Shopping |
| `meal` | Groceries |
| `watch` | Watchlist |
| `task` / `custom` | General |

Selecting a kind creates one `List` with `sourceActivityId` set to the plan and a title
defaulted to `<Kind> · <Plan title>` (e.g. `Packing · New York Trip`), editable in the same
sheet before confirming.

Hard rule: **no list is created without that confirmation.** Creating a trip plan does not
silently produce three lists. See
[`overview.md`](overview.md#44-suggest-never-auto-create).

### 4.2 The link

`List.sourceActivityId` is the only link. Consequences:

- The plan's LISTS section shows every list with `sourceActivityId === plan.activityId`,
  plus their item counts.
- The list's own header shows `From New York Trip`, tappable back to the plan.
- Deleting the plan does **not** delete its lists. The lists keep their items and lose the
  back-link (`sourceActivityId` is cleared). A list of things you own is not owned by the
  trip.
- Archiving the plan (completing it) does not archive its lists. The user archives lists
  explicitly (§5.4).

---

## 5. Lists

Lists hold things the user wants to remember without committing to when. They are
deliberately the simplest entity in the product: a title, a kind, and an ordered set of
items.

### 5.1 The eight kinds

`ListKind` is a closed enum. There is no UI to create a ninth.

| Kind | Holds | Items checkable | Default scheduling type |
| --- | --- | --- | --- |
| `watchlist` | Movies and shows to watch | No | `watch` |
| `meals` | Meals to try or cook again | No | `meal` |
| `restaurants` | Restaurants to try | No | `outing` |
| `places` | Places to visit | No | `outing` |
| `groceries` | Things to buy for food | Yes | `task` |
| `shopping` | Things to buy generally | Yes | `task` |
| `packing` | Things to bring | Yes | `task` |
| `general` | Anything else | Yes | `custom` |

The scheduling-type column is the mapping in
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).
It is a default the user can override in the schedule sheet.

> **Decision:** `general` lists are checkable. The data model's comment marks `checked` as
> "for groceries/packing/shopping", but a general list is most often a to-do-ish list and a
> non-checkable one is inert. The four non-checkable kinds are the aspirational ones —
> watchlist, meals, restaurants, places — where the completion signal is *scheduling the
> item*, not ticking it.

A user may have several lists of the same kind (`Groceries — Trader Joe's` and
`Groceries — Costco`). Each is a separate `List`. There is no default-list singleton, but
"add to Groceries" flows target the user's most recently used `groceries` list and let them
change it in the same sheet.

### 5.2 List behaviours

| Behaviour | Rule |
| --- | --- |
| **Add item** | Persistent `+ Add item` row at the foot. Return commits and re-focuses so several items can be typed in sequence. Each commit is one `POST /v1/lists/:id/items`. |
| **Check / uncheck** | Only on checkable kinds. Tapping the checkbox toggles `checked` optimistically; tapping the row body opens item detail. |
| **Checked item placement** | Checked items stay in place and render struck-through and de-emphasised. They do **not** jump to the bottom. Re-sorting under the user's finger is disorienting and makes accidental double-taps destructive. |
| **Reorder** | Long-press and drag on any kind. Writes one `PATCH /v1/lists/:id/items/:itemId` with `afterItemId`, which the server converts to a `lexoRank`. Never renumbers the list. |
| **Clear checked** | Header overflow → `Clear checked (7)`. One `POST /v1/lists/:id/clear-checked`. Deletes the checked items. Undoable for the standard undo window ([`interaction-contract.md`](interaction-contract.md#4-undo-policy)); after that it is permanent. Only offered on checkable kinds. |
| **Uncheck all** | Header overflow → `Uncheck all`. Offered on `packing` and `groceries` only, for reuse across trips and shops. |
| **Archive** | Header overflow → `Archive list`. Sets `archived: true`. Archived lists leave the Lists index, keep their items, and are reachable through `Lists → ⋯ → Show archived`. Restoring is one tap. |
| **Delete** | Header overflow → `Delete list`, confirmed. Deletes items. Any item with a `linkedActivityId` first clears the Activity's `listItemId`/`listId`; the Activity survives. |
| **Rename** | Inline on the header title. |
| **Item detail** | Tapping an item row opens a sheet: title, note, kind-specific fields (§5.3), `Schedule`, `Move to another list`, `Delete`. |
| **Move item** | Between lists of any kind. Kind-specific `details` that do not apply to the target kind are dropped, with the same confirmation pattern as a type change ([`activities.md`](activities.md#63-changing-an-activitys-type)). |
| **Empty list** | `Nothing here yet.` plus the add row. No illustration, no encouragement copy. |
| **Item cap** | 500 items per list. Beyond that, `POST` returns `validation_failed` with `List is full.` |

### 5.3 Per-kind specifics

| Kind | Extra item fields | Extra behaviours |
| --- | --- | --- |
| `watchlist` | `details.mediaKind` (movie/show), `details.watchStatus` (`want` / `watching` / `watched`), `details.season`, `details.episode` | Items group under three headings in this order: `Watching`, `Want to watch`, `Watched`. `Watched` collapses by default. A `watching` item shows `S2 E4` and, if a session is scheduled, `Next session Fri · 8 PM`. See §7. |
| `meals` | none beyond `note` | Item detail offers `Schedule` and `Add ingredients`. Ingredients typed here are stored on the item's `note` until it is scheduled; the resulting Activity's `details.ingredients` is populated from them. |
| `restaurants` | none | Item `note` is used for the dish or the recommendation source. Scheduling defaults to `outing` with `details.placeName` = the item title. |
| `places` | none | Same as restaurants. Frequently created from a trip plan (§4). |
| `groceries` | `sourceActivityId`, `sourceLabel` | Items created from a meal carry a provenance label (§6.3). Manually added items carry none. Checkable, and `Clear checked` is the primary post-shop action. |
| `shopping` | none | Checkable. |
| `packing` | none | Checkable, plus `Uncheck all` for reuse. |
| `general` | none | Checkable. |

---

## 6. The Lists → Plans bridge

### 6.1 The no-duplication rule

Scheduling a list item **does not copy it**. It creates one Activity and links the two
rows, per
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem):

```
ListItem.linkedActivityId  ──►  Activity
Activity.listItemId, .listId ──►  ListItem
```

One endpoint does this atomically:
`POST /v1/lists/:id/items/:itemId/schedule`.

A user who schedules `Zahav` from `Restaurants to try` must not end up with `Zahav` in two
places that can drift apart. There is one title, edited in one place: editing the Activity's
title updates the list item's title, and vice versa. The server keeps them equal on write.

> **Decision:** title is mirrored bidirectionally and kept equal by the server. Notes are
> **not** mirrored — `ListItem.note` and `Activity.notes` stay independent, because the
> note on a watchlist entry ("Ben said start at S1") means something different from the
> note on a watch session ("bring the HDMI cable").

### 6.2 What the item looks like after scheduling

The item stays in its list, in place, with an added state line. It is not moved, not
checked, and not hidden.

```
Restaurants to try
  Zahav
  Planned Saturday · 7 PM                    →
```

```
Watchlist
  Severance
  Watching · S2 E4
  Next session Friday · 8 PM                 →
```

Rules:

- The state line shows the linked Activity's date and time in the same relative format used
  elsewhere: weekday name within 7 days, otherwise `d MMM`.
- Tapping the state line opens the **Activity**, not the item detail. Tapping the title
  opens the item detail. Both targets are ≥ 44 pt.
- A scheduled item is visually distinguished by the state line alone. No colour change, no
  strike-through, no move.
- Checkable-kind items that are scheduled are still checkable. Checking one does not
  complete the Activity, and completing the Activity does not check it — except in the
  groceries case, which is not a link but a provenance record (§6.3).

### 6.3 What happens on completion, un-completion and deletion

| Event on the Activity | Effect on the linked ListItem |
| --- | --- |
| Completed (any outcome) | On `watchlist` items: `details.watchStatus` and progress update per §7.4. On `meals`, `restaurants`, `places`: the item is **not** deleted; its state line becomes `Done Saturday` and it remains in the list. On checkable kinds: the item is set `checked: true`. |
| Un-completed | The state line reverts; `checked` reverts to `false`; watchlist progress reverts to its pre-completion values. |
| Skipped / `didnt_happen` | The state line is removed and the item returns to its unscheduled appearance. The link is cleared. |
| Rescheduled | The state line updates. |
| Unscheduled (`date: null`) | The state line is removed. The link is **kept** — the Activity still exists as a `saved` item, and the pair stays connected. |
| Deleted | `ListItem.linkedActivityId` is cleared. **The list item survives.** It returns to looking exactly as it did before scheduling. |
| ListItem deleted | `Activity.listItemId` and `.listId` are cleared. **The Activity survives.** |

Neither side cascade-deletes the other. This is stated in the data model and repeated here
because it is the most commonly mis-implemented rule in the product.

> **Decision:** completing a restaurant / meal / place item leaves it in the list rather
> than removing it. These lists are memories as much as queues, and "we went there in
> March" is worth keeping. Users who want it gone delete it, or archive the list.

### 6.4 The reverse direction

Plan → list is covered in §4. The two directions use different mechanisms and must not be
confused:

| Direction | Mechanism | Cardinality |
| --- | --- | --- |
| List item → Plan | `ListItem.linkedActivityId` ↔ `Activity.listItemId` | One item ↔ one Activity |
| Plan → List | `List.sourceActivityId` | One plan → many lists |
| Meal → grocery items | `ListItem.sourceActivityId` + `sourceLabel` | One meal → many items, **not** a link (§6.5) |

### 6.5 Provenance vs linkage

A grocery item created from a meal is **not** the same relationship as a scheduled list
item. It carries `sourceActivityId` and a human `sourceLabel`, but no `linkedActivityId`.
It is a record of where the item came from, not a bidirectional identity.

Consequences: checking off `Chicken` does not affect the meal; completing the meal does not
delete `Chicken`; deleting the meal leaves `Chicken` on the list with its label intact
(the back-link becomes non-navigable and the label stays as written).

---

## 7. Meals

Meals are an activity guide, not a product. No calories, no macros, no recipe steps, no
scaling — see
[`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1).

### 7.1 Save

A meal with no date is a `saved` Activity, or an item on a `meals` list, depending on where
it was created:

- **Add → Meal → no date** creates an Activity with `status: 'saved'`. It shows in Today's
  ANYTIME group 3 and in `GET /v1/activities?filter=saved`.
- **Meals list → + Add item** creates a `ListItem`. Nothing is scheduled and no Activity
  exists yet.

Both are legitimate. The list is the better home for "meals to try"; the saved Activity is
what you get from capture when the user typed a meal without a date.

### 7.2 Schedule

Setting a date and time (and optionally a slot) makes it a plan. Slot ↔ time inference is
specified in [`activities.md`](activities.md#42-meal). A meal can have participants,
expenses, prep tasks and attachments like any other activity.

### 7.3 Ingredients to groceries

The flow, exactly:

1. The meal's detail screen (or its creation form) has an **Ingredients** section: rows of
   `name` + optional `quantity`, each with a checkbox. Checkboxes default to **checked**.
2. Below it: `Add 4 selected to Groceries`, with the target list shown and changeable. The
   target defaults to the most recently used `groceries` list; if the user has none, the
   action offers to create `Groceries` first.
3. Tapping it issues one `POST /v1/lists/:id/items/bulk` with the selected ingredients.
4. Each created `ListItem` gets:
   - `title` = ingredient `name`, with `quantity` appended in parentheses if present
     (`Tortillas (8)`),
   - `sourceActivityId` = the meal's `activityId`,
   - `sourceLabel` = the provenance label (§7.5).
5. Each source ingredient gets `details.ingredients[i].addedToListId` set, so the button
   can render `Added` for those rows and offer only the remaining ones next time.
6. Duplicate handling: if an item with the same case-insensitive, trimmed title already
   exists **unchecked** on the target list, no second row is created; the existing row's
   `sourceLabel` is extended (`Sunday dinner · Thursday lunch`). If the existing row is
   **checked**, a new row is created — the previous one was already bought.

Nothing in this flow happens automatically. Creating a meal with ingredients writes zero
grocery items until step 3.

### 7.4 Completion

Completing a meal uses the verb `Had it` (`outcome: 'had_it'`) — see
[`activities.md`](activities.md#52-completion-verbs). Follow-ups offered, each dismissible:

- If ingredients exist that were never added to Groceries and the meal is likely to recur,
  nothing is offered. The app does not ask about the past.
- If the meal has participants and no expenses: `Add an expense?`
- If the meal came from a `meals` list item: the item's state line becomes `Done Sunday`.

### 7.5 The provenance label

`ListItem.sourceLabel` is a short human string rendered after the item title, separated by
an em dash:

```
Groceries
  Chicken          — Sunday dinner
  Tortillas (8)    — Sunday dinner
  Tomatoes         — Sunday dinner
  Milk
```

> **Decision — label format.** `sourceLabel` is computed at creation time and stored, never
> recomputed:
>
> 1. If the source meal is scheduled within the next 7 days **and** has a `mealSlot`:
>    `"<Weekday> <slot>"` — `Sunday dinner`.
> 2. If it is scheduled within 7 days with no slot: `"<Weekday>"` — `Sunday`.
> 3. If it is scheduled beyond 7 days: `"<d MMM> <slot>"` — `23 Aug dinner`.
> 4. If it is unscheduled: the meal's title — `Chicken tacos`.
> 5. If a label produced by rules 1–3 already exists on the target list from a *different*
>    meal, the meal title is appended: `Sunday dinner · Chicken tacos`.
>
> Storing rather than recomputing means the label stays truthful after the meal is
> rescheduled or deleted. A manually added item has no label and renders no dash.

The label is not a link in v1; it is text. Tapping the item opens item detail, which shows
`From Chicken tacos` as a navigable row when `sourceActivityId` still resolves.

---

## 8. Watch

The differentiator is *what I want to watch → when I'll watch it → who I'll watch it with*.
Not a catalogue, not ratings, not discovery. See
[`overview.md`](overview.md#6-non-goals).

### 8.1 Watchlist entries

A watchlist entry is a `ListItem` on a `watchlist` list with `details`:

| Field | Values | Meaning |
| --- | --- | --- |
| `mediaKind` | `movie` \| `show` | Controls whether season/episode fields render |
| `watchStatus` | `want` \| `watching` \| `watched` | The three headings the list groups under |
| `season` | integer | Current progress, shows only |
| `episode` | integer | Current progress, shows only |

Entries are created by typing into the watchlist, or by an Add → Watch with
`Save to Watchlist` on and no date. All fields are free text or numbers; the app never
looks anything up.

Progress is displayed as `S2 E4`. A movie shows no progress line. `watchStatus` transitions
are:

- `want` → `watching`: automatic on the first completed watch session for that item.
- `watching` → `watched`: manual only, from the item detail's `Mark as watched`. The app
  never decides a show is finished, because it does not know how many episodes there are.
- Any → any: manual, from item detail.

> **Decision:** `want → watching` is the one automatic status transition in the product.
> It is a status change on an existing row, not a creation, so it does not violate
> "suggest, never auto-create". It is undoable from item detail.

### 8.2 Scheduling a watch session

From the watchlist item: `Schedule` → `POST /v1/lists/:id/items/:itemId/schedule` with the
inferred type `watch`.

The created Activity is pre-filled with:

- `title` and `details.mediaTitle` = the item title,
- `details.mediaKind`, `details.season`, `details.episode` copied from the item's current
  progress, **incremented by one episode** for a `watching` show (S2 E4 → the session is
  for S2 E5),
- `details.watchlistItemId` = the item id,
- `details.service` = the last service used by this user.

The user can change all of it in the schedule sheet before confirming. Participants are
added in the same sheet.

> **Decision:** the pre-fill increments the episode. Scheduling the episode you have
> already seen is never what is meant. The value is editable, and for a `want` item with no
> progress the session defaults to S1 E1.

### 8.3 On Today

The session renders as a `watch` row with subtitle `Watch · S2 E5`, the service in the
detail screen, and participant avatars. No checkbox (§4 of
[`today-and-tasks.md`](today-and-tasks.md#4-row-affordances-by-type)).

### 8.4 Marking watched and progress increment

Completing the session (`Watched`, `outcome: 'watched'`) does exactly this:

1. Writes `status: 'completed'`, `completedAt`, `outcome: 'watched'` on the Activity.
2. If `details.watchlistItemId` resolves, updates that item's `details.season` /
   `details.episode` to the session's values, and sets `watchStatus: 'watching'` if it was
   `want`.
3. Shows one follow-up in the confirmation slot:

   ```
   Severance · now at S2 E5              Schedule S2 E6?     ✕
   ```

4. Tapping `Schedule S2 E6?` opens the **schedule sheet** pre-filled with S2 E6, the same
   participants, the same service, and the same time next week. It creates nothing until
   the user confirms in that sheet.

Step 4 is the concept's explicit constraint: the app "may then suggest scheduling the next
episode, but should not automatically create it". A code path that writes an Activity from
step 3 is a bug, not a shortcut.

For a `movie`, step 3 offers `Mark as watched?` instead, which flips the watchlist item to
`watched`.

---

## 9. Worked end-to-end examples

### 9.1 Watchlist → Today

**Goal:** Severance is on the watchlist; the user watches S2 E5 with Alice on Friday.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Lists → Watchlist → `+ Add item` → `Severance`, kind Show | `ListItem { itemId: itm_1, title: 'Severance', details: { mediaKind: 'show', watchStatus: 'want' } }` |
| 2 | Item detail → sets progress S2 E4 (already watched up to there) | `PATCH /v1/lists/:id/items/itm_1` → `details.season: 2, episode: 4, watchStatus: 'watching'` |
| 3 | Item detail → `Schedule` | Sheet opens pre-filled: `watch`, `Severance`, **S2 E5**, Friday, service Apple TV+. User sets 8:00 PM and adds Alice. |
| 4 | Confirm | `POST /v1/lists/:id/items/itm_1/schedule` → one `TransactWriteItems`: `ACT#act_9/META` (type `watch`, `schedule { date: '2026-08-07', time: '20:00' }`, `details.watchlistItemId: itm_1`), `USER#<owner>/IDX#act_9`, `LIST#/ITEM#itm_1` with `linkedActivityId: act_9`. Alice is added in the same request → `ACT#act_9/PART#psn_alice`, `USER#<alice>/IDX#act_9`, both `PLINK#` rows. |
| 5 | Watchlist now reads | `Severance` / `Watching · S2 E4` / `Next session Friday · 8 PM` — one row, not two (§6.2). |
| 6 | Friday, Today | `8:00 PM ◇ Severance   Watch · S2 E5   (A)` in SCHEDULE. Alice sees the same row on her Today. |
| 7 | 10 PM, EARLIER TODAY → `How did it go?` → `Watched` | `POST /v1/activities/act_9/complete { outcome: 'watched' }`. `itm_1.details.episode` → 5. |
| 8 | Follow-up | `Severance · now at S2 E5 — Schedule S2 E6?` Dismissed. **Nothing is created.** |

### 9.2 Meal → Groceries

**Goal:** Chicken tacos for Sunday dinner; the ingredients need buying.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Add → Meal → `Chicken tacos`, Sunday, slot Dinner (time auto-fills 19:00) | Nothing yet — the form is local |
| 2 | Ingredients: `Chicken`, `Tortillas` qty `8`, `Tomatoes`, `Sour cream` (unchecks Sour cream — already has it) | Local |
| 3 | `Add selected ingredients to Groceries` toggled on, target `Groceries` | Local |
| 4 | Save | `POST /v1/activities` → `act_12` with `details.ingredients` = all four rows. Then `POST /v1/lists/lst_g/items/bulk` with the three checked rows. |
| 5 | Groceries list now reads | `Chicken — Sunday dinner` · `Tortillas (8) — Sunday dinner` · `Tomatoes — Sunday dinner` · `Milk` (added manually last week, no label) |
| 6 | Meal detail | Chicken / Tortillas / Tomatoes render `Added`; Sour cream renders with `Add to Groceries`. |
| 7 | Saturday: user shops, checks all three | `PATCH` on each item, `checked: true`. **The meal is untouched** — provenance is not linkage (§6.5). |
| 8 | Sunday 19:00, Today | `7:30 PM ◇ Chicken tacos   Meal · Dinner`. (Time as entered; the 19:00 default was overridden.) |
| 9 | After dinner → `Had it` | `POST /v1/activities/act_12/complete { outcome: 'had_it' }` |
| 10 | Monday: Groceries → `Clear checked (3)` | Three items deleted, undoable for the standard window. Milk remains. |

### 9.3 Trip plan → Packing list

**Goal:** a New York trip with prep, packing, and places.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Add → Outing → `New York Trip`, 14–16 Aug, location `Manhattan`, people Alice + Ben | `POST /v1/activities` → `act_20`, `visibility: 'shared'`, two `PART#` rows, two invitee `IDX#` rows |
| 2 | Plan detail → PREP → `+ Add prep task` ×2: `Book hotel` (2 Aug), `Buy tickets` (8 Aug) | Two `POST /v1/activities` with `parentActivityId: act_20`. `act_20.childCount` = 2. |
| 3 | Plan detail → LISTS → `Add list` | Sheet suggests **Packing, General, Places, Shopping** for a multi-day outing (§4.1) |
| 4 | Picks `Packing`, keeps the default title | `POST /v1/lists { kind: 'packing', title: 'Packing · New York Trip', sourceActivityId: 'act_20' }` |
| 5 | Adds `Charger`, `Jacket`, `Passport` | Three `POST /v1/lists/lst_p/items` |
| 6 | Back on the plan, LISTS reads | `Packing · New York Trip — 3 items` |
| 7 | Picks `Places` too, adds `Central Park`, `Museum` | A second list with the same `sourceActivityId` |
| 8 | 2 Aug, Today | `☐ Book hotel   New York Trip` in ANYTIME — a prep task on its own date with the plan as subtitle (§3) |
| 9 | 13 Aug: packs, checks all three | `checked: true` ×3 |
| 10 | 16 Aug, EARLIER TODAY → `How did it go?` → `Done` | `act_20` completed. **Both lists survive, unarchived, with their items.** Alice and Ben see the completion in the updates feed. |
| 11 | Next trip | The user opens `Packing · New York Trip` → overflow → `Uncheck all`, renames it `Packing`, and reuses it. Nothing was lost. |
