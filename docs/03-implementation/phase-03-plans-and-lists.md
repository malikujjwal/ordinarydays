# Phase 3 — Plans and lists

## Goal

At the end of this phase the third noun exists and the loop closes. Lists hold things
without a date; scheduling a list item creates one Activity and links the two rows without
duplicating anything; completing that Activity writes progress back to the item. A plan
detail screen shows the full anatomy — when and where, prep tasks, related lists, notes,
attachments — and a plan can produce lists rather than only consuming them. A meal's
ingredients become grocery items with honest provenance labels, on confirmation and never
automatically. A watchlist entry carries season and episode, gains `watching` status on its
first completed session, and offers the next episode as a suggestion the user must accept.
Images upload to S3 through presigned URLs and render through CloudFront. After this phase
the product does what the concept describes: *Lists → Plans → Today*, in both directions.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phases 1 and 2 complete and passing | The Activity CRUD, the agenda, and completion are all load-bearing here. |
| 2 | [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) read in full | It is the specification for this phase, including the three worked examples in §9 which are the integration fixtures. |
| 3 | The media bucket and media CloudFront distribution deployed | Created in Phase 0 (P0-15, P0-19); this phase is the first consumer. |

## Deliverables

- [ ] `List` and `ListItem` entities, repository, and the eight closed kinds.
- [ ] `lexoRankBetween` in `packages/shared`, so reordering is a single-item write.
- [ ] Lists CRUD, item CRUD, `bulk`, `clear-checked`, archive, move.
- [ ] `POST /v1/lists/:id/items/:itemId/schedule` — the Lists → Plans bridge — creating the
      Activity and linking both rows in one transaction, with type inferred from
      `list.kind` and overridable by the client.
- [ ] Bidirectional title mirroring, kept equal server-side; notes deliberately not mirrored.
- [ ] Watchlist progress: `mediaKind`, `watchStatus`, season, episode; the one automatic
      status transition (`want` → `watching`); the next-episode suggestion that creates
      nothing.
- [ ] Meal ingredients → groceries: the stored provenance label, the duplicate-handling
      rule, and `addedToListId` marking on the source rows.
- [ ] Prep tasks as child activities inside a plan, with `childCount`, the two-level nesting
      cap, and survival of the parent's deletion.
- [ ] Plan → list suggestion sheet with the per-shape ranked kinds; nothing created without
      confirmation.
- [ ] The plan detail screen with all ten sections in fixed order and their visibility rules.
- [ ] The updates feed: `GET`/`POST /v1/activities/:id/updates` with server-written system
      entries.
- [ ] Attachments: presigned `PUT`, confirm-and-link, `primaryAttachmentId` as the hero
      image, the viewer, delete.
