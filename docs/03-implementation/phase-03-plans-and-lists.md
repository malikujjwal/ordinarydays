# Phase 3 — Plans and lists

## Goal

At the end of this phase the third noun exists. Lists are independent collections: a user can
keep a list of bars, gift ideas or things to pack, and a list that never produces an Activity
is a finished thing, not an unfinished one. There are **three behaviours** — `collection`,
`watch`, `meals` — and an unbounded catalogue of templates on top of them, so adding "Bars to
try" is a config entry rather than a schema change. The selected template's behaviour,
capabilities, slot, icon and empty-state guidance are copied onto the row at creation.

The bridge to Activities then exists as an explicit option rather than an inferred
destination. `Plan this item` asks for a Plan kind and an audience, creates one Activity, and
writes caller-scoped link pointers without duplicating the ListItem. Different people may
independently plan the same shared item; nobody sees another person's private state. A plan
detail screen shows the full anatomy — when and where, prep tasks, related lists, notes,
attachments — and a plan can produce lists rather than only consuming them. A meal's
ingredients become grocery items with honest provenance labels, in a destination the user
chose, on confirmation and never automatically. A watch item carries season and episode, gains
`watching` status on its first completed session, and offers the next episode as a suggestion
the user must accept. Images upload through presigned URLs to a local S3-compatible object
store, over the same `@aws-sdk/client-s3` code path that will address the deployed media
bucket unchanged.

