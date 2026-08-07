# Activities and the Add experience

**Status:** canonical for creation UX. Storage shapes are owned by
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity);
endpoints by
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities).
This document specifies what the user sees and what each control writes.

---

## 1. The universal Activity

Everything the user creates is one Activity. A meal, a TV episode, a dentist appointment, a
weekend trip, a reminder to call the apartment office, and a prep task hanging off a trip
are all the same stored entity with a different `type` and a different `details`
sub-document.

There is no `Plan` entity and no `Meal` entity. "Plan" is the word for an Activity whose
`schedule.date` is set. See
[`../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity`](../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity).

### 1.1 The six types are creation guides

| `type` | Guides creation of | Sets `details.kind` |
| --- | --- | --- |
| `task` | Something to accomplish | `task` |
| `meal` | Something to eat or cook | `meal` |
| `watch` | A movie, show, or episode | `watch` |
| `event` | A concert, appointment, festival, ticketed thing | `event` |
| `outing` | A restaurant, hike, coffee, shopping trip | `outing` |
| `custom` | Anything that does not fit the above | `custom` |

The type controls three things and nothing else:

1. **Which fields the creation form shows** (§4).
2. **Which verb the completion control uses** (§5.2).
3. **Whether the row renders a checkbox** — `task` only, everywhere in the product
   (see [`today-and-tasks.md`](today-and-tasks.md) §3).