- [ ] Follow-up suggestions after completion, all dismissible, none of which write.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P3-01 | `List` / `ListItem` types and Zod schemas | shared | P1-09 | no | M |
| P3-02 | `lexoRankBetween` | shared | — | yes | M |
| P3-03 | `ListRepository` | api | P3-01, P1-08 | no | L |
| P3-04 | Lists CRUD endpoints | api | P3-03 | no | M |
| P3-05 | List item CRUD and `bulk` | api | P3-03, P3-02 | no | L |
| P3-06 | `clear-checked`, `uncheck-all`, archive | api | P3-05 | yes | S |
| P3-07 | Move an item between lists | api | P3-05, P1-20 | yes | M |
| P3-08 | The Lists → Plans bridge endpoint | api | P3-05, P1-13 | no | L |
| P3-09 | Title mirroring, both directions | api | P3-08 | no | M |
| P3-10 | Link lifecycle on complete / skip / unschedule / delete | api | P3-08, P2-11 | no | L |
| P3-11 | Watchlist progress and status transitions | api | P3-10 | no | M |
| P3-12 | Meal ingredients → groceries and the provenance label | shared/api | P3-05 | no | L |
| P3-13 | Prep tasks: `childCount`, nesting cap, orphaning | api | P1-13 | yes | M |
| P3-14 | Updates feed endpoints | api | P1-12 | yes | M |
| P3-15 | `POST /v1/attachments/upload-url` | api | P0-15 | yes | M |
| P3-16 | Confirm, link, delete an attachment; `primaryAttachmentId` | api | P3-15 | no | M |
| P3-17 | Media distribution cache tuning and lifecycle verification | infra | P3-15 | yes | S |
| P3-18 | Shared API client: lists, items, attachments, updates | shared | P3-04, P3-15 | no | M |
| P3-19 | Lists index screen | mobile | P3-18, P1-29 | no | M |
| P3-20 | List detail screen and the inline add row | mobile | P3-19 | no | L |
| P3-21 | List item sheet | mobile | P3-20 | no | M |
| P3-22 | Drag to reorder | mobile | P3-20, P3-02 | no | M |
| P3-23 | Watchlist grouping and progress UI | mobile | P3-21, P3-11 | no | M |
| P3-24 | The schedule sheet from a list item | mobile | P3-21, P3-08 | no | L |
| P3-25 | State line on a scheduled item | mobile | P3-24 | no | M |
| P3-26 | Plan detail screen: full anatomy | mobile | P1-33, P3-18 | no | L |
| P3-27 | Prep section inside a plan | mobile | P3-26, P3-13 | no | M |
| P3-28 | Lists section and the `Add list` suggestion sheet | mobile | P3-26, P3-04 | no | M |
| P3-29 | Updates section | mobile | P3-26, P3-14 | yes | M |
| P3-30 | Image picker, upload, and progress | mobile | P3-15, P3-16 | no | L |
| P3-31 | Attachment viewer and hero image | mobile | P3-30 | no | M |
| P3-32 | Meal ingredients UI and `Add selected to Groceries` | mobile | P3-12, P1-32 | no | M |
| P3-33 | Follow-up suggestions after completion | mobile | P3-11, P3-12 | no | M |
| P3-34 | E2E: the three worked examples | ci | P3-25, P3-32, P3-28 | no | L |

P3-06 and P3-17 are mechanical; follow the canonical sections and skip the discussion.

---

### P3-02 — `lexoRankBetween`

**Files.** `packages/shared/src/rank/lexoRank.ts`.

**Approach.** A fractional-index string generator: `lexoRankBetween(a?, b?)` returns a
string strictly between `a` and `b` in lexicographic order, with `undefined` meaning "no
bound". Base-62 over `0-9A-Za-z`, appending a character when the gap between neighbours is
exhausted rather than renumbering.

The whole point is that reordering is **one item write**, never a renumber of the list.

**Edge cases.**

- `lexoRankBetween(a, a)` is a programming error, not a rank — throw.
- Repeated insertion at the same position grows the string. Cap the length at 64 characters
  and, on overflow, rebalance the whole list once in a background write. A 500-item cap
  makes this unreachable in practice; implement the guard anyway so the failure is a
  rebalance rather than a corrupt order.
- Ranks are opaque to the client. The client sends `afterItemId`; the server computes the
  rank. Never let the client send a rank.

**Tests.** Property test: 10,000 random insertions at random positions leave the list in the
intended order at every step. Unit: insert at head, at tail, between two adjacent ranks 200
times in the same gap and assert order holds and length stays under the cap.

---

### P3-03 — `ListRepository`

**Files.** `services/api/src/repositories/listRepository.ts`.

**Approach.** Access patterns 7 and 8 from
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns).
Lists live under `USER#<u>/LIST#<listId>` with a mirror at `LIST#<listId>/META`; items live
at `LIST#<listId>/ITEM#<lexoRank>#<itemId>`.

The mirror exists so a list can be read by id without knowing its owner, which the bridge
endpoint and the plan detail's LISTS section both need. Both copies are written in one
transaction; the `USER#` copy is authoritative for ownership and the `LIST#` copy for
membership.

`itemCount` on the list is denormalised and maintained on write.