The Plans tab also becomes itself. One `GET /v1/plans` returns three stages — Needs a date,
Upcoming, Past — so a plan that exists without a date has somewhere to live that is not
Today's Anytime list and is not a backlog with a counter on it.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phases 1, 2 and blocking Phase 2.5 complete and passing | The Activity CRUD, agenda, completion, explicit occurrence targeting and recurrence reconciliation are all load-bearing here. Phase 3 implementation does not overlap the stabilization gate. |
| 1a | Phase 2.6 P2-63 complete and its real-device/account-migration gate passing | Native Lists/ListItems start on typed SQLite repositories and the same transactional outbox; they do not extend the retired AsyncStorage/TanStack domain materializer. Web binds the shared use cases to its existing online-first TanStack adapter. |
| 2 | [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) read in full | It is the specification for this phase, including the three worked examples in §9 which are the integration fixtures. |
| 3 | [`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem) and [`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists) read in full | The list model is behaviour plus capabilities plus templates, not a closed enum of list kinds. ADR-031 to ADR-035 in [`../02-architecture/decisions.md`](../02-architecture/decisions.md) record why, and are the reference when a task looks like it wants a new kind. |
| 3a | [`../02-architecture/data-model.md#33-list-partition`](../02-architecture/data-model.md#33-list-partition) read | The canonical list is at `LIST#<l>`, not in the owner's partition, and the `USER#` row is a near-pure pointer. Building it the other way round works for one user and has to be migrated for two (ADR-041, ADR-042). |
| 3b | Phase 2's `deriveGsi1Bucket` (P2-05) and `lastActivityAt` (P2-06) merged | `GET /v1/plans` is a read over the `#P` bucket. Without both, the Needs-a-date stage has nothing to query and nothing to sort by. |
| 4 | MinIO running in the local `docker compose` stack, with the `od-media-local` bucket created | Nothing is deployed to AWS before Phase 4, so every attachment task is built and tested against this **local S3-compatible store**. MinIO speaks the S3 API including SigV4 presigned `PUT`, so the endpoint and credentials differ and the application code does not — see [`../02-architecture/infrastructure.md#61-dynamodb-local-and-minio`](../02-architecture/infrastructure.md#61-dynamodb-local-and-minio). |
| 5 | The media bucket and media CloudFront distribution **defined**, not deployed | Written in Phase 0 (`DataStack` P0-12, `WebStack` P0-16). This phase writes their configuration; the deployed bucket is first exercised in Phase 4 and the media domain in Phase 5 — see [`roadmap.md`](roadmap.md) §3.1. |

## Deliverables

- [ ] `List` and `ListItem` entities and repository, with the canonical list at `LIST#<l>` /
      `META`, owner-and-active-member pointers at `USER#<u>` / `LIST#<l>`, the three behaviours, the
      capability flags, and `ListItemDetails` for `watch` and `meals`.
- [ ] The Lists tab as **one `Query` plus one `BatchGetItem`**. A list screen reads exact
      `META`, then exactly the first 50 `ITEM#` rows and bounded caller-link hydration; later
      item pages use the opaque cursor and no path queries the whole `LIST#` partition.
- [ ] `compareListItems` — the `(rank, itemId)` total order, exported once and used by the
      repository, the projection and the client.
- [ ] `GET /v1/plans` and the three-stage Plans screen, with the needs-a-date row, its RSVP
      summary and its most-recently-discussed ordering, and no badge or count anywhere.
- [ ] The template/style catalogue in `packages/shared/src/lists/templates.ts` and
      `GET /v1/list-templates`, with a stable explicit-selection order and no title matcher.
- [ ] Template resolution at creation: behaviour, capabilities, slot, icon and empty-state
      copy **copied** onto the list, never re-resolved on read.
- [ ] `lexoRankBetween` in `packages/shared`, so reordering changes one logical item and its
      identity locator rather than renumbering the list.
- [ ] Lists CRUD, item CRUD, `bulk`, `clear-checked` (no dialog, 10-second bulk undo),
      `uncheck-all` (10-second bulk undo), archive, and the tombstone-aware restore path used
      by item-delete undo.
- [ ] `PATCH /v1/lists/:id` capability changes and replay-protected
      `POST /v1/lists/:id/behaviour` transitions, with additive changes applying immediately
      and destructive ones gated by echoing the complete server-authored preview.
- [ ] `User.defaultLists` and the four-step slot resolution shared by every "add to X" flow.
- [ ] `POST /v1/lists/:id/items/:itemId/schedule` — the optional bridge to Activities — with
      a required client-minted `activityId`, required `creationTarget` and `audience`, no type
      or audience inference, a one-time title copy, and per-viewer `LNK#` pointers rather than
      one global item state.
- [ ] Link titles independent after creation; list edits cannot rename a private Plan.
- [ ] Watch progress: `mediaKind`, `watchStatus`, season, episode; grouped item rendering;
      an explicit, undoable progress update that may apply `want` → `watching`; and the
      next-episode suggestion that creates nothing.
- [ ] Meal ingredients → a chosen destination list: the `Add ingredients to:` sheet, the
      stored provenance label, the duplicate-handling rule, and `addedToListId` marking on
      the source rows.
- [ ] The template-first list creation sheet with a visible editable title and exact
      `Create list` action, plus the capability-driven item renderer — one renderer for every
      list, reading flags off the row.
- [ ] Global `List item` creation requires an explicit destination list; list detail uses
      `+ Add an item` and ends with `Add to {list name}`. Neither route guesses a destination.
- [ ] Prep tasks as child activities inside a plan, with `childCount`, the two-level nesting
      cap, and survival of the parent's deletion.
- [ ] Plan → list catalogue sheet with the same full explicit order as general `New list` and
      every Plan type; nothing selected or created without confirmation. A typed Watch
      destination is the documented three-style eligibility exception.
- [ ] The plan detail screen with all ten sections in fixed order and their visibility rules.
- [ ] The updates feed: `GET`/`POST /v1/activities/:id/updates` with server-written system
      entries.
- [ ] Attachments: presigned `PUT`, confirm-and-link, `primaryAttachmentId` as the hero
      image, the viewer, delete.
- [ ] Follow-up suggestions after completion, all dismissible, none of which write.
- [ ] The eleven catalogue icons P3-02 named but never drew, and a test that every
      `LIST_TEMPLATES` icon resolves to an exported component.
- [ ] `List.lastItemActivityAt`, bumped by every item writer and by neither `If-Match` nor a
      list-level edit, backing the Lists index's `Updated today`.
- [ ] Discriminated `GET /v1/plans` modes. Initial loading launches all four streams;
      Upcoming and Past continuations launch only their own streams, and bounded Past windows
      expose exact completion metadata before the calendar may claim an empty date.
- [ ] The Plans stages behind a `SegmentedControl` with no counts on it, and the calendar
      navigator beneath it on Upcoming and Past: one day cell, collapsed as a rolling seven
      days and expanded as a month, eligibility from the stage rather than the displayed
      month, and a pure derive over the same projected agenda the list renders.
- [ ] Plan detail as settings-always plus sections-once-filled, with 1–3 expanded, 4-or-more
      peeking at three, and the completion action still at the top.
- [ ] Per-type row markers in `RowLeading`, which changes Today as well as Plans.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P3-01 | `List` / `ListItem` types, behaviours and capabilities | shared | P1-06 | no | M |
| P3-02 | The list template catalogue | shared | P3-01 | no | M |
| P3-03 | `lexoRankBetween` | shared | — | yes | M |
| P3-04 | `ListRepository` | api | P3-01, P1-05 | no | L |
| P3-05 | Lists CRUD and template resolution at creation | api | P3-04, P3-02 | no | M |
| P3-06 | `GET /v1/list-templates` | api | P3-02 | yes | S |
| P3-07 | Explicit template/style selection contract | shared | P3-02 | yes | S |
| P3-08 | List item CRUD and `bulk` | api | P3-04, P3-03 | no | L |
| P3-09 | Capability changes on `PATCH`; behaviour changes on replay-protected `POST` | api | P3-05, P3-08 | no | L |
| P3-10 | `clear-checked`, `uncheck-all`, tombstone-aware Undo, archive | api | P3-08, P3-09, P3-13 | no | L |
| P3-11 | ~~Move an item between lists~~ — cut 2026-08-07, not in v1 | api | — | — | — |
| P3-12 | `User.defaultLists` and slot resolution | shared/api | P3-05 | no | M |
| P3-13 | The bridge to Activities: explicitly plan a list item | api | P3-08, P1-10 | no | L |
| P3-14 | One-time title seed and independent edits | api | P3-13 | no | M |
| P3-15 | Link lifecycle on complete / skip / unschedule / delete | api | P3-13, P2-13 | no | L |
| P3-16 | Watch progress and status transitions | api | P3-15 | no | M |
| P3-17 | Meal ingredients → a destination list, and the provenance label | shared/api | P3-08, P3-12 | no | L |
| P3-18 | Prep tasks: `childCount`, nesting cap, orphaning | api | P1-10 | yes | M |
| P3-19 | Updates feed endpoints | api | P1-09 | yes | M |
| P3-20 | `GET /v1/plans` — the three-stage Plans endpoint | api | P2-05, P2-06, P2-11 | no | L |
| P3-21 | `POST /v1/attachments/upload-url` | api | P0-21, P1-03 | yes | M |
| P3-22 | Confirm, link, delete an attachment; `primaryAttachmentId` | api | P3-21 | no | M |
| P3-23 | Media distribution cache tuning and lifecycle verification | infra | P3-21 | yes | S |
| P3-24 | Shared API client: lists, templates, items, attachments, updates | shared | P3-05, P3-06, P3-10, P3-13, P3-21 | no | M |
| P3-25 | Lists index screen | mobile | P3-24, P1-22 | no | M |
| P3-26 | The template-first list creation sheet | mobile | P3-25, P3-07 | no | M |
| P3-27 | List detail screen and the inline add row | mobile | P3-25 | no | L |
| P3-28 | The capability-driven item renderer | mobile | P3-27 | no | M |
| P3-29 | List item sheet, and the shared item PATCH pipeline | mobile | P3-28, P3-10, P3-08 | no | M |
| P3-30 | Drag to reorder | mobile | P3-27, P3-03 | no | M |
| P3-31 | Watch behaviour: grouped items and progress UI | mobile | P3-28, P3-16 | no | M |
| P3-32 | Inline List title edit; settings for capabilities, slot and behaviour | mobile | P3-27, P3-09 | no | M |
| P3-33 | The `Plan this item` kind-and-audience sheet | mobile | P3-29, P3-13 | no | L |
| P3-34 | Caller-scoped Plan state line on a list item | mobile | P3-33 | no | M |
| P3-35 | The Plans tab: three stages | mobile | P3-20, P3-24, P2-32 | no | L |
| P3-36 | Plan detail screen: full anatomy | mobile | P1-26, P3-24 | no | L |
| P3-37 | Prep section inside a plan | mobile | P3-36, P3-18 | no | M |
| P3-38 | Lists section and the `Add list` catalogue sheet | mobile | P3-36, P3-05, P3-26, P3-49 | no | M |
| P3-39 | Updates section | mobile | P3-36, P3-19 | yes | M |
| P3-40 | Image picker, upload, and progress | mobile | P3-21, P3-22 | no | L |
| P3-41 | Attachment viewer and hero image | mobile | P3-40 | no | M |
| P3-42 | Explicit Plan-to-list side effects: Meal ingredients and Watch items | mobile | P3-13, P3-17, P3-12, P3-26, P1-25 | no | L |
| P3-43 | Follow-up suggestions after completion | mobile | P3-16, P3-17, P3-18 | no | M |
| P3-44 | E2E: the worked examples, a list that links to nothing, and a plan with no date | ci | P3-34, P3-35, P3-42, P3-38 | no | L |
| P3-45 | The eleven missing catalogue icons | ui | P3-02 | yes | M |
| P3-46 | `List.lastItemActivityAt` and every writer that must bump it | shared/api | P3-04, P3-05, P3-08, P3-10 | no | M |
| P3-47 | The Upcoming/Past calendar navigator | mobile | P3-35, P3-20, P3-24 | no | L |
| P3-48 | Per-type row markers in `RowLeading` | mobile | P2-44 | yes | S |
| P3-49 | Clear `List.sourceActivityId` when its source Plan is deleted | api | P3-05, P1-14 | yes | S |
| P3-50 | A `Sheet`-owned present/dismiss animation, so web has one at all | ui | P3-26 | yes | S |

> **Added 2026-08-27 (founder).** **P3-50** owns the animation `Sheet` has never had. P3-26
> removed react-native-web's, because RNW ties the dialog role and the focus trap to an
> animation-end event that never arrives; native still has RNW's fade, at the wrong duration
> and outside `useMotion()`. Nothing depends on it, so it is unblocked and unblocking.

> **Added 2026-08-26 (founder).** **P3-49** carries the backend half of a cleanup that
> §P3-38's edge cases described but no shipped task owned. P3-05 already writes
> `sourceActivityId` and its `SOURCE_LIST#` reverse projection, so the dangling link is
> reachable today; P3-38 is a `mobile` task and cannot be what closes it. Raised in the P3-18
> review, and **it gates P3-38**, which keeps the section's UI and its own catalogue tests.

> **Added 2026-08-25 (founder).** P3-45 to P3-48 came out of the design pass on the Plans and
> Lists screens. Two of them are consequences of tasks that have **already shipped**, so they
> are forward work rather than amendments: P3-45 closes a gap P3-02 left, and P3-46 adds a
> field whose four writers (P3-04, P3-05, P3-08, P3-10) are all on `main`. **P3-45 and P3-46
> both gate P3-25** and want doing before the mobile work starts.

P3-23 is mechanical; follow the canonical sections and skip the discussion.

Three creation labels are cross-task contracts:

- Global `+` → `List item` opens a required list picker before any item fields. No default,
  recent list, title text, template, behaviour or model may choose the destination.
- List detail uses the exact contextual action `+ Add an item`; the current list fixes the
  destination and the final action is `Add to {list name}`.
- Plan detail uses the exact contextual action `+ Add prep task`; the parent fixes the
  relationship, the object is explicitly a Task, and the final action is `Save task`.

All three are tested with the same title through another route, proving that context—not
words—sets object kind and destination.

---

### P3-01 — `List` / `ListItem` types, behaviours and capabilities

**Files.** `packages/shared/src/types/list.ts`, `packages/shared/src/schemas/list.ts`.

**Approach.** The shapes in
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem),
transcribed exactly and once. `ListBehaviour` is a closed union of **three** values —
`collection`, `watch`, `meals`. There is no `ListKind`, and no enum of groceries, shopping,
packing, restaurants, places or general anywhere in the codebase. Those are template keys,
which are strings the server never branches on.

What varies between one collection and another is `ListCapabilities` on the row:

| Flag | Meaning | Applies to |
| --- | --- | --- |
| `checkable` | Items can be ticked off | `collection` only; `watch` uses `watchStatus` |
| `supportsLocation` | The item sheet offers a location field | `collection` only |

`ListItemDetails` is a discriminated union on `behaviour`, present only for `watch` and
`meals`, and absent on every `collection` item.

The strict create inputs are part of the same shared schema surface. List creation accepts
optional `listId: ulidId('lst')`; single-item creation and each bulk member accept optional
`itemId: ulidId('itm')`. They accept no owner, timestamps, rank or other authority fields.

> **Decision:** the three behaviours are the complete set for v1. Before adding a fourth,
> apply the test in ADR-031: the application must render items differently, carry a typed
> field no other behaviour has, or take part in a flow that exists nowhere else. A new label,
> a new icon or a different default for an existing flag is a template (P3-02), not a
> behaviour, and needs no code.

**Edge cases.**

- Validate `details.behaviour === list.behaviour` at every public read and write boundary, the
  same rule `Activity.details.kind` follows. P3-09's private migration worker is the sole
  storage-level exception: target-shaped rows may exist only while META carries
  `behaviourMigrationId`, and that marker gates every item read and mutation until the final
  transaction changes `List.behaviour` and clears the marker. No mixed shape is serialised.
- `capabilities.checkable` on a `watch` or `meals` list is meaningless, not an error. The
  server stores what the template gave it and the renderer ignores it, so a later behaviour
  change does not lose the user's setting.
- `slot` is `groceries | watch | meals | null` and is a *destination* marker, unrelated to
  behaviour. A `collection` may hold `slot: 'groceries'`; a `watch` list may hold `null`.

**Tests.** Type-level: a `Record<ListBehaviour, …>` map with a missing key fails to compile.
Schema: an item carrying `details.behaviour: 'watch'` on a `collection` list is rejected; a
`collection` item with no `details` is accepted; an unknown `behaviour` string is rejected.
The schema used to **read an already stored List** accepts an unknown `templateKey`, because
the catalogue is data and old clients must not break when it grows. The create service still
rejects a key absent from its current catalogue (P3-05); it never substitutes another style.

---

### P3-02 — The list template catalogue

**Files.** `packages/shared/src/lists/templates.ts`,
`packages/shared/src/lists/__tests__/templates.test.ts`.

**What to build.** A plain exported array of `ListTemplate` records — no classes, no
registry, no I/O. This is the file someone edits to add "Books to read", and editing it must
be the entire change.

The exact record shape is illustrated by the first canonical entry:

```ts
{
  templateKey: 'simple-list',
  chooserLabel: 'Blank',
  summary: 'A plain list',
  defaultTitle: 'Simple list',
  icon: 'list',
  behaviour: 'collection',
  capabilities: { checkable: false, supportsLocation: false },
  slot: null,
  emptyStateCopy: 'Add the first item.',
}
```

Implement all seventeen records exactly as specified in the canonical table in
[`../01-product/plans-and-lists.md#53-the-template-catalogue`](../01-product/plans-and-lists.md#53-the-template-catalogue).
That table, not prose invented during implementation, owns every chooser label, summary,
default title, icon, capability boolean, slot and empty-state guidance line.

**The v1 catalogue ships in this fixed order:** `simple-list`, `checklist`, `groceries`,
`shopping`, `packing`, `restaurants-to-try`, `bars-to-try`, `coffee-shops`,
`places-to-visit`, `date-ideas`, `favourite-restaurants`, `books-to-read`, `gift-ideas`,
`watchlist`, `movies-to-watch`, `tv-shows`, `meals-to-try`. The first thirteen use
`behaviour: 'collection'`, the next three use `watch`, and the last uses `meals`. One template
seeds `groceries`, three deliberately seed `watch`, and one seeds `meals`; multiple visible
styles may share the same semantic destination slot.
Per-occasion templates such as `packing` seed `null`, because a packing list for Lisbon is
not a standing destination.

`simple-list` is a catalogue choice, not a fallback. A missing `templateKey` is invalid, and
creation has exactly one code path after an explicit style selection.

**Edge cases.**

- The array is **data consumed at creation time only**. It may be imported by the API creation
  service, the templates route, and the mobile creation-choice projection in P3-07. Nothing
  may import it into a stored-List read path, renderer or repository. A list renders from its
  own `capabilities`, `icon` and `emptyStateCopy`, never from
  `LIST_TEMPLATES[list.templateKey]`. A lint or dependency-cruiser rule enforces that boundary.
- Adding a template is additive and needs no migration. **Changing** one changes nothing
  about existing lists, by design (ADR-032).
- **Removing** a template does not alter existing lists: their copied icon and empty-state
  copy remain. It removes the style from future creation, which is a product decision. If a
  style needs to remain visible but unavailable, that would require a `deprecated` flag, which is **not** in
  the canonical `ListTemplate` shape in
  [`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem);
  if it turns out to be needed, amend that document in the same pull request rather than
  adding the field here.

**Tests.** A snapshot asserts every field of all seventeen records matches the canonical
table exactly; `templateKey` values are unique and the shipped catalogue matches its fixed
order. Non-`collection` templates are the only ones with a non-`null`
`details`-bearing behaviour. Every non-null slot is compatible with its behaviour, and the
three Watch styles are all allowed to seed `watch`. The test that
matters most: **all copied fields are values, not live references** — create a list from
`groceries`, mutate the in-memory template object's behaviour, capabilities, slot, icon and
empty-state copy, re-read the list, and assert the stored behaviour, capabilities, slot, icon and
`emptyStateCopy` are unchanged. That test fails the day someone turns the copy into a lookup.

---

### P3-03 — `lexoRankBetween`

**Files.** `packages/shared/src/rank/lexoRank.ts`.

**Approach.** A fractional-index string generator:
`lexoRankBetween(prev?: string | null, next?: string | null)` returns a string strictly
between `prev` and `next` in lexicographic order; a missing bound — `null`, `undefined` or an
omitted argument — means "no neighbour on that side", so `lexoRankBetween()`,
`lexoRankBetween(last)` and `lexoRankBetween(null, first)` are all valid calls. Base-62 over `0-9A-Za-z`, appending a character when the gap
between neighbours is exhausted rather than renumbering. Two bounded neighbours are bisected;
an open end steps by one, so a list built by sequential appends or prepends never reaches
repair inside the 500-item cap. The algorithm, the two error classes and the growth
guarantees are canonical in [`../04-conventions/coding-standards.md`](../04-conventions/coding-standards.md) §9.

The whole point is that reordering changes **one logical item**, never renumbers the list.
P3-04's stable-id locator moves in the same transaction; that bookkeeping row is not a
second ListItem or a fan-out write. Rank allocation is serialised by the List META
`rankVersion`: the server reads the neighbours and version, then conditionally increments
the version in the same transaction as the item mutation. A version conflict re-reads the
neighbours and retries; it never publishes a rank computed from a stale gap.

**The `(rank, itemId)` tie-break.** New writes do not intentionally create duplicate ranks:
P3-04's `rankVersion` condition serialises callers that target the same gap. The read order is
still total and defensive: sort by `(rank, itemId)`. `itemId` is a ULID, so a duplicate left
by Undo restoration, an old client, a seed or an interrupted repair renders identically on
every device. It is not business chronology: an offline client's ULID carries its device
clock. Export the comparator from this module —
`compareListItems(a, b)` — so there is one implementation that the repository, the projection
and the client all use. A comparator on `rank` alone leaves the order to the engine's sort
stability and is the bug this rule exists to prevent.

**Edge cases.**

- `lexoRankBetween(a, a)` is a programming error, not a rank — throw. If either neighbour
  belongs to an equal-rank run, perform the bounded list-rank repair, re-read neighbours and
  retry instead of calling the generator with equal bounds. The existing client projection
  remains visible while repair runs; no server read may expose a mixed rank generation.
- `repairListRanks` first conditionally marks META with a repair id/version, snapshots the
  at-most-500 items in `(rank, itemId)` order, and rewrites ranked rows plus locators in
  resumable receipt-linked chunks to evenly spaced ranks. Other rank mutations retry while
  the marker exists. Item-page cursors carry the `rankVersion` under which they were issued.
  Every list detail or item-page read strongly reads META before the item Query: while the
  marker exists it attempts the bounded repair drain and, if work remains, returns `503 internal`
  with `Retry-After: 1` without querying or serialising any `ITEM#` row. The item Query itself uses
  `ConsistentRead: true`. Before serialising, the service strongly reads META again and
  requires the same `rankVersion` with both `rankRepairId` and `behaviourMigrationId` absent.
  A changed fence or either marker returns the same retryable `503`, so a repair or reorder
  that begins
  between the first read and the Query cannot label a mixed/new page with an old cursor. The
  client retains its last committed projection and retries. The final conditional META write
  clears the marker and advances `rankVersion`; a crash resumes from the stored cursor. A
  cursor carrying the old version receives the same `503` and the client restarts at page
  one. Thus neither mixed rows nor a cursor spanning rewritten sort keys can omit or duplicate
  an item. This is exceptional repair, not the normal drag path's permission to renumber a
  list.
- Repeated insertion into one bounded gap grows the string by about a character per six
  inserts. Cap the length at 64 characters (`MAX_LEXO_RANK_LENGTH`) and, on the typed
  `LexoRankOverflowError`, invoke the same resumable `repairListRanks` path. Overflow is
  raised only when no rank of at most 64 characters exists between the bounds — a 64-character
  neighbour with prefix room still yields a short rank. Pathological
  repeated insertion into a single bounded gap reaches the cap after roughly 315 inserts,
  which is inside the 500-item cap: repair is exceptional, not mathematically unreachable.
  Sequential head or tail creation steps by one and stays far under the cap (nine characters
  at 500 items), so ordinary list building never triggers repair.
- Ranks are opaque to the client. The client sends `afterItemId`; the server computes the
  rank. Never let the client send a rank.

**Tests.** Property test: 10,000 random insertions at random positions leave the list in the
intended order at every step. Unit: at least 500 sequential appends and 500 sequential
prepends stay under the cap; insert between two adjacent ranks 200 times in the same gap and
assert order holds and length stays under the cap; a pathological bounded gap throws the
typed overflow; an empty string, a non-base62 character and a supplied rank ending in `0` are
rejected as bounds.

Plus the concurrency test, which is the one that matters for Phase 6 and is written here:
two callers reading the same neighbours race, exactly one `rankVersion` condition succeeds,
and the loser re-reads and obtains a different rank. Also, given two restored or legacy items with an
**identical** rank and different
`itemId`s, `compareListItems` returns the same order for both possible input orderings, and
sorting the pair produces the same array whether it started shuffled one way or the other.
Run the same assertion over 1,000 randomly shuffled arrays containing three groups of
equal-ranked items.
An interrupted two-chunk repair never returns an item page while META carries the repair
marker. Force a repair and an ordinary reorder separately between a page's pre-read and Query,
and between its Query and post-read; every race returns the retryable `503` rather than a
mis-versioned page. After completion, a pre-repair cursor receives `503` and a page-one restart
returns every item exactly once in repaired order.

---

### P3-04 — `ListRepository`

**Files.** `services/api/src/repositories/listRepository.ts`.

**Approach.** Access patterns 7, 7b, 8 and 8b from
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns),
against the partition layout in
[`../02-architecture/data-model.md#33-list-partition`](../02-architecture/data-model.md#33-list-partition).

**The canonical list is `LIST#<listId>` / `META`.** The `USER#<u>` / `LIST#<listId>` row is an
**index entry**, one for the owner and each active non-owner, exactly as `IDX#` works for
activities. An invited person gets no pointer until verified signup. This is the
inversion of the obvious layout and it is the whole reason a shared list works, so get it the
right way round before writing a line:

| Item | Holds | Written when |
| --- | --- | --- |
| `LIST#<l>` / `META` | The whole `List`: title, behaviour, capabilities, slot, counts, `rankVersion`, storage-only `itemVersion`, optional repair/migration gates, `archived`, `updatedAt` | Creation, every list-level edit, every public item mutation, and a gated worker's final commit — **one write, whoever made it** |
| `USER#<u>` / `LIST#<l>` | `ListIndex`: `role` and `addedAt`, and nothing else | Creation for the owner; membership changes in Phase 6 |
| `LIST#<l>` / `ITEM#<rank>#<itemId>` | The item plus storage-only `itemRevision` | Item writes |
| `LIST#<l>` / `ITEMID#<itemId>` | Stable identity locator containing the current `rank` and matching `itemRevision` | Every item mutation; never serialised |
| `LIST#<l>` / `ITEM_TOMBSTONE#<itemId>` | Replay guard plus the exact deletion snapshot needed by an authorised Undo | Item delete and `clear-checked`; never serialised |
| `LIST#<l>` / `UNDO#<operationId>` | Operation kind, affected item ids or settings inverse, token hash, UI offer deadline, replay-retention TTL and consumed state | Single delete, `clear-checked`, `uncheck-all`, and additive list-settings changes; never serialised |
| `LIST#<l>` / `RANK_REPAIR#<operationId>` | Stable `(rank,itemId)` snapshot progress and cursor | Exceptional equal-rank/length repair; never serialised |
| `LIST#<l>` / `BEHAVIOUR_MIGRATION#<operationId>` | From/to behaviours, stable item snapshot, progress cursor and Undo inverse | Chunked behaviour change; never serialised |
| `LIST#<l>` / `MEMBER#<personId>` | A non-owner `ListMember`; the owner never has one | Phase 6 |

> **Decision:** the index entry carries no title, no icon and no counts. This is
> deliberately **not** how `ActivityIndex` works, and the asymmetry is justified in
> [`../02-architecture/data-model.md#33-list-partition`](../02-architecture/data-model.md#33-list-partition):
> an activity feed is time-ranged and sorted, so its index must carry sortable denormalised
> data; a user's lists are a small unordered set, so a batch get is cheap. In exchange,
> renaming a shared list is one write rather than one per active user, and a grocery list two
> people are ticking through generates no fan-out write per tick. A denormalised `title` on
> the pointer would reintroduce both.

Two primary list read shapes:

- **The Lists tab** is access pattern 7: a paged `Query` on `pk = USER#<u>`, `sk begins_with
  LIST#` for 50 pointers, then **one `BatchGetItem`** for that page's `LIST#<l>` / `META`
  rows. Not a `GetItem` per list. The 100-list cap applies to Lists the user owns; incoming
  memberships may exceed it, so the cursor is not optional.
- **A list screen** is access pattern 8b: a strongly consistent exact `GetItem` for `META`,
  followed by a strongly consistent `Query` of `ITEM#` with `Limit: 50`. For those item ids
  only, one bounded `BatchGetItem`
  fetches the caller's `LNK#` rows and one bounded Activity batch hydrates readable links.
  A second strong META read after the item Query must match the first `rankVersion` and find
  neither repair nor behaviour-migration marker before any row is serialised. The response
  carries the item-page cursor bound to that version. A marker, changed post-read fence or
  version-mismatched cursor returns `503 internal` with `Retry-After: 1` so the client can
  restart at page one rather than cross changed sort keys. Later pages use the same projection through
  `GET /v1/lists/:id/items?cursor=`. Members are a separate paged endpoint; detail uses
  `META.memberCount`, and the owner comes from `META.ownerId`, not a `MEMBER#` row.

`itemCount`, `uncheckedCount` and `memberCount` are denormalised on the `META` row and
maintained on write. `memberCount` is the owner plus physical non-owner `MEMBER#` rows: it is
`1` for a private list in this phase while the partition has zero `MEMBER#` rows.

**Sorting.** Items sort by **`(rank, itemId)`**, not by `rank` alone. The sort key already
orders them that way — `ITEM#<lexoRank>#<itemId>` — so the tie-break comes free from
DynamoDB, but any in-memory re-sort in a service, a projection or the client must use the
same pair. A comparator that sorts on `rank` alone is stable in one JavaScript engine and
not guaranteed to be in another, which produces two devices showing two orders for identical
data. See P3-03.

**Edge cases.**

- An item's sort key contains its rank, so a reorder is a delete-and-put, not an update. The
  ranked row and `ITEMID#` locator carry the same storage-only `itemRevision`. Delete the old
  row only if that revision still matches, put the freshly read row at the new key with the
  next revision, conditionally move the locator from the same old rank/revision, and
  conditionally increment `META.rankVersion` in one transaction. A field PATCH likewise
  updates only supplied fields and advances both copies of `itemRevision` conditionally. Every
  public item mutation also atomically increments storage-only `META.itemVersion` once; a gated
  repair/migration worker increments it when its final transaction exposes the rewritten rows.
  Its absence on a legacy META row means zero. Whole-list decisions fence on both generations,
  while page cursors use only `rankVersion` so an unrelated checkbox tap does not restart
  pagination. The race therefore makes one operation retry against the current row instead of allowing a
  stale reorder image to overwrite a title, note, checked state or typed detail. Item create
  uses the same META version condition. A condition conflict re-reads and retries. An Undo-restored or
  legacy equal-rank run
  triggers an explicit bounded repair before the requested move; normal drag never rewrites
  unrelated ListItems.
- Every list-scoped repository method takes the caller's `userId`, preserving the
  tenant-scoped call shape, and requires the repository-issued, opaque result of the exact
  caller-pointer read before touching the `LIST#` partition. The service calls the single
  role-aware `assertListAccess(userId, listId, level)` helper, which obtains and returns that
  grant from one exact `USER#<u>` / `LIST#<l>` read; a missing pointer is `not_found`, while
  the pointer's role is the service's member-versus-owner decision. This follows
  `security-privacy.md` §1 row 4a: repositories enforce possession of the storage grant so
  their public methods cannot bypass the pointer, while role policy is decided only once in
  the service.
- Deleting a list deletes the `META` row and every item, locator, pointer, Undo, rank-repair
  and behaviour-migration row, then leaves
  `LIST#<listId>` / `TOMBSTONE` for the Phase 2.6 automatic-replay window. Deleting an item
  removes its locator and leaves `ITEM_TOMBSTONE#<itemId>` in the List partition for the same
  window. The list tombstone is also the cascade's deletion gate: item reads check it in both
  halves of their strong fence, and every list-partition mutation condition-checks its absence,
  so a concurrent write cannot escape the cascade snapshot. A normal create always
  condition-checks the item tombstone. Only P3-10's restore service
  may reclaim the same id, and only when its opaque token resolves to the matching retained,
  unused `UNDO#` operation; it removes the tombstone as it restores the item and locator. The
  retained item snapshot also includes the bounded owner/active-member `LNK#` rows and matching
  Activity `listId` / `listItemId` back-pointers. Delete clears those relationships in the item
  transaction, and restore recreates only relationships whose viewer still has list access and
  whose Activity still exists and has not been repointed. In this phase there is exactly one
  list index pointer.

**Tests.** Integration on DynamoDB Local: create a list, add ten items, reorder the last to
the front, assert the paged item query returns them in the new order and `itemCount` is still 10; a
reorder interrupted between delete, put and locator update is impossible (assert the
transaction is used); the same transaction conditionally increments `rankVersion`; two
concurrent inserts into one gap converge with distinct ranks after one retry; an exact item
read follows the locator after that reorder;
renaming a list writes **exactly one item**, asserted by a repository spy; the Lists tab
issues exactly one `Query` and one `BatchGetItem` for 40 lists, asserted by a spy; a
`LIST#<l>` read by a user with no pointer returns `not_found`, not the list. A normal create
cannot reuse a tombstoned item id, while a matching retained Undo can restore that exact id;
a retention-expired, mismatched or already-used token cannot. Item delete snapshots and clears
current viewer links and matching Activity provenance; restore omits a relationship when its
Activity was independently deleted.

---

### P3-05 — Lists CRUD and template resolution at creation

**Files.** `services/api/src/routes/lists.ts`,
`services/api/src/services/listCreationService.ts`.

**Approach.** `POST /v1/lists` takes the strict body
`{ listId?, title, templateKey, sourceActivityId? }` per
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).
Resolution order, in one function with no branches per template:

1. Require a non-empty visible `title` and look up the required `templateKey`. Missing and
   unknown keys are `validation_failed`; the server never substitutes `simple-list`.
2. **Copy** the template's `behaviour`, `capabilities`, `slot`, `icon`, and `emptyStateCopy`
   onto the new list.
3. If `sourceActivityId` is present, verify it names an owned Plan, force the copied `slot` to
   `null`, and write `ACT#<sourceActivityId>` / `SOURCE_LIST#<listId>` as an id-only reverse
   projection. A list made for one Plan must not silently become a standing destination.
4. Store `templateKey` as provenance and analytics only, and never read it to render. Create
   rejects client-supplied `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy`;
   users change only the supported settings later in List settings.

Step 2 is a copy. The stored list is the whole truth about what it can do, and no read path
consults the catalogue. That is the point of ADR-032 and it is one line away from being
implemented wrongly.

Creation writes the canonical `LIST#<l>` / `META` and the owner's `USER#<owner>` /
`LIST#<l>` pointer in one transaction. When `sourceActivityId` is present, that same
transaction also writes the id-only `ACT#<a>` / `SOURCE_LIST#<l>` projection. The projection
is not a second domain link and carries no title or counts: `List.sourceActivityId` remains
the source of truth, while Plan detail uses the pointer ids for one bounded `BatchGetItem` of
current List META rows. Renaming therefore remains one write.

`GET /v1/lists` is access pattern 7: one `Query` for the pointers, one `BatchGetItem` for the
`META` rows (P3-04). `DELETE` removes the `META` row, its `SOURCE_LIST#` projection when
present, every item and **every** pointer in chunked transactions, deletes every `LNK#` row,
and clears `listItemId` / `listId` on Activities named by those links — it never deletes an
Activity. In this phase there is one member pointer, but potentially many item-link rows; the delete is
written to iterate the pointer set rather than to assume a single owner, because Phase 6 adds
members and a delete that assumed one would strand the others' pointers.

`listId`, when supplied, is the permanent monotonic `lst_<ULID>` minted by generalising the
Phase 2.6 native-CSPRNG generator before an offline write enters the SQLite transaction; do
not add a weaker second random or clock-only generator. The server validates it but derives
owner and timestamps itself. Creation conditionally writes `META` and condition-checks the list
tombstone; omission retains server-minted behaviour for online callers. A collision returns
the same metadata-free error as Activity creation. Recovery reads `GET /v1/lists/:id`: `200`
adopts the canonical server row, while `404` parks the intent for explicit Retry or Discard.
Retry mints a fresh list and mutation id and, in one SQLite transaction, remaps the List, its
dependent local items, and every outbox payload, ordering key, dependency and compensation
that contains the old `listId`. It never automatically re-mints on collision.

**Edge cases.**

- A `templateKey` that is not in the catalogue is `validation_failed`, not a silent fallback.
  A client sending an unknown key is a client running ahead of the server, and guessing on
  its behalf produces a list that is not what the user picked.
- `title` is required in the request even when the person keeps the visible `defaultTitle`.
  The client pre-fills it only after the style tap; the server never invents a title.
- **Owned-list cap: 100 per user.** Beyond it, `POST` returns `validation_failed`. Incoming
  shared-list memberships do not consume this creation quota and are served by pagination.
- Deleting a list that is a `defaultLists` target clears that slot on the profile in the same
  transaction (P3-12). A dangling default resolves to nothing and silently breaks the
  ingredients flow.

**Tests.** Integration: creating from `groceries` copies behaviour, capabilities, slot, icon
and `emptyStateCopy` onto the row; mutating every template field afterwards leaves every
stored value unchanged; create bodies containing
client-supplied `behaviour`, `capabilities`, `slot`, `icon` or `emptyStateCopy` are rejected;
an unknown or missing `templateKey`
`400`s and writes nothing; an omitted or empty title also `400`s. A list created from a Plan
stores `sourceActivityId` and `slot: null` and writes its `SOURCE_LIST#` projection; deleting
that list removes the projection. Deleting a list also clears the
profile default that pointed at it and clears provenance on every currently linked Activity
without deleting one. Durable-create tests mirror P2-49: response loss beyond the 24-hour
idempotency receipt reconciles the same `listId`; create → delete → replay does not resurrect;
malformed and foreign-colliding ids fail without metadata; explicit Retry atomically remaps a
locally populated list and its whole dependent intent chain.

---

### P3-06 — `GET /v1/list-templates`

**Approach.** Returns `LIST_TEMPLATES` from P3-02 as-is. Static: no DynamoDB read,
`Cache-Control: public, max-age=86400`, and an `ETag` derived from a hash of the catalogue so
a shipped change invalidates it.

Mechanical, with one rule worth stating: the response is the catalogue as data, including
every field, so non-bundled clients can preview exactly what a template will produce. The
mobile sheet uses P3-07's bundled projection of this same module; it does not hard-code a
second map or require this route before first-launch offline creation.

**Tests.** The route is authenticated, returns every template, sets the cache headers, and
its payload validates against the shared `ListTemplate` schema.

---

### P3-07 — Explicit template/style selection contract

**Files.** `packages/shared/src/lists/templates.ts`,
`packages/shared/src/lists/templateChoices.ts`.

**What to build.** The stable catalogue order P3-26 renders before the user
names the list. It projects the same catalogue record to `{ templateKey, chooserLabel, icon, summary,
defaultTitle }`; it accepts no title or free text and returns no recommendation.

**Approach.** `LIST_TEMPLATES` already holds the fixed documented order, `chooserLabel`,
`summary`, and every other displayed value. `templateChoices.ts` is a field projection with
no per-template map, switch, second ordering array, or copy. The user must tap one visible
style. That tap is the only input that sets `templateKey`; title text typed on the next step
cannot change it. The `simple-list` record supplies `chooserLabel: 'Blank'` and the editable
next-step `defaultTitle: 'Simple list'`; the label and default title are intentionally
different fields.

There is no `/v1/lists/suggest-template` endpoint, matcher, match-term array, fuzzy search,
model call, ranking or fallback based on words. The bundled mobile projection and
`GET /v1/list-templates` both consume `LIST_TEMPLATES`, so P3-07 gives every client the same
explicit order and labels without a second catalogue or a required startup request.

**Tests.** Every catalogue entry appears exactly once, `Blank` and `Checklist` are first,
`Blank` projects `templateKey: 'simple-list'` and `defaultTitle: 'Simple list'`, and the
projection accepts no title parameter. Adding a fixture entry to `LIST_TEMPLATES` makes it
appear without changing any other file. A contract test asserts no route named
`/v1/lists/suggest-template` is registered and no `suggestTemplate` symbol exists.

---

### P3-08 — List item CRUD and `bulk`

**Approach.** `POST /v1/lists/:id/items` with `{ itemId?, title, note?, location?, details?,
afterItemId? }`. The server converts `afterItemId` to a rank via P3-03. `PATCH` accepts
`title`, `checked`, `note`, `location`, `details`, `afterItemId`. `POST .../items/bulk` takes
an array of the same ordinary create shape, including one optional `itemId` per item. It never
accepts source-meal or ingredient identity; P3-17 owns the distinct activity-scoped action
that is authorised to derive provenance. `GET /v1/lists/:id/items/:itemId` is the authoritative exact-id read
used by durable-create reconciliation; it follows P3-04's locator and returns `404` for a
missing or tombstoned item.

Native creates mint monotonic `itm_<ULID>` identities before atomically storing the visible
row and outbox intent. The server conditionally puts both the item and its `ITEMID#` locator
and condition-checks `ITEM_TOMBSTONE#`; omission preserves server-minted online behaviour.
Bulk callers persist every item id with the one operation, so replay after the receipt expires
can reconcile each exact identity without duplicating a partially completed chunk. Collision
recovery matches P2-49: exact `GET` success adopts server truth; `404` parks; an explicit Retry
atomically remaps the local item and every dependent outbox reference to a fresh item and
mutation id. There is no automatic re-mint.

That condition is absolute for ordinary single and bulk creates. Undo does not call either
create route: P3-10's restore service validates an opaque retained, unused operation token, requires
each tombstone to name that operation, and conditionally recreates the same item id, ranked
row and locator while deleting the tombstone. This narrow compensation cannot be used to
resurrect a replayed or arbitrarily chosen id.

**Edge cases.**

- **Item cap 500 per list.** Beyond it, `POST` returns `validation_failed` with the message
  `List is full.`
- `checked` is validated against **both** `behaviour === 'collection'` and
  `capabilities.checkable` on the list row, not against a hard-coded set of templates.
  Any `checked` mutation on `watch` or `meals`, or on a collection whose flag is false,
  returns `validation_failed`. Stored checked values remain retained while hidden.
- `location` is accepted only when `behaviour === 'collection'` and
  `capabilities.supportsLocation` is true, by the same rule and with the same error. Stored
  locations remain retained when either gate is later false.
- `details` is accepted only when the list's behaviour has a `details` shape, and must carry
  the matching `behaviour` discriminant.
- Checked items **stay in place**, struck through and de-emphasised. They do not jump to the
  bottom. Re-sorting under the user's finger is disorienting and makes an accidental
  double-tap destructive.
- Every server-owned single create or reorder allocates rank under P3-04's `rankVersion`
  condition. A bulk operation allocates its ordered rank sequence from one version read and
  conditionally advances the version once for the operation. A conflict re-reads neighbours
  and retries; callers never publish equal ranks from the same stale gap.
- `bulk` is a single transaction when it fits within DynamoDB's 100-action limit after its
  identity locators and receipt are counted, and a resumable chunked sequence otherwise. It
  must be idempotent both under the `Idempotency-Key` and, after that receipt expires, under
  the stable per-item ids.

**Tests.** Integration: the 501st item `400`s with the exact message; `checked: true` on a
collection with `checkable: false` `400`s and on the same list after `PATCH`ing
`checkable: true` succeeds; the same mutation on `watch` and `meals` `400`s even when the
stored flag is true; `location` on a list
with `supportsLocation: false` `400`s; `details` with the wrong `behaviour` discriminant
`400`s; a bulk insert of 30 items produces 30 rows in the sent order; repeating the bulk call
with the same key or replaying its stable item ids after receipt expiry produces no
duplicates. Response-loss, create → delete → replay, malformed-id, foreign-collision and
atomic explicit-remap tests are the ListItem versions of P2-49.

---

### P3-09 — Capability changes on `PATCH`; behaviour changes on replay-protected `POST`

**Files.** `services/api/src/services/listMutationService.ts`.

**What to build.** The change rules table in
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists),
implemented exactly. This is where the product's additive/destructive rule meets a list.

| Change | Behaviour |
| --- | --- |
| `capabilities.checkable` false → true | Applies immediately. Nothing is lost. |
| `capabilities.checkable` true → false | Applies immediately. `checked` is **retained** on items so re-enabling restores it. |
| `capabilities.supportsLocation` true → false | Applies immediately. Stored `location` is retained and hidden. |
| `behaviour` `collection` → `watch` or `meals` | Applies immediately, initialising `details` on every item — `watchStatus: 'want'` for `watch`, an empty `ingredients` array for `meals`. |
| `behaviour` `watch` or `meals` → anything else | **Destructive.** The first call returns a typed `409` preview; the confirmed call echoes that complete preview. |
| `slot` | Free. Changes no items. |
| `templateKey` | Immutable. A `PATCH` containing it is `validation_failed`. |

The `409` body must name the fields that would be lost and the **exact count of items
affected**, so the client can render "…will remove season, episode and watch status from 7
items." A generic conflict message forces the user to guess what they are agreeing to.

**The destructive row is conditional.**
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §1a.1 rule 3
names a behaviour change as destructive only *sometimes*, and calls a confirmation that can
appear with a count of `0` a bug. An empty `watch` list, or a `meals` list carrying no
ingredients, therefore changes behaviour with no confirmation — the migration still runs,
because every item must match the new behaviour, but nothing is lost and nothing is asked.
Recorded in P3-09 alongside the matching amendment to
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.7, which stated
the row unconditionally; the product doc outranks it on behaviour.

**Approach.** `PATCH /v1/lists/:id` handles `title`, capabilities, slot and archive but rejects
`behaviour`. `POST /v1/lists/:id/behaviour` accepts one target `{ behaviour }`, requires
`If-Match` and `Idempotency-Key`, and classifies that transition as additive or destructive.
Register it as a mutating POST in the route registry so the existing idempotency middleware
owns receipt lookup, response replay and races; do not add a PATCH-only receipt path.
Reject a destructive unconfirmed transition before creating an idempotency receipt or migration
record; the confirmed action uses a newly minted stable key. A behaviour change is a bounded,
resumable migration identified by that key; it does **not** change public META before its item
backfill:

1. A transaction checks `If-Match`, requires both repair/migration gates to be absent, creates
   `BEHAVIOUR_MIGRATION#<operationId>` in `snapshotting` state and sets
   `META.behaviourMigrationId`. It leaves `META.behaviour`, `updatedAt` and every item unchanged.
2. With all item and list mutations now condition-checking that the gate is absent, the worker
   strongly snapshots the at-most-500 stable item ids/ranks/revisions and rewrites bounded
   chunks to the target shape, conditionally advancing each ranked row and locator's matching
   `itemRevision`. Only this private worker may parse target-shaped items against
   the migration's `toBehaviour`; every public item read, exact-id read and mutation attempts a
   bounded drain and otherwise returns `503 internal` with `Retry-After: 1` and no rows or writes.
3. After every snapshotted revision is transformed, one final transaction condition-checks
   the work record, changes `META.behaviour`, clears `behaviourMigrationId`, advances
   `rankVersion` to invalidate pre-migration item cursors, records the settings Undo inverse and
   receipt, and deletes the work row. Only then does the POST return the new List.

A crash in any phase resumes from the stored cursor. A replay of the same key drains or returns
the recorded response; a different list or item mutation cannot pass the marker condition. The
same protocol handles confirmed destructive changes and behaviour-upgrade Undo, so neither
direction can expose a META/item mismatch. Non-behaviour additive settings remain ordinary
atomic mutations. Every additive settings mutation owned here—capabilities, slot and behaviour
upgrade—returns
`{ list, undoToken, undoExpiresAt }` and retains a single-use operation
inverse for `POST /v1/lists/:id/undo`. A behaviour-upgrade inverse records the prior
behaviour and the exact default fields that operation created. It is applicable only while
those fields and the affected list settings are unchanged; otherwise Undo returns the typed
`no_longer_applicable` result and writes nothing. This dedicated compensation may restore
`collection` without destructive confirmation; an ordinary downgrade still follows the destructive
rule above. A slot inverse also records the exact `defaultLists[oldSlot]` entry removed by
the forward change. It restores that entry only if the slot is still absent there; a newer
destination choice makes the whole inverse no longer applicable.

**Edge cases.**

- Upgrading a 500-item list writes 500 items. Chunk it under the migration gate; a retry after
  any partial failure converges without exposing a mixed list. The final `rankVersion` advance
  invalidates every item cursor issued before the migration began.
- `watch` → `meals` is destructive in the same way as `watch` → `collection`; it is not a
  sideways move.
- Setting `slot` on a list when another list already holds that slot is allowed. Slots are
  eligibility, not exclusivity; `user.defaultLists` breaks the tie (P3-12).
- When a PATCH changes or clears a slot and that exact `(slot, listId)` is the profile
  default, the list service removes only that nested default in the same transaction as the
  List update. The conditional profile write must not clear a different destination selected
  concurrently on another device.

**Tests.** One test per row. Specifically: `collection → watch` initialises `details` on
every existing item with `watchStatus: 'want'` and leaves titles and ranks untouched. Pause a
500-item migration after each chunk: list/item reads and every competing item mutation return
the retryable `503`, META still exposes `collection`, and replay completes to one observable
`watch` generation. A pre-migration cursor receives `503` after the final version advance;
its returned Undo restores `collection` and removes only the defaults that upgrade created;
editing one of those fields before Undo returns `no_longer_applicable` and loses nothing;
`watch → collection` POST without `confirmation` returns `409` and writes **nothing**, and
the body names the behaviours, `itemVersion`, affected field list and item count; a new
replay-protected call echoing that exact confirmation succeeds and drops `details`; an item
mutation between preview and confirmation returns a fresh `409`; `checkable` true → false → true
restores the original `checked` values; slot Undo restores the exact removed default when it
is still absent and returns `no_longer_applicable` after a newer choice; a `PATCH` carrying
`templateKey` `400`s. A registry test classifies the behaviour action as a mutating POST, and
a lost-response replay returns its receipt without running a second migration.

---

### P3-10 — `clear-checked`, `uncheck-all`, tombstone-aware Undo, archive

**Files.** `services/api/src/handlers/clearChecked.ts`, `unCheckAll.ts`, `patchList.ts`,
`services/api/src/services/listUndoService.ts`,
`apps/mobile/src/features/lists/components/ListHeaderMenu.tsx`.

**Approach.** The bulk operations, `PATCH { archived }`, and dedicated compensation endpoint from
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists)
§2.7. `clear-checked` and `uncheck-all` are offered and accepted only when
`behaviour === 'collection' && capabilities.checkable`; `PATCH { archived: true }` archives
the list and returns the ordinary additive-settings Undo token. There is no separate archive
route.

The only decision in the task is what `Clear checked` costs the user:

> **Decision:** `Clear checked` shows **no confirmation dialog**. It deletes immediately and
> shows a **10-second bulk undo toast** (`7 items cleared · Undo`), which restores the items
> with their previous `rank` values. The count is stated in the button itself —
> `Clear checked (7)` — so nothing is hidden, and the undo window is the safety net.

This is a deliberate exception to the destructive-change rule in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §1a.1, and it
is the only one. The justification is the situation: clearing checked items is the *end* of a
shopping trip, performed one-handed with a bag in the other, on rows the user has already
ticked one at a time. A dialog asks them to re-confirm a decision they have already made seven
times. The 10-second window is the standard bulk undo from §4 of the same document, so this
uses an existing mechanism rather than inventing a softer one. Recorded in
[`../00-open-decisions.md`](../00-open-decisions.md) item 33.

`uncheck-all` is not destructive, so it gets no dialog. It still gets the canonical
**10-second bulk undo toast**. The server snapshots exactly the ids changed from checked to
unchecked and returns an opaque Undo token; compensation sets those still-existing ids back
to checked and ignores an item independently deleted during the window.

**Edge cases.**

- Single-item delete, the bulk operations, and additive list-settings PATCHes return an opaque
  token for `POST /v1/lists/:id/undo`.
  `undoExpiresAt` is the 6-second or 10-second **UI offer deadline**, not the server replay
  deadline. If the user taps Undo while the toast is offered, the native coordinator records
  the inverse durably; the server accepts that single-use token until the shared
  `MAX_AUTOMATIC_INTENT_AGE_DAYS` retention expires, even when offline replay arrives after
  `undoExpiresAt`. The restore path is the sole exception to the normal item-create tombstone
  check, and clients never initiate a new Undo after the UI deadline.
- Delete Undo re-creates the items with their original ids and **previous ranks**, not appended
  at the end. It also restores the deleted current `LNK#` rows and corresponding Activity
  provenance from the deletion snapshots. A restored shopping list in a different order or
  with dead state lines is a failed undo. If a linked Activity was independently deleted,
  restore the item but omit that now-invalid link.
- The network call fires immediately, not at the end of the window (the P2-24 rule). Undo is
  a compensating call. Closing the app without tapping Undo leaves the deletion committed;
  tapping first makes the compensating intent durable across app close and offline replay.
- On a **shared** list, undo restores the items for everybody, because the delete removed
  them for everybody. A second member who added an item during the 10 seconds is unaffected —
  the Undo operation names only the deleted ids and their per-item snapshots; it never replaces
  the List with a whole-list snapshot.
- `Clear checked` on a list with zero checked items is absent from the menu rather than
  present and disabled.
- Undo is idempotent under its own `Idempotency-Key`. A retention-expired, mismatched or
  already-used token cannot reclaim an item id; it returns the typed
  expired/no-longer-applicable result and writes nothing.

**Tests.** Integration: seven checked and three unchecked items → seven deleted, three
untouched, `itemCount` and `uncheckedCount` both correct afterwards; Undo tapped within the
window and replayed after `undoExpiresAt` restores the same seven ids with byte-identical
`rank` values, locators, live links and Activity provenance. Normal create with one of those
tombstoned ids fails before Undo and succeeds neither after replay retention expires nor with
a mismatched token. `Uncheck all` shows its 10-second toast and Undo rechecks exactly the
affected surviving ids. Both endpoints on a non-collection list or on a collection with
`checkable: false` return `400`; hidden retained checks cannot be cleared. Archiving through
`PATCH` returns an Undo token and Undo restores `archived: false`. Client: a test asserting **no confirmation dialog is
rendered** on tap — written as an assertion on the absence of the dialog component, so
re-adding one fails — and that each bulk operation's toast appears with a 10-second window.

---

### P3-12 — `User.defaultLists` and slot resolution

**Files.** `packages/shared/src/lists/resolveSlot.ts` (pure),
`services/api/src/services/listSlotService.ts`.

**What to build.** The four-step rule in
[`../02-architecture/data-model.md#default-slots`](../02-architecture/data-model.md#default-slots),
in one pure function used by every "add these to X" flow. There must be exactly one
implementation; a second copy in the ingredients path is how the two drift.

```ts
resolveSlot(slot, lists, defaultLists):
  | { kind: 'use'; listId: string; wasDefault: boolean }
  | { kind: 'ask'; candidates: List[] }
  | { kind: 'none'; slot: DefaultSlot }
```

| Eligible lists | Result | Profile write |
| --- | --- | --- |
| Exactly one | `use`, `wasDefault: false` | none |
| Several, `defaultLists[slot]` set and still valid | `use`, `wasDefault: true` | none |
| Several, no valid default | `ask` | on answer, `defaultLists[slot] = chosen` |
| None | `none`; no `templateKey`, title, or recommendation | none |

`defaultLists` is patched through `PATCH /v1/me` (`api-contract.md` §2.1) as a **nested
per-slot patch**, not as replacement of the stored map. An omitted slot is preserved; a
`listId` sets just that slot; `null` removes just that slot. Stored `User.defaultLists` values
remain non-nullable because clearing removes the key. Archived lists are not eligible.

The strict PATCH schema is
`Partial<Record<DefaultSlot, ulidId('lst') | null>>`. The repository applies supplied slots
with DynamoDB document-path `SET` / `REMOVE`; it never emits `SET defaultLists = :partial`.
For a legacy profile with no parent map, conditionally create the one-key map, and on a
concurrent creator retry the nested operation. This preserves sibling slots even when two
devices set different defaults concurrently.

`listSlotService.ts` is the API-side home of these invariants: `resolveListSlot`, which drains
the caller's list index, reads the profile and hands both to the pure rule — **both reads
strongly consistent**, because this resolve is the step straight after the `PATCH /v1/me` that
stored the user's answer, and an eventually consistent read there returns the map from before
it, keeps a list archived seconds ago looking eligible, and yields pointers to memberships
already revoked. `GET /v1/lists` keeps its cheaper eventually consistent read; eligibility is
a destination decision, not a rendering one. Alongside it, 
`profileDefaultToClear`, the single answer to "which default may this list write clear" that
P3-05's delete and P3-09's slot change both ask. The conditional transaction item itself —
`removeDefaultListTransactItem` — stays in `userRepository`: it builds a DynamoDB update over
the profile key, so it belongs to the repository layer, and both of its callers are inside
`listRepository`, which may not import a service. There is still exactly one implementation;
the service names it rather than copying it (P3-12).

> **Decision:** a per-operation override is a parameter to that request and is **not**
> written to the profile. Choosing a different destination once must not silently become
> permanent, and most-recently-used is rejected outright (ADR-033). Opening a list writes
> nothing at all.

**Edge cases.**

- A `defaultLists` entry pointing at a deleted or archived list is treated as unset and
  falls through to step 3. P3-05 clears it on delete; this is the belt-and-braces read-side
  guard, because a stale pointer must never produce a dead end.
- The resolved destination is returned to the client even in the `use` case, because the
  sheet has to show where the items are going. Silent step 1 means "do not ask", not "do not
  tell".
- Step 4 creates nothing and returns no template. The client may offer `New list`. General
  and ingredient flows open P3-26's full fixed-order catalogue with nothing selected. An
  explicitly chosen Watch destination filters that same source to the three `watch` records
  in canonical relative order, also unselected. `Create list` returns the new `listId` to the
  original flow, whose separate named add action is still required.

**Tests.** Unit over all four cases plus the stale-default case. Integration: two grocery
lists and no default produces `ask`; answering it stores `defaultLists.groceries` and the
next call returns `use` with `wasDefault: true`; passing the visibly chosen `listId` to the
ingredient action uses that list and leaves `defaultLists` unchanged. **Opening a list does not change
the default**—a `GET /v1/lists/:id` against the non-default list, then a re-resolve, still
returns the original default; deleting the default list falls back to `ask`. With no candidates
the result is exactly `{ kind: 'none', slot: 'groceries' }` and contains no template or title.
A no-destination Watch case returns `none`, then the client presents exactly the three Watch
styles unselected without `resolveSlot` returning or persisting a `templateKey`. A profile
integration test starts with all three slots, sets `groceries`, then clears `watch` with
`null`, proving each request preserves every omitted slot. The one line here that needs the
activity-scoped ingredient action — "passing the visibly chosen `listId` to the ingredient
action uses that list and leaves `defaultLists` unchanged" — is **deferred to P3-17**, which
owns that endpoint and already carries the same assertion in its own test list; a
per-operation override is a parameter to that request, so P3-12 has no surface to point it
at.

---

### P3-13 — The bridge to Activities: explicitly plan a list item

**Files.** `services/api/src/routes/lists.ts`,
`services/api/src/services/listScheduleService.ts`.

**What to build.** `POST /v1/lists/:id/items/:itemId/schedule`. The most consequential
endpoint in this phase, because getting it wrong produces the duplication the concept
explicitly forbids. It is also **optional in the product sense** — most items in most lists
never reach it, and nothing in the list model treats an item that does not as unfinished.

**Approach.** Validate the separate `ScheduleListItemInput` contract before any write:

```ts
{
  activityId: 'act_<ULID>',
  creationTarget: { objectKind: 'plan', type: PlanType },
  audience: { mode: 'just_me' },
  title?, notes?, schedule?, recurrence?,
  reminders?: { reminderId: 'rem_<ULID>', offsetMinutes: number }[],
  location?, details?, attachmentIds?,
  sourceUrl?
}
```

`activityId` is required and is the permanent monotonic id minted with the Phase 2.6 native
generator before the bridge intent—or P3-42's combined item-plus-bridge chain—enters SQLite.
Every supplied reminder likewise carries its permanent client-minted `reminderId`; this
offline-capable route never relies on a server response to identify or arm a reminder.
`PlanType = Exclude<ActivityType, 'task'>`. `creationTarget` is required and `type` must be
the Plan kind the user selected:
`General → custom`, `Meal → meal`, `Watch → watch`, or `Event → event`. The server never
reads `behaviour`, `templateKey` or any capability to
select or pre-select it. In this single-player phase only
`audience: { mode: 'just_me' }` is accepted; the `selected_people` union shape is already in
the shared schema but returns `validation_failed` with `Sharing is coming soon.` until Phase 6.

The service extends Phase 2.6's durable Activity-create transaction rather than rebuilding a
smaller create path. One `TransactWriteItems` condition-checks the Activity tombstone and
writes, at minimum:

1. `ACT#<activityId>/META` — a Plan Activity with `listItemId` and `listId` provenance,
2. `USER#<caller>/IDX#<activityId>` — the caller's index entry in the correct GSI1 bucket,
3. `LIST#<listId>/LNK#<callerUserId>#<itemId>` — the caller's current
   `ListItemActivityLink`,
4. one caller-owned `ACT#<activityId>/REM#<callerUserId>#<reminderId>` for every supplied
   reminder, using the ids already persisted in SQLite, and
5. the ordinary idempotency receipt plus any other rows required by the accepted create
   fields (for example confirmed attachment links).

The core three domain rows remain exactly one each; “three” is not a ceiling that permits
accepted reminder or attachment input to be dropped. Transaction-size validation reserves
the optional rows before any write.

The `ITEM#` row is unchanged. When `title` is omitted, the service copies the item title
once; after creation the titles are independent. Target-compatible structured item fields may
be offered in the client only **after** the Plan kind choice and remain editable before the
request. They are never grounds for choosing the kind.

**Edge cases.**

- The item is **not** copied, moved, checked, hidden or given an Activity id. It stays in place;
  the list projection joins only the caller's `LNK#` row into `viewerLink`.
- An existing pointer for this caller is not a global conflict. A confirmed new action
  replaces that caller's current pointer only. Idempotency prevents a retry of the same action
  from creating a second Plan.
- The Activity put is conditional on `ACT#<activityId>` absence. After the 24-hour receipt
  expires, an existing Activity with the same owner, `listId` and `listItemId` is the earlier
  successful action: return it and do **not** rewrite the current `LNK#`, which may now point
  to a newer confirmed action. Any other collision follows the metadata-free durable-create
  conflict path. A genuinely new scheduling action always mints a new `activityId`.
- The response is `{ activity, item, viewerLink }`; `viewerLink` belongs to the caller and no
  other viewer's pointer may be serialised.

**Tests.** Integration: `Zahav` with explicit `creationTarget.type: 'event'` and
`audience.mode: 'just_me'` produces exactly one new Activity, one index entry and one caller
link while leaving the item byte-identical. Missing `activityId`, missing `creationTarget`,
missing audience, a Plan target with no type, and `details.kind` that differs from the selected
type each return `400` and write nothing. Run the same title with each explicit Plan kind and
assert the stored type follows the request every time, even when it contradicts `behaviour` or
the template.
An offline bridge carrying two stable reminder ids projects and arms those same ids locally,
then creates exactly two caller `REM#` rows on replay; replay after receipt expiry creates no
duplicate reminder. A reminder missing `reminderId` is rejected before the SQLite/outbox
transaction and writes nothing.
Changing either list field has no effect on the target. A repeated idempotency key creates one
Plan; replaying the same `activityId` after receipt expiry still creates one; a fresh confirmed
action uses a fresh id and replaces only this caller's pointer. Replaying the older id after
that replacement does not roll the pointer back.

---

### P3-14 — One-time title seed and independent edits

**Approach.** The ListItem and Plan are separate objects joined by provenance and a
caller-scoped pointer. If the schedule request omits `title`, copy `ListItem.title` into the
new Plan exactly once. After creation, title and notes edits are independent in both
directions.

This separation is a sharing boundary, not merely a simpler update path: a member allowed to
rename a shared list item must not rename another member's private Plan, and a Plan participant
who cannot edit the source list must not rename the shared item.

**Edge cases.** Replacing a viewer's pointer does not rename or delete the formerly pointed-to
Plan. A deleted or inaccessible Plan is omitted from the list projection and its stale pointer
is queued for cleanup; an item edit still succeeds.

**Tests.** Integration: omitted title copies once; explicit title wins; editing either side
leaves the other byte-identical. Seed two viewer pointers to different Plans and prove one
item rename changes neither Plan. Notes never mirror.

---

### P3-15 — Link lifecycle

**Approach.** The table in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §6.3, implemented
exactly. It is described in the canonical doc as "the most commonly mis-implemented rule in
the product", so it gets its own task and its own test file.

| Event | Effect on the caller-visible link |
| --- | --- |
| Plan completed / un-completed / rescheduled | Keep the `LNK#` pointer. Derive the caller-only state line from the Activity. **Never** check, uncheck, delete or rewrite the ListItem. |
| Plan unscheduled | Keep the `LNK#` pointer but remove the state line until the Plan is scheduled again. The item remains byte-identical. |
| Plan cancelled | Keep the `LNK#` pointer and render `Cancelled`. The Plan and item remain independent. |
| Plan converted to Task | Delete matching `LNK#` rows and clear `Activity.listId` / `.listItemId` in the same conditional transaction as the conversion. The Task and item both survive. |
| Non-occurrence Plan skipped / `didnt_happen` | Remove the state line and clear the matching viewer pointers. The Plan and item both survive independently. An occurrence-only skip writes `OCC#` and does not clear the recurring series pointer. |
| Plan deleted | Delete only `LNK#` rows that still point to it. **The item survives.** |
| ListItem deleted | Delete its current `LNK#` rows and clear `Activity.listItemId` / `.listId` on those Plans. **Every Plan survives.** |
| Viewer schedules again | Replace only `LNK#<viewerUserId>#<itemId>`; the older Plan remains an ordinary Plan and v1 exposes no link history. |
| Viewer loses list access | Remove or invalidate that viewer's pointers; Plan access is unchanged and is enforced separately. |

Neither side ever cascade-deletes the other.

**The formerly open transitions are settled.** A link is Plan-specific, so Plan → Task
deletes it and clears the Activity provenance in the conversion transaction; retaining an
unrenderable pointer would create permanent hidden state. Cancellation is different: the
Activity remains a Plan and the cancellation itself is useful context, so the pointer stays
and P3-34 renders `Cancelled`.

**What the read side must carry.** Rows 1 and 2 both turn on the client seeing the Plan's
current state, so the projection returns `viewerPlan` — `ListItemPlanState`, the caller's
linked Plan trimmed to `type`, `status` and an optional `schedule` — beside `viewerLink`
(`api-contract.md` §3). The two are one shape, not two optional fields: a row has both or
neither. Without it a scheduled Plan and the same Plan after
unscheduling are indistinguishable in the response, and P3-34 has no state to render. The
Activities are hydrated in **one bounded batch** per page, after the caller filter, never one
read per link.

**Tests.** One test per row, all in
`services/api/src/services/__tests__/listLinkLifecycle.test.ts`. The lifecycle test separates
skip from unschedule: skip clears the pointer, unschedule retains it but renders no state line,
and a later reschedule makes that same pointer visible again. A recurring occurrence skip
leaves its series pointer byte-identical. Plus a test that deletes an
Activity and asserts the item is byte-identical. Completing a Plan linked from a checkable
list leaves `checked` byte-identical. Projection tests distinguish scheduled, unscheduled,
completed, cancelled and rescheduled versions of one linked Plan; each linked row carries matching
`viewerLink` and `viewerPlan`, while an unlinked or unreadable row carries neither. A fixture
with links for two viewers returns only the caller's pair and never attempts to load the other
viewer's Activity. A route test proves both list read endpoints serialise the pair rather than
discarding the state after the service projection.

---

### P3-16 — Watch progress and status transitions

**Approach.** Watch completion goes through the existing recurrence-aware completion service;
it does not write Activity META directly:

1. A non-recurring watch writes `status: 'completed'`, `completedAt`, `outcome` on the
   Activity and may return a follow-up **suggestion** to update a compatible watch item visible
   to the caller.
2. A recurring watch occurrence requires `occurrenceDate`, writes only that occurrence's
   `OCC#` completion, leaves the series META byte-identical and returns no follow-up. An
   unscoped recurring completion is rejected.

The suggestion creates and updates nothing. Confirming it issues an ordinary explicit item
`PATCH` that advances `season`/`episode` and may set `want → watching`; dismissal leaves the
item byte-identical. `watching → watched` is manual only: the app does not know how many
episodes there are.

**Edge cases.** For a `movie`, the follow-up is `Update {list name} item to Watched?` rather
than a next episode. A code path that writes an Activity from the follow-up is a bug, not a shortcut. If
the linked item's list has since been changed away from `behaviour: 'watch'`, its `details`
are gone: skip the progress write and return no follow-up rather than resurrecting the
fields.

**Tests.** Integration: completing non-recurring S2 E5 leaves the item at S2 E4 and returns the
suggestion; dismissing writes nothing; confirming advances it to S2 E5 and `watching`.
Completing a movie does not set `watched` automatically, and no follow-up path creates a
second Activity. A recurring occurrence writes only `OCC#<occurrenceDate>`, leaves series META
byte-identical and returns no suggestion; the same request without `occurrenceDate` is
rejected.

---

### P3-17 — Meal ingredients → a destination list, and the provenance label

**Files.** `packages/shared/src/lists/provenanceLabel.ts`,
`packages/shared/src/lists/formatIngredientTitle.ts`,
`services/api/src/services/ingredientsToListService.ts`.

**Approach.** The exact flow in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §7.3, with one
change: the destination is **resolved, not assumed**. There is no "the Groceries list" —
there is whichever `collection` the user's `groceries` slot resolves to under P3-12, and the
user may choose a different one for this operation only. Resolution is a read-side client
step over the Lists projection. Until it returns one visible, confirmed destination, no
write request is issued.

Each stored ingredient has a required stable `ingredientId: ulidId('ing')`, minted with the
same native CSPRNG/monotonic-ULID utility before a meal create or ingredient-row addition is
accepted. Editing or reordering a row retains its id; replacing or adding a row mints a new
one. Phase 3 is still pre-deploy, so the local seed/fixture reset is the schema boundary for
the previous id-less shape—do not invent an index-derived compatibility id that changes when
rows move.

Once the destination is known, call the dedicated
`POST /v1/activities/:id/ingredients/add-to-list` with
`{ listId, ingredients: [{ ingredientId, itemId? }] }`. `listId` is required: the server
validates the caller may write that collection, reads the owned meal, resolves every selected
stable id against its current typed ingredient array, and derives every title and provenance
field. An id that was removed or replaced is stale and rejects the whole operation; a reorder
cannot redirect the request to another ingredient.
The ordinary list bulk endpoint never accepts `sourceActivityId`, `sourceLabel`, or source
ingredient identity. Each created item gets
`title` from the pure `formatIngredientTitle(name, quantity)` function: preserve the full
ingredient name and, when a non-empty quantity is present, append it in parentheses
(`Tortillas (8)`). If that would exceed `MAX_TITLE_LEN`, truncate only the quantity to the
remaining budget and end it with one ellipsis inside the parentheses. Thus the maximum
120-character name plus a maximum 120-character quantity still produces a valid,
deterministic 200-character ListItem title rather than making a valid meal fail bulk insertion.
`sourceActivityId` = the meal, and `sourceLabel` from the pure function below. In the same
receipt-aware operation, each exact source ingredient, found again by `ingredientId`, gets
`addedToListId`, so the button renders `Added` for those rows next time. A missing/stale id, a
non-meal activity, or an inaccessible destination is rejected without partial writes.

`provenanceLabel(meal, existingLabelsOnList)` implements the five rules in §7.5:

1. Scheduled within 7 days **and** has a slot → `"<Weekday> <slot>"` — `Sunday dinner`.
2. Scheduled within 7 days, no slot → `"<Weekday>"`.
3. Scheduled beyond 7 days → `"<d MMM> <slot>"` — `23 Aug dinner`.
4. Unscheduled → the meal's title.
5. If rules 1–3 produce a label already on the list **from a different meal**, append the
   meal title: `Sunday dinner · Chicken tacos`.

The label is **computed once and stored, never recomputed**, so it stays truthful after the
meal is rescheduled or deleted. A manually added item has no label and renders no dash. A
single canonical segment may contain a full 200-character meal title. The rendered field
therefore has its own `MAX_SOURCE_LABEL_LEN` (4,000), not the generic 120-character free-text
bound. Extensions are never truncated: the service validates the completed rendered value
before composing the transaction and rejects the whole action if the bound would be crossed.

**Duplicate handling.** If an item with the same case-insensitive, trimmed title already
exists **unchecked** on the target list, no second row is created — the existing row's
`sourceLabel` is extended (`Sunday dinner · Thursday lunch`). If the existing row is
**checked**, a new row is created: the previous one was already bought. Selections in one
request are classified by normalized-title group, so two selected ingredients with the same
title use the same existing unchecked row or create one new row. Storage also retains
activity-keyed provenance segments; ownership is never reconstructed by splitting the
rendered label, because a rule-5 segment can itself contain ` · `.

Classification and persistence are one optimistic unit. A strong, bounded item snapshot
returns both `META.rankVersion` and storage-only `META.itemVersion`; the single
`TransactWriteItems` conditions its META update on those exact generations, then advances both
while writing every created row, extended label, source marker, the meal's new `updatedAt` and
the idempotency receipt. The service also revalidates `behaviour = collection` and capacity
from that exact transaction basis; a successful behaviour migration between the earlier
preflight and this read cannot authorize a bare row in a typed list. `rankVersion` catches a concurrent create or reorder; `itemVersion`
also catches a title patch, check, delete or restore that could change the duplicate decision
without changing rank. A failed condition discards the classification and repeats the entire
read/classify/commit cycle. The request is capped at 30 selected ingredients so its worst case
(94 transaction items) remains under DynamoDB's 100-item limit. A destination `itemId` is
optional: the server mints one only if creation is needed. When the client supplies one, a
single `ITEMID#<itemId>` namespace is authoritative for both ordinary locators and permanent
aliases created by a labelled outcome. The identity stores the exact source Activity,
ingredient and original outcome; replay must match all three, and ordinary item creation
cannot claim an alias id. A created locator/tombstone or absorbed alias therefore keeps that
identity from becoming a different row after the receipt expires. A bound target answers its
own replay even after check/rename, but absorbs a fresh same-title selection only while it is
still unchecked and its current normalized title matches. A binding whose target was later
deleted returns conflict; it never permits the requested id to create a replacement.

**Edge cases.** Nothing in this flow happens automatically. Creating a meal with ingredients
writes zero grocery items until the user taps the button. Provenance is **not** linkage
(§6.5): checking `Chicken` does not affect the meal, completing the meal does not delete
`Chicken`, and deleting the meal leaves `Chicken` with its label intact and a non-navigable
back-link.

**Tests.** `provenanceLabel` unit tests for all five rules including the collision case.
`formatIngredientTitle` tests no quantity, an exact-boundary quantity and the 120 + 120
maximum; the last preserves all 120 name characters, has one ellipsis, and is exactly
`MAX_TITLE_LEN` characters. Integration for the duplicate rule in all three states (absent, present-unchecked,
present-checked), same-title selections in one request, a 200-character unscheduled title,
and a repeated extension that would exceed the rendered provenance bound. A test asserting the label is unchanged after the source meal is
rescheduled and after it is deleted. An integration test asserting that creating a meal with
four ingredients and never tapping the button leaves the destination list empty. Plus:
with two lists holding `slot: 'groceries'` and no default, the client presents the choice and
issues no POST; with an explicit confirmed `listId`, the items land there and `defaultLists`
is unchanged. A contract test proves the ordinary bulk schema rejects provenance fields,
while the activity action derives them from the meal and updates the selected ingredient
ids idempotently. An offline request selected before two ingredient rows are reordered still
adds the originally selected ids; deleting one selected row before replay rejects the whole
action and writes nothing. Deterministic injected-race tests add and rename a destination row
after classification; both invalidate the snapshot, retry from current truth and avoid a
duplicate. A same-key concurrent replay creates every row once, and the no-partial-write test
asserts the exact receipt key is absent when provenance cannot commit. A deduplicated supplied
id is replayed after its target is checked/renamed and after deletion: the former still
resolves that target, while the latter conflicts without creating a row.

---

### P3-18 — Prep tasks

**Approach.** Prep tasks are ordinary Activities of type `task` with `parentActivityId` set.
They are not a sub-entity and have no reduced capability: their own schedule, reminders,
recurrence, checkbox everywhere, and their own row on Today with the parent plan's title as
the subtitle.

Retrieval is access pattern 16 — from the parent's partition, not a GSI filter. The data
model offers two options and picks the latter; use `Query pk = ACT#<parent>, sk begins_with
SUB#`, `Limit: MAX_PREP_TASKS_PER_PLAN`, writing a lightweight `SUB#<childId>` pointer item
whose projection includes `isRecurring`
alongside the child's own `ACT#<childId>/META`. `MAX_PREP_TASKS_PER_PLAN = 50` is a shared
model cap, so this one bounded page is the complete prep collection; do not reuse Phase 2's
unbounded `listChildPointers/queryAll` helper on the detail path.

`activity.childCount` on the parent is maintained on write. `3 of 5 done` is a drill-down:
tapping it opens the plan's prep list including completed items.
Creating/removing recurrence on a prep task rewrites the parent pointer in the same transaction,
just as title and status edits do, so follow-up eligibility never guesses from a stale child
projection.

**Edge cases.**

- **Nesting is capped at 2 levels.** A `POST` that would create a third returns
  `validation_failed`. Arbitrary nesting turns the product into an outliner.
- **A Plan has at most 50 prep tasks.** Creating the 51st returns `validation_failed` with
  `Plan has too many prep tasks.` and writes nothing. The cap is what makes the complete
  `3 of 5 done` ratio and P3-43's exact eligible one-off count compatible with a bounded detail read.
- **Deleting the parent does not delete prep tasks.** It clears `parentActivityId` and they
  become ordinary tasks. A user who cancels a trip may still need to return the rental car;
  cascade-deleting real to-dos because the container went away is the kind of data loss that
  ends trust in a planner. This differs from the cascade for `PART#` and `EXP#` items and is
  therefore easy to get wrong by pattern-matching.

**Tests.** Integration: three levels `400`; the 51st direct or offline-replayed child `400`s
with the exact message and writes neither Activity nor `SUB#` pointer; `childCount` is correct
after add, complete and delete; one `Limit: 50` Query returns the complete collection and its
exact completed/open counts without `queryAll`; a recurring child pointer is created with
`isRecurring: true`, and recurrence conversion updates it to false in the same transaction;
deleting the parent leaves the children with
`parentActivityId` absent and their schedules intact; a prep task with today's date appears
on Today with the parent title as subtitle.

---

### P3-19 — Updates feed endpoints

**Files.** `services/api/src/routes/updates.ts`,
`services/api/src/services/updatesService.ts`.

**What to build.** `GET /v1/activities/:id/updates?cursor=` and
`POST /v1/activities/:id/updates` per
[`../02-architecture/api-contract.md#25-updates-the-plans-activity-feed`](../02-architecture/api-contract.md#25-updates-the-plans-activity-feed).
Storage is the `UPD#<isoTs>#<updateId>` item in the activity partition
([`../02-architecture/data-model.md#31-activity-partition`](../02-architecture/data-model.md#31-activity-partition)),
so the plan-detail screen already receives the first page from access pattern 4; this route
exists to page older entries and to post.

**Approach.**

- `GET` is one `Query` on `pk = ACT#<id>`, `sk begins_with UPD#`, `ScanIndexForward=false`
  — newest first, cursor-paginated per §Pagination of the API contract.
- `POST` takes `{ body }` and nothing else. The server sets `kind: 'user'`, the author, and
  the timestamp; a request carrying `kind`, `authorUserId` or `createdAt` is
  `validation_failed`. `body` is 1..2000 characters (decision recorded here — raise in PR if
  wrong). Authorisation: owner or participant
  ([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules));
  in this phase that is the owner.
- A successful POST returns `{ update, lastActivityAt }`. That authoritative timestamp is
  the client's ordering signal; a refetch through GSI1 is reconciliation only because the
  index is eventually consistent.
- System entries (`kind: 'system'`) are written **only server-side**, through one
  `writeSystemUpdate` helper in this service that the owning services call. In this phase
  the writers are the schedule path — date set, date changed, time changed
  ([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.4) — and
  completion (§9.3 step 10). RSVP and expense entries arrive with Phases 6 and 7.
- The `ActivityUpdate` entity shape (`updateId`, `activityId`, `kind`,
  `authorUserId?` — present on `user` entries only — `body`, `createdAt`,
  `schemaVersion`) is named in the data model's key table but has no §4 shape yet. Add it to
  [`../02-architecture/data-model.md#4-entity-shapes`](../02-architecture/data-model.md#4-entity-shapes)
  in the same PR; the Zod schema lives once in `packages/shared`.
- **A posted update bumps `lastActivityAt` and never `updatedAt`**
  ([`../02-architecture/feature-to-schema-map.md`](../02-architecture/feature-to-schema-map.md)
  — two timestamps, two jobs). Bumping the wrong one either 409s an unrelated `If-Match`
  edit or leaves the Needs-a-date stage unsorted. Updates never increment `icsSequence`
  ([`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity)).

**Edge cases.**

- [`../01-product/interaction-contract.md#3-gesture-table`](../01-product/interaction-contract.md#3-gesture-table)
  §3.3 gives an update entry an author-only `Delete`, but the API contract §2.5 defines no
  delete endpoint. Resolution recorded here: implement
  `DELETE /v1/activities/:id/updates/:updateId`, author-only, on `kind: 'user'` entries only
  — a system entry is the record of what happened and nobody may delete another's
  ([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 row 9) — and
  amend `api-contract.md` §2.5 in the same PR. Raise the conflict in the PR description.
- Updates work on a private plan; the client hides the empty section (§2.2), the endpoint
  does not.
- A Plan → Task conversion retains existing update rows as read-only history. `GET` still
  pages those rows and `DELETE` still permits the author's own `user` entries; `POST` and
  every server-side system writer remain Plan-only. The conversion must not make stored
  discussion unreachable or silently delete it.

**Tests.** Integration: post then get returns newest first; a client-supplied
`kind: 'system'` `400`s; after a post, the response carries the new `lastActivityAt`, META
has moved and `updatedAt` is byte-identical, and the GSI projection eventually places the
plan at the head of the `#P` bucket ordering (ties into P3-20);
the cursor pages a 60-entry feed; the author deletes their own entry, a `system` entry
delete `404`s; a converted Plan's 60-entry history still pages without omissions or
duplicates while new posts fail; the schedule path writes exactly one system entry per date
change.

---

### P3-20 — `GET /v1/plans` — the three-stage Plans endpoint

> **Amended 2026-08-25 (review) — discriminate initial loads and continuations.** The original
> contract launched `#P`, future `#S`, past `#S` and `#R` on every request, so scrolling one
> stage paid for all three. `mode` now selects one strict query/response arm: `initial`,
> `upcoming_window`, `past_window` or `past_cursor`. Past calendar navigation supplies both
> visible bounds, and dense windows continue under the same bounds until their returned
> coverage is complete. Contract in `api-contract.md` §2.2a; P3-47 is the caller.

> **Amended 2026-08-26 (founder) — close the shared Activity-authorisation consistency
> gap alongside P3-20.** P3-19 made feed callers opt into strong reads, but the same stale
> grant risk predates the feed and affects every route using `assertActivityAccess`. This
> task makes strong META, participant and parent reads an invariant inside that helper, with
> no caller opt-out, and tests the default at the shared service boundary. Endpoint shapes
> and authorisation rules do not change.

**Files.** `services/api/src/routes/plans.ts`,
`services/api/src/services/plansService.ts`,
`packages/shared/src/schemas/plans.ts`.

**What to build.** The endpoint behind the Plans tab, exactly as specified in
[`../02-architecture/api-contract.md#22a-plans`](../02-architecture/api-contract.md#22a-plans).
One initial request, three stages, and no second call to render the screen. Later Upcoming
and Past requests use response arms that omit inactive stages, so merging a continuation
cannot replace another stage with an empty array.

| Stage | Query | Order |
| --- | --- | --- |
| `needsDate` | `GSI1` `gsi1pk = U#<u>#P`, `ScanIndexForward=false` — access pattern 2b | `lastActivityAt` descending |
| `upcoming` | `GSI1` `gsi1pk = U#<u>#S`, widening the requested viewer window by two stored-key days on each side before timezone conversion and exact filtering, plus the first converted later Activity date as the continuation hint | viewer-local date ascending |
| `past` | the same dated-Activity bucket, starting above the viewer-local today boundary by the required two-day overlap, then timezone-converted and filtered to `< today`, `ScanIndexForward=false`, `?cursor=` | viewer-local date descending |
| recurring input for `upcoming` | `GSI1` `gsi1pk = U#<u>#R` — access pattern 3 | Activity rows expanded only inside the requested Upcoming window |

**Approach.**

1. `mode=initial` starts four logical `Query` streams concurrently: `#P`, the
   timezone-widened future slice of `#S`, the cursor-paged and boundary-widened past slice of
   `#S`, and `#R`. `mode=upcoming_window` starts only future `#S` and `#R`;
   `mode=past_window` and `mode=past_cursor` start only past `#S`. `needsDate` is capped as
   below. The initial request defaults `upcomingFrom` to today and `upcomingTo` to 61 days later; explicit
   windows may contain at most `MAX_AGENDA_DAYS` (62) inclusive calendar dates. The response
   returns `{ from, through, nextFrom }`, where `nextFrom` is the earliest one-off or recurring
   date after `through`, or `null` when neither source has one. It may jump an empty gap but
   never skips a row. Scrolling requests the next 62-day window from that date. Ordinary
   older `past` remains cursor-paginated through `past_cursor`. A calendar landing uses
   `past_window` with required `pastFrom` and exclusive `pastBefore`; a cursor is scoped to
   those same bounds and repeated until `pastCoverage` says the entire visible range is
   complete. `#S` and `#R` are shared Activity
   buckets: scheduled and recurring Tasks live there too and remain visible in Plans. Follow
   access pattern 1: hydrate every widened Activity candidate,
   convert timed rows from their projected stored `timezone` into the request timezone, and
   only then filter into Upcoming or Past. The future stream stops only after it has a converted
   one-off Activity candidate after `through` (or is exhausted), and derives `nextFrom` from
   that viewer-local date rather than a raw sort key. Past pagination carries the raw DynamoDB
   cursor but refills across candidates filtered out at the today boundary.
   Recurrence math supplies the corresponding next date for each bounded `#R` row, so
   calculating `nextFrom` never scans an empty calendar gap.
2. `upcoming` **expands recurring Activity series** through the same `expandAgenda` path the
   agenda uses (P2-08), so a weekly dinner contributes one row per date. Do not reimplement
   expansion here: pass all bounded `#R` rows and the exact requested window to the shared
   service, merge them with `#S`, and propagate its recurrence warnings.
3. Items in `upcoming` and `past` are ordinary `AgendaItem` projections (P2-10). Items in
   `needsDate` are an `AgendaItem` **plus** `lastActivityAt`, `rsvpSummary` and
   `suggestionCount`. The timestamp is required for P3-39's monotonic merge when an
   eventually consistent GSI page is older than a mutation response.
4. Each `rsvpSummary` group is `{ count: number, names: string[] }`; `names` contains at most
   the first two display names while `count` is the full group size. The four keys are
   `interested`, `maybe`, `pass`, and `pending`. The names are the **undated** vocabulary,
   which is what the row renders. No new stored enum value: `interested` maps stored `going`,
   and `pass` maps `declined`. See
   [`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change).
5. In this phase there are no participants or date suggestions. Every group is therefore
   `{ count: 0, names: [] }`, `suggestionCount` is `0`, and the client renders `Just you`.
   The stable fields ship now and are populated by the Phase 6 work, so the client is written
   once.

**Edge cases.**

- Phase 3 performs no participant or suggestion read: both collections are structurally
  absent until Phase 6, so it constructs the zero projection above. P6-40 owns the bounded
  server projection for real names and counts; do not introduce a Phase 3 Query per row.
- **`needsDate` is capped at 200 rows** with no cursor. Beyond that the response carries a
  `needs_date_limit_exceeded` warning, exactly as the agenda does for series. A user with more
  than 200 undecided plans has a different problem and it is not one pagination fixes.
- `cancelled` and `completed` activities never appear in `needsDate`.
- The endpoint never returns `#N`. An undated `objectKind: 'task'` is Today's business, not Plans'. This
  is the mirror of the agenda's rule about `#P` and is asserted the same way — by not
  querying the bucket.
- Dated and recurring Tasks are returned from `#S` and `#R` under the same viewer-local
  boundaries as Plans. Only undated Tasks are absent because the endpoint never queries `#N`.
- No stage-level count, total, unread marker or badge field is returned. Nested RSVP-group
  `count` values and the row-level `suggestionCount` are content, not backlog totals, and must
  never be bound to tab or heading chrome. There is nothing for a client to badge, enforcing
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.3.2.

**Tests.** Integration: three seeded activities in `#P` returned newest-`lastActivityAt`
first; touching the oldest one's `lastActivityAt` updates the canonical row and its GSI
projection, which moves it to the head after eventual-index convergence rather than being
asserted on the immediately following read;
a `#N` activity appears in no stage; dated and recurring `type: 'task'` rows at the timezone
and page boundaries in `#S` and `#R` appear exactly once in the correct stage/window; a
recurring Plan series contributes one row per date in
`upcoming` inside the first 62-day window; requesting its returned `nextFrom` in
`upcoming_window` mode produces the next non-overlapping window; a 63-day request is
`validation_failed`; `past` paginates and
the cursor is opaque and user-scoped. Boundary fixtures stored in timezones on both sides of
the request timezone cross `upcomingFrom`, `upcomingTo`, and today after conversion; each
appears in exactly one viewer-local stage/window, and `nextFrom` is its converted date rather
than its raw key date. A schema test permits `rsvpSummary.*.count` and
`suggestionCount` but proves the response has no stage-level `count`, `total`, `unread` or
`badge`. Repository spies prove `initial` starts the four bucket/range streams above,
Upcoming continuation never reads Needs Date or Past, and either Past continuation never
reads Needs Date, Upcoming or Recurrence. A dense 42-day `past_window` reports partial
coverage and a cursor until the exact requested range is complete. Schema tests prove the
response union omits inactive stage keys, so client replacement cannot erase them. The
service pages streams according to their documented caps and performs no participant read, while
`series_limit_exceeded` propagates from the shared expansion path. A far-future one-off after
an empty gap becomes `nextFrom`, and the next window includes it.

---

### P3-21 — `POST /v1/attachments/upload-url`

**Where the bytes go in this phase.** The `minio` service in `docker-compose.yml`, holding a
bucket named `od-media-local`. It is reached with `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` — the same two packages, the same `PutObjectCommand`, the
same `getSignedUrl` call the deployed stack uses. `lib/s3.ts` sets `endpoint` and
`forcePathStyle` from `S3_ENDPOINT` when it is present. That is **configuration, not a code
branch**: there is no `if (local)` anywhere in the attachment path, and the same tests run
unchanged against the deployed dev bucket from Phase 4.

**Approach.** First drains the caller's at-most-20 unresolved upload records, then creates a
durable, caller-owned pending-upload record containing the `attachmentId`, declared
temporary and final keys, content type, byte size and one-day `cleanupAfter`, then
returns `{ attachmentId, uploadUrl, key }` for a presigned S3 `PUT`, with:

- **5-minute expiry.**
- `Content-Type` and `Content-Length` both bound into the signature, so the client cannot
  upload a different type or size than it declared.
- **10 MB cap**, image MIME types only (`image/jpeg`, `image/png`, `image/heic`,
  `image/webp`).
- Key `tmp/u/<userId>/<ulid>.<ext>` on upload; copied to `u/<userId>/<ulid>.<ext>` on
  confirmation. The `tmp/` prefix has a 1-day lifecycle expiry, and the pending record is
  the durable authority for retrying or cleaning a confirmation.
- Rate limited at 60/hour per user.

Bytes never pass through Lambda. Uploading through the function burns duration and hits the
6 MB payload limit.

**Edge cases.** The deployed bucket has all four Block Public Access settings on and is read
only by CloudFront via OAC. Never make it public. Those are properties of `DataStack` and
`WebStack`, asserted by the CDK tests (P0-26) rather than by MinIO, which models none of
them. Media is served by unguessable key rather than signed URL in v1 (ADR-023); the API only
ever returns keys for images the caller may see.

**Tests.** Integration against MinIO, in the same harness that runs DynamoDB Local, so they
run on a laptop and in CI with no AWS credentials: a presigned `PUT` with the declared content
type succeeds; the same URL with a different content type is rejected by the store, not by the
API; an 11 MB declaration `400`s at the API; an `application/pdf` declaration `400`s; the URL
is unusable after 5 minutes. Signature validation is the reason the store is MinIO and not a
mock — a mock that accepts every presigned URL tests nothing. Seed 20 unresolved records and
assert the drain removes expired `awaiting_upload` rows before allowing another URL; 20 live
unresolved records reject the request without creating a 21st.

---

### P3-22 — Confirm, link, delete an attachment; `primaryAttachmentId`

**Files.** `services/api/src/routes/attachments.ts`,
`services/api/src/services/attachmentService.ts`.

**What to build.** The two activity-scoped endpoints in
[`../02-architecture/api-contract.md#26-attachments`](../02-architecture/api-contract.md#26-attachments),
plus the cover rule: `POST /v1/activities/:id/attachments { attachmentId }` confirms and
links an upload, `DELETE /v1/activities/:id/attachments/:attachmentId` removes one, and
`Set as cover` is `PATCH /v1/activities/:id { primaryAttachmentId }` validated against the
activity's own `ATT#` rows (the PATCH route already accepts partial updates; the validation
is this task's).

**Approach.**

1. **Confirm.** Resolve the caller's durable pending-upload record, verify
   `tmp/u/<callerId>/<ulid>.<ext>` exists with the declared `Content-Type` and length
   (`HeadObject`), record the target Activity, and mark the record `confirming` before any permanent copy. Copy to
   `u/<callerId>/<ulid>.<ext>`, `HeadObject` the destination, then transactionally write
   `ACT#<id>` / `ATT#<attachmentId>` and consume the pending record; only then delete the
   `tmp/` object. All through `lib/s3.ts`; no local branch (P3-21's rule).
   Repeating confirm resumes from the recorded state. The same bounded pending-upload drain
   runs before another upload URL and on later attachment/detail access. It handles expired
   records by completing a verified link or deleting both keys before the record; no scan,
   DynamoDB Stream or scheduled worker is introduced in this phase.
   Therefore every crash point is discoverable—after copy but before DynamoDB is a tracked
   `confirming` operation, not an unowned permanent object.
2. The `Attachment` row carries `attachmentId`, `activityId`, `key`, `contentType`,
   `byteSize`, `createdAt`, `schemaVersion`. **Corrected 2026-08-27 (P3-22):** this task used
   to say the entity had no §4 shape and to add one.
   [`../02-architecture/data-model.md#43c-attachment-and-pending-upload`](../02-architecture/data-model.md#43c-attachment-and-pending-upload)
   has defined both `Attachment` and `PendingUpload` since P3-21, so the Zod schema is a
   **transcription** of that section — adding a second definition beside it is exactly the
   drift the one-shape rule exists to prevent. Never store or return a URL: media is served
   by unguessable key (ADR-023) and the API returns keys only for images the caller may see.
3. Owner-only add and delete
   ([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 row 8).
   Confirm is idempotent: re-confirming an already linked id returns the existing row.
4. Delete removes the `ATT#` row and the S3 object; when the deleted attachment is the
   activity's `primaryAttachmentId`, the same write clears that field, so the hero can
   never point at nothing.
5. `attachmentIds` on `POST /v1/activities` and on the schedule bridge run this same
   confirm-and-link path per id; a create carrying an unconfirmable id is
   `validation_failed` and writes nothing.

**Edge cases.**

- Confirming an id whose upload never happened, or arrived after the 1-day `tmp/` expiry,
  is `validation_failed`; the client re-uploads.
- Another user's `attachmentId` is `not_found` — the key is derived from the *caller's* id,
  so it cannot resolve to someone else's object.
- Attachments never bump `icsSequence`
  ([`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity)).
- **Cap: 20 attachments per activity** (decision recorded here — raise in PR if wrong).
  The 21st confirm returns `validation_failed`.
- `primaryAttachmentId` naming an id not linked to this activity is `validation_failed`.

**Tests.** Integration against MinIO and DynamoDB Local: presign → `PUT` → confirm moves
the key out of `tmp/` and writes exactly one `ATT#` row (acceptance criterion 24);
inject a crash after the permanent copy but before the final transaction, then retry/repair
and assert it produces exactly one linked row or deletes both objects with no orphan;
re-confirm is idempotent; delete removes row and object, and deleting the cover clears
`primaryAttachmentId` in the same write; confirm with no uploaded object `400`s and writes
nothing; setting the cover to a linked id succeeds and to an unlinked id `400`s; none of
these writes bumps `icsSequence`.

---

### P3-24 — Shared API client: lists, templates, items, attachments, updates

> **Amended 2026-08-25 (founder).** The Plans reader also surfaces `pastBefore` (P3-20), and
> its typing must make the exclusivity unrepresentable rather than merely documented: a Past
> request carries **either** a landing date **or** a continuation cursor, never a shape that
> can hold both. Responses merge into a **date-keyed** store rather than one cached by window
> bounds — a month grid can request up to 42 days, so consecutive months overlap, and keying
> by bounds would re-fetch and re-store the overlap while making "August → September → August"
> free only if the exact bounds repeat. The same store is what lets P3-47 answer which ranges
> have actually been loaded, which its no-dot-means-no-claim rule depends on.

**Files.**
`packages/shared/src/client/endpoints/{lists,listItems,listTemplates,attachments,updates}.ts`.

**Approach.** Extends the P1-20 client the same way: one function per endpoint in
[`../02-architecture/api-contract.md#25-updates-the-plans-activity-feed`](../02-architecture/api-contract.md#25-updates-the-plans-activity-feed)
§2.5–§2.7, typed from the shared schemas, returning parsed data or throwing `ApiError`,
each registered with the OpenAPI harness as it is written. The task is mostly mechanical;
these contract points are not:

- `patchList` accepts `title`, capabilities, slot and `archived`, but not `behaviour`.
  `changeListBehaviour` calls replay-protected `POST /v1/lists/:id/behaviour`, requires
  `If-Match`, takes `confirmation?: ListBehaviourConfirmation`, and surfaces the destructive
  `409` as a typed value carrying the server's behaviours, item version, field list and
  affected-item count, so P3-32 can render and echo it instead of re-deriving state from a
  paginated cache.
- `scheduleListItem` sends `ScheduleListItemInput` exactly. No convenience overload defaults
  `activityId`, `creationTarget` or `audience`; an omitted field fails at the schema, loudly.
- `undoListOperation` sends only the opaque token returned by an item, bulk, archive or
  additive-settings mutation. It never reconstructs rows or a settings inverse client-side.
- `addMealIngredientsToList(activityId, { listId, ingredients })` calls the dedicated
  activity action. It sends selected stable source ingredient ids and optional stable
  destination item ids, never client-supplied provenance. No wrapper routes this through
  ordinary item bulk.
- `getListTemplates()` sends `If-None-Match` and honours the 24-hour cache headers. The
  mobile creation sheet does not call it — it uses P3-07's bundled projection — so nothing
  in this file is a startup dependency.
- Attachments are two functions: `requestUploadUrl({ contentType, byteSize })`, and a
  separate `putToUploadUrl(url, bytes, contentType, onProgress)` that performs the raw
  presigned `PUT` with **no `Authorization` header** and no envelope parsing. S3 is not the
  API, and forwarding the bearer token to a storage URL is a leak.
- Item mutations carry the `Idempotency-Key` (`bulk` especially); reorder sends
  `afterItemId` and no function anywhere accepts a `rank` parameter (P3-03's rule).
- Create functions expose the optional stable `listId` / per-item `itemId`, and the client
  includes an exact-item GET for collision reconciliation. No wrapper drops or regenerates
  an id while retrying the same durable action.
- List detail and item-page responses preserve the opaque item cursor; no client assumes the
  first 50 items are the whole list.
- List responses type `viewerLink` as the caller's link. There is no field for other
  viewers' links to filter client-side, because the server never serialises them.

**Tests.** Unit per endpoint with a stubbed `fetch`: request shape, response parsing, error
mapping. Plus: the `409` destructive-change mapping produces the typed fields-and-count
value; `putToUploadUrl` sends no `Authorization` header (spy on headers); a type-level or
grep test that no exported client function has a `rank` parameter.

---

### P3-25 — Lists index screen

> **Amended 2026-08-25 (founder).** The count line below is confirmed as written — `n items`
> plus `· k checked` for a checkable collection, from `META` — and `design-system.md` §7.2 was
> corrected to match, having specified template-supplied vocabulary that no catalogue field
> could supply. Two additions: the card also renders `Updated today` from **`lastItemActivityAt`**
> (P3-46), never `updatedAt`; and the stored `icon` only resolves once **P3-45** exists, since
> eleven of the seventeen templates name glyphs the registry does not yet have. **This task now
> depends on P3-45 and P3-46.**

**Files.** `apps/mobile/app/(app)/(tabs)/lists.tsx`,
`apps/mobile/src/features/lists/{hooks/useLists.ts, components/ListIndexRow.tsx}`.

**What to build.** The Lists tab over `GET /v1/lists`, plus the `+` that opens P3-26 and a
header `⋯` holding `Show archived`
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.6).

**Approach.**

- A row renders the List's own stored `icon`, its title, and a de-emphasised
  `n items` — with `· k checked` appended only when
  `behaviour === 'collection' && capabilities.checkable`, mirroring the plan-detail
  LISTS line — all from the `META` fields in the response. The renderer imports nothing
  from the catalogue and never resolves `templateKey` (ADR-032; same CI grep as P3-28).
- Row tap opens the list (U1). Swipe-left per
  [`../01-product/interaction-contract.md#3-gesture-table`](../01-product/interaction-contract.md#3-gesture-table)
  §3.2: `Archive` · `Delete` on an owned list, keyed off the pointer's `role` so the
  member variant (`Leave`) is one branch in Phase 6, not a rewrite.
- **Ordering is the server's stable pointer order** — lexicographic list id, with no claim
  that client-minted ids represent chronology — and no client re-sort (decision recorded
  here — raise in PR if wrong). §3.2 offers a long-press
  `Reorder lists`, but `ListIndex` carries `role` and `addedAt` only
  ([`../02-architecture/data-model.md#33-list-partition`](../02-architecture/data-model.md#33-list-partition))
  and acceptance criterion 27 forbids adding attributes to the pointer, so there is
  nothing to persist a manual order to. Do not build index reordering in this phase;
  raise the doc conflict in the PR rather than resolving it silently.
- Archived lists are filtered out of the main render on `archived` and shown by
  `Show archived` as a separate de-emphasised group with one-tap restore — a client-side
  filter over the same response, not a second endpoint. `GET /v1/lists` pages all access
  pointers and may return a page containing only archived META rows.
- **Auto-drain filtered pages.** Continue while the active filtered collection cannot fill
  the viewport and `nextCursor` exists. An empty filtered page is not completion, and
  `No lists yet` is legal only after the cursor is exhausted. Opening `Show archived` first
  uses materialized pages, then continues draining if that view still cannot fill. Bound the
  synchronous work per render cycle and schedule further pages asynchronously so a long run
  of filtered rows cannot monopolise rendering.
- Empty state, verbatim from §5.9: `No lists yet` /
  `Keep things you want to remember, track, or organise together.` / `New list`.
- Pagination at 50 pointers per page, auto-fetch at 80 % scroll depth. Native pages are
  materialized into typed SQLite rows and served through repository subscriptions, with
  creates in the same transactional outbox; web uses its TanStack cache.

**Tests.** Render: a fixture whose catalogue record is mutated after creation still renders
the stored icon and copy; a watch list retaining `checkable: true` and checked rows renders no
checked count; an archived list is absent until `Show archived`; the empty state
matches §5.9 exactly; rows render in response order for a deliberately shuffled fixture —
  no client sort; the first 50 pointers archived and page two active neither shows `No lists
  yet` nor requires scrolling an invisible collection; opening `Show archived` reuses those
  first-page rows and continues draining when needed; a grep test that the feature directory imports no `LIST_TEMPLATES`;
navigation test that tapping a row opens list detail and issues no mutation.

---

### P3-26 — The template-first list creation sheet

**Files.** `apps/mobile/src/features/lists/components/NewListSheet.tsx`,
`apps/mobile/src/features/lists/hooks/useCreateList{,.native}.ts`. The component sits under
`components/` per [`../04-conventions/repo-structure.md`](../04-conventions/repo-structure.md)
§7, which binds implicitly (agent-playbook §1.1a); the platform-split hook is the same rule
that puts `useLists` beside it.

**What to build.** The `+` on the Lists index. **Template/style first, title second.** The
sheet opens on P3-07's bundled projection of `LIST_TEMPLATES`, with the full explicit
catalogue, no selected card and no text field yet.

**Approach.** The user taps one style, such as `Blank`, `Checklist`, `Groceries`,
`Watchlist`, or `Restaurants to try`. The next step shows the chosen style and a visible,
focused title field pre-filled with that template's `defaultTitle`. The user may edit it;
the exact final action is `Create list`.

The typed title never changes, replaces or recommends a template. There is no no-selection
fallback to `simple-list`; choosing `Blank` is an explicit tap like every other style.
The style preview renders the selected record's exact `summary`; it does not generate a
description from capabilities or claim a Plan kind will be selected. The title can be renamed
later only through the inline List header editor; behaviour, capabilities and slot can be
changed in list settings (P3-32). `templateKey`, icon and empty-state guidance remain the
frozen values copied from the chosen style.

**Edge cases.**

- No style is auto-applied or pre-selected. Title entry is unavailable until one is chosen.
- P3-07's projection of the shared `LIST_TEMPLATES` module is bundled with the mobile client,
  so the sheet works on first launch offline; the confirmed create mints one monotonic
  `lst_` identity, then atomically stores the visible row and queued create. Transport retry
  reuses both that id and the mutation id. `GET /v1/list-templates` exposes that same module to other
  clients and contract tests, not a second catalogue or a required mobile startup fetch.
- Creating from a plan's `Add list` sheet (P3-38) enters the same full fixed-order catalogue
  with **none selected**. Plan kind, title and participants do not group, rank, hide or select
  styles. The title is pre-filled only after the user's explicit style tap.

**Tests.** Playwright: the sheet opens with the catalogue and no selection; there is no title
field or enabled `Create list` yet. Choose Groceries, edit its visible title to `Costco run`,
tap `Create list`, and assert the stored `templateKey` is still `groceries`. Choosing
`Blank` explicitly creates `simple-list` with the visible title pre-filled as `Simple list`.
A test asserts title changes never trigger a
template or model request.

---

### P3-27 — List detail and explicit item destinations

**Approach.** List detail renders the exact contextual action `+ Add an item`. It opens the
item form with the current list already fixed, and the final action reads
`Add to {list name}`. Global `+` → `List item` opens a list picker first, with no selection;
only after the user chooses a list does the same item form open.

The global route never uses `defaultLists`, most-recently-used, list behaviour, title words or
template metadata to choose the destination. `defaultLists` belongs only to named flows
such as `Add ingredients to:`. Both routes send the same `POST /v1/lists/:id/items` request,
with the path's `:id` equal to the list visibly named on the final button. Native confirmation
mints one monotonic `itm_` identity, then atomically stores the visible item and queued create;
retry reuses both stable ids.

Camera / Photos / Link are available only after that destination exists. Their Phase 1 stubs
receive `{ objectKind: 'listItem', listId }`; Phase 8 may fill compatible item fields but may
never return a different list.

With zero items, detail renders fixed heading `Nothing here`, the List row's stored
`emptyStateCopy`, and `+ Add an item`. It never looks up `templateKey` or regenerates guidance
from behaviour or capabilities.

The initial detail response contains at most 50 items and an opaque cursor. Fetch subsequent
pages at 80% scroll depth through `GET /v1/lists/:id/items?cursor=` and merge by `itemId` in
authoritative `(rank, itemId)` order. `itemCount` comes from META; no empty-state decision or
bulk operation mistakes an unloaded page for the whole list.
If an item-page request crosses rank repair, behaviour migration, or a version fence, the
implemented contract is `503 internal` with `Retry-After: 1` and no rows. Retain the current
committed projection, discard every item cursor, wait for `Retry-After`, and restart from page
one. Replace the projection only after page one succeeds; never merge a post-repair page into
pre-repair pages. This retry is projection recovery, not a `409` edit conflict.

**Tests.** Enter `Try Zahav` through global `List item`, assert no form or capture call exists
before selecting `Restaurants to try`, and assert `Add to Restaurants to try` writes one item
there. Enter the same words through `+ Add an item` inside another list and assert they stay in
that list. A recent/default list is seeded and proved not to pre-select either route. Mutate
the selected catalogue record after creating an empty List and assert detail still renders
the stored guidance with `Nothing here`. A `503` item page with `Retry-After: 1` keeps the
committed rows visible, clears every cursor, waits, restarts at page one, and installs no new
projection until that first page succeeds.

---

### P3-28 — The capability-driven item renderer

**Files.** `apps/mobile/src/features/lists/ListItemRow.tsx`.

**What to build.** **One** row component for every list in the product. It reads the list's
`behaviour` and `capabilities` and renders accordingly. If this component ever contains a
comparison against a template key, the model has been misunderstood.

| Input | Effect on the row |
| --- | --- |
| `behaviour: 'collection'` and `capabilities.checkable` | Renders the checkbox and the struck-through checked state |
| `behaviour: 'collection'`, `capabilities.supportsLocation`, and `item.location` | Renders the location subtitle and the maps tap target |
| `behaviour: 'watch'` | Renders `S2 E4` and the status chip instead of a checkbox |
| `behaviour: 'meals'` | Renders the ingredient count |
| Caller-scoped `viewerLink` whose hydrated Activity has `schedule.date` | Renders the state line (P3-34) |
| `item.sourceLabel` | Renders `— Sunday dinner` |

**Edge cases.**

- A row must render correctly for a list whose capabilities were changed a second ago. A
  P3-09 behaviour migration never supplies half-backfilled rows: the server returns the
  retryable `503` and the client keeps its last committed projection until a full target
  generation is available. Missing typed `details` in an otherwise committed `watch` or
  `meals` response is invalid data, not a default the renderer invents.
- Item metadata and caller state occupy independent slots. Render every applicable provenance
  label and location line without hiding either, then render the caller-scoped state line as
  its own tap target (P3-34). A linked item may therefore legitimately use more than one line.
- `checked` is retained when either half of the operational gate is false: a non-collection
  behaviour or `capabilities.checkable === false`. The renderer hides it; it does not clear it.

**Tests.** Render tests over a matrix of behaviour × capability combinations, asserting the
checkbox appears exactly when `behaviour === 'collection' && checkable`; `watch` and `meals`
never render one even when the stored capability is true. Location likewise appears exactly
for a qualifying collection; fixtures changed from collection to `watch` and `meals` retain
both the flag and stored location but render neither the subtitle nor maps target. A
qualifying collection test proves provenance, location and a caller state line all remain
visible together, with the state line retaining its separate tap target. A lint-level
assertion — or a grep test in CI — that the file contains no template key string.

---

### P3-29 — List item sheet, and the shared item PATCH pipeline

> **Amended 2026-08-28 (founder).** This task also owns the **one** item mutation path, web and
> native, and both callers of it: the sheet's field edits and **P3-28's row checkbox**. That is
> a clarification rather than added scope — the sheet already committed optimistic item
> `PATCH`es, and the checkbox is the same write with one field — but it needed saying, because
> the phase table had no task that owned check/uncheck and P3-28 shipped the control
> deliberately disabled while none existed. Raised in P3-28's PR.

**Files.** `apps/mobile/src/features/lists/components/ItemSheet.tsx`,
`apps/mobile/src/features/lists/hooks/usePatchListItem{,.native}.ts`,
`apps/mobile/src/features/lists/hooks/useListItemActions.ts`,
`apps/mobile/src/features/lists/model/{itemSheet,itemUndoToast,undoOffer,checkedOverride}.ts`,
wiring in `ListDetailScreen.tsx` and the `/lists/:listId` route.

The PATCH hook stays **inside the feature**: `repo-structure.md` §3.2 moves a thing up to
`src/hooks/` when *two features* need it, and both callers — the sheet and P3-28's row — are
`features/lists`. The parenthetical in the amendment above allows exactly this.

Its native half extends the P3-27 inventory rather than adding a domain:
`lib/sqlite/{listItemsRepository,listTransactions,syncEngine,outbox}.ts` and
`lib/sync/pushAdapter.ts` learn the `['list','item-patch']` intent — the merge, the route, the
settlement, the rejection rollback, and the protection of a pending edit from a page that
predates it.

**What to build.** The sheet opened by tapping an item row's body (U1). Per
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.6: title, note,
the fields this list's capabilities and behaviour allow (§5.7), `Plan this item`, `Delete`.
(Moving an item between lists is not in v1.)

**Approach.** The field set is driven by the list row's `behaviour` and `capabilities`,
exactly as P3-28's renderer is — no template-key comparison, same CI grep:

- Every behaviour: editable title and note, plus the provenance row `From Chicken tacos`,
  navigable while `sourceActivityId` still resolves and plain text once it does not (§7.5).
- `collection` with `supportsLocation`: place label and optional address, the address
  tappable through to the platform maps app.
- `watch`: `mediaKind`, the status control (`want` / `watching` / `watched` — any → any is
  manual here, §8.1), season and episode for a show only, and `Mark as watched`.
- `meals`: the typed ingredient rows (name + optional quantity) and the
  `Add ingredients to…` entry into P3-42's destination flow.
- When the response carries the caller's `viewerLink` **and its hydrated Activity has
  `schedule.date`**, the state line renders with its own tap target opening the Activity
  (§6.2). An unscheduled link remains stored but has no state line.

Each field edit commits one optimistic `PATCH /v1/lists/:id/items/:itemId`, **through the one
mutation path this task builds**. Three rules bind every caller of it, the checkbox included:

- **The absolute value, never a toggle.** A checkbox sends `checked: next` — the value the row
  was displaying, flipped once, here — and never `checked: !checked` computed at the server or
  from a re-read. §5.11.5's first row is the reason: two people ticking `Milk` at the same
  moment, one of them offline in a shop, must end with it checked once, with no flicker and no
  un-tick when the queue drains. A set is idempotent and survives the offline queue with no
  merge logic; a toggle does not.
- **No `If-Match`.** Item writes are per-field last-write-wins (§5.11.5's recorded decision);
  optimistic concurrency on a checkbox produces constant spurious `409`s in exactly the
  situation the feature exists for.
- **Durable and replayable on native**, on the P3-27 pattern: the visible change and its outbox
  intent commit in one SQLite transaction, ordered behind that list's other work, with a stable
  mutation id so a replay after the idempotency receipt expires is the same write rather than a
  second one. Web stays online-first. `Plan this item` opens P3-33
and is one action among several, never the primary one (§5.1). `Delete` deletes with **no
confirmation** and returns P3-10's opaque token for a 6-second undo that restores the same
item id, previous rank, live viewer links and Activity provenance
([`../01-product/interaction-contract.md#4-undo-policy`](../01-product/interaction-contract.md#4-undo-policy)).
Focus lands on the first control, is trapped, and returns to the row on close
(interaction contract §7.3).

**Edge cases.**

- While P3-09 carries a behaviour-migration gate, opening or saving the item receives the
  retryable `503` and retains the last committed projection. The sheet never renders
  target defaults over an old-behaviour row or serialises a migration-internal mixed shape.
- Renaming an item with a `viewerLink` renames the item only; the Plan title is
  independent after creation (P3-14).
- Checking an item from the row and editing a field in the sheet are the **same** durable
  write with different fields. A test that ticks a row offline, backgrounds and replays must
  produce one `PATCH`, and the row must not un-tick when the queue drains.
- A status change made here regroups the row when the user returns to the list, at its
  rank within the new group (P3-31).

**Tests.** Render matrix over behaviour × capabilities asserting exactly the §5.7 field
set appears — a location field on a `supportsLocation: false` list is absent, not
disabled; delete shows no dialog and shows the undo toast; Playwright: rename an item,
open its linked Plan, assert the Plan title is unchanged; the CI grep for template keys.

**Decisions recorded while building this (2026-08-28), each raised in its PR.**

- **Provenance resolvability is a client-side reading, not a field.** Nothing on the wire says
  whether `sourceActivityId` still resolves, so the row offers navigation until an attempt
  meets a `404` and degrades to plain text for the rest of the sheet's life. **Only** a `404`:
  offline or a `5xx` still navigates, because a row that went dead in a tunnel would be lying
  about the data.
- **A builder writes only when something changed.** The sheet commits on blur, so tapping
  `Delete` blurs the title — a write fired there would race the delete that caused it, and on a
  shared list would re-assert an untouched field over another member's edit under
  last-write-wins.
- **`Mark as watched` is absent once the item is `watched`**, like every other control this
  phase offers only when it can be taken. The any→any chips remain.
- **Deleting one item is online-first on both platforms**, matching `Clear checked` and
  `Uncheck all`, which are §P3-10's other half and already delete items through one online
  call. Undo *is* the server's opaque token, so an offline delete would have nothing to offer
  it with until acknowledgement. The consequence is that
  [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §5.4's "Undo
  while offline: works" is not yet true for this action on native; closing it needs the
  item-scoped equivalent of the archive Undo offer the outbox already keeps for lists, which is
  **not** in this task.

**Not built here, and why.**

- **`Plan this item`** (P3-33) and **`Add ingredients to…`** (P3-42) are **absent, not
  disabled**. Both name a flow this build does not have, and §5.6 offers an action when it can
  be taken.
- **The §6.2 state line inside the sheet.** Its eligibility rule is P3-28's
  (`mayShowPlanStateLine`) and its wording is P3-34's, and no projection carries the
  `viewerLink`/`viewerPlan` pair yet: `useListDetail` keeps only `entry.item` on web, and the
  native `list_items` slice has no columns for a per-viewer pointer. Rendering it needs those
  three pieces, and the row renderer already takes the props for when they exist.

---

### P3-30 — Drag to reorder

**Files.** `apps/mobile/src/features/lists/model/reorder.ts` (the feature's pure models live
in `model/`, as `listItemRow.ts` and `listDetail.ts` already do),
`apps/mobile/src/features/lists/components/ReorderableList{,.web}.tsx`,
`apps/mobile/src/features/lists/hooks/useReorderItems.ts`, and wiring in the list screen.

`ListItemRow.tsx` is **not** touched: the drag wraps the row rather than entering it, which is
what keeps P3-28's one renderer one renderer. The projection hooks gain a single `applyRank`,
and `ListItemsRepository` a single `setRankLocal`, because the optimistic drop, the server's
answer and the revert are one write with three values and native's is a SQLite transaction
(ADR-057).

**What to build.** Long-press starts the drag (the interaction contract's supporting
rule); dropping issues **one** `PATCH /v1/lists/:id/items/:itemId` carrying `afterItemId`
— the id of the item now immediately above, absent for the head. The client never computes
or sends a rank; the server converts via P3-03.

**Approach.**

- Reanimated + gesture-handler on the native thread, the same stack as the swipe rows. Web
  uses the hover drag handle
  ([`../01-product/interaction-contract.md#71-hover-and-pointer`](../01-product/interaction-contract.md#71-hover-and-pointer)).
- Optimistic: the row lands where dropped; the authoritative order is the server's
  `(rank, itemId)` through the one exported `compareListItems` — no local comparator
  (acceptance criterion 29).
- On a `watch` list the drag is constrained to the item's current status group. Dragging
  across a heading would change `watchStatus` by gesture, which no spec grants — status
  changes are explicit controls in the item sheet (decision recorded here — raise in PR if
  wrong).
- Checked items reorder like any other and stay where they are put (§5.6).
- Reorder is available while online on native and web. If the connection is unavailable at
  drop, the row returns to its original position and the app shows
  `Reordering needs a connection.` No reorder intent enters the outbox and no `Pending` state
  is materialized. An online request still carries its stable `Idempotency-Key`.

**Edge cases.**

- Dropping a row back where it started issues no write.
- Two members reordering concurrently race on `rankVersion`; one retries against fresh
  neighbours, so new writes receive distinct ranks. The `(rank, itemId)` tie-break remains
  defensive for restored or legacy duplicate rows.
- A reorder racing any item-field PATCH also retries on the row/locator `itemRevision`; its
  eventual full-row move is built from refreshed truth and cannot erase the field assignment.
- A failed `PATCH` reverts the row with the standard error toast and `Retry` (§5.3).
- Reduce Motion: the drag still tracks the finger — direct manipulation, not decorative
  motion (§6.5). No haptic on drop; haptics are completion and swipe-commit only.

**Tests.** A spy asserts an online request carries `afterItemId` and no `rank`, and that one
online drag issues exactly one mutation. An offline drop springs the row back, shows the exact
connection message, and issues and enqueues nothing. A concurrent-move test forces one
`rankVersion` conflict and proves the retry uses fresh neighbours. A fixture with restored or legacy
duplicate ranks renders in `compareListItems` order both times it is shuffled; render test that the drag cannot cross
a watch group heading; a no-op drop issues no request.

The `rankVersion` conflict and its retry are the **server's**, and they are tested there:
`listRepository.test.ts` forces the conflict and `listItems.int.test.ts` proves a reorder is one
transaction of four domain actions that advances the version. The client has no part in that
retry — it sends one position and reads one answer — so it is referenced from here rather than
re-tested against a mock of the thing being asserted.

**Decisions and corrections recorded while building this (2026-08-28), each raised in its PR.**

- **A drag to the head sends `afterItemId: null`, not an absent field.** This section says
  "absent for the head", but
  [`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists)
  §2.7 and `patchListItemInput` both say the opposite in as many words — "`null` moves the item
  to the front… absent means **no reorder at all**, which is why it is nullable rather than
  merely optional" — and `listItems.int.test.ts` moves a row to the top by sending `null`. The
  architecture doc wins on mechanics (playbook §2), and it is also the only reading under which
  a drag to the head does anything. **This section's prose should be amended to say `null`.**
- **The request carries no `Idempotency-Key`.** This section says "an online request still
  carries its stable `Idempotency-Key`", but §2.7 and `routes/lists.ts` both say only the
  mutating `POST`s take that header, and `patchListItem` deliberately sends none because the
  route is not replay-protected. A reorder is idempotent by construction anyway — `afterItemId`
  is an absolute position — so the stable per-drag key is held on the client, where it makes a
  `Retry` re-send *that* drag rather than a second one, and refuses a `Retry` the user has
  already superseded with another drag.
- **A provisional local rank is computed for the optimistic row and never sent.** "The client
  never computes or sends a rank" is read as *never sends*, which is the reading P3-27 already
  established in merged code: `pendingListItem.ts` runs the same `lexoRankBetween` for an
  appended create, stores it, and lets acknowledgement replace it. Equal adjacent ranks make the
  computation impossible, and that is handled rather than worked around — the row simply does
  not move until the server answers.
- **Web's drag handle is also a keyboard grab.** §7.1 ends with "hover-revealed controls are
  always **also** reachable by keyboard and are never the only path to an action", and a pointer
  drag is unreachable without a pointer. `Return` picks a row up, `↑`/`↓` move it, `Return`
  drops it and `Escape` puts it back — one drag and one request, not one request per keypress.
  §7.2's arrows still move focus between rows everywhere else; the override lasts only while a
  row is deliberately held.
- **The watch range always includes the row's own position**, so a drag can put a row back where
  it came from even when its group has one member. Refusing that would stop a cancelled drag.

---

### P3-31 — Watch behaviour: grouped items and progress UI

**Files.** `apps/mobile/src/features/lists/components/WatchSections.tsx` and
`SwipeableWatchRow{,.web}.tsx`;
`apps/mobile/src/features/lists/model/{watchSections,watchProgress,watchUndoToast}.ts`;
`apps/mobile/src/features/lists/hooks/useWatchActions.ts`; wiring in the list screen. The
feature's pure models live in `model/` and its components in `components/`, as
`listItemRow.ts` and `ListItemRow.tsx` already do.

`ListItemRow.tsx` is **not** touched. A watch row's status chip, its `S2 E4` and the absence of
a checkbox are all P3-28's and already correct; §3.2's swipe wraps the row rather than entering
it. `listItemRow.ts` gains only the `WATCH_STATUS_LABELS` record its own comment anticipated —
"so the chip and P3-31's group heading say the same words about the same item".

**What to build.** The one grouped item list in the product
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.2): a `watch`
list renders three sections in fixed order — `Watching`, `Want to watch`, `Watched` — each
holding P3-28 rows sorted by `(rank, itemId)` within the group.

**Approach.**

- Grouping is a pure projection over the flat item response keyed on
  `details.watchStatus`. A group with nothing in it is omitted rather than rendered empty
  (decision recorded here — §5.2 fixes the order but not empty-group rendering, and the
  Plans-tab always-render rule is explicitly about stages, not list groups — raise in PR
  if wrong).
- A show renders `S2 E4`; a movie renders no progress line; the status chip replaces the
  checkbox (P3-28). No checkbox exists on any watch row.
- Manual transitions: `Mark watched` from the item sheet or the row's swipe action
  ([`../01-product/interaction-contract.md#3-gesture-table`](../01-product/interaction-contract.md#3-gesture-table)
  §3.2) — an ordinary `PATCH` with the 6-second undo. `watching → watched` is manual only;
  the app does not know how many episodes there are (§8.1).
- This task provides the **progress-update mutation** that P3-43's follow-up calls: one
  `PATCH` setting season/episode to the session's values and, only when the item was
  `want`, `watchStatus: 'watching'` — one write, its own undo toast (§8.4). Dismissal
  calls nothing. The follow-up's presentation belongs to P3-43; building any of it here
  duplicates the confirmation slot.
- A status change regroups the item under its new heading at its existing rank; nothing
  else about the row changes — no move to top, no highlight.

**Edge cases.**

- P3-09 back-fill rows never reach this component. While migration is gated, keep the prior
  committed sections; after it commits, every `watch` item has typed details. A committed
  `watch` row with missing details is rejected by the response schema rather than silently
  placed in `Want to watch`.
- A list changed away from `watch` renders flat immediately; the sections component is
  chosen off the row's stored `behaviour`, nothing else.

**Tests.** Render: fixed group order with a shuffled fixture; movie vs show progress
line; a status `PATCH` regroups while preserving rank; an empty group's heading is
absent; unit test that the progress-update mutation applies `want → watching` only from
`want` and touches no other field; the template-key grep.

**Decisions recorded while building this (2026-08-28), each raised in its PR.**

- **An empty group renders no heading**, which is the decision this section already asked to be
  recorded. §5.2 fixes the order of the three sections and says nothing about rendering an empty
  one, and the always-render rule that does exist is the Plans tab's, explicitly about **stages**
  rather than list groups. Two empty headings on a two-item watchlist would be scaffolding
  describing a state the user is not in.
- **Each section is its own drag surface.** P3-30's `reorderRange` already clamps a watch drag to
  the item's status group; giving each section its own `ReorderableList` makes that *structural*
  — there is no gesture that crosses a heading, rather than one the finger discovers at the edge.
  `groupDropIndex` translates a drop among a group's rows back into the flat position
  `afterItemId` names a neighbour in, so ranks stay global and interleaved. That is why a status
  change regroups a row at its existing rank: nothing was ever grouped in storage.
- **The mutation covers both arms of `completionFollowUp`**, not only `watch_progress`. The
  movie arm's `Update {list name} item to Watched?` is §8.4's own copy and its confirmation is a
  tap with its own undo, not the automatic transition §8.1 forbids. Typing the input as the
  whole union is what stops P3-43 re-deriving the other half — which is the point of typing it
  from the payload at all.
- **A committed watch row with no typed details is kept and left unclassified.** The response
  schema is meant to reject it; if one arrives anyway it renders without a heading rather than
  being filed under `Want to watch`, which is P3-28's rule for the same data one level down.
  Dropping it would hide a row the user owns.
- **`Delete` is listed and, since P3-29 landed, wired.** §3.2 gives this row `Mark watched` ·
  `Delete`; `watchItemSwipeActions()` states both and their order, and the component renders an
  action only where the caller supplied a handler. Both handlers exist now.

**The P3-29 seam, closed when it landed (2026-08-28).** `Mark watched` goes through
`usePatchListItem` — the one item-write path — so on native the row and its
`['list','item-patch']` intent commit together and the swipe works with no signal. The row it
names is on screen, so the committed local row that path requires is there by construction.

`confirmFollowUp` stays **online-first**, and that is a precondition rather than an oversight:
the durable path reads the committed row inside its writer transaction and refuses an item this
device does not hold, and §8.4's follow-up is confirmed from **Today**, about a list the device
may never have opened. Making it durable needs the intent to carry the item rather than find it.
**That is P3-43's to answer**, with the surface that offers the question.

---

### P3-32 — Inline List title edit; settings for capabilities, slot and behaviour

**Files.** `apps/mobile/src/features/lists/components/{ListHeader.tsx, ListSettingsSheet.tsx}`
— under `components/`, where `repo-structure.md` §7 puts a feature's components and where every
sibling in this slice already lives (`ListHeaderMenu.tsx`, `ItemSheet.tsx`). Corrected in P3-32.

**What to build.** Rename is inline on the List header title: activating the title swaps it for
a focused text field, and save/cancel returns focus to the title. It is not duplicated in the
`⋯` settings sheet. The sheet is the client half of P3-09: toggle `checkable` and
`supportsLocation`, set or clear the default-destination `slot`, and change behaviour. There
is no setting for what Plan kind an item creates; `Plan this item` always asks explicitly.
Checkbox and location capability controls are shown only for `collection`; switching to
`watch` or `meals` retains their stored flags and item values but hides the controls and all
checkbox-derived counts and bulk actions.

**Approach.** Which changes are additive and which are destructive, and the required shape
of a destructive confirmation, are fixed by
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a-product-wide-invariants)
§1a.1. Additive toggles and behaviour upgrades apply immediately with a 6-second undo toast
and no dialog. Only destructive behaviour changes go through a confirmation in that shape:

- Upgrading (`collection → watch` or `meals`) previews what is gained — for example,
  "Items will gain a watch status, season and episode" — applies optimistically on selection,
  enqueues `changeListBehaviour` with one stable idempotency key, and offers Undo instead of
  confirmation.
- Downgrading (`watch` or `meals` → anything) sends the behaviour `POST` **without** a
  `confirmation`, receives the `409`, and renders the server's field list and item count
  verbatim, in the dialog
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.5 mocks — heading,
  `This will remove:`, `Watch status, season and episode from 7 items`, and the `Keeps:` line.
  That direct online preview carries its own key but is not accepted into the outbox.
  Only on confirm does the client enqueue a new replay-protected call with the complete
  `confirmation` object echoed in its body and its own stable idempotency key.

> **Amended 2026-08-28 (P3-32) — the quoted sentence pointed at §5.5 instead.** This bullet
> used to spell the dialog out as *"This will remove season, episode and watch status from 7
> items. This cannot be undone."* Three things about that paraphrase disagreed with
> [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.5, which mocks the
> same dialog and outranks this file on behaviour: the field order is the server's
> (`Watch status, Season, Episode`), §5.5 carries a `Keeps:` line naming what survives, and it
> has no "cannot be undone" sentence —
> [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §1a.1's
> required shape does not include one either, and names `This can't be undone.` *alone* as a
> defect. Nothing about the protocol changes; only the illustrative copy, which now points at
> the one place that owns it.

> **Decision:** the client asks the server what would be lost rather than computing it
> locally. A count computed from a paginated cache would be wrong for a long list, and being
> wrong in the sentence that precedes irreversible data loss is worse than a round trip.

Setting `slot` shows what it means in plain words — "Send ingredients here by default" —
because a slot is otherwise invisible until it changes where something lands.

Changing behaviour or capabilities never changes `templateKey`, icon or empty-state
guidance. The behaviour-change copy previews that those presentation values stay as they are;
the List continues to render its own stored fields rather than adopting another template.

**Edge cases.**

- Destructive changes get a confirmation dialog and **no undo**, per the product's undo rule.
  Additive ones get the opaque server Undo token and no dialog. In particular, undoing a
  behaviour upgrade calls `POST /v1/lists/:id/undo`; it does not issue an ordinary destructive
  downgrade behaviour POST. If affected defaults were edited after the upgrade, the typed
  `no_longer_applicable` response leaves the current list untouched.
- Clearing a slot that is the profile default also clears `defaultLists` for that slot, and
  the sheet says so. The one List PATCH performs the server-side conditional nested removal;
  the client does not issue a second profile request that could partially succeed.
- The sheet is a settings surface, not a wizard: every control is independent and applies on
  its own.

**Tests.** Playwright: activating the header title renames inline and the settings sheet has no
Rename row; turning off `checkable` hides the checkboxes and turning it back on restores the
previous checked state; a `collection → watch` change applies with no dialog and its undo
toast restores the collection behaviour; a `watch → collection` change shows the exact
server count in the dialog, and cancelling it leaves every item's `details` intact; confirming
it succeeds; the upgrade and confirmed downgrade each reuse one idempotency key across
transport retries; the undo toast on an additive toggle reverts the change.

---

### P3-33 — The `Plan this item` kind-and-audience sheet

**Approach.** One sheet, opened from the exact list-item action `Plan this item` or its swipe
equivalent. Step one requires `General`, `Meal`, `Watch`, or `Event`; nothing is pre-selected
from the list. Step two is the required audience step. In this personal phase it contains
`Just me`, initially unselected, and the user must tap it; Phase 6 expands the same step to the
final unselected `Just me` / `Choose people` pair. Step three opens the matching Plan-kind form
with compatible item fields pre-filled. Confirming issues one bridge call with required
`creationTarget` and the audience the user explicitly tapped.

The user can edit all compatible fields before confirming. The selected kind changes only by
returning to the explicit kind step; no title, behaviour, capability or parser result
changes it. Nothing is written until confirmation, whose final button reads `Save plan`.

**Edge cases.** After the user explicitly chooses `Watch`, structured watch fields may be
offered from the item and remain editable. A `watching` item at S2 E4 may offer S2 E5; that
offer does not select Watch and does not exist in another kind's form. `audience.mode` can
only become `just_me` in this phase, but only after the visible tap; it has no initial value.

**Tests.** Playwright: open `Plan this item` on `Severance`, assert all four kinds and no
selection, choose `Watch`, assert the form is still closed until `Just me` is visibly tapped,
then edit the offered S2 E5 to S2 E6 and confirm. Assert `creationTarget.type: 'watch'`,
`audience.mode: 'just_me'` and S2 E6. Repeat on a watch list
while choosing `General`; the result is `custom`, proving the list never chooses the kind.

---

### P3-34 — The caller-scoped Plan state line on a list item

**Approach.** The item stays in its list, in place. When the list-detail response includes the
caller's `viewerLink` and its `viewerPlan` either carries `schedule.date` or has
`status: 'cancelled'`, that caller alone sees a state line. `viewerPlan` is
`ListItemPlanState` — `type`, `status` and an optional
`schedule` — supplied by P3-15; the client derives the line from it and never fetches
Activities per row, and takes the line's tap target from `viewerLink.activityId`:

```
Restaurants to try
  Zahav
  Planned Saturday · 7 PM                    →
```

Rules that are easy to get wrong:

- The state line shows the caller-linked Activity's date and time in the relative format used
  elsewhere: weekday name within 7 days, otherwise `d MMM`.
- **`viewerPlan.status` selects the line.**
  `scheduled` renders `Planned …` (or `Next session …` for a `watch` Plan) and `completed`
  renders `Done …`. `cancelled` renders `Cancelled`, with no date suffix. `saved` has no date
  and so renders nothing. A skip clears the pointer, so `skipped` should not normally reach a
  row and renders nothing defensively if a stale projection does.
- Unscheduling retains `viewerLink` but hides the line; rescheduling the same Activity makes
  it visible again. Link presence alone is never display eligibility.
- **Tapping the state line opens the Activity. Tapping the title opens the item detail.**
  Both targets are ≥ 44 pt and are separate accessibility elements.
- A caller-linked item is distinguished by the state line **alone**. No colour change, no
  strike-through, no move.
- An item on a `collection` with `capabilities.checkable` is still checkable once scheduled. Checking one does not
  complete the Activity, and completing the Activity never checks it. The tick changes only
  through an explicit List action (P3-15).

**Tests.** Render test asserting two separate accessibility elements with the labels from
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2.
Playwright asserting each tap target navigates to the correct screen. A projection test seeds
two viewers with different pointers and proves each response and render contains only that
viewer's Plan; a third member sees the ordinary item with no state line. A cancelled fixture
renders `Cancelled` while retaining the same tap target. Completing the Plan
from both a checked and unchecked source fixture leaves the ListItem byte-identical.

---

### P3-35 — The Plans tab: three stages

> **Amended 2026-08-25 (founder) — the stages are a switcher, not a stack.** Everything below
> about *content* stands: the three stages, their order, their ordering rules, their empty
> copy, and every prohibition in §1.3.2. What changes is that they render behind a
> `SegmentedControl` rather than stacked on one scroll, because `needsDate` does not paginate
> and eight undated plans were burying Upcoming below the fold. Consequences for the text
> below: **"A stage with nothing in it renders its heading and its empty line"** now means the
> *selected* stage renders its own empty line, and the all-three-empty case replaces the
> switcher with the single `No plans` screen (§1.3.3). The switcher carries **no counts** —
> `design-system.md` §7.3 was corrected, having asked for them in direct conflict with
> §1.3.2's first two rules. The grep test for badge components and stage-length counts is
> unchanged and now also covers the switcher. The calendar navigator that sits beneath it is
> **P3-47**, not this task.

**Files.** `apps/mobile/app/(app)/(tabs)/plans.tsx`,
`apps/mobile/src/features/plans/{hooks/usePlans.ts, components/NeedsDateRow.tsx,
model/rsvpSummary.ts}`.

**What to build.** The screen in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.3, replacing the
date-range view Phase 2 shipped (P2-32). Three stages in fixed order — **Needs a date**,
**Upcoming**, **Past** — from one `GET /v1/plans`.

**A stage with nothing in it renders its heading and its empty line.** It is not hidden. The
three stages together are the shape of the screen, and a Plans tab that shows two headings on
Monday and three on Tuesday teaches nothing about where things go. This is the opposite of
Today's rule, where an empty section is absent, and the difference is deliberate: Today is a
day, Plans is a map.

**The needs-a-date row.** Three lines, no time column, no checkbox, per §1.3.1:

```
NEEDS A DATE

  ◇  Dinner at Zahav                                Event
     Alice interested · Ben hasn't replied                    ›
```

| Element | Rule |
| --- | --- |
| Leading marker | The Plan type's non-interactive diamond. **Never a checkbox**, for any of the four `PlanType` values. Tasks cannot enter this stage. |
| Trailing label | The type label, de-emphasised. **No date chip**; there is no date. |
| Second line | The RSVP summary, always rendered, never empty. |
| Tap | Opens plan detail. Nothing on the row mutates anything (U1). |

`model/rsvpSummary.ts` is a pure function from the response's grouped `rsvpSummary` — each
group's full `count` plus its first two `names` — to the summary string, unit-tested
independently of React, over the five cases in §1.3.1: `Just you`; two people named; `Alice and
2 others interested`; `Nobody
has replied`; and the mixed case joined by ` · ` in the order interested, maybe, pass, no
reply. The words are the **undated** vocabulary and the switch that produces them belongs to
Phase 6 (P6-40); in this phase there are no participants, so every row renders `Just you`.

**Ordering is the server's.** The client renders `needsDate` in the order it arrives and does
not re-sort. Sorting locally by title, by age or by anything else would silently disagree
with `lastActivityAt` and would reintroduce the oldest-first backlog the ordering exists to
avoid.

**Edge cases.**

- **No backlog badge or stage count.** Not on the tab, not in the `Needs a date` heading, not
  as a `(3)` after it. The heading is two words. RSVP prose and a future row's
  `2 dates suggested` are content, never stage chrome. §1.3.2 lists five rules a reviewer
  checks and every one of them is a test here.
- `Past` paginates on scroll through `mode=past_cursor`; `needsDate` does not paginate.
  `Upcoming` loads one bounded 62-day date window initially and requests the next window with
  `mode=upcoming_window` from `upcomingWindow.nextFrom` only when the user reaches its end.
  Continuation responses contain only their active stage and may not replace inactive client
  stages. A zero-row window with a
  non-null `nextFrom` retains that end sentinel, so the far-future row remains reachable; a
  null value renders the ordinary final empty line and issues no further request.
- A Needs-a-date row never ages into an archive, greys out or re-sorts merely because it has
  remained undated. Past rows retain the canonical de-emphasised row treatment; stage
  membership and ordering remain the server's.
- Pull-to-refresh refetches all three stages in the one request.

**Tests.** Render tests for all three empty states and the all-three-empty state from
§1.3.3; one needs-a-date fixture for each of the four Plan types, each with no checkbox or
date chip, and a contract fixture proving an undated task is absent; unit tests
over `rsvpSummary` for the five cases; a test asserting the rendered order equals the
response order for a deliberately unsorted fixture; a Past fixture is de-emphasised while a
Needs-a-date fixture is not. Tapping either Plans `Add` empty-state action opens the global
**Task / Plan / List item** chooser with all three unselected; it does not open a Plan form. A
**grep test over
`src/features/plans/`** asserting the directory contains no badge component and no numeric
count bound to a stage length — the same shape of test P2-28 uses for unresolved items.
An Upcoming test begins with an empty 62-day window whose `nextFrom` jumps to a plan six
months out, reaches the sentinel, and renders that plan after exactly one further window load.

---

### P3-36 — Plan detail screen: full anatomy

> **Amended 2026-08-25 (founder) — settings always, sections once filled.** This task pointed
> at `plans-and-lists.md` §2.1's ten expanded sections while `design-system.md` §7.5 —
> written later and **already built by P2-41** — specified collapsed disclosure rows with the
> completion action at the top. Both documents were amended together; build to the reconciled
> rule, which is canonical in §2.1:
>
> - **Settings** (Notes, Reminder, Repeat) always render, one compact row each.
> - **Sections** do not exist until they hold something; meanwhile they are named chips in one
>   `Add to this plan` row at the foot.
> - A section of **1–3 rows renders in full**; **4 or more** shows three then `Show all n`.
> - The **completion action stays at the top**, directly under the schedule line (§7.5 rule 1).
> - `Coming later` rows for unbuilt capabilities are unchanged.
>
> The one-request rule, the bounded reads, the undated-plan rule and the "your reminders only"
> rule below are all unaffected. `Show all n` needs a destination: prefer a pushed sub-screen,
> since Prep and Updates both already have their own pagination endpoints.

**Approach.** One screen and one `GET /v1/activities/:id`. That one HTTP response is composed
from bounded storage reads, not an unbounded whole-partition Query: first a strongly
consistent `GetItem` of `ACT#<activityId>` / `META` establishes existence and owner
authority; a non-owner requires the exact strongly consistent
`USER#<callerId>` / `IDX#<activityId>` access grant (or the documented parent grant),
then strongly consistent prefix Queries fetch only the first documented page of each
section. Updates are newest-first with `Limit: 50` and a cursor; attachments are capped at
20, and the attachment path first drains P3-22's caller-scoped at-most-20 pending uploads;
children use P3-18's complete model-capped `Limit: 50` page; caller reminders, participants
and `SOURCE_LIST#` ids use their model caps. The
`SOURCE_LIST#` ids are followed by one bounded `BatchGetItem` for current
`LIST#<listId>` / `META` rows. Later pages use their section endpoints. The ten sections in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1, in fixed order,
with the visibility rules in §2.2.

The rule that shapes the screen: **a section with nothing in it collapses to a single "add"
affordance rather than disappearing**, so the plan's capabilities stay discoverable. The
exceptions are the hero image (hidden with no `primaryAttachmentId`), Expenses (hidden below
2 participants and 0 expenses — Phase 7) and Updates (hidden when private with no entries).

Unimplemented capability discovery follows the canonical pre-build rule. People may render as
a non-interactive row ending in `Coming later`, with no chevron, disabled action, expansion or
tap behaviour. Expenses and Updates remain absent until their own product conditions and
implementation phases make them available; they do not render disabled controls.

The when/where block is **one tap target** opening the reschedule sheet, with the address row
as a separate target opening the platform maps app. It is never inline-editable.

**The reminders row shows the caller's own reminders and says so.** The response already
contains only those (P1-10 rule 6), so the client renders what it is given and adds no filter
of its own. On a shared plan the copy is `Your reminders` rather than `Reminders`, because a
plan has one schedule and many reminder sets and the screen should not imply otherwise. There
is no affordance anywhere for seeing, setting or removing somebody else's.

A plan with **no date** renders the same applicable section set. The when/where block reads
`Not scheduled`, exposes the owner `Schedule` action, and opens the same sheet. Nothing about
the screen treats an undated plan as a
lesser or unfinished object: a plan is an Activity with commitment or coordination, and a date
changes its scheduling state, not its identity
([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §1). The date-suggestion
section that fills this gap for participants arrives in Phase 6 (P6-51).

**Tests.** Render tests for each visibility rule. A network assertion that opening the screen
issues exactly one HTTP request and that a fixture with two `SOURCE_LIST#` rows performs the
authoritative META `GetItem`, bounded prefix reads (including a newest-first 50-update page),
and one two-key `BatchGetItem`, not one read per List and never `queryAll` over the Activity
partition. A render test over an
undated plan asserts the same applicable section set as a dated one, with `Not scheduled` and
`Schedule` in the when/where block and no copy calling it incomplete. A pre-build render test
asserts People is non-interactive `Coming later` while Expenses and Updates are absent.
A test that the reminders row renders exactly the reminders in the response and that the
component contains no `userId` comparison.

---

### P3-37 — Prep section inside a plan

**Approach.** The empty PREP section renders the exact contextual action
`+ Add prep task`. The parent Plan is already explicit, so this action fixes
`{ objectKind: 'task', type: 'task', parentActivityId }` and opens the Task form directly;
it does not reopen the global chooser or parse the title to choose a kind. The final action
reads `Save task`.

**Tests.** Create `Book hotel` from `+ Add prep task` and assert the request contains
`type: 'task'` and the current `parentActivityId`. Use the same words through global
`+` → `Plan` → `General` and assert it remains a standalone `custom` Plan.

---

### P3-38 — The `Add list` catalogue sheet

**Approach.** The LISTS section's `Add list` opens the same explicit template/style catalogue
from P3-26, in the same stable order and with no selection. A small context line names the
Plan the eventual list will relate to; Plan type, title, duration and participants do not
rank, hide, select or pre-select a style.

After the user taps a template, the next step shows a title pre-filled as
`<Default title> · <Plan title>`, visibly editable before `Create list`. Confirmation
creates one `List` with `sourceActivityId` set.

**Hard rule: no list is created without that confirmation.** Creating a trip plan does not
silently produce three lists.

**Edge cases.** `List.sourceActivityId` is the **only domain link**. Its id-only
`ACT#<activityId>` / `SOURCE_LIST#<listId>` row is a reverse access projection, not a second
source of truth. Detaching or deleting the List clears `sourceActivityId` and removes that row
in the same transaction. **Deleting the plan is §P3-49's**, not this task's — it enumerates
those rows, clears the matching back-links and leaves every List and item intact. This task
depends on it and asserts the outcome; it does not implement it. Completing a
plan does not archive its lists. A list of things you own is not owned by the trip. A list
created this way forces `slot: null` regardless of the selected template, so one Plan's list
never becomes a standing destination without a later explicit settings change.

**Tests.** Integration: creating an `event` writes zero lists; `Add list` initially shows the
same full unselected catalogue as general `New list`; explicitly choosing and confirming `Packing`
writes exactly one with `sourceActivityId` set, `behaviour: 'collection'`, `slot: null` and one
matching `SOURCE_LIST#` projection; deleting the plan leaves the list with its items and
`sourceActivityId` cleared and removes the projection (the clear itself is §P3-49's; this
asserts the sourced List this task creates is one it correctly reaches). A test runs
every Plan type through the entry point and asserts catalogue order and selection are identical.

---

### P3-39 — Updates section

**Files.** `apps/mobile/src/features/plans/UpdatesSection.tsx`.

**What to build.** Plan detail section 9
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1): the feed,
newest first, with `+ Write an update` at the foot.

**Approach.**

- The first page arrives inside `GET /v1/activities/:id`; older entries page through
  P3-19's `GET .../updates?cursor=` on scroll. Opening the plan issues no second request
  (P3-36's one-request rule).
- An entry renders its body and a relative timestamp (`2 days ago`). System entries render
  the same row de-emphasised with no author name — the entry text is the event (decision
  recorded here — §2.1 specifies content, not styling — raise in PR if wrong). In this
  phase the only possible author is the caller, so user entries carry no name either;
  Phase 6 adds names.
- `+ Write an update` opens a one-field composer whose final action is `Post update`
  (decision recorded here — raise in PR if wrong); posting is optimistic and the entry
  appears at the head without reflowing the rest of the screen.
- An entry's row body is not interactive
  ([`../01-product/interaction-contract.md#3-gesture-table`](../01-product/interaction-contract.md#3-gesture-table)
  §3.3); the author's own entry offers swipe `Delete`, consuming whatever endpoint P3-19
  ships for it, and the affordance is absent — not disabled — on system entries.
- Visibility per §2.2: hidden when `visibility === 'private'` **and** there are no
  entries. The consequence is deliberate: on a private plan the section first appears once
  a system entry exists (a date change, a completion), and only then offers the composer.
- Posting returns the authoritative `lastActivityAt` from P3-19. The client immediately
  applies that value to its local/native Plans projection (in the same SQLite transaction as
  the confirmed mutation) or web cache and moves a needs-a-date row accordingly. It then
  refetches for reconciliation, but an older eventually consistent GSI1 projection may not
  overwrite a newer locally known `lastActivityAt`; monotonic merge wins until the index
  catches up.

**Tests.** Render: newest first from an unsorted fixture; the §2.2 visibility matrix
(private + 0 entries hidden, private + n shown, shared + 0 shown); a system entry has no
delete affordance and no author name; optimistic post renders before the response; the
cursor fetch fires on scroll and not on open. A stale immediate Plans refetch cannot move the
row back after the POST response has supplied a newer `lastActivityAt`; a later converged
response matches the local order.

---

### P3-40 — Image picker, upload, and progress

**Files.**
`apps/mobile/src/features/attachments/{useAttachmentUpload.ts, AttachmentPicker.tsx}`.

**What to build.** The client half of P3-21 and P3-22: pick an image, `PUT` it to the
presigned URL, confirm, and show progress — reached from plan detail's ATTACHMENTS `Add`
and from the creation forms' attachment control.

**Approach.**

1. `expo-image-picker` for camera and library — already in `tech-stack.md`; on web,
   `Photos` is a file picker only and there is no camera path (tech-stack platform table).
2. Client-side pre-checks before any network call: MIME is one of the four allowed image
   types, size ≤ 10 MB. Failing early is a validation message, not a round trip.
3. Then the three-step chain through P3-24: `requestUploadUrl({ contentType, byteSize })`
   → `putToUploadUrl` with a progress callback → confirm. One visible progress state; the
   thumbnail placeholder appears immediately and resolves when the confirm returns.
4. On a **creation form** no activity exists yet, so the flow stops after the upload; the
   collected ids ride in `attachmentIds` on the eventual `POST /v1/activities` (or the
   schedule bridge), where P3-22 confirms them server-side.
5. The presigned URL lasts 5 minutes. A `PUT` rejected as expired silently requests a
   fresh URL once, then surfaces the standard error toast with `Retry` (§5.3). A `429`
   from the upload-url route renders the standard rate-limit handling.

**Edge cases.**

- HEIC from the iOS camera uploads as-is — `image/heic` is allowed; no client transcode.
- The `PUT` carries exactly the declared `Content-Type`; the signature binds it (P3-21),
  so a mismatch is a store rejection surfaced as a retryable failure, not silence.
- Killing the app mid-upload leaves a `tmp/` object the 1-day lifecycle cleans; on next
  open the row shows a failed placeholder with `Retry`, never a phantom attachment.
- Offline: the upload queues per interaction contract §5.4, placeholder until success,
  `Pending` dot meanwhile.

**Tests.** Unit: an 11 MB image and a PDF are refused with no network call made (fetch
spy). Integration against MinIO through the dev server: pick → upload → confirm renders
the image from the key the API returned (acceptance criterion 24). A stubbed expired-URL
`PUT` triggers exactly one re-request then errors. A form-created activity carries the
uploaded ids in `attachmentIds`.

---

### P3-41 — Attachment viewer and hero image

**Files.**
`apps/mobile/src/features/attachments/{AttachmentViewer.tsx, HeroImage.tsx}`.

**What to build.** The viewer behind the ATTACHMENTS thumbnails, and the hero. Rules from
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1–§2.2 and the
gesture table §3.3:

- Tap a thumbnail → full-screen viewer, swiping between the activity's images; tap the
  hero → the same viewer opened at the cover image.
- Long-press a thumbnail → `Set as cover` / `Delete`. Owner only; a participant sees
  neither (absent, not disabled).
- The hero renders only when `primaryAttachmentId` is set (§2.2) and collapses cleanly
  when it is not. Images render through `expo-image` by the key the API returned against
  the configured media origin — no URL is ever stored on a row (ADR-023).

**Approach.**

- `Set as cover` issues P3-22's `PATCH`, updates the hero optimistically, and gets the
  standard 6-second undo — it is additive, nothing is lost (§1a.1).
- `Delete` is a deletion, so it **confirms** — deletions always confirm, even of one thing
  (§1a.1 rule 3) — in the §1a.1 shape, naming the object, with no undo. Neither the §1a.1
  table nor the §4 undo table has an attachment row yet; §1a.1 says an unlisted change
  needs a line added in the same PR, so add both rows there in the implementing PR
  (decision recorded here — raise in PR if wrong).
- Deleting the cover clears the hero — the server clears `primaryAttachmentId` (P3-22) and
  the screen collapses the slot rather than rendering a broken image.
- Accessibility: the viewer traps focus and returns it on close (§7.3); thumbnails are
  labelled `Photo 2 of 3`; the hero contributes no second announcement of the plan title.

**Tests.** Render: no hero without `primaryAttachmentId`; the hero appears after
`Set as cover` (acceptance criterion 25) and the toast offers undo; delete shows a
confirmation and no undo toast; deleting the cover collapses the hero slot; both actions
are absent for a non-owner fixture; the viewer opens from the hero and from a thumbnail
at the right image.

---

### P3-42 — Explicit Plan-to-list side effects: Meal ingredients and Watch items

**Files.** `apps/mobile/src/features/meals/IngredientPicker.tsx`,
`apps/mobile/src/features/watch/WatchListDestination.tsx`,
`apps/mobile/src/features/lists/DestinationSheet.tsx`.

**What to build.** The client half of P3-17. The ingredient list on a meal, with a checkbox
per ingredient, and a destination sheet that makes the target explicit.

**Approach.** Every ingredient starts **unchecked**. Selecting some enables
`Add 3 selected`. Tapping it resolves the destination through P3-12 and renders one of three
states:

| Resolution | What the user sees |
| --- | --- |
| `use` | A confirm row: `Add ingredients to: Groceries ▾`. The `▾` opens the picker for a one-off change. |
| `ask` | The picker, open, listing every eligible list, with `Remember this choice` checked by default. |
| `none` | `Choose or create a list`. `New list` opens P3-26 with the full fixed-order catalogue and nothing selected; after `Create list`, this sheet returns with the new list named and still requires `Add <n> to <list>`. |

The destination is **always visible before the write**, including in the `use` case. Silent
step 1 means the app does not ask, not that it does not say.

The final named ingredient action calls P3-17's
`POST /v1/activities/:id/ingredients/add-to-list` with that visible `listId`, the selected
stable source `ingredientId`s and any stable destination item ids. It never constructs provenance or calls
ordinary `/items/bulk`.

> **Decision:** `Remember this choice` is checked by default in the `ask` case, and
> unchecking it makes the choice one-off. A user with two grocery lists is asked once, which
> is the point of storing the answer; leaving it unchecked by default would ask them forever.
> Changing the destination from the `use` case never writes the default — that path has no
> `Remember` control at all.

Once the write lands, each added ingredient shows `Added` and cannot be added twice from the
same meal.

The Watch Plan's separate `Also add a list item to…` toggle appears in the reviewed Watch form
and is off in every context. Turning
it on resolves the `watch` slot and always shows the named destination before a write. If no
eligible destination exists, `New list` opens P3-26 constrained to exactly `watchlist`,
`movies-to-watch`, and `tv-shows`, in their canonical relative order and with none selected.
That filter comes from the user's explicit Watch-destination control; title and capture text
are not inputs. `Create list` writes only the List and returns here. Only the later named
`Save plan and add <title> to <list>` action creates the item, then submits the reviewed Plan
through P3-13's `/schedule`
bridge, which creates the Plan and caller's viewer-local `LNK#`
pointer. In Phase 3 the adapter explicitly supplies `audience: { mode: 'just_me' }`; Phase 6
maps the reviewed Watch form's People selection to `selected_people`. This is caller
construction, not a default in `scheduleListItem` or an inference from the item. Before the
combined operation enters SQLite it mints and persists one permanent
`activityId` in the bridge payload, alongside a stable bridge idempotency key distinct from
the item-create key. The conditional Activity identity, not an unbounded receipt lifetime,
makes replay unable to create a duplicate Plan. If the item write succeeds while scheduling
is offline, the item remains a valid saved ListItem and the queued
bridge visibly shows `Plan will finish syncing`; the UI does not claim the Plan exists until
that request succeeds. `Plan will finish syncing` is **not a new mechanism**: it is the
copy-parameterised pending indicator from the Phase 2.6 outbox
([`phase-02-6-sync-hardening.md`](phase-02-6-sync-hardening.md) P2-62), and this task's
native queued writes use the same SQLite transaction/coordinator — implementing a second
pending system or making TanStack native domain authority here is a defect.

**Edge cases.**

- Nothing is written until the button and, where shown, the sheet are both confirmed.
- The picker lists only lists whose `slot` matches, plus a `Choose another list` escape that
  opens the full index. A user is allowed to put ingredients in a list that is not marked as
  a destination.
- With no network, the resolution runs against the cached list index and the write queues.
- Cancelling either Watch style selection or `Create list` returns without a List, ListItem,
  Plan, or link write. A created Watch list is visibly selected but receives no item until the
  later combined action is activated.

**Tests.** Playwright: with one grocery list, the confirm row names it and the write lands
there; with two and no default, the picker opens, choosing one writes `defaultLists`, and the
next meal skips the picker; changing the destination from the `▾` writes the items elsewhere
and leaves `defaultLists` untouched; with none, no template is selected or suggested,
`Create list` writes no ingredient, and only the later `Add <n> to <list>` action does. Render
test: every ingredient starts unchecked.
Watch tests cover one destination, several with and without a saved default, and none. The
none case begins with all three compatible styles unselected; choosing a style never writes
the item, and the final action names both objects and the destination before any of its writes.
The Phase 3 combined bridge payload explicitly contains `{ mode: 'just_me' }`; the Phase 6
fixture contains exactly the audience selected in the reviewed People field.
A forced offline gap after item creation shows `Plan will finish syncing`; replaying the same
bridge key and `activityId`, including after simulated receipt expiry, creates exactly one Plan
and one caller pointer, then clears that state.

---

### P3-43 — Follow-up suggestions after completion

**Approach.** Completion may present **exactly one** contextual follow-up. Its presentation
rules are the product-wide invariant in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a-product-wide-invariants)
§1a.2 — do not restate or vary them here. The catalogue, from
[`../01-product/activities.md`](../01-product/activities.md) §5.3:

| Completed | Follow-up | Creates on tap |
| --- | --- | --- |
| `watch` (show with progress) | `{list name} · currently S2 E4 — Update to S2 E5?` then, separately, `Create a Plan for S2 E6?` | Explicit progress update; then opens `Plan this item`, which creates nothing until kind, audience and final confirmation are chosen. |
| `watch` (movie) | `Update {list name} item to Watched?` | Sets that named item's `watchStatus` to `watched`. |
| `meal` with ingredients | `Add ingredients to a list?` | Opens the ingredient picker and then the destination sheet (P3-42); writes only what the user selects, where they chose. |
| `event` created through `Plan this item` from a `collection` list with both `checkable` and `supportsLocation` | `Mark {item title} visited in {list name}?` | Sets that named item's `checked` only when tapped; completion itself leaves the item byte-identical. |
| ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigation only. Phase 7. |
| ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the sheet. No write until saved. Phase 7. |
| ≥ 1 incomplete **non-recurring** prep task | `2 one-off prep tasks are still open — keep them?` with `Keep` · `Complete all` · `Delete` and the real eligible-child count | Completion itself leaves every prep child untouched. `Keep` and dismiss write nothing; the other explicit taps complete or delete exactly those incomplete non-recurring children. Recurring prep tasks are retained and excluded from the count and bulk actions. |
| Recurring occurrence | **Nothing.** The next occurrence already exists. | — |

Priority is mandatory: a recurring parent occurrence offers nothing. Otherwise, when the eligible open-prep
row and any other row qualify, the open-prep question is the one follow-up shown. Only after
a show-progress update has been explicitly confirmed may its separate next-episode prompt be
offered; it is not a second simultaneous completion follow-up.

**Tests.** An integration test asserting that dismissing every follow-up produces zero
writes. A qualifying bridged Event offers `Mark visited`; tapping it checks only the named
item. General, a manually linked Event, a non-collection list, and a list missing either
capability offer nothing. A movie offers the watched transition. A completion with open
one-off prep and another qualifying suggestion offers only the counted prep question and
exercises each explicit choice. Mix incomplete one-off and recurring prep children: the copy,
Complete all and Delete name/affect only the one-off ids, and the recurring rows and their
occurrences remain byte-identical. A Plan with only recurring prep children offers no prep
follow-up. A test that a recurring parent completion offers no follow-up at all even when
another row would otherwise qualify.

---

### P3-44 — E2E: the worked examples, a list that links to nothing, and a plan with no date

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

A fourth flow, short and just as load-bearing, because it is the case the model now leads
with: **a list that never links to anything.** From the Lists index choose `New list`,
explicitly tap the **Bars to try** style, keep or edit its visible title, and tap `Create
list`; add three items, check one, reopen the app, and assert three items, one checked, zero
Activities in the table and nothing on Today.

A fifth, for the stage that did not exist before this phase: **a plan with no date.** Create
`Poconos trip` as an `event` with no date, assert it appears under Needs a date and on no
other screen — not Today, not Upcoming, not Anytime — then give it a Saturday and assert it
moves to Upcoming, that its `#P` index entry is gone and a `#S` one exists, and that no badge
or count appeared anywhere at any point.

Playwright on web for all five; Maestro on iOS for the first and the fifth.

**Tests.** These are the tests. They gate the phase.

---

### P3-45 — The eleven missing catalogue icons

**Files.** `packages/ui/src/icons/index.tsx`.

**What to build.** P3-02 shipped `packages/shared/src/lists/templates.ts` naming fifteen
icons. **Four exist** — `bowl`, `check-square`, `map-pin`, `play-rect`. The other eleven do
not: `bag`, `book`, `cart`, `cup`, `film`, `gift`, `glass`, `heart`, `list`, `star`,
`suitcase`. Nothing has surfaced it because no screen renders a list card yet; P3-25 is the
first and would fail on eleven of the seventeen templates.

**Approach.** Draw the eleven to the registry's existing grammar: a `24 × 24` viewBox, the
shared `stroke` constant (1.5 weight, round caps and joins), no fill, colour taken from the
`color` prop. `CheckSquare`'s filled check is the documented exception and is not a licence
for more. Each is exported by name and added to the same barrel as the rest.

**Founder approval.** Given 2026-08-25. `plans-and-lists.md` §5.3 requires it — "a new
template must reuse an icon already in `packages/ui/src/icons/` unless the founder approves a
new one" — precisely so that adding a template does not quietly become a design task. It did
here, once, and this closes it.

**Edge cases.** Do not let a template share a glyph with another to avoid drawing one; the
catalogue's seventeen entries are meant to be distinguishable at a glance in the style
chooser. `list` is the `simple-list` glyph and must not be confused with `ListLines`, which is
the Lists **tab** icon.

**Tests.** A test asserting **every** `icon` value in `LIST_TEMPLATES` resolves to an exported
component — the assertion that would have caught this at P3-02, and that keeps a
seventeenth template honest. Render each at 24 and at 44 and assert a non-empty path set.

---

### P3-46 — `List.lastItemActivityAt` and every writer that must bump it

**Files.** `packages/shared/src/types/list.ts`, `packages/shared/src/schemas/list.ts`,
`services/api/src/repositories/listRepository.ts`, `listService.ts`, `listItemService.ts`.

**What to build.** A second timestamp on `List`, per `data-model.md` §4.6. `updatedAt` backs
`If-Match` and moves only when the List row itself changes; `lastItemActivityAt` moves when
any **item** is created, edited, checked, deleted, reordered or touched by a bulk operation,
and backs nothing. The Lists index renders the second (P3-25, `design-system.md` §7.2).

**Why it is its own task.** Its four natural owners — P3-04, P3-05, P3-08, P3-10 — are all on
`main`. This is forward work against shipped code, not an amendment to their text.

**Approach.** Required, not optional: `POST /v1/lists` seeds it equal to `createdAt`, and
every item write path sets it. **Nothing is deployed yet** — no AWS account exists before
Phase 4 (`00-open-decisions.md` #50) — so there is no migration, no backfill and no
absent-value branch to carry. That is only true now; the same change after Phase 4 needs a
migration path, which is the reason to do it here rather than later.

It is written on the same `LIST#<listId>` / `META` row the Lists index already
`BatchGetItem`s, so it costs no extra read, no index and no query. It must **not** participate
in `If-Match`: an ordinary item write would otherwise bump the concurrency token every open
list-settings sheet is holding.

**Edge cases.** A bulk operation bumps it once for the operation, not once per item. Undo of
a bulk operation bumps it again — the list did change, twice. A behaviour migration is a
list-level change and moves `updatedAt`, not this.

**Tests.** Checking an item moves `lastItemActivityAt` and leaves `updatedAt` untouched;
renaming the list does the reverse. A `PATCH` carrying a stale `If-Match` still fails on
`updatedAt` after an unrelated item write — the regression this split exists to prevent.
`clear-checked` bumps once. Every item route is covered, because a missed writer is invisible
until a card silently goes stale.

---

### P3-47 — The Upcoming/Past calendar navigator

**Files.** `apps/mobile/src/features/plans/components/{CalendarNavigator.tsx, DayCell.tsx}`,
`apps/mobile/src/features/plans/model/deriveCalendarCells.ts`.

**What to build.** The control specified in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.3.4: collapsed, a
rolling seven-day strip; expanded, a normal month calendar. On Upcoming and Past only — Needs
a date has no dates to navigate. It resolves `00-open-decisions.md` #52.

**Approach.**

- **One day-cell component.** Seven columns at `compact` give ~44 pt cells, and the month grid
  is also seven columns — so the same cell is drawn seven times collapsed and up to
  forty-two times expanded. Only the date sequence differs.
- **Eligibility comes from the stage, never the displayed month.** One expression, no
  month-boundary branch. Adjacent-month spillover that belongs to the active stage is live and
  **carries its density**; out-of-stage dates are inert. Three visual treatments — normal,
  subordinate-but-live, inert — and the middle one must not read as disabled.
- **`deriveCalendarCells(items, window)` is pure** and takes the **projected** agenda the list
  renders, including optimistic local writes. It takes no response envelope, no cache handle
  and issues no fetch, so the calendar cannot diverge from the list by construction rather
  than by discipline. On native that means subscribing to the same SQLite repository
  projection the list uses; wiring it to the query cache is the defect this signature exists
  to prevent.
- **`WallDate` throughout** — cell, grouping, request bounds and the today boundary share one
  viewer-local definition (`coding-standards.md` §4.4). The derive path constructs **no `Date`
  object at all**; day-of-week and days-in-month come from `date-fns`, which is greppable in
  review.
- **Navigation selects a window; it is not a second pagination model.** A fetch is issued only
  when the visible grid leaves the loaded range, and it requests the **visible grid range**
  (up to 42 days, inside `MAX_AGENDA_DAYS`), not the nominal month. Forward uses
  `mode=upcoming_window` with `upcomingFrom`/`upcomingTo`; backward uses `mode=past_window`
  with both `pastFrom` and exclusive `pastBefore` (P3-20). A dense Past grid follows the
  returned cursor under the same bounds until coverage is complete. Ordinary older-history
  paging remains the separate `past_cursor` mode.
- **Expanding never fetches.** Collapsed and expanded are the same projection over the same
  data. Expanded-or-collapsed is remembered **locally** per platform — view state, not profile
  data, so no `User` field.
- **Gesture contract.** Changing the visible month during a gesture does not fetch. Fetch on
  settle, and cancel a superseded request. While a cold month loads, keep the calendar shell
  and its weekday header with quiet skeleton density; never collapse the control or block the
  Plans screen.

**Edge cases.**

- Today belongs to Upcoming, so it is inert at the end of Past's `Previous 7 days` strip.
- The clamp is visible: Upcoming dims the back arrow and every earlier month, Past the
  forward arrow.
- Past shows presence, never load. **No dot means no claim**, which requires tracking which
  ranges have actually been fetched — without it the dots are whatever survives cache
  eviction. No "which months contain history" endpoint: that is a second projection able to
  disagree with the list. The client may mark a date loaded-and-empty only inside completed
  `pastCoverage`; a partial dense response carries no negative claims below `coveredFrom`.

**Tests.** Unit over `deriveCalendarCells`: for both stages, every cell's live/spill/inert
state is rebuilt independently from the stage rule and compared, including the today boundary
and both spillover directions; spillover cells carry density. A test that the function is
never handed a network payload — its signature admits none. A render test that expanding
  issues zero requests. A gesture test that three fast month changes issue one request for the
  settled month and cancel the rest. A dense 42-day Past grid test drains partial coverage
  before marking empty dates. An offline test that a month with no loaded range renders the
  shell and no false dots. A grep test that the feature directory constructs no `Date`.

---

### P3-48 — Per-type row markers in `RowLeading`

**Files.** `apps/mobile/src/features/agenda/components/RowLeading.tsx`.

**What to build.** `RowLeading` receives only `hasCheckbox`, so every non-task activity — event,
meal, watch, general — renders one 8 pt filled grey square rotated 45°, ignoring both the
per-type glyph and the per-type accent that `design-system.md` §5.2 specifies. Pass the
activity `type` and render its glyph at `16 × 16` in its accent.

**Note the blast radius.** This is P2-44 code and **Today renders it too**, so this changes
both tabs. It is listed in Phase 3 because that is when it was caught, not because it is
Plans-only.

**Approach.** `type → glyph` is the §5.2 table: `bowl`, `play-rect`, `map-pin`, and `diamond`
for `custom`, the visible **General** kind. Use `type`, never `hasCheckbox`, to choose — the
latter is capability-gated, so a task the caller cannot complete would fall through to a
marker. The marker stays non-interactive, keeps no hit target, and remains
`accessibilityElementsHidden`; its meaning is already in the row's label. Keep its 1.5 stroke
visibly lighter than the checkbox border on the adjacent row so it does not begin to read as
a control. §5.2's prose was corrected in the same pass — its table was always right.

**Tests.** A render matrix asserting each `type` produces its own glyph and accent, and that
`custom` is the only diamond. A test that a non-completable task still renders a checkbox
rather than a marker. Snapshot both Today and Plans, since both consume this component.

---

### P3-49 — Clear `List.sourceActivityId` when its source Plan is deleted

**Files.** `services/api/src/repositories/listRepository.ts`,
`services/api/src/services/activityService.ts`,
`services/api/test/integration/planDeleteSourcedLists.int.test.ts`.

**What to build.** The Activity half of a two-way cleanup whose List half already ships.
Deleting a List removes its `ACT#<a>/SOURCE_LIST#<l>` projection (P3-05); deleting the **Plan**
does not clear the `List.sourceActivityId` pointing back at it. The Plan's cascade deletes the
whole Activity partition, projections included, so the surviving List keeps a provenance link
naming an activity that no longer exists — and the reverse pointer that could have found it is
destroyed in the same pass. Required by
[`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items)
*Delete activity* and
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities)
`DELETE`, both of which already say the clear happens.

**Approach.** In `removeActivity`, **before** the cascade removes the projections and META,
read the `SOURCE_LIST#` ids out of the partition already held and clear each matching
back-link. Each clear is a single conditional `UpdateItem` on that List's `META`, conditional
on `sourceActivityId` still naming **this** Plan, and a condition failure is swallowed: a List
already cleared, deleted, or re-sourced is not this delete's business. That makes the pass
idempotent and resumable, which is the property the ordering exists for — while the
projections survive, an interrupted delete re-reads them and finishes; once they are gone, so
is every List that still needed clearing.

Bounded by `MAX_OWNED_LISTS`, so the loop needs no cursor. One conditional write per List
rather than one transaction: the Lists live in their own partitions, a hundred of them exceed
a transaction, and one re-sourced List must not cancel the other ninety-nine.

**Edge cases.**

- **The clear does not advance `List.updatedAt`, and that is load-bearing.** The
  behaviour-migration finisher pins `expectedUpdatedAt` in its durable work record and
  condition-checks it (P3-09). Advancing the version underneath an in-flight migration fails
  that condition **permanently** — a retry re-reads the same stored value — leaving
  `behaviourMigrationId` installed and every item read and mutation gated into `503` for ever.
  Bricking a list to freshen a version is the wrong trade. It is safe because
  `patchListMeta` is `SET` over named fields and never a whole-item `Put`, so no client holding
  a stale copy can write the attribute back; the worst case is one stale render until refetch.
- **The clear is not gated on the migration or repair markers.** Removing an unrelated META
  attribute leaves `updatedAt`, `rankVersion` and `behaviourMigrationId` untouched, so every
  in-flight condition still holds. Gating it would let a running migration block a Plan
  deletion and leave behind exactly the dangling link this task exists to remove.
- A Plan with no sourced Lists does no extra reads and issues no writes.
- Deleting the **List** is unchanged: it already removes the projection (§P3-05) and this task
  adds nothing to that direction.

**Tests.** Integration: delete a Plan whose sourced List holds items, and assert the List and
every item survive, `sourceActivityId` is absent, and the projection is gone; a Plan sourcing
two Lists clears both; a List re-sourced to another Plan keeps its pointer when the first Plan
is deleted; a Plan with no sourced Lists writes nothing extra; the clear leaves
`List.updatedAt`, `rankVersion` and `itemVersion` byte-identical; a delete interrupted after
the clears and retried still completes. Unit: the conditional expression names the Plan being
deleted, and a condition failure is swallowed rather than raised.

---

### P3-50 — A `Sheet`-owned present/dismiss animation, so web has one at all

**Files.** `packages/ui/src/primitives/Sheet.tsx`, `packages/ui/src/primitives/Sheet.test.tsx`.

**What to build.** The row
[`../04-conventions/design-system.md`](../04-conventions/design-system.md) §4.3 already
specifies — `Sheet` present / dismiss, `slow`, `decelerate` in and `accelerate` out — as this
component's own animation rather than a modal library's.

**Why it has no animation to inherit.** It was never `Sheet`'s: react-native-web's `Modal`
faded its own container, at RNW's fixed 250 ms rather than `slow`, and outside `useMotion()`,
so Reduce Motion could not switch it off. P3-26 removed even that on web, because RNW marks
its modal *active* — and only then adds `role="dialog"` and runs its focus trap — when that
fade's `animationend` fires, and the event never arrives: measured in Chromium against the
built export, `role: null` two seconds after mount, which axe reports as a **critical**
`aria-allowed-attr`. Passing no animation type makes RNW complete that lifecycle on mount.
The accessibility fix stands; this task gives back the motion it cost, on both platforms and
under this component's control.

**Approach.** The surface already holds an `Animated.Value` for the drag. Present and dismiss
are the same value plus an opacity on the scrim, driven from `useMotion()` so `instant` under
Reduce Motion is not a branch this component writes. Dismissal must **wait for the exit**
before `onClose` reaches the caller, or a sheet that unmounts with its route will still
disappear instantly. Do not reintroduce `animationType` on web: the dialog role and the focus
trap depend on its absence, and `Sheet.test.tsx` asserts the role under jsdom precisely so a
change that puts it back behind an `animationend` fails.

**Edge cases.**

- The centred `medium`/`expanded` dialog and the `compact` bottom sheet enter differently —
  a dialog fades and scales slightly, a bottom sheet travels. One component, two resolved
  values, no second component.
- A sheet dismissed by the drag is already at its final offset; the exit animates opacity only
  from wherever the finger left it, and never snaps back first.
- `dirty` sheets route through `onDiscardRequest` and must not animate out until the prompt
  resolves.

**Tests.** Reduce Motion resolves every duration to `instant` and the sheet still mounts and
unmounts; `onClose` fires after the exit rather than with it; the dialog-role assertion from
P3-26 still passes, which is what pins the accessibility fix in place.

## Acceptance criteria

1. A list created from the `bars-to-try` template, filled with three items and never
   scheduled, is a complete feature: three item rows, zero Activities, zero index entries,
   nothing on Today, and nothing in the UI implying the items are pending.
2. Adding a template is a config entry. Adding one fixture template to
   `packages/shared/src/lists/templates.ts` makes it available in `GET /v1/list-templates`,
   in the creation sheet and in creation, with **no** schema change, no migration and no new
   branch anywhere — asserted by a test that adds one and exercises the whole path.
3. **Every seeded field is copied, not referenced.** Create a list from the `groceries`
   template, mutate its behaviour, capabilities, slot, icon and empty-state copy in the
   running process, then re-read the List: every stored value is unchanged. `templateKey`
   is provenance only, and no stored-List read path imports the catalogue.
4. `POST /v1/lists/:id/behaviour` from `collection` to `watch` initialises `details` with
   `watchStatus: 'want'` on every existing item and preserves titles and ranks; the client
   applies that upgrade immediately with the returned settings-operation Undo and no
   confirmation. A paused or crashed chunked migration leaves public META on the old
   behaviour, gates every item read/mutation, and resumes to one target generation; the final
   transaction advances `rankVersion`, so old item cursors receive `503`. Undo uses the
   dedicated compensation endpoint and restores only unchanged upgrade defaults; it does not
   attempt an ordinary destructive transition. Posting a `watch` list back to `collection`
   **without** `confirmation` returns `409`, writes nothing, and names the behaviours,
   `itemVersion`, fields lost and exact number of items affected; echoing that complete object
   succeeds only while the shown snapshot is still current.
5. Slot resolution behaves correctly in all four cases: one eligible list is used silently
   but still shown; several with a default use the default; several with none ask once and
   store the answer; none offers creation and writes nothing until confirmed. **Opening a
   list never changes the default** — verified by resolving, opening a different eligible
   list, and resolving again to the same answer.
6. List creation shows the explicit template/style catalogue before the title field, starts
   with no selection, and enables `Create list` only after a style tap and a non-empty visible
   title. No `/v1/lists/suggest-template` route or title matcher exists.
7. `Plan this item` for `Zahav` requires the fixed order Plan kind → audience → matching form,
    with neither of the first two choices pre-selected. Confirming an Event creates exactly one
    Activity and one caller `LNK#` row while leaving exactly one
    byte-identical ListItem; missing activity id, kind or audience writes nothing. Replaying
    the persisted `activityId` after the 24-hour receipt expires creates no duplicate and does
    not roll a pointer for a newer confirmed action back to the older Plan. Bridge reminders
    require client-minted `reminderId`s; offline replay writes and locally arms those same ids
    exactly once.
8. The item stays in place. Only a response carrying the caller's `viewerLink` **whose
   hydrated Activity has `schedule.date`** renders a state line, with no colour change,
   strike-through or reorder; tapping the title opens item
   detail and tapping the state line opens an Activity the caller may read. That state line
   does not suppress the item's provenance or location metadata.
9. The item title seeds the Plan title once. Editing either title or note afterwards leaves
   the other object byte-identical.
10. Deleting the Activity deletes only matching `LNK#` pointers and leaves the item intact.
    Deleting the item clears every current pointer and each linked Activity's provenance;
    every Activity survives. Skipping clears the matching pointer, while unscheduling retains
    it without a state line; rescheduling makes that same link visible again.
11. Completing a watch session at S2 E5 leaves the watch item at S2 E4 and returns an explicit
    progress-update suggestion. Dismissal writes nothing; confirming advances it to S2 E5 and
    may set `want → watching`. Completing a recurring watch occurrence writes only its
    `OCC#` row, leaves series META unchanged and returns no follow-up.
12. The `Create a Plan for S2 E6?` follow-up creates nothing when dismissed and opens `Plan this item` —
    not an Activity — when tapped, verified by a table item count.
13. Creating a meal with four ingredients writes zero list items. Tapping `Add 3 selected`
    and confirming the destination calls the activity-scoped ingredient action and writes
    exactly three, into the list the user confirmed,
    each with `sourceActivityId` and a `sourceLabel` of `Sunday dinner`. A valid maximum-length
    ingredient name and quantity succeeds with a deterministic `MAX_TITLE_LEN` title that
    preserves the full name and truncates only the quantity with an ellipsis. Ingredient
    selection is by stable `ing_` id, not array index; reorder before offline replay cannot
    redirect the action, and a deleted selected id rejects the whole write.
14. Adding the same ingredient again while the existing row is unchecked extends its label to
    `Sunday dinner · Thursday lunch` and creates no second row; doing it while the row is
    checked creates a second row.
15. Rescheduling the source meal does not change any existing item's label; deleting the meal
    leaves the items and their labels intact.
16. Reordering a 200-item list changes exactly one logical ListItem, verified by a repository
    spy asserting one `TransactWriteItems` with exactly four domain actions: delete the old
    ranked row, put the new ranked row, update its identity locator, and conditionally
    increment `META.rankVersion`. No other ListItem row is written. Concurrent allocation
    conflicts re-read neighbours and retry with a distinct rank. A reorder racing a title or
    checked-state PATCH conditionally loses on `itemRevision`, refreshes, and preserves both
    the field edit and requested move. Reordering remains available online; an offline drop springs back with
    `Reordering needs a connection.` and writes and enqueues nothing.
17. Adding a 501st item to a list returns `400` with the message `List is full.`
18. `checked: true` is rejected with `400` on a list whose `capabilities.checkable` is false
    and accepted on the same **collection** after that capability is turned on. It is rejected
    on `watch` and `meals` even when the flag remains stored. Counts, clear/uncheck endpoints
    and UI controls use the same two-part gate. No endpoint, service or
    component contains a list of "checkable kinds". The row renderer additionally requires
    `behaviour: 'collection'`; `watch` and `meals` render no checkbox even if the stored flag
    is true. Location rendering uses the parallel collection-plus-capability gate; retained
    locations stay hidden on `watch` and `meals`.
19. `Clear checked (7)` deletes seven items with **no confirmation dialog** and shows a
    10-second undo toast. Undo may be initiated only while that toast is offered; once accepted,
    its durable inverse restores all seven even if offline replay reaches the server after
    `undoExpiresAt`, with their
    original ids, previous ranks, live links and Activity provenance. Normal create cannot
    bypass their tombstones. `Uncheck all` also shows a 10-second Undo; compensation rechecks
    exactly the affected items that still exist. If no Undo is initiated before the UI window
    closes, the operation is permanent; an already accepted inverse is never discarded for
    crossing that presentation deadline.
20. A prep task created inside a plan appears on Today on its own date with the plan's title
    as its subtitle, and deleting the plan leaves it as an ordinary task with its schedule
    intact.
21. Creating a prep task on a prep task returns `400`. A Plan accepts at most 50 prep tasks;
    the 51st returns `400` with `Plan has too many prep tasks.` and no write. The complete set
    and exact done/open counts come from one `Limit: 50` `SUB#` Query, never `queryAll`.
22. Creating an `event` writes zero lists; confirming `Packing` in the suggestion
    sheet writes exactly one, with `behaviour: 'collection'`, `slot: null` and an id-only
    `SOURCE_LIST#` projection; deleting the plan removes that projection and leaves the list
    and its items with `sourceActivityId` cleared (the creation half is §P3-38, the deletion
    half §P3-49).
23. A presigned upload URL rejects a different `Content-Type` than declared, rejects a body
    over the declared length, and is unusable after five minutes.
24. An uploaded image round-trips through the local store: the presigned `PUT` succeeds, the
    confirm step moves the key out of `tmp/`, and the app renders the image from the key the
    API returned. A crash after permanent copy and before the final database transaction is
    represented by a durable pending confirmation that retry/repair completes or cleans;
    it cannot leave an undiscoverable permanent orphan. Serving through the media domain is Phase 5.
25. Setting an attachment as the cover sets `primaryAttachmentId` and the plan detail
    renders it as the hero.
26. The three worked examples in
    [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §9 pass as
    executable E2E flows, step for step, alongside the unlinked-list flow in P3-44.
27. The canonical list is `LIST#<l>` / `META` and the `USER#<u>` / `LIST#<l>` row carries
    `role` and `addedAt` and nothing else — asserted by reading both items after creation and
    comparing the pointer's attribute set to a checked-in literal list.
28. Renaming a list inline on its header writes **exactly one item**, verified by a repository
    spy; the settings sheet exposes no Rename action. The Lists tab with 40 lists issues
    exactly one `Query` and one `BatchGetItem`.
29. Two items stored with an identical `lexoRank` and different `itemId`s render in the same
    order on two independently seeded clients, and `compareListItems` returns the same result
    for both input orderings. No comparator in the codebase sorts list items on `rank` alone.
30. `GET /v1/plans?mode=initial` returns three stages in one request. `needsDate` is the `#P` bucket
    ordered by `lastActivityAt` descending; touching the oldest plan's `lastActivityAt` moves
    it to the head after GSI convergence, while the mutation response's authoritative value
    moves the client row immediately and a stale reconciliation cannot roll it back. Upcoming
    and the Past boundary query `#S` with the access-pattern-1
    two-day timezone overlap, convert before exact viewer-window filtering, merge Upcoming
    with all-Activity `#R` expansion inside a 62-day window, and supply `nextFrom` from
    converted Activity dates. Upcoming continuation reads only future `#S` and `#R`; Past
    window/cursor modes read only past `#S`. A bounded dense Past grid reports partial
    coverage until fully drained, and response unions omit inactive stages. Undated Tasks
    appear in no stage because `#N` is not queried; dated and recurring Tasks appear exactly
    once under the same boundaries as Plans.
31. The Plans tab renders all three stage headings when every stage is empty, renders no
    backlog badge or stage count, and renders `needsDate` in the server's order without
    re-sorting. Past rows are de-emphasised; Needs-a-date rows are not de-emphasised merely
    because they have remained undated.
32. Needs-a-date rows for `custom`, `meal`, `watch`, and `event` have no checkbox or date
    chip. Tapping any needs-a-date row opens plan detail and writes nothing.
33. Global `+` → `List item` requires a visible list choice before fields or capture; its
    final button is `Add to {list name}`. List detail's `+ Add an item` fixes that list, and
    neither route consults a default or recent destination.
34. Plan detail's `+ Add prep task` fixes `type: 'task'` and the current
    `parentActivityId`, ends with `Save task`, and never classifies the entered title.
35. An undated Plan detail reads `Not scheduled` with `Schedule`. Before Phase 6, People is a
    non-interactive `Coming later` discovery row with no chevron, disabled action or tap;
    Expenses and an empty private Updates section are absent. One HTTP response is assembled
    from authoritative META plus bounded per-section reads; a non-empty Updates section
    returns its newest 50 and cursor. Related Lists
    load through the Activity partition's `SOURCE_LIST#` ids plus one bounded `BatchGetItem`.
    Prep is the complete, model-capped set from one `Limit: 50` `SUB#` Query.
36. Opening a 500-item List returns META, exactly the first 50 `ITEM#` rows and an opaque
    cursor, then loads subsequent pages through the items endpoint. Link reads and Activity
    hydration are bounded to each page. No repository path queries or serialises the whole
    List partition, and the server-side `itemCount` remains 500 throughout pagination. A
    repair/migration marker or a version change between the strong pre-read, strongly
    consistent item Query and strong post-read returns no item page; after repair or behaviour
    migration, a cursor bound to the prior `rankVersion` receives `503` and the client restarts
    from page one without omissions or duplicates.
37. Follow-up selection covers the full §5.3 catalogue: a movie offers the watched update;
    a completion with incomplete one-off prep and any other qualifying row offers only the
    counted prep question; Complete all/Delete affect only those one-off ids while recurring
    prep tasks remain untouched; and a recurring parent occurrence offers nothing even when
    another row qualifies.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Participants, the participant picker beyond a non-interactive `Coming later` discovery row, RSVP, invitations, the public invite page | Phase 6 |
| Expenses, the plan's EXPENSES section beyond its hidden state | Phase 7 |
| The People layer, person views, balances | Phase 7 |
| Push notifications for prep-task completion or plan updates | Phase 5 |
| Capture from an image — the upload path is Phase 3, the *extraction* is Phase 8 | Phase 8 |
| List **sharing**: `ListMember` rows, the members endpoints, the share sheet, the leave flow, the two roles in the authorisation middleware | Phase 6. This phase writes the partition layout that makes it a small change — the canonical list at `LIST#`, pointers at `USER#` — and creates exactly one pointer. |
| RSVP summaries with real people or date suggestions on the needs-a-date row. The grouped fields ship here with zero counts, empty names and `suggestionCount: 0`. | Phase 6 |
| Sub-lists, tags, labels | Not in v1 at all |
| **User-authored** list templates — the catalogue ships with the app | Not in v1 at all |
| A fourth list behaviour. Templates are unbounded and free to add; behaviours are not | Needs a product decision (ADR-031) |
| Full link history between a list item and every activity derived from it | Not in v1 (ADR-034) |
| Any template suggester, whether model, heuristic or title matcher | Not in v1 at all; the user chooses from the catalogue |
| Nutrition, macros, recipe steps, scaling, servings | Not in v1 at all |
| A media catalogue, ratings, metadata lookup, a discovery feed for watch | Not in v1 at all |
| Serving attachments through `media.dev.ordinarydays.app`, or any assertion against the deployed bucket or distribution | Phase 5 |
| Signed URLs for media (open question OQ-1) | Phase 7, if at all |
| A map picker, geocoding, location autocomplete | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The bridge duplicates instead of linking | `Zahav` appears twice and the two copies drift | Persist one client-minted `activityId` with the bridge intent; criterion 7 replays it after receipt expiry and after a newer action. The id prevents duplication and the replay must not roll the current pointer back. |
| A cascade delete removes the other side | A user deletes a plan and loses their packing list, or deletes a watch item and loses the session | Every row of the §6.3 table is a test. Plan deletion enumerates `SOURCE_LIST#` ids and clears only matching back-links; item/Plan lifecycle clears pointers and never deletes the other object. |
| Delete Undo is routed through ordinary create or hard-expires at the toast deadline | Every Undo fails on `ITEM_TOMBSTONE#`, weakening the tombstone lets a delayed create resurrect deleted data, or an accepted offline inverse is rejected before replay | Only the opaque, retained and unused `UNDO#` operation may restore the same ids and delete matching tombstones. The UI deadline controls whether a new inverse may be accepted; replay retention controls how long an accepted inverse can arrive. Criterion 19 tests normal-create rejection, exact restoration after the UI deadline, retention expiry and token mismatch. |
| Related Lists are discovered with a scan or one read per List | Plan detail slows with table size, or Plan deletion leaves stale `sourceActivityId` values | List creation transactionally writes id-only `SOURCE_LIST#` projections. Access pattern 4 uses a bounded `SOURCE_LIST#` prefix Query plus one bounded BatchGet; Plan deletion uses the same ids. |
| Prep tasks are cascade-deleted with their parent by pattern-matching the `PART#`/`EXP#` cascade | Real to-dos vanish when a trip is cancelled | P3-18's explicit test, and a comment at the cascade site naming the exception. |
| Provenance is implemented as a viewer link | Checking off `Chicken` marks the meal as cooked, or deleting the meal deletes the groceries | §6.5 is a separate test group; `sourceActivityId` records origin while `LNK#` is caller-scoped Plan navigation, with deliberately different behaviour. |
| The provenance label is recomputed on read | Labels change after a meal is rescheduled and become lies after it is deleted | Computed once at creation and stored; acceptance criterion 15. |
| Ingredients are added to a list automatically | The user's shopping list fills with things they did not ask for, or lands somewhere they did not choose | Acceptance criterion 13 asserts zero writes before the tap and that the destination is confirmed. This is the "suggest, never auto-create" rule and it has a test. |
| Reordering renumbers the list | A 400-item list write on every drag | `lexoRankBetween` plus acceptance criterion 16's one-logical-item assertion. |
| **The list is stored in the owner's partition** with a mirror at `LIST#`, which is the obvious layout and the wrong one | It works perfectly for one user. Phase 6 then needs a migration, and every rename becomes one write per member | The canonical row is `LIST#<l>` / `META` from the first line of P3-04, the pointer carries `role` and `addedAt` only, and acceptance criteria 27 and 28 assert both. ADR-041 and ADR-042 record why. |
| A denormalised `title` or `itemCount` is added to the `USER#` pointer "to save a `BatchGetItem`" | Renaming a shared list becomes one write per member, and a grocery list two people are ticking generates fan-out writes per tick | Acceptance criterion 27 compares the pointer's attributes to a literal list and fails on any addition. The one saved call is a `BatchGetItem` over at most 100 keys. |
| A list-item comparator sorts on `rank` alone, or a reader treats that comparator as permission to expose repair-pending rows | Two devices show two orders for an Undo-restored, legacy or seeded duplicate rank, or one client receives pages from two rank generations — so it is discovered by a user, not a test | One exported `compareListItems`, the `(rank, itemId)` pair, acceptance criterion 29 and the defensive-order test in P3-03. New allocation separately serialises on `rankVersion`; strong pre/post META fences around the strongly consistent Query reject either work marker or a changed version. |
| Reorder serialises only rank allocation | A concurrent title/check edit commits and is then replaced by the stale full item image moved to its new key | Ranked row and locator share `itemRevision`; both reorder and field PATCH advance it conditionally, and retry applies the move to refreshed truth. Criterion 16 races both orderings. |
| Behaviour META changes before chunked item conversion finishes | A crash leaves half the list invalid under its advertised behaviour | `behaviourMigrationId` gates every item read/mutation while the stable snapshot is transformed; only the final transaction flips behaviour and advances `rankVersion`. Criterion 4 pauses every chunk. |
| Plans filters dated or recurring Tasks out of shared `#S`/`#R` buckets | Rows already visible in the shipped Phase 2 Plans tab disappear, contradicting the product's dated-Activity stages | P3-20 applies no Task discriminator to `#S` or `#R`; criterion 30 seeds Tasks on bucket/page and timezone boundaries and requires them exactly once. |
| The bridge implements only its three core rows | A reminder selected offline is dropped or comes back with a different identity | Bridge reminder input requires the locally persisted `reminderId`, and P3-13 extends the ordinary durable Activity-create transaction with one caller `REM#` per supplied id. |
| The Needs-a-date stage grows a stage count, a badge or an age sort | Plans becomes the backlog the stage was designed not to be | The endpoint returns no stage total to badge (P3-20), the client re-sorts nothing (P3-35), and both a schema-shape test and a directory grep test enforce it. |
| Completion mutates watch progress or recurring series META | A session advances its source list without consent, or one occurrence completes every future occurrence | Non-recurring completion returns a suggestion only; recurring completion requires `occurrenceDate`, writes `OCC#` only and returns none. Acceptance criterion 11 covers both. |
| Prep `Complete all` includes a recurring child without an occurrence selection | The request either fails or guesses which occurrence happened | `SUB#` mirrors `isRecurring`; the counted prompt and both bulk actions include incomplete one-off children only. Recurring prep tasks remain untouched. |
| A template is resolved at read time instead of copied at creation | A shipped change to the catalogue silently alters a list the user is standing in a shop reading | Acceptance criterion 3 mutates a template and asserts an existing list is unaffected. The catalogue module is importable only by creation services, the templates route, and creation-choice projections—never a stored-List read path or renderer. |
| The three behaviours grow back into eight kinds under another name | A `templateKey` comparison appears in a renderer, service or creation-target map | Plan kind is never derived from a list; the item renderer is one component (P3-28) with a CI grep asserting it holds no template key. The test for a fourth behaviour is in ADR-031. |
| A destructive behaviour change ships without the confirmation | A user turns a watch list into a checklist and loses season, episode and status on every item with no warning | Acceptance criterion 4: the unconfirmed call `409`s and writes nothing, and the dialog renders the server's own field list and item count (P3-32). |
| The ingredients flow hard-codes "the Groceries list" | The first user with two shopping lists has items land in the wrong one, or the flow breaks when the list is renamed | One `resolveSlot` implementation (P3-12), used by every add-to flow, with the destination always shown before the write. |
| Most-recently-used creeps back in as a convenience | Opening a list to check something silently redirects tomorrow's ingredients | ADR-033 rejects it explicitly; acceptance criterion 5 opens a list between two resolutions and asserts the answer is unchanged. |
| A title matcher or default style is reintroduced | `Costco run` silently becomes Groceries while an ambiguous title becomes the `Blank` / `simple-list` style, so the words—not the user's tap—choose structure | P3-07 accepts no title, P3-26 starts with no selection, and criterion 6 asserts the suggestion route and symbol do not exist. |
| An attachment upload path that goes through Lambda | 6 MB payload failures and burnt duration | Presigned `PUT` only; the API never touches image bytes. |
| The media bucket is made public "to make the images load" | Every user's images are world-readable by URL | Block Public Access on all four settings with a CDK assertion test (P0-26), since MinIO cannot catch this. The deployed check that a direct S3 `GET` returns `403` is Phase 5. |
| MinIO is treated as "close enough" and the S3 client grows a local branch | An `if (STAGE === 'local')` in the attachment path, and the deployed path is first executed in Phase 4 having never run | Endpoint and path style are read from `S3_ENDPOINT` in `lib/s3.ts` and nowhere else, exactly as `DDB_ENDPOINT` is read in `lib/ddb.ts`. A review that finds a stage check in a route, service or repository rejects the pull request. |