The type never controls whether an Activity can be scheduled, shared, given expenses,
given prep tasks, attached to a list item, or shown on Today. Every type supports every one
of those. This is the "types guide, never restrict" rule from
[`overview.md`](overview.md#41-types-guide-never-restrict).

### 1.2 No category management

There is no UI to add, rename, delete, colour, reorder or nest a type. A user who feels a
type is missing chooses `custom`. `custom` is not a lesser type: it takes a title, date,
optional time, people, reminder, repeat and notes, which is everything most activities
need.

---

## 2. The unified Add experience

### 2.1 Entry points

The Add affordance is reachable from every primary screen and must never be more than one
tap away.

| Surface | Affordance |
| --- | --- |
| Today | Floating action button, bottom-right, above the tab bar. |
| Plans | Same FAB. Pre-fills `schedule.date` with the date currently in view. |
| Lists (list detail) | Inline "Add item" row at the bottom of the list, plus the FAB. The inline row creates a **ListItem**, not an Activity. |
| Plan detail | "Add prep task" in the prep-tasks section, pre-filling `parentActivityId`. |
| Web | The FAB, plus the global keyboard shortcut `N` (§7.2). |
| iOS share sheet | Sharing a URL or image into Ordinary Days opens the Add screen with that input pre-loaded (Phase 8, P8-11). |

### 2.2 The "What are you planning?" screen

Opening Add presents one screen. It does **not** ask the user to pick a type first.

```
┌──────────────────────────────────────────┐
│  Cancel                            Save  │
│                                          │
│  What are you planning?                  │
│  ┌────────────────────────────────────┐  │
│  │ (text input, autofocused)          │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [ Camera ] [ Photos ] [ Link ]          │
│                                          │
│  Task  Meal  Watch  Event  Outing  Custom│
└──────────────────────────────────────────┘
```

Behaviour:

- The text field is focused and the keyboard is up on open. Typing a title and hitting Save
  is the fastest path and must complete in under 5 seconds
  ([`overview.md`](overview.md#7-success-criteria-for-v1) S1).
- The six type chips are a horizontally scrollable row, always visible. Tapping one skips
  suggestion entirely and opens that type's form (§4) with the typed text as the title.
- **Camera / Photos / Link** are the non-text entry modes (§2.3).
- Nothing is written to the server until the user commits. Closing the Add screen with
  non-empty content prompts "Discard this?" with Discard / Keep editing.

> **Decision:** voice capture is listed in the concept's flow diagram but is not a v1
> entry mode. iOS dictation on the text field covers it at zero cost. Do not build a
> separate voice pipeline.

### 2.3 Entry modes

| Mode | Input | What happens | Endpoint |
| --- | --- | --- | --- |
| **Type** | Free text in the input | On Save (or after a 600 ms pause of ≥ 8 characters, whichever is first), the text is sent for parsing and the type suggestion appears. | `POST /v1/capture/parse` |
| **Photo** | Camera capture | Image is uploaded, then extracted. Shows an inline progress state on the Add screen. | `POST /v1/attachments/upload-url` → `POST /v1/capture/extract` |
| **Screenshot** | Picked from the photo library | Identical to Photo. | Same as Photo |
| **Link** | A pasted or shared URL | The URL is fetched and parsed. The URL is retained on `activity.sourceUrl` regardless of parse success. | `POST /v1/capture/link` |
| **Pick a type** | Tap a type chip | No parsing. Straight to the form. | none |

All three capture endpoints return `501 not_implemented` until Phase 7 — see
[`../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier)
and [`ai-capture.md`](ai-capture.md). Until then:

- **Type mode** falls back silently: no suggestion banner appears, and the type chips
  remain the way to proceed. The typed text becomes the title. The user is never shown an
  error for a `501` on the type path.
- **Photo / Screenshot / Link** modes show the fallback described in
  [`ai-capture.md`](ai-capture.md) §6: the image is still attached and the link is still
  retained, and the user completes the form manually.

### 2.4 How the type suggestion is presented and overridden

When a parse returns, the Add screen transitions to the suggested type's form with the
parsed fields filled in. Above the form sits a single-line suggestion banner:

```
Watch · from what you typed                          Change
```

Rules:

1. The suggestion banner is **never modal** and never blocks Save.
2. Tapping **Change** reveals the six type chips inline. Selecting a different type applies
   the type-change field-mapping rules in §6.3 to the draft, in memory, before any write.
3. Any field the parse filled with `confidence < 0.7` is highlighted per
   [`ai-capture.md`](ai-capture.md) §3. A highlighted field never blocks Save either; it is
   a visual cue, not a validation error.
4. If `suggestedType` has confidence `< 0.5`, the app does **not** pre-select a type. It
   shows the six chips with the parsed title filled in and the banner reads
   `Not sure what this is — pick one`.
5. The chosen type is what is sent as `type` in `POST /v1/activities`. The server never
   infers a type.

### 2.5 Save behaviour

- **Save** is enabled as soon as `title` is non-empty after trimming. Every other field on
  every type is optional.
- Save issues one `POST /v1/activities` with an `Idempotency-Key` (a client-generated
  UUID, regenerated only when the draft changes).
- On success the Add screen dismisses and the app shows a confirmation toast anchored to
  where the item landed:

  | Draft state | Toast | Toast action |
  | --- | --- | --- |
  | Has `schedule.date` = today | `Added to Today` | `View` |
  | Has `schedule.date` ≠ today | `Planned for Fri, 8 Aug` | `View` |
  | No `schedule.date` | `Saved` | `Schedule` |

  The toast persists for 4 seconds and is dismissible by swipe.
- On failure the Add screen stays open with the draft intact and an inline error banner.
  See [`interaction-contract.md`](interaction-contract.md) §5.

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
   | Reminder | Only enabled when a date is set. Options in [`notifications.md`](notifications.md) §3. |
   | Repeat | Only enabled when a date is set. Options in [`today-and-tasks.md`](today-and-tasks.md) §5.1. |
   | Notes | Multi-line, max 4000 characters, no formatting. |
   | Location | Free-text label plus optional address. v1 has no map picker and no geocoding. |

5. **Validation errors are inline and per-field**, shown on blur and again on Save attempt.
   They map one-to-one onto the `details[]` entries of a `validation_failed` error
   (see [`../02-architecture/api-contract.md#1-shape`](../02-architecture/api-contract.md#1-shape)).
6. **Character limits:** `title` 1–200, `notes` 0–4000, any free-text sub-field
   (`service`, `placeName`, `organiser`, ingredient `name`) 0–120.

> **Decision:** v1 has no location autocomplete, no geocoding and no map. `location.lat`,
> `location.lng` and `location.mapUrl` exist in the model but are only populated by capture
> extraction (Phase 7) or by a pasted maps URL. The form collects `label` and `address` as
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
| Reminder | Select | No | Requires a date | User's `defaultReminderOffset` if a time is set; `Off` if all-day | `reminders[]` |
| Repeat | Select → recurrence sheet | No | Requires a date | `Never` | `recurrence` |
| Related plan | Plan picker (search over upcoming Activities) | No | Must be an Activity the user owns or participates in | Pre-filled when opened from a plan | `parentActivityId` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details` is `{ kind: 'task' }` — it carries no fields.

### 4.2 Meal

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Meal | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Auto-set from the slot when a slot is chosen and no time is set: breakfast 08:00, lunch 12:30, dinner 19:00, snack unset | `schedule.time` |
| Slot | Segmented: Breakfast / Lunch / Dinner / Snack | No | One of the four | Inferred from Time if a time is set and no slot chosen: < 11:00 breakfast, < 15:00 lunch, < 17:00 snack, else dinner | `details.mealSlot` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Ingredients | Repeating rows: name + optional quantity, each with a checkbox | No | Name 1–120; max 60 rows | Empty | `details.ingredients[]` (`name`, `quantity`) |
| Add selected ingredients to Groceries | Toggle + list picker, shown only when ≥ 1 ingredient row exists | No | Target list must be `kind: 'groceries'` | Off, target = the user's first groceries list | Post-create `POST /v1/lists/:id/items/bulk`; sets `details.ingredients[].addedToListId` |
| Recipe link | Single-line URL | No | Valid absolute `http(s)` URL | Empty | `details.recipeUrl` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

Ingredient checkboxes default to **checked**; the "Add selected" toggle defaults to
**off**. Nothing is written to Groceries unless the user turns the toggle on — this is the
"suggest, never auto-create" rule. See [`plans-and-lists.md`](plans-and-lists.md) §6.

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
| Save to Watchlist | Toggle | No | — | **On** when there is no date; **off** when a date is set and the activity did not come from a watchlist item | Post-create `POST /v1/lists/:id/items`; sets `details.watchlistItemId` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details.service` is free text by design. There is no catalogue and no provider list.

### 4.4 Event

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Title | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Start time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| End time | Time picker | No | After start; requires a start | Empty | `schedule.endTime` |
| Location | Text label + optional address | No | Label 0–120, address 0–300 | Empty | `location.label`, `location.address` |
| Description | Multi-line text | No | 0–4000 | Empty | `details.description` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Price | Currency input, cents-integer | No | ≥ 0; stored as an integer number of minor units | Empty | `details.priceCents`, `details.currency` (from profile) |
| Ticket link | Single-line URL | No | Valid absolute `http(s)` URL | Empty | `details.ticketUrl` |
| Organiser | Single-line text | No | 0–120 | Empty | `details.organiser` |
| Source image / link | Attachment thumbnail + URL row | No | Image ≤ 10 MB, image MIME only | Populated by photo/link capture | `attachmentIds[]`, `sourceUrl` |
| Reminder | Select | No | Requires a date | Default offset if a time is set | `reminders[]` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details.description` and `notes` are distinct: description is shown on the public invite
page, notes are private and never leave the owner's view. See
[`sharing-and-people.md`](sharing-and-people.md) §4.4.

### 4.5 Outing

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Place | Single-line text | Yes | 1–200 | Text from the Add screen | `title` **and** `details.placeName` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| End time | Time picker | No | After start | Empty | `schedule.endTime` |
| Location | Text label + optional address | No | Label 0–120, address 0–300 | Label pre-filled from Place | `location.label`, `location.address` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Reservation | Disclosure group: name, time, party size, reference | No | Party size 1–99; reservation time `HH:mm` | Reservation name = user's display name; reservation time = `schedule.time` | `details.reservation.{name,time,partySize,reference}` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

### 4.6 Custom

| Field | Control | Req. | Validation | Default | Maps to |
| --- | --- | --- | --- | --- | --- |
| Title | Single-line text | Yes | 1–200 | Text from the Add screen | `title` |
| Date | Date picker | No | Valid date | Empty | `schedule.date` |
| Time | Time picker | No | `HH:mm`; requires a date | Empty | `schedule.time` |
| People | Participant picker | No | ≤ 50 | Empty | `participants[]` |
| Reminder | Select | No | Requires a date | Default offset if a time is set | `reminders[]` |
| Repeat | Select → recurrence sheet | No | Requires a date | `Never` | `recurrence` |
| Notes | Multi-line text | No | 0–4000 | Empty | `notes` |

`details` is `{ kind: 'custom' }`. `details.shortcutId` exists in the model for a later
personalisation feature (concept §30) and is not written in v1.

### 4.7 Fields available on every type, off the creation form

These are reachable from the Activity detail screen for every type, regardless of what the
creation form showed:

- Participants and sharing.
- Prep tasks (child activities).
- Attachments.
- Expenses (only meaningful once there are participants — see
  [`expenses.md`](expenses.md) §2.1).
- Notes.
- Updates feed.
- Related lists.

That an Outing's creation form does not show a Reminder field does not mean an Outing
cannot have a reminder; it means the form stays short. Add it from the detail screen.

---

## 5. Lifecycle and completion

### 5.1 States

`ActivityStatus` is the closed enum in
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity).

| State | Meaning | How it is reached |
| --- | --- | --- |
| `saved` | Exists, no date committed. Lives in Anytime / the Inbox. | Created without `schedule.date`, or a date is cleared. |
| `scheduled` | Has a date, optionally a time. **This is a Plan.** | `POST /v1/activities/:id/schedule` or created with a date. |
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
| `outing` | Done | Didn't happen | `done` / `didnt_happen` |
| `custom` | Done | Didn't happen | `done` / `didnt_happen` |

Notes:

- "Appointment" in concept §17 is not a type. An appointment is an `event`; the concept's
  "Done" for appointments is covered by `event` → Attended, and the row is not a checkbox.
- The secondary label appears only in the passed-plan prompt described in
  [`today-and-tasks.md`](today-and-tasks.md) §6, and in the overflow menu.
- `didnt_happen` and `didnt_go` set `status: 'skipped'`, not `completed`. They are the
  polite way to clear something without claiming it happened.

### 5.3 Follow-up suggestions

Completion may present exactly one contextual follow-up, inline, in the same toast slot as
the confirmation. It is always dismissible and never pre-selected.

| Completed type | Follow-up offered | Creates on tap |
| --- | --- | --- |
| `watch` (show, with season/episode) | `Watched S2 E4. Update progress to S2 E5?` | Updates the linked watchlist item's `details.episode`. Then offers `Schedule S2 E5?` as a second, separate step. |
| `meal` with ingredients | `Add anything to Groceries?` | Opens the ingredient picker; writes only what the user selects. |
| Any type with ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigates to the plan's expense section. No write. |
| Any type with ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the add-expense sheet. No write until saved. |
| Recurring occurrence | Nothing. The next occurrence already exists by definition. | — |

No follow-up ever writes without the tap. See
[`overview.md`](overview.md#44-suggest-never-auto-create).

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
- Clearing the date on an activity with participants warns:
  `Removing the date un-plans this for everyone. Continue?`
- Rescheduling a **recurring series** presents a two-option sheet: `This occurrence only` /
  `All future occurrences`. The first writes an `Occurrence` with `overrideTime`; the
  second patches `recurrence`. There is no "all occurrences including past" option.

### 6.3 Changing an activity's type

Type is mutable — see the rule in
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity):
"Changing type keeps `details` fields that still apply and drops the rest (log what was
dropped)."

The user-facing contract:

1. Changing type is done from the detail screen's overflow menu → `Change type`, or inline
   on the Add screen before the first save.
2. Fields on `Activity` itself — `title`, `notes`, `schedule`, `recurrence`, `reminders`,
   `location`, participants, expenses, attachments, prep tasks, list links — are **never**
   lost when the type changes.
3. Fields on `details` are mapped where a same-meaning field exists, and otherwise dropped.
   The mapping table is exhaustive:

   | From → To | Carried over | Dropped |
   | --- | --- | --- |
   | `watch` → any | — | `mediaTitle`, `mediaKind`, `season`, `episode`, `episodeTitle`, `service`. `watchlistItemId` is unlinked (the watchlist item's `linkedActivityId` is cleared, the item is **not** deleted). |
   | `meal` → any | — | `mealSlot`, `recipeUrl`. `ingredients[]` is dropped, but any grocery items already created from it keep their `sourceActivityId` and their provenance label. |
   | `event` → `outing` | `description` → `notes` (appended, separated by a blank line, if `notes` is non-empty) | `priceCents`, `currency`, `ticketUrl`, `organiser` |
   | `event` → any other | `description` → `notes` (same append rule) | `priceCents`, `currency`, `ticketUrl`, `organiser` |
   | `outing` → `event` | `placeName` → `location.label` if `location.label` is empty; `reservation.*` → `notes` as a single formatted line | `reservation` object |
   | `outing` → any other | Same as above | `reservation` object |
   | any → `watch` | `title` → `details.mediaTitle` | — |
   | any → `outing` | `title` → `details.placeName` | — |
   | `task` ↔ `custom` | Everything (both have empty or near-empty `details`) | — |
   | any → `task` / `custom` | — | The whole source `details` payload beyond the mappings above |

4. **Before** the change is applied, the client shows a confirmation listing exactly what
   will be lost, by label:

   ```
   Change Watch → Task?

   This will remove:
     Season and episode (S2 E4)
     Streaming service (Netflix)

   Keeps: title, date, time, people, notes, reminders.
   ```

   If nothing would be dropped, no confirmation is shown.
5. The server logs the dropped payload at `info` with the `activityId`, the old type and
   the old `details` object, so a support request can recover it from CloudWatch within the
   retention window. It is not restorable through the UI.
6. Changing type does **not** change `status`, `completedAt`, or `outcome`. An `event` that
   was `attended` and is changed to `outing` stays completed with `outcome: 'attended'`,
   and the detail screen renders the historical verb.

### 6.4 Deleting

- Delete is owner-only, in the overflow menu, and always confirms:
  `Delete "<title>"? This can't be undone.` with Delete / Cancel.
- For a shared activity the confirmation adds:
  `<n> people will lose access to this plan.`
- For a recurring series the confirmation asks `This occurrence` / `Whole series`. The
  first writes a `skipped` occurrence; the second deletes the Activity.
- Deletion cascades per
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).
  A linked ListItem is **not** deleted; its `linkedActivityId` is cleared and it returns to
  looking like an ordinary unscheduled list item.
- Delete has no undo. Completion does — see
  [`interaction-contract.md`](interaction-contract.md) §4.

---

## 7. Quick add and platform affordances

### 7.1 Quick-add behaviours

| Behaviour | Rule |
| --- | --- |
| Inline add on Today | The Anytime section has a persistent `+ Add a task` row at its foot. Typing a title and pressing Return creates a `task` with today's date and no time, and immediately re-focuses the input so several can be entered in a row. |
| Inline add on a list | The list detail's `+ Add item` row creates a `ListItem`, never an Activity. Return commits and re-focuses. |
| Inline add of a prep task | Same behaviour inside a plan's prep-tasks section, creating a `task` with `parentActivityId` set. |
| Add from Today's FAB | Pre-fills `schedule.date` = today. |
| Add from Plans on a date | Pre-fills `schedule.date` = the date in view. |
| Repeat-last-type | The Add screen remembers the last type the user explicitly chose via a chip and shows that chip first in the row. It does **not** pre-select it. |
| Duplicate | `POST /v1/activities/:id/duplicate` copies title, type, details, location, notes and reminders. It does **not** copy schedule, participants, expenses, attachments or completion state, and the copy opens in the edit state with the title suffixed ` (copy)`. |

> **Decision:** duplicate deliberately drops participants. Re-inviting people is a
> deliberate act; silently re-inviting on duplicate would send unexpected notifications.

### 7.2 Keyboard and web affordances

React Native Web builds share one codebase, so these are web-only behaviours guarded by
`Platform.OS === 'web'`. Full focus-order and shortcut rules live in
[`interaction-contract.md`](interaction-contract.md) §7.

| Key | Context | Action |
| --- | --- | --- |
| `N` | Anywhere outside a text field | Open Add |
| `T` / `P` / `L` | Anywhere outside a text field | Go to Today / Plans / Lists |
| `Return` | Add screen, title focused | Save (if title non-empty) |
| `Cmd/Ctrl + Return` | Any form | Save |
| `Esc` | Any sheet or Add screen | Cancel, with the discard prompt if dirty |
| `1`–`6` | Add screen, title focused, with a modifier (`Alt`) | Select type chip 1–6 in order Task, Meal, Watch, Event, Outing, Custom |
| `Cmd/Ctrl + V` | Add screen | If the clipboard holds a URL, switch to Link mode; if it holds an image, switch to Screenshot mode |
| `↑` / `↓` | Any row list | Move focus between rows |
| `Space` | A focused task row | Toggle completion |
| `Return` | A focused row | Open detail |

Text inputs on web support paste of an image directly into the Add field, which is treated
as Screenshot mode.