**Edge cases.** An item's sort key contains its rank, so a reorder is a delete-and-put, not
an update. Do both in one transaction so an interrupted reorder cannot lose the item.

**Tests.** Integration on DynamoDB Local: create a list, add ten items, reorder the last to
the front, assert one query returns them in the new order and `itemCount` is still 10; a
reorder interrupted between delete and put is impossible (assert the transaction is used).

---

### P3-05 — List item CRUD and `bulk`

**Approach.** `POST /v1/lists/:id/items` with `{ title, note?, details?, afterItemId? }`.
The server converts `afterItemId` to a rank via P3-02. `PATCH` accepts `title`, `checked`,
`note`, `details`, `afterItemId`. `POST .../items/bulk` takes an array and is what
"add ingredients to Groceries" uses.

**Edge cases.**

- **Item cap 500 per list.** Beyond it, `POST` returns `validation_failed` with the message
  `List is full.`
- `checked` is only meaningful on checkable kinds. Per the decision in
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.1, the checkable
  kinds are `groceries`, `shopping`, `packing` **and `general`**. `watchlist`, `meals`,
  `restaurants` and `places` are the aspirational kinds where the completion signal is
  scheduling the item, not ticking it. A `checked: true` on those returns
  `validation_failed`.
- Checked items **stay in place**, struck through and de-emphasised. They do not jump to the
  bottom. Re-sorting under the user's finger is disorienting and makes an accidental
  double-tap destructive.
- `bulk` is a single transaction when it fits in 100 items and a chunked sequence otherwise;
  it must be idempotent under the `Idempotency-Key`.

**Tests.** Integration: the 501st item `400`s with the exact message; `checked` on a
`restaurants` item `400`s; a bulk insert of 30 items produces 30 rows in the sent order;
repeating the bulk call with the same key produces no duplicates.

---

### P3-08 — The Lists → Plans bridge

**Files.** `services/api/src/routes/lists.ts`,
`services/api/src/services/listScheduleService.ts`.

**What to build.** `POST /v1/lists/:id/items/:itemId/schedule`. The single most important
endpoint in this phase, because getting it wrong produces the duplication the concept
explicitly forbids.

**Approach.** One `TransactWriteItems` writing:

1. `ACT#<newId>/META` — the Activity, with `listItemId` and `listId` set,
2. `USER#<owner>/IDX#<newId>` — the index entry in the correct GSI1 bucket,
3. `LIST#<listId>/ITEM#<rank>#<itemId>` — updated with `linkedActivityId`.

The body is a `CreateActivityInput` minus `type`, which is inferred from `list.kind` per the
mapping in
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists):
`watchlist → watch`, `meals → meal`, `restaurants|places → outing`,
`groceries|shopping|packing → task`, `general → custom`. The client **may override** it; the
inference is a suggestion, per the product principle.

Kind-specific pre-fill, computed server-side so the client and the server cannot disagree:

| Kind | Pre-fill |
| --- | --- |
| `watchlist` | `details.mediaTitle`, `mediaKind`, `season`, `episode` from the item, **incremented by one episode** for a `watching` show; `details.watchlistItemId`; `details.service` = the user's last used service. |
| `meals` | `details.ingredients` from the item's typed ingredients. |
| `restaurants`, `places` | `details.placeName` = the item title. |
| others | Title only. |

> The episode increment is deliberate: scheduling the episode you have already seen is never
> what is meant. It is editable in the sheet, and a `want` item with no progress defaults to
> S1 E1.

**Edge cases.**

- The item is **not** copied, not moved, not checked and not hidden. It stays in place with
  an added state line.
- If the item already has a `linkedActivityId` pointing at a live Activity, return `409
  conflict` rather than creating a second one.
- The response returns **both** the created Activity and the updated ListItem, so the client
  updates two caches from one call.

