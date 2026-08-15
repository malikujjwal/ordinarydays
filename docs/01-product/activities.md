# Activities and the Add experience

**Status:** canonical for creation UX. Storage shapes are owned by
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity);
endpoints by
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities).
This document specifies what the user sees and what each control writes.

---

## 1. The universal Activity

Every Task or Plan the user creates is one Activity. A meal, a TV episode, a dentist
appointment, a weekend trip, a reminder to call the apartment office, and a prep task
hanging off a trip are all the same stored entity with a different `type` and a different
`details` sub-document. A List item is deliberately different: it is a `ListItem`, never an
Activity chosen on the user's behalf.

There is no separate `Plan` entity and no `Meal` entity. "Plan" is the user's explicit
creation choice, persisted on the Activity as `objectKind: 'plan'`; Task is persisted as
`objectKind: 'task'`. A date changes scheduling state, not identity. The rule is stated once in
[`overview.md`](overview.md#31-four-concepts-connected-where-it-is-useful) §3.1 and is canonical in
[`../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity`](../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity).

### 1.1 The five stored types are explicit creation guides

| `type` | Guides creation of | Sets `details.kind` |
| --- | --- | --- |
| `task` | Something to accomplish | `task` |
| `meal` | Something to eat or cook | `meal` |
| `watch` | A movie, show, or episode | `watch` |
| `event` | A concert, appointment, restaurant, hike, coffee, festival, or shopping trip | `event` |
| `custom` | **General** — a Plan that does not fit the guided kinds | `custom` |

The global `+` first asks **Task**, **Plan**, or **List item**. Choosing Task fixes
`objectKind: 'task'` and `type: 'task'`. Choosing Plan fixes `objectKind: 'plan'`, then
requires one visible choice: **General**, **Meal**,
**Watch**, **Event**. General maps to `custom`; it is never an omitted value
or a hidden default. The words entered afterward and any capture response cannot select or
change either choice.

The type controls three things and nothing else:

1. **Which fields the creation form shows** (§4).
2. **Which verb the completion control uses** (§5.2).
3. **Whether the row renders a checkbox** — `task` only, everywhere in the product
   (see [`today-and-tasks.md`](today-and-tasks.md) §3).

Within Plans, Plan kind never controls whether the Activity can be scheduled, shared, given
expenses, given prep tasks, attached to a list item, or shown on Today. Every Plan kind
supports those operations. Tasks are intentionally solo: they cannot gain direct participants or
expenses; coordinated work is created as **Plan → General** or another visible Plan kind.
This is the "types guide, never restrict" rule from
[`overview.md`](overview.md#41-types-guide-never-restrict).

### 1.2 No category management

There is no UI to add, rename, delete, colour, reorder or nest a type. A user whose Plan
does not fit a guided kind explicitly chooses **General**, stored as `custom`. General is
not a lesser kind: it takes a title, date, optional time, people, reminder, repeat and
notes, which is everything most Plans need.

---

## 2. The explicit Add experience

### 2.1 Entry points

The Add affordance is reachable from every primary screen and must never be more than one
tap away. A global add always asks what to create. A contextual add states what it creates
in its label and skips only that already-answered choice.

| Surface | Affordance |
| --- | --- |
| Today | Global `+`, bottom-right, above the tab bar. Opens **Task / Plan / List item**. After a choice, today may pre-fill `schedule.date`; it never pre-selects the choice. The ANYTIME section also has contextual `+ Add a task`. |
| Plans | Global `+`. Opens the same three choices. After Task or Plan is chosen, a date currently in view may pre-fill `schedule.date`. |
| Lists (list detail) | Contextual `+ Add an item` at the bottom fixes **List item** and the current list as its destination. The global `+` still opens all three choices. |
| Plan detail | Contextual `+ Add a prep task` fixes **Task** and pre-fills `parentActivityId`. |
| Web | The global `+`, plus the global keyboard shortcut `N` (§7.2), both opening the same chooser. |
| iOS share sheet | Holds the shared URL or image locally, then asks **Task / Plan / List item**. Plan also asks its kind; List item asks its destination. Only then does capture inspect the payload (Phase 9, P9-11). |

### 2.2 The global object chooser

Opening global `+` or pressing `N` presents one required, unselected choice:

```
┌──────────────────────────────────────┐
│  Cancel                              │
│                                      │
│  What would you like to add?         │
│                                      │
│  Task                              › │
│  Plan                              › │
│  List item                         › │
└──────────────────────────────────────┘
```

No row is selected, recommended, reordered from history, or bypassed by typed or shared
content. Each row determines the stored object before capture starts:

| Choice | Next required choice | Result |
| --- | --- | --- |
| **Task** | None | Task form; every create request sends `objectKind: 'task'`, `type: 'task'`. |
| **Plan** | **General / Meal / Watch / Event**, with none selected | The matching Plan form sends `objectKind: 'plan'`; General sends `type: 'custom'`. |
| **List item** | A destination list, unless a contextual list already fixed it | List-item form; its final button names that list. |

The Plan-kind step asks `What kind of plan?` and lists the four kinds in the order above,
with nothing selected:

```
┌──────────────────────────────────────┐
│  Back                                │
│                                      │
│  What kind of plan?                  │
│                                      │
│  General                           › │
│  Meal                              › │
│  Watch                             › │
│  Event                             › │
└──────────────────────────────────────┘
```

General is a real, visible choice. The app must not silently use it when no Plan kind was
selected. Back returns to the chooser without writing. Closing a non-empty form prompts
`Discard this?` with `Discard` / `Keep editing`.

### 2.3 Contextual entry and capture modes

`+ Add a task`, `+ Add an item`, and `+ Add a prep task` are explicit choices expressed by
their entry-point labels. They open the corresponding form directly. The current list or
parent plan is also explicit in the surrounding screen, so no destination is inferred.

Once object kind — and, for a Plan, Plan kind — is fixed, the form's title field is focused
and the keyboard is up. Text, Camera, Photos, and Link can then help fill **compatible
fields on that form only**:

| Mode | Input | What happens | Endpoint |
| --- | --- | --- | --- |
| **Type** | Free text | After a 600 ms pause of ≥ 8 characters, automatic capture may suggest values for visible fields. It cannot suggest a different object or Plan kind. | `POST /v1/capture/parse` |
| **Photo** | Camera capture | Uploads, then suggests compatible visible field values. | `POST /v1/attachments/upload-url` → `POST /v1/capture/extract` |
| **Screenshot** | Picked from the photo library | Identical to Photo. | Same as Photo |
| **Link** | Pasted or shared URL | Suggests compatible visible fields; the URL remains in the selected object's supported source or note field. | `POST /v1/capture/link` |

Nothing is written until the named final button is activated. Typing a person's name does
not add a person or propose sharing; people are added only through the visible People
picker. Typing `remind me` never sets a reminder; the separate visible Reminder control stays
`Off` or shows the user's explicitly saved default until the user changes it. Capture never
chooses a list destination or turns one selected object into another.

All three capture endpoints return `501 not_implemented` until Phase 8 — see
[`../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier)
and [`ai-capture.md`](ai-capture.md). Until then, the selected manual form remains fully
usable, preserving the text, image, or URL. No object or type fallback is needed because
the user already selected both.

> **Decision:** voice capture is listed in the concept's flow diagram but is not a v1
> entry mode. iOS dictation on the selected form's text field covers it at zero cost. Do
> not build a separate voice pipeline.

### 2.4 Assistance never owns intent

The selected object and Plan kind remain visible in the form header, for example
`Plan · Watch`. They are not a suggestion banner. An explicit `Change` action may return to
the relevant chooser; capture cannot invoke it.

Rules:

1. There is no `suggestedType` presentation, type-confidence threshold, or automatic type
   pre-selection. A returned type-like value is ignored and never rendered.
2. Capture may fill only fields allowed by the already selected form. A field with
   confidence `< 0.7` is highlighted per [`ai-capture.md`](ai-capture.md) §3, but never
   blocks the form.
3. Capture never suggests people, sharing, privacy, a list destination, another stored
   object, a reminder/notification action, or the save action. Those remain explicit
   controls; a saved reminder default is user-owned configuration, not text inference.
4. Changing object or Plan kind is a separate user action. The app previews any fields that
   would be dropped and follows §6.3; it performs no write until the new form is saved.

### 2.5 Named write behaviour

- A non-empty trimmed title enables the final action because object and Plan kind have
  already been chosen. Every other field remains optional.
- Final buttons name exactly what will be written:

  | Selected object | Button | Write |
  | --- | --- | --- |
  | Task | `Save task` | One `POST /v1/activities` with `objectKind: 'task'`, `type: 'task'`. |
  | Plan | `Save plan` | One `POST /v1/activities` with `objectKind: 'plan'` and the explicitly selected Plan kind's type. |
  | List item | `Add to <list name>` | One `POST /v1/lists/:id/items` to the list named on the button. |

- The client always includes the selected `type`. It never omits the field and never relies
  on a server default. Each write carries its normal idempotency key.
- If the user explicitly enables a second-object write, the button names both writes and
  the destination: for example `Save plan and add 3 items to Groceries`. A generic `Save`
  button must never hide a list write.
- On success the form dismisses and the toast names the object and destination:

  | Result | Toast | Toast action |
  | --- | --- | --- |
  | Task dated today | `Task · added to Today` | `View` |
  | Task dated another day | `Task · planned for Fri, 8 Aug` | `View` |
  | Undated solo Task | `Task · saved to Anytime` | `View` |
  | Undated Plan | `<kind> plan · saved to Needs a date` | `View` |
  | Dated Plan | `<kind> plan · planned for Fri, 8 Aug` | `View` |
  | Task or Plan dated a past day | `Task · logged for Tue, 4 Aug` / `<kind> plan · logged for Tue, 4 Aug` | `View` |
  | List item | `Added to <list name>` | `View list` |

  Creating with a past date is allowed and intended — it is the retro-log path. A
  past-dated Activity lands in Plans → Past on its own date, carrying the resolution
  prompt ([`today-and-tasks.md`](today-and-tasks.md#82-resolution-prompts) §8.2) so it can
  be resolved on the spot.

  The toast persists for 4 seconds and is dismissible by swipe. On failure the selected
  form stays open with its draft intact and an inline error banner; see
  [`interaction-contract.md`](interaction-contract.md) §5.

---

## 3. Progressive creation forms — shared rules

Rules that apply to every type's form.

1. **Only relevant fields are shown.** A field that does not appear in a type's table in §4
   does not appear on that type's form, is not collapsed behind a disclosure, and is not
   greyed out.
2. **Everything except title is optional.** No type has a second required field.
3. **Order matters.** Fields render top-to-bottom in the order given in §4. That order is
   part of the spec, not a suggestion.
4. **Common controls** behave identically across types:

   | Control | Behaviour |
   | --- | --- |
   | Date | Opens a date picker with quick chips: `Today`, `Tomorrow`, `This weekend`, `Next week`, `Pick a date`. Clearing it removes `schedule` entirely and returns the Activity to `saved`. |
   | Time | Only enabled when a date is set. Opens a time picker in 5-minute increments. Clearing it makes the item all-day / Anytime. |
   | End time | Only shown once a start time exists. Must be after the start time; a same-day end time before the start is a `validation_failed`. |
   | People | Opens the participant picker — see [`sharing-and-people.md`](sharing-and-people.md) §2. |
   | Reminder | Only enabled when a date is set. Sets **your own** reminder and nobody else's — reminders are per person, per activity ([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1). Options in [`notifications.md`](notifications.md) §3. |
  | Repeat | Only enabled when a date is set. A single dropdown provides the exact options in [`today-and-tasks.md`](today-and-tasks.md#61-the-options-list) §6.1; `Custom` reveals a typed 2–365 Days field mapped to `interval_days`. On an existing series the sheet always shows and edits the **active rule segment**; an "all future" edit appends a segment and never rewrites the segments already written ([`today-and-tasks.md`](today-and-tasks.md#62-one-row-per-series) §6.2). **Does not repeat** converts an explicitly targeted occurrence to the one-off and confirms first when stored completion history will stop rendering. Ends is a separate dropdown whose indefinite value is **No end**. **End series** is a separate action that preserves recurrence and its history. |
   | Notes | Multi-line, max 4000 characters, no formatting. |
   | Location | Free-text label plus optional address. v1 has no map picker and no geocoding. |

5. **Validation errors are inline and per-field**, shown on blur and again when the named
   final write action is attempted.
   They map one-to-one onto the `details[]` entries of a `validation_failed` error
   (see [`../02-architecture/api-contract.md#1-shape`](../02-architecture/api-contract.md#1-shape)).
6. **Character limits:** `title` 1–200, `notes` 0–4000, any free-text sub-field
   (`service`, `organiser`, reservation fields, ingredient `name`) 0–120.

> **Decision:** v1 has no location autocomplete, no geocoding and no map. `location.lat`,
> `location.lng` and `location.mapUrl` exist in the model but are only populated by capture
> extraction (Phase 8) or by a pasted maps URL. The form collects `label` and `address` as
> plain text.

---

## 4. Field tables per type

Columns: **Field** (label as shown), **Control**, **Req.**, **Validation**, **Default**,
**Maps to** (path on `CreateActivityInput` /
[`Activity`](../02-architecture/data-model.md#41-activity)).

### 4.1 Task

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Title | Single-line text | Yes | 1–200 chars after trim | Text from the Add screen | `title` |
| Date | Date picker with quick chips | No | Valid `YYYY-MM-DD` | Today if the user came from Today's FAB; otherwise empty | `schedule.date` |
| Time | Time picker, 5-min steps | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| Reminder | Select | No | Requires a date | User's explicitly saved `defaultReminderOffset` if a time is set; otherwise `Off`. New accounts ship Off. | `reminders[]` on input → your own `REM#` item |
| Repeat | Select → recurrence sheet | No | Requires a date | `Does not repeat` | `recurrence` |
| Related plan | Plan picker (search over upcoming Activities) | No | Must be an Activity the user owns or participates in | Pre-filled when opened from a plan | `parentActivityId` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details` is `{ kind: 'task' }` — it carries no fields.

### 4.2 Meal

> **Amended after implementation review.** The Time row read "auto-set from the slot when a
> slot is chosen **and no time is set**". That protected a time the user typed, which is right,
> but it could not tell one from a time **the app had just derived itself** — so the first slot
> picked froze the field. Choosing Breakfast wrote 08:00, and Dinner was then refused its 19:00
> because "a time is set", leaving the meal at eight in the morning. Snack was worse: it has no
> hour to offer, so it silently kept the previous slot's.
>
> The rule now turns on **who set the time**, not whether one is set. The app re-derives its own
> guess as often as the slot changes; a time the user picked is never touched, which was always
> the point.

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Meal | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Set from the slot **every time the slot changes, unless the user chose the time themselves**: breakfast 08:00, lunch 12:30, dinner 19:00, snack unset — and choosing Snack *clears* a slot-derived time. Once the user picks a time, no slot change touches it again | `schedule.time` |
| Slot | Segmented: Breakfast / Lunch / Dinner / Snack | No | One of the four | Inferred from Time if a time is set and no slot chosen: < 11:00 breakfast, < 15:00 lunch, < 17:00 snack, else dinner | `details.mealSlot` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Ingredients | Repeating rows: name + optional quantity, each with a checkbox | No | Name 1–120; max 60 rows | Empty | `details.ingredients[]` (`name`, `quantity`) |
| Add selected ingredients to… | Toggle + destination dropdown, shown only when ≥ 1 ingredient row exists. The destination is named in the label (`Add selected ingredients to Groceries`) | No | Any list the user picks; the dropdown offers lists holding the `groceries` slot first, then the rest | Off. The destination resolves through the **`groceries` slot** by the four-step rule in [`plans-and-lists.md`](plans-and-lists.md) §5.8 — never "the first groceries list", never the most recently used one. With no eligible list the row reads `Choose or create a list`; New list opens the unselected style catalogue and returns here after the separate `Create list` action | After an existing or newly created destination is visibly confirmed, `POST /v1/lists/:id/items/bulk`; sets `details.ingredients[].addedToListId` |
| Recipe link | Single-line URL | No | Valid absolute `http(s)` URL | Empty | `details.recipeUrl` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

Ingredient checkboxes default to **unchecked**; the "Add selected" toggle defaults to
**off**. The user selects the exact ingredients to copy. Nothing is written to any list
unless the user turns the toggle on — this is the
"suggest, never auto-create" rule. See [`plans-and-lists.md`](plans-and-lists.md) §7.3 for
the flow and §5.8 for how the destination is chosen.

### 4.3 Watch

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Movie or show | Single-line text | Yes | 1–200 | Text from the Add screen | `title` **and** `details.mediaTitle` (kept identical unless the user edits the title, after which `mediaTitle` is authoritative for the watchlist) |
| Kind | Segmented: Movie / Show | No | One of two | `Show` if a season or episode is entered, else `Movie` | `details.mediaKind` |
| Season | Numeric stepper + text | No | Integer 0–99; shown only when Kind = Show | From the linked watchlist item, if any | `details.season` |
| Episode | Numeric stepper + text | No | Integer 0–999; shown only when Kind = Show | From the linked watchlist item, if any | `details.episode` |
| Episode title | Single-line text | No | 0–120; shown only when Kind = Show | Empty | `details.episodeTitle` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Streaming service | Single-line text with recent-values suggestions | No | 0–120, free text | The service last used by this user | `details.service` |
| Also add to… | Toggle + destination dropdown. Once resolved, the label names both the object and list (`Also add a list item to Movies to watch`) | No | Destination must be a list whose behaviour is `watch` | **Off in every context.** The destination resolves through the **`watch` slot** by the four-step rule in [`plans-and-lists.md`](plans-and-lists.md) §5.8. It never assumes a single list named `Watchlist` exists; with none eligible the row reads `Choose or create a Watch list`. `New list` shows exactly **Watchlist / Movies to watch / TV shows** in their canonical relative order, with nothing selected; this eligibility filter follows the user's explicit Watch destination choice, never the title. `Create list` and the later `Save plan and add…` are separate confirmations | The named final action first creates the ListItem with `POST /v1/lists/:id/items`, then submits the reviewed Watch Plan through that item's `/schedule` bridge, which creates the Plan and viewer-local `LNK#<viewer>#<itemId>` pointer. The ListItem carries no global link field |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details.service` is free text by design. There is no catalogue and no provider list. A
Watch Plan never creates a ListItem just because it has no date. If the user turns on the
second-object control, the final button reads, for example,
`Save plan and add Severance to Movies to watch`.

### 4.4 Event

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Title | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Start time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| End time | Time picker | No | After start; requires a start | Empty | `schedule.endTime` |
| Location | Text label + optional address | No | Label 0–120, address 0–300 | Empty | `location.label`, `location.address` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Reservation | Disclosure group: name, time, party size, reference | No | Party size 1–99; reservation time `HH:mm` | Reservation name = user's display name; reservation time = `schedule.time` | `details.reservation.{name,time,partySize,reference}` |
| Tickets & details | Disclosure group: Price, Ticket link, Organiser | No | Price ≥ 0 in integer minor units; ticket link is an absolute `http(s)` URL; organiser 0–120 | Empty; currency comes from profile | `details.priceCents`, `details.currency`, `details.ticketUrl`, `details.organiser` |
| Description | Multi-line text | No | 0–4000 | Empty | `details.description` |
| Source image / link | Attachment thumbnail + URL row | No | Image ≤ 10 MB, image MIME only | Populated by photo/link capture | `attachmentIds[]`, `sourceUrl` |
| Reminder | Select | No | Requires a date | Explicitly saved default if set and a time exists; otherwise `Off` | `reminders[]` on input → your own `REM#` item |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details.description` and `notes` are distinct: description is shown on the public invite
page, notes are private and never leave the owner's view. See
[`sharing-and-people.md`](sharing-and-people.md) §4.4.

### 4.5 Retired Plan kind

The former fifth Plan-kind form was merged into Event; this section number remains as a tombstone.

### 4.6 General (`custom`)

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Title | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Reminder | Select | No | Requires a date | Explicitly saved default if set and a time exists; otherwise `Off` | `reminders[]` on input → your own `REM#` item |
| Repeat | Select → recurrence sheet | No | Requires a date | `Does not repeat` | `recurrence` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details` is `{ kind: 'custom' }`. `details.shortcutId` exists in the model for a later
personalisation feature (concept §30) and is not written in v1.

### 4.7 Fields available after creation

Every Task and Plan can add notes, attachments, a schedule, reminders, recurrence, a
related-list link, and prep tasks where relevant. Every **Plan kind** additionally exposes:

- Participants and sharing.
- Expenses (only meaningful once there are participants — see
  [`expenses.md`](expenses.md) §2.1).
- Updates feed.

Tasks never expose People, sharing, or expenses. If a to-do needs coordination, the user
creates or explicitly changes it to **Plan → General**; the app never changes it because a
name was typed.

---

## 5. Lifecycle and completion

### 5.1 States

`ActivityStatus` is the closed enum in
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity).

| State | Meaning | How it is reached |
| --- | --- | --- |
| `saved` | Exists, no date committed. `objectKind: 'plan'` lives in **Plans → Needs a date**; `objectKind: 'task'` lives in Today's **Anytime** ([`plans-and-lists.md`](plans-and-lists.md) §1.2). | Created without `schedule.date`, or a date is cleared. |
| `scheduled` | Has a date, optionally a time. It appears in Plans → Upcoming and can reach Today. | `POST /v1/activities/:id/schedule` or created with a date. |
| `completed` | The user says it happened. | `POST /v1/activities/:id/complete` |
| `skipped` | Deliberately not done, no guilt attached. | `POST /v1/activities/:id/skip` |
| `cancelled` | The plan itself is off; distinct from the user personally skipping it. | `PATCH /v1/activities/:id` with `status: 'cancelled'` from the overflow menu. |

Rules:

- `status` is derived server-side. The client never sets `saved` or `scheduled` directly;
  they follow from the presence of `schedule.date`.
- Reaching `completed` sets `completedAt` and an `outcome`.
- For a recurring series, completion writes an `Occurrence` row and the series' own
  `status` stays `scheduled` — see [`today-and-tasks.md`](today-and-tasks.md) §5.
- `cancelled` on a shared plan notifies participants
  ([`notifications.md`](notifications.md) §7, `plan_cancelled`). `skipped` never notifies
  anyone; it is a private statement.
- **On a shared plan, only the owner may complete, skip or snooze.** Completion is global:
  it says *the thing happened*, not *I was there*, and the result is the same for everyone
  on the plan
  ([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)).
  A participant who did not go sets their RSVP to declined; a participant who wants the plan
  off their day leaves it
  ([`sharing-and-people.md`](sharing-and-people.md#34-what-a-participant-can-and-cannot-change)
  §3.4). Participants see the plan's state and no completion control — not a disabled one.
  Per-participant completion is deferred, not forgotten. This is about the **plan**: its prep
  tasks are shared checklist items and any participant of the plan may tick one
  ([`plans-and-lists.md`](plans-and-lists.md#3-prep-tasks) §3).

State transitions:

```
saved ──schedule──► scheduled ──complete──► completed
  │                     │  ▲                    │
  │                     │  └────uncomplete──────┘
  │                     ├──skip──────► skipped ──uncomplete──► scheduled
  │                     └──cancel────► cancelled
  └──complete──► completed        (an undated task can be completed directly)
```

`POST /v1/activities/:id/uncomplete` reverses `completed` and `skipped` and restores the
prior status, clearing `completedAt` and `outcome`.

### 5.2 Completion verbs

The completion control's label is chosen by `type`. The stored `outcome` is what the API
records; the label is presentation only.

| `type` | Primary label | Secondary label | `outcome` written |
| --- | --- | --- | --- |
| `task` | Complete | — | `done` |
| `meal` | Had it | Didn't happen | `had_it` / `didnt_happen` |
| `watch` | Watched | Didn't happen | `watched` / `didnt_happen` |
| `event` | Attended | Didn't go | `attended` / `didnt_go` |
| `custom` | Done | Didn't happen | `done` / `didnt_happen` |

Notes:

- "Appointment" is an example of the **Event** Plan kind, not a separate kind. Its outcome
  is `event` → Attended, and the row is not a checkbox.
- The secondary label appears only in the passed-plan prompt described in
  [`today-and-tasks.md`](today-and-tasks.md) §6, and in the overflow menu.
- `didnt_happen` and `didnt_go` set `status: 'skipped'`, not `completed`. They are the
  polite way to clear something without claiming it happened.

### 5.3 Follow-up suggestions

Completion may present exactly one contextual follow-up, inline, in the same toast slot as
the confirmation. It is always dismissible and never pre-selected. Each row below is an
instance of the cross-object rule in
[`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2, which
owns the general statement.

| Completed type | Follow-up offered | Writes on tap |
| --- | --- | --- |
| `watch` (show, with season/episode) | `{list name} · currently S2 E4 — Update to S2 E5?` | Sets that named item's `details.season` / `details.episode` to the session's values, and `want` → `watching`. Then offers `Create a Plan for S2 E6?` as a second, separate step. |
| `watch` (movie) | `Update {list name} item to Watched?` | Sets that named item's `watchStatus` to `watched`. |
| `meal` with ingredients | `Add ingredients to a list?` | Opens the ingredient picker; writes only what the user selects, to the destination resolved and visibly named by [`plans-and-lists.md`](plans-and-lists.md) §5.8. |
| Any Plan kind explicitly created from a list item, where completing it is evidence about that item | `Mark {item title} visited in {list name}?` | On tap, sets that named item's `checked` when the list is `checkable` ([`plans-and-lists.md`](plans-and-lists.md) §5.10). Completion alone leaves the item unchanged. |
| Any Plan with ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigates to the plan's expense section. No write. |
| Any Plan with ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the add-expense sheet. No write until saved. |
| Any Plan with ≥ 1 incomplete prep task | `2 prep tasks are still open — keep them?` with `Keep` · `Complete all` · `Delete` — the count is the real number of open prep children | Completing the plan itself leaves the prep tasks untouched, consistent with the parent-deletion rule ([`today-and-tasks.md`](today-and-tasks.md#55-related-plan) §5.5). `Keep` — and dismissing — writes nothing. `Complete all` completes each open prep child. `Delete` deletes them. Every option is an explicit tap. |
| Recurring occurrence | Nothing. The next occurrence already exists by definition. | — |

When the prep-task row and another row both apply, the prep-task question is the one
follow-up shown: it is the only one about live to-dos left behind.

No follow-up ever writes without the tap, and completion itself writes nothing outside the
Activity. See [`overview.md`](overview.md#44-suggest-never-auto-create).

---

## 6. Editing

### 6.1 General rules

- Editing happens on the Activity detail screen, in place. There is no separate "edit
  mode" screen and no Save button for individual fields: a field commits on blur (text) or
  on selection (pickers), issuing a `PATCH /v1/activities/:id`.
- Every `PATCH` sends `If-Match: <updatedAt>`. A `409 conflict` means someone else changed
  the plan; the client refetches, shows `This plan changed. Review the update.` and
  re-applies the user's pending edit onto the fresh version only if the fields do not
  overlap. Overlapping fields are dropped and the user is told which.
- Participants (app users) may not edit title, schedule, location or type. Only the owner
  may. See
  [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules).
- Any owner edit to `title`, `schedule`, `location` or `status` on a **shared** activity
  writes a system entry to the updates feed and notifies participants
  ([`notifications.md`](notifications.md) §7, `plan_changed`).

### 6.2 Editing schedule

- Tapping the date or time anywhere in the product opens the reschedule sheet. It never
  edits in place on the row.
- Clearing the date on an activity with participants warns, per
  [`interaction-contract.md`](interaction-contract.md#1a1-additive-changes-happen-immediately-destructive-changes-explain-what-will-be-lost)
  §1a.1: `This takes it off everyone's day and moves it back to Needs a date.` with
  `Keeps: the plan, everyone on it, and their replies.` and a `Remove the date` button. The
  plan is still a plan; it no longer has a day (§1.2 of
  [`plans-and-lists.md`](plans-and-lists.md#12-where-an-explicitly-chosen-object-with-no-date-appears)).
- The removal action in that sheet names the object rather than the mechanism: a one-off task
  offers `Move to Anytime`, a plan offers `Remove date`, and one day of a series offers
  `Skip this occurrence` — a day of a series has no date to clear, and dropping it is a skip
  ([`today-and-tasks.md`](today-and-tasks.md#54-skip) §5.4). The exact strings are
  [`interaction-contract.md`](interaction-contract.md#55-reschedule-and-snooze-sheet-copy) §5.5.
- Rescheduling a **recurring series** presents a two-option sheet: `This occurrence only` /
  `All future occurrences`. **The question is asked after the edit, not before it**
  (amended 2026-08-14, P2-42): the user picks the date or time first, and the sheet then shows
  `Apply changes to` with the before→after summary of what is being scoped. Asking first meant
  choosing a scope for a change that did not exist yet, and the answer silently decided which
  editor appeared. A move to a **different day** is not asked about: an appended rule segment
  carries a time and not a date, so moving one occurrence to another day has only the
  occurrence reading, which is the `overrideDate` write below. Changing which days a series
  lands on is the Repeat sheet. The first writes an `Occurrence` with `overrideTime` and/or
  `overrideDate` and never touches the series — a single occurrence can move to another
  day, where it is emitted on its override date with a `moved from` affix
  ([`today-and-tasks.md`](today-and-tasks.md#63-occurrence-semantics) §6.3). The second **appends a rule segment** to `recurrence`, effective from
  the edited occurrence's date — or from today, when the sheet was opened from the series'
  detail screen outside any occurrence context. Past segments and past occurrences are
  untouched, so history keeps rendering as it happened
  ([`today-and-tasks.md`](today-and-tasks.md#62-one-row-per-series) §6.2). At the
  20-segment cap the write returns `validation_failed`; the sheet explains it and suggests
  ending the series and starting a new one. There is no "all occurrences including past"
  option.

### 6.3 Changing object or Plan kind

`objectKind` changes only through an explicit conversion action. A Plan's `type` is mutable
among General (`custom`), Meal, Watch, Event — see the rule in
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity):
"Changing type keeps `details` fields that still apply and drops the rest (log what was
dropped)."

The user-facing contract:

1. The detail overflow offers `Change Plan kind` on a Plan, `Change to Plan` on a Task, and
   `Change to Task` on a Plan. Before first save, `Change` returns to the chooser because no
   object exists yet. Text, AI, adding a date, and adding or removing fields never invoke a
   conversion.
2. **Task → Plan** opens the unselected **General / Meal / Watch / Event** chooser.
   The user must choose one; General is not assumed. Common fields are preserved, then the
   selected Plan form opens for review. No write occurs until `Save changes`.
3. **Plan → Task** is available only when the Plan has zero participants, zero expenses,
   and zero prep children. Otherwise the action is blocked and names exactly what must be
   removed first, for example `Remove 2 people and 1 expense before changing this to a
   Task.` Each count links to that section. The conversion never deletes coordinated data
   as a side effect.
4. Common fields on `Activity` — `title`, `notes`, `schedule`, `recurrence`, `location`,
   attachments, reminders, and viewer-local list pointers — are preserved. Plan-specific
   `details` fields are mapped where a same-meaning field exists and otherwise require the
   loss preview below. Reminders are separate per-user items, not a
   field on the Activity
   ([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)).
5. Fields on `details` are mapped where a same-meaning field exists, and otherwise dropped.
   The mapping table is exhaustive:

   | From → To | Carried over | Dropped |
   | --- | --- | --- |
   | `watch` → any | — | `mediaTitle`, `mediaKind`, `season`, `episode`, `episodeTitle`, `service`. Any viewer-local `LNK#` pointer remains; changing Plan kind never mutates the source ListItem. |
   | `meal` → any | — | `mealSlot`, `recipeUrl`. `ingredients[]` is dropped, but any grocery items already created from it keep their `sourceActivityId` and their provenance label. |
   | `event` → any other | `description` → `notes` (appended, separated by a blank line, if `notes` is non-empty) | `priceCents`, `currency`, `ticketUrl`, `organiser`, and each populated `reservation.{name,time,partySize,reference}` field. The destructive confirmation names those reservation fields and their values. |
   | any → `watch` | `title` → `details.mediaTitle` | — |
   | Task → any Plan kind | All common Activity fields | No Task-specific details exist |
   | any Plan kind → Task | All common Activity fields | The source `details` payload beyond mappings above |
   | any Plan kind → `custom` (General) | — | The whole source `details` payload beyond the mappings above |

   > **A kind changed to itself is a no-op** (recorded in P1-17). The `→ any` rows above are
   > shorthand for the cross-kind cases: read literally, `watch → any` would include
   > `watch → watch` and report the season and episode as dropped, which is data loss from a
   > request that changed nothing. The rule at the head of this section already answers it —
   > every field on a Watch "still applies" to a Watch. This matters because
   > `PATCH /v1/activities/:id` takes `objectKind` and `type` as a pair, so a form re-sending
   > the current values alongside a title edit reaches the mapping.

6. **Before** a lossy kind change or allowed Plan → Task conversion is applied, the client
   shows the confirmation required by the
   product-wide additive/destructive rule
   ([`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.1).
   That section owns the shape — the object named, the fields listed by their user-facing
   labels, the count of affected records, the `Keeps:` line, `Cancel` first, and the verb
   repeated on the destructive button. A type change is one instance of it, and the fields
   it names come from the mapping table in point 5:

   ```
   Change Watch → Event?

   This will remove:
     Season and episode (S2 E4)
     Streaming service (Netflix)

   Keeps: title, date, time, people, notes, reminders.
   ```

   A type change affects exactly one record, so the count is carried by the object name
   rather than stated separately. If nothing would be dropped, the change is additive and no
   confirmation is shown at all.
7. The server logs the dropped payload at `info` with the `activityId`, the old type and
   the old `details` object, so a support request can recover it from CloudWatch within the
   retention window. It is not restorable through the UI.
8. An explicit Task → Plan write sets `objectKind: 'plan'` and the chosen Plan `type`; an
   allowed Plan → Task write sets `objectKind: 'task'`, `type: 'task'`. A Plan-kind-only
   change leaves `objectKind` unchanged. No conversion changes `status`, `completedAt`, or
   `outcome`; the detail screen continues to render the historical completion verb.

### 6.4 Deleting

- Delete is owner-only, in the overflow menu, and always confirms, in the §1a.1 shape
  ([`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants)). The
  base confirmation names what is removed, with real counts wherever counts exist — notes,
  attachments, reminders, occurrences — and carries a `Keeps:` line whenever anything
  survives:

  ```
  Delete "Paris weekend"?

  This removes: the plan, its notes, 3 attachments and 2 reminders.

  Keeps: its 2 prep tasks, which become ordinary tasks.

                                        [ Cancel ]  [ Delete plan ]
  ```

  A line with nothing to name is omitted, and the destructive button repeats the verb
  (`Delete task` / `Delete plan`). A bare `Delete "<title>"? This can't be undone.` with
  no `This removes:` line is a §1a.1 defect — it was exactly this dialog's old copy.
- For a shared Plan the confirmation adds:
  `<n> people will lose access to this plan.`
- Where a viewer-local `LNK#` pointer exists, the confirmation says what survives:
  `The item stays on "Restaurants to try".`
- If any Expense on the Activity has a settled obligation, Delete is blocked before the
  confirmation with `Undo settlement before deleting this plan`, linking to every blocking
  Settlement. Deletion never silently discards settled Expense state or its audit history.
- For a recurring series, Delete opens a sheet with three options, in this order:
  `This occurrence` · `End series` · `Delete whole series`.
  - `This occurrence` writes a `skipped` occurrence. The series is untouched.
  - `End series` is the primary, gentler affordance: it sets the series' end to today
    (`recurrence.endDate`, through the normal `PATCH`), so no further occurrences are
    emitted. The Activity row, every rule segment, and every past occurrence are kept —
    nothing stored is removed, so there is no confirmation; it applies immediately with
    the standard 6-second undo, which clears the end date again.
  - `Delete whole series` is the destructive option, styled as such and listed last. Its
    confirmation follows the §1a.1 shape and must name the history destroyed, with the
    real count of stored past completions (the series' `Occurrence` rows with
    `status: 'completed'`, counted before the dialog renders):

    ```
    Delete "Gym"?

    This removes: the series and its 40 past completions.

                                      [ Cancel ]  [ Delete series ]
    ```

    A series with no recorded completions names `the series` alone. The `Keeps:` line
    appears whenever anything survives — prep tasks or a viewer-local `LNK#` pointer, per
    the surrounding bullets. A dialog that says only `This can't be undone.` here is a
    defect: it hides exactly the loss this copy exists to name.
- Deletion cascades per
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).
  Any viewer-local `LNK#` pointers to the Plan are deleted. The source ListItem is
  byte-identical and survives. After all settlement guards are clear, every Expense locator
  is removed with its Expense row.
- Delete has no undo. Completion does — see
  [`interaction-contract.md`](interaction-contract.md) §4.

---

## 7. Quick add and platform affordances

### 7.1 Quick-add behaviours

| Behaviour | Rule |
| --- | --- |
| Inline add on Today | The Anytime section has a persistent `+ Add a task` row at its foot. The labelled action fixes `{ objectKind: 'task', type: 'task' }` before any words are accepted, opens the Task form directly with today's date and no time, and finishes with `Save task`. It never opens the global chooser or infers Task versus Plan from the title. |
| Inline add on a list | The list detail's `+ Add an item` row creates a `ListItem` in that list, never an Activity. Return commits with the accessible action `Add to <list name>` and re-focuses. |
| Inline add of a prep task | The plan's `+ Add a prep task` row creates a `task` with `parentActivityId` set. |
| Global `+` from Today | Opens **Task / Plan / List item**. After the user chooses Task or Plan, the form may pre-fill `schedule.date` = today. |
| Global `+` from Plans on a date | Opens the same chooser. After Task or Plan is chosen, the form may pre-fill the date in view. |
| Remembered choices | Object and Plan-kind choices always appear in the fixed documented order, unselected. Last-used values never reorder, pre-select, or bypass them. |
| Duplicate | `POST /v1/activities/:id/duplicate` copies `objectKind`, title, type, details, location and notes. It does **not** copy schedule, reminders, participants, expenses, attachments, prep children, generated or attached lists, or completion state. The copy opens in the edit state with the title suffixed ` (copy)`. |

> **Decision:** duplicate deliberately drops participants. Re-inviting people is a
> deliberate act; silently re-inviting on duplicate would send unexpected notifications.

> **Decision — duplicate also drops reminders, prep children and lists (2026-08-07).** A
> reminder is an offset from a schedule, and the copy has no schedule: the old text copied
> "your own reminders" into a dateless state the UI itself forbids (Reminder requires a
> date, §4.1). Prep children and generated or attached lists are likewise not copied —
> they are structure, not content, and copying them would quietly multiply real to-dos and
> list rows, which is auto-creation by another name. Set a date on the copy and a reminder
> is one visible control away.

### 7.2 Keyboard and web affordances

React Native Web builds share one codebase, so these are web-only behaviours guarded by
`Platform.OS === 'web'`. Full focus-order and shortcut rules live in
[`interaction-contract.md`](interaction-contract.md) §7.

| Key | Context | Action |
| --- | --- | --- |
| `N` | Anywhere outside a text field | Open the global **Task / Plan / List item** chooser |
| `T` / `P` / `L` | Anywhere outside a text field | Go to Today / Plans / Lists |
| `Return` | Selected Task, Plan, or List-item form, title focused | Activate `Save task`, `Save plan`, or `Add to <list name>` when valid |
| `Cmd/Ctrl + Return` | Any selected creation form | Activate its visible named write button |
| `Esc` | Any sheet or Add screen | Cancel, with the discard prompt if dirty |
| `Alt + 1`–`3` | Global object chooser | Choose Task, Plan, or List item, in that order |
| `Alt + 1`–`4` | Plan-kind chooser | Choose General, Meal, Watch, Event, in that order |
| `Cmd/Ctrl + V` | A selected creation form | If the clipboard holds a URL, switch to Link mode; if it holds an image, switch to Screenshot mode. The chooser never inspects the clipboard. |
| `↑` / `↓` | Any row list | Move focus between rows |
| `Space` | A focused task row | Toggle completion |
| `Return` | A focused row | Open detail |

Text inputs on web support paste of an image directly into a selected creation form, which
is treated as Screenshot mode. Pasting cannot skip the object or Plan-kind chooser.