**Tests.** Integration: scheduling `Zahav` from `Restaurants to try` produces exactly one
new Activity, one index entry, and one updated item — asserted by counting the table before
and after. A second schedule call on the same item `409`s. Type inference is correct for all
eight kinds and a client override wins.

---

### P3-09 — Title mirroring

**Approach.** The title is one value edited in one place. Editing the Activity's title
updates the linked list item's title, and vice versa; the server keeps them equal on write.

`ListItem.note` and `Activity.notes` are **not** mirrored — the note on a watchlist entry
("Ben said start at S1") means something different from the note on a watch session ("bring
the HDMI cable").

**Edge cases.** The mirror write must be in the same transaction as the originating write,
or a failure leaves two titles that drift. If the linked counterpart no longer exists, clear
the pointer and proceed rather than failing the user's edit.

**Tests.** Integration both directions; a mirror to a deleted counterpart clears the pointer
and succeeds; notes do not mirror.

---

### P3-10 — Link lifecycle

**Approach.** The table in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §6.3, implemented
exactly. It is described in the canonical doc as "the most commonly mis-implemented rule in
the product", so it gets its own task and its own test file.

| Event on the Activity | Effect on the linked `ListItem` |
| --- | --- |
| Completed | Watchlist: progress and `watchStatus` update (P3-11). Meals / restaurants / places: **not deleted**; the state line becomes `Done Saturday` and it stays in the list. Checkable kinds: `checked: true`. |
| Un-completed | State line reverts; `checked` reverts; watchlist progress reverts to pre-completion values. |
| Skipped / `didnt_happen` | State line removed; the item returns to its unscheduled appearance; the link is cleared. |
| Rescheduled | State line updates. |
| Unscheduled (`date: null`) | State line removed; **the link is kept** — the Activity still exists as `saved` and the pair stays connected. |
| Activity deleted | `ListItem.linkedActivityId` cleared. **The item survives.** |
| ListItem deleted | `Activity.listItemId` and `.listId` cleared. **The Activity survives.** |

Neither side ever cascade-deletes the other.

**Reverting watchlist progress on un-complete requires storing the previous values.** Write
`details.previousSeason` / `previousEpisode` on the item at completion time and consume them
on un-complete. Recomputing by decrementing is wrong: the user may have edited the progress
in between.

**Tests.** One test per row, all in
`services/api/src/services/__tests__/listLinkLifecycle.test.ts`. Plus a test that deletes an
Activity and asserts the item's other fields — title, note, rank, `sourceLabel` — are
untouched.

---

### P3-11 — Watchlist progress and status transitions

**Approach.** Completing a watch session with `outcome: 'watched'` does exactly three
things:

1. Writes `status: 'completed'`, `completedAt`, `outcome` on the Activity.
2. If `details.watchlistItemId` resolves, sets that item's `season`/`episode` to the
   session's values and, if `watchStatus` was `want`, sets it to `watching`.
3. Returns a follow-up **suggestion** in the response for the client to render.

Step 3 creates nothing. `want → watching` is the one automatic status transition in the
product — a status change on an existing row, not a creation — and is undoable from item
detail. `watching → watched` is manual only: the app does not know how many episodes there
are.

**Edge cases.** For a `movie`, the follow-up is `Mark as watched?` rather than a next
episode. A code path that writes an Activity from the follow-up is a bug, not a shortcut.

**Tests.** Integration: completing S2 E5 sets the item to S2 E5 and `watching`; un-completing
restores S2 E4; completing a movie does not set `watched` automatically; the response's
follow-up field is present and **no** second Activity exists in the table afterwards.

---

### P3-12 — Meal ingredients → groceries and the provenance label

**Files.** `packages/shared/src/lists/provenanceLabel.ts`,
`services/api/src/services/groceryService.ts`.

**Approach.** The exact flow in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §7.3. One
`POST /v1/lists/:id/items/bulk` with the selected ingredients; each created item gets
`title` = `name` with `quantity` in parentheses if present (`Tortillas (8)`),
`sourceActivityId` = the meal, and `sourceLabel` from the pure function below. Each source
ingredient gets `details.ingredients[i].addedToListId`, so the button renders `Added` for
those rows next time.

`provenanceLabel(meal, existingLabelsOnList)` implements the five rules in §7.5:

1. Scheduled within 7 days **and** has a slot → `"<Weekday> <slot>"` — `Sunday dinner`.
2. Scheduled within 7 days, no slot → `"<Weekday>"`.
3. Scheduled beyond 7 days → `"<d MMM> <slot>"` — `23 Aug dinner`.
4. Unscheduled → the meal's title.
5. If rules 1–3 produce a label already on the list **from a different meal**, append the
   meal title: `Sunday dinner · Chicken tacos`.

The label is **computed once and stored, never recomputed**, so it stays truthful after the
meal is rescheduled or deleted. A manually added item has no label and renders no dash.

**Duplicate handling.** If an item with the same case-insensitive, trimmed title already
exists **unchecked** on the target list, no second row is created — the existing row's
`sourceLabel` is extended (`Sunday dinner · Thursday lunch`). If the existing row is
**checked**, a new row is created: the previous one was already bought.

**Edge cases.** Nothing in this flow happens automatically. Creating a meal with ingredients
writes zero grocery items until the user taps the button. Provenance is **not** linkage
(§6.5): checking `Chicken` does not affect the meal, completing the meal does not delete
`Chicken`, and deleting the meal leaves `Chicken` with its label intact and a non-navigable
back-link.

**Tests.** `provenanceLabel` unit tests for all five rules including the collision case.
Integration for the duplicate rule in all three states (absent, present-unchecked,
present-checked). A test asserting the label is unchanged after the source meal is
rescheduled and after it is deleted. An integration test asserting that creating a meal with
four ingredients and never tapping the button leaves the groceries list empty.

---

### P3-13 — Prep tasks

**Approach.** Prep tasks are ordinary Activities of type `task` with `parentActivityId` set.
They are not a sub-entity and have no reduced capability: their own schedule, reminders,
recurrence, checkbox everywhere, and their own row on Today with the parent plan's title as
the subtitle.

Retrieval is access pattern 16 — from the parent's partition, not a GSI filter. The data
model offers two options and picks the latter; use `Query pk = ACT#<parent>, sk begins_with
SUB#`, writing a lightweight `SUB#<childId>` pointer item alongside the child's own
`ACT#<childId>/META`.

`activity.childCount` on the parent is maintained on write. `3 of 5 done` is a drill-down:
tapping it opens the plan's prep list including completed items.

**Edge cases.**

- **Nesting is capped at 2 levels.** A `POST` that would create a third returns
  `validation_failed`. Arbitrary nesting turns the product into an outliner.
- **Deleting the parent does not delete prep tasks.** It clears `parentActivityId` and they
  become ordinary tasks. A user who cancels a trip may still need to return the rental car;
  cascade-deleting real to-dos because the container went away is the kind of data loss that
  ends trust in a planner. This differs from the cascade for `PART#` and `EXP#` items and is
  therefore easy to get wrong by pattern-matching.

**Tests.** Integration: three levels `400`s; `childCount` is correct after add, complete and
delete; deleting the parent leaves the children with `parentActivityId` absent and their
schedules intact; a prep task with today's date appears on Today with the parent title as
subtitle.

---

### P3-15 — `POST /v1/attachments/upload-url`

**Approach.** Returns `{ attachmentId, uploadUrl, key }` for a presigned S3 `PUT`, with:

- **5-minute expiry.**
- `Content-Type` and `Content-Length` both bound into the signature, so the client cannot
  upload a different type or size than it declared.
- **10 MB cap**, image MIME types only (`image/jpeg`, `image/png`, `image/heic`,
  `image/webp`).
- Key `tmp/u/<userId>/<ulid>.<ext>` on upload; moved to `u/<userId>/<ulid>.<ext>` on
  confirmation. The `tmp/` prefix has a 1-day lifecycle expiry, so an abandoned upload
  cleans itself up.
- Rate limited at 60/hour per user.

Bytes never pass through Lambda. Uploading through the function burns duration and hits the
6 MB payload limit.

**Edge cases.** The bucket has all four Block Public Access settings on and is read only by
CloudFront via OAC. Never make it public. Media is served by unguessable key rather than
signed URL in v1 (ADR-023); the API only ever returns keys for images the caller may see.

**Tests.** Integration against a real dev bucket in the deploy pipeline: a presigned PUT with
the declared content type succeeds; the same URL with a different content type is rejected by
S3; an 11 MB declaration `400`s at the API; a `application/pdf` declaration `400`s; the URL
is unusable after 5 minutes.

---

### P3-24 — The schedule sheet from a list item

**Approach.** One sheet, opened from a list item's `Schedule` action or swipe. It shows the
inferred type, the pre-filled fields from P3-08, a date and time picker, and the participant
picker (disabled until Phase 5). Confirming issues one bridge call.

The user can change everything before confirming, including the type. Nothing is written
until they confirm.

**Edge cases.** For a `watching` watchlist item the sheet opens on the **next** episode, and
the user can edit it. For a `want` item with no progress it opens on S1 E1.

**Tests.** Playwright: schedule `Severance` from the watchlist, assert the sheet shows S2 E5
when the item is at S2 E4, change it to S2 E6, confirm, and assert the created Activity
carries S2 E6.

---

### P3-25 — The state line on a scheduled item

**Approach.** The item stays in its list, in place, with an added state line:

```
Restaurants to try
  Zahav
  Planned Saturday · 7 PM                    →
```

Rules that are easy to get wrong:

- The state line shows the linked Activity's date and time in the relative format used
  elsewhere: weekday name within 7 days, otherwise `d MMM`.
- **Tapping the state line opens the Activity. Tapping the title opens the item detail.**
  Both targets are ≥ 44 pt and are separate accessibility elements.
- A scheduled item is distinguished by the state line **alone**. No colour change, no
  strike-through, no move.
- Checkable-kind items that are scheduled are still checkable. Checking one does not
  complete the Activity, and completing the Activity does not check it — except in the
  groceries case, which is provenance, not a link.

**Tests.** Render test asserting two separate accessibility elements with the labels from
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2.
Playwright asserting each tap target navigates to the correct screen.

---

### P3-26 — Plan detail screen: full anatomy

**Approach.** One screen, one `GET /v1/activities/:id`, one DynamoDB `Query`. The ten
sections in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1, in fixed order,
with the visibility rules in §2.2.

The rule that shapes the screen: **a section with nothing in it collapses to a single "add"
affordance rather than disappearing**, so the plan's capabilities stay discoverable. The
exceptions are the hero image (hidden with no `primaryAttachmentId`), Expenses (hidden below
2 participants and 0 expenses — Phase 6) and Updates (hidden when private with no entries).

Sections that belong to later phases render their affordance in a disabled state with copy
naming what is coming: People and Updates-from-others in Phase 5, Expenses in Phase 6.

The when/where block is **one tap target** opening the reschedule sheet, with the address row
as a separate target opening the platform maps app. It is never inline-editable.

**Tests.** Render tests for each visibility rule. A network assertion that opening the screen
issues exactly one request.

---

### P3-28 — The `Add list` suggestion sheet

**Approach.** The LISTS section's `Add list` opens a sheet with the ranked kinds for this
plan's shape, plus all eight kinds below a divider:

| Plan shape | Suggested kinds, in order |
| --- | --- |
| `outing` or `event` spanning ≥ 2 days | Packing, General, Places, Shopping |
| `outing` or `event` on one day, with participants | General, Shopping |
| `meal` | Groceries |
| `watch` | Watchlist |
| `task` / `custom` | General |

Selecting a kind creates one `List` with `sourceActivityId` set and a title defaulting to
`<Kind> · <Plan title>`, editable in the sheet before confirming.

**Hard rule: no list is created without that confirmation.** Creating a trip plan does not
silently produce three lists.

**Edge cases.** `List.sourceActivityId` is the **only** link. Deleting the plan does not
delete its lists — it clears the back-link and the lists keep their items. Completing a plan
does not archive its lists. A list of things you own is not owned by the trip.

**Tests.** Integration: creating a multi-day outing writes zero lists; confirming `Packing`
writes exactly one with `sourceActivityId` set; deleting the plan leaves the list with its
items and `sourceActivityId` cleared.

---

### P3-33 — Follow-up suggestions after completion

**Approach.** Completion may present **exactly one** contextual follow-up, inline, in the
same toast slot as the confirmation. Always dismissible, never pre-selected, and it never
writes without the tap. From
[`../01-product/activities.md`](../01-product/activities.md) §5.3:

| Completed | Follow-up | Creates on tap |
| --- | --- | --- |
| `watch` (show with progress) | `Watched S2 E4. Update progress to S2 E5?` then, separately, `Schedule S2 E5?` | Progress update; then opens the schedule sheet, which creates nothing until confirmed. |
| `meal` with ingredients | `Add anything to Groceries?` | Opens the ingredient picker; writes only what the user selects. |
| ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigation only. Phase 6. |
| ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the sheet. No write until saved. Phase 6. |
| Recurring occurrence | **Nothing.** The next occurrence already exists. | — |

**Tests.** An integration test asserting that dismissing every follow-up produces zero
writes. A test that a recurring completion offers no follow-up at all.

---

### P3-34 — E2E: the three worked examples

**Approach.** The three end-to-end examples in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §9 are written as
executable flows, because each of them exercises a chain of rules that unit tests verify
individually and nothing else verifies together:

1. **Watchlist → Today** (§9.1), all eight steps, asserting one row not two at step 5, the
   correct write set at step 4, and **nothing created** at step 8.
2. **Meal → Groceries** (§9.2), all ten steps, asserting the three labelled items, the
   `Added` state on the meal, and that checking items leaves the meal untouched.
3. **Trip plan → Packing list** (§9.3), all eleven steps, asserting both lists survive the
   plan's completion, unarchived, with their items.

Playwright on web for all three; Maestro on iOS for the first.

**Tests.** These are the tests. They gate the phase.

## Acceptance criteria

1. Scheduling `Zahav` from `Restaurants to try` creates exactly one Activity and leaves
   exactly one list item, with `linkedActivityId` and `listItemId` pointing at each other —
   verified by counting table items before and after.
2. The item stays in place in its list with a state line and no colour change, no
   strike-through and no reorder; tapping the title opens item detail and tapping the state
   line opens the Activity.
3. Editing the Activity's title updates the item's title and vice versa; editing either's
   note leaves the other's unchanged.
4. Deleting the Activity leaves the list item with every other field intact and
   `linkedActivityId` cleared. Deleting the list item leaves the Activity with `listItemId`
   cleared. Neither cascade-deletes.
5. Completing a watch session at S2 E5 sets the watchlist item to S2 E5 and `watching`;
   un-completing restores S2 E4 exactly, including a value the user edited in between.
6. The `Schedule S2 E6?` follow-up creates nothing when dismissed and opens a sheet — not an
   Activity — when tapped, verified by a table item count.
7. Creating a meal with four ingredients writes zero grocery items. Tapping
   `Add 3 selected to Groceries` writes exactly three, each with `sourceActivityId` and a
   `sourceLabel` of `Sunday dinner`.
8. Adding the same ingredient again while the existing row is unchecked extends its label to
   `Sunday dinner · Thursday lunch` and creates no second row; doing it while the row is
   checked creates a second row.
9. Rescheduling the source meal does not change any existing grocery item's label; deleting
   the meal leaves the items and their labels intact.
10. Reordering a 200-item list writes exactly one item, verified by a CloudWatch metric or a
    repository spy asserting a single `TransactWriteItems` with two entries.
11. Adding a 501st item to a list returns `400` with the message `List is full.`
12. `checked: true` on a `restaurants`, `places`, `meals` or `watchlist` item returns `400`;
    on `general` it succeeds.
13. `Clear checked (7)` deletes seven items and is undoable for 10 seconds; after the window
    the deletion is permanent.
14. A prep task created inside a plan appears on Today on its own date with the plan's title
    as its subtitle, and deleting the plan leaves it as an ordinary task with its schedule
    intact.
15. Creating a prep task on a prep task returns `400`.
16. Creating a multi-day outing writes zero lists; confirming `Packing` in the suggestion
    sheet writes exactly one; deleting the plan leaves the list and its items with
    `sourceActivityId` cleared.
17. A presigned upload URL rejects a different `Content-Type` than declared, rejects a body
    over the declared length, and is unusable after five minutes.
18. An uploaded image renders through `media.dev.ordinarydays.app`, and a direct `GET`
    against the S3 bucket URL returns `403`.
19. Setting an attachment as the cover sets `primaryAttachmentId` and the plan detail
    renders it as the hero.
20. The three worked examples in
    [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §9 pass as
    executable E2E flows, step for step.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Participants, the participant picker beyond a disabled control, RSVP, invitations, the public invite page | Phase 5 |
| Expenses, the plan's EXPENSES section beyond its hidden state | Phase 6 |
| The People layer, person views, balances | Phase 6 |
| Push notifications for prep-task completion or plan updates | Phase 4 |
| Capture from an image — the upload path is Phase 3, the *extraction* is Phase 7 | Phase 7 |
| Sub-lists, list templates, tags, list sharing | Not in v1 at all |
| Nutrition, macros, recipe steps, scaling, servings | Not in v1 at all |
| A media catalogue, ratings, metadata lookup, a discovery feed for watch | Not in v1 at all |
| Signed URLs for media (open question OQ-1) | Phase 6, if at all |
| A map picker, geocoding, location autocomplete | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The bridge duplicates instead of linking | `Zahav` appears twice and the two copies drift | Acceptance criterion 1 counts table items before and after. The canonical doc calls this the most commonly mis-implemented rule in the product; it gets its own test file (P3-10). |
| A cascade delete removes the other side | A user deletes a plan and loses their packing list, or deletes a watchlist entry and loses the session | Every row of the §6.3 table is a test. Both directions clear pointers and never delete. |
| Prep tasks are cascade-deleted with their parent by pattern-matching the `PART#`/`EXP#` cascade | Real to-dos vanish when a trip is cancelled | P3-13's explicit test, and a comment at the cascade site naming the exception. |
| Provenance is implemented as linkage | Checking off `Chicken` marks the meal as cooked, or deleting the meal deletes the groceries | §6.5 is a separate test group; `sourceActivityId` and `linkedActivityId` are deliberately different fields with different behaviour. |
| The provenance label is recomputed on read | Labels change after a meal is rescheduled and become lies after it is deleted | Computed once at creation and stored; acceptance criterion 9. |
| Ingredients are added to Groceries automatically | The user's grocery list fills with things they did not ask for | Acceptance criterion 7 asserts zero writes before the tap. This is the "suggest, never auto-create" rule and it has a test. |
| Reordering renumbers the list | A 400-item list write on every drag | `lexoRankBetween` plus acceptance criterion 10's single-write assertion. |
| Un-complete cannot restore watchlist progress | Progress silently decrements to the wrong episode | Store `previousSeason`/`previousEpisode` at completion rather than decrementing; acceptance criterion 5 edits the value in between. |
| An attachment upload path that goes through Lambda | 6 MB payload failures and burnt duration | Presigned `PUT` only; the API never touches image bytes. |
| The media bucket is made public "to make the images load" | Every user's images are world-readable by URL | Block Public Access on all four settings with a CDK assertion test; acceptance criterion 18 asserts a direct S3 `GET` returns `403`. |
</content>
