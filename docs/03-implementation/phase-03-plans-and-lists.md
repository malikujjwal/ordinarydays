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
- [ ] The Lists tab as **one `Query` plus one `BatchGetItem`**, and a list screen as one
      `Query` over the `LIST#` partition.
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
      archive.
- [ ] `PATCH /v1/lists/:id` capability and behaviour changes, with the additive changes
      applying immediately and the destructive ones gated behind `?confirmDataLoss=true`.
- [ ] `User.defaultLists` and the four-step slot resolution shared by every "add to X" flow.
- [ ] `POST /v1/lists/:id/items/:itemId/schedule` — the optional bridge to Activities — with
      required `creationTarget` and `audience`, no type or audience inference, a one-time title
      copy, and per-viewer `LNK#` pointers rather than one global item state.
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
| P3-09 | Capability and behaviour changes on `PATCH /v1/lists/:id` | api | P3-05, P3-08 | no | L |
| P3-10 | `clear-checked`, `uncheck-all`, archive | api | P3-08 | yes | S |
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
| P3-24 | Shared API client: lists, templates, items, attachments, updates | shared | P3-05, P3-06, P3-21 | no | M |
| P3-25 | Lists index screen | mobile | P3-24, P1-22 | no | M |
| P3-26 | The template-first list creation sheet | mobile | P3-25, P3-07 | no | M |
| P3-27 | List detail screen and the inline add row | mobile | P3-25 | no | L |
| P3-28 | The capability-driven item renderer | mobile | P3-27 | no | M |
| P3-29 | List item sheet | mobile | P3-28 | no | M |
| P3-30 | Drag to reorder | mobile | P3-27, P3-03 | no | M |
| P3-31 | Watch behaviour: grouped items and progress UI | mobile | P3-28, P3-16 | no | M |
| P3-32 | List settings: title, capabilities, slot and behaviour | mobile | P3-27, P3-09 | no | M |
| P3-33 | The `Plan this item` kind-and-audience sheet | mobile | P3-29, P3-13 | no | L |
| P3-34 | Caller-scoped Plan state line on a list item | mobile | P3-33 | no | M |
| P3-35 | The Plans tab: three stages | mobile | P3-20, P3-24, P2-32 | no | L |
| P3-36 | Plan detail screen: full anatomy | mobile | P1-26, P3-24 | no | L |
| P3-37 | Prep section inside a plan | mobile | P3-36, P3-18 | no | M |
| P3-38 | Lists section and the `Add list` catalogue sheet | mobile | P3-36, P3-05, P3-26 | no | M |
| P3-39 | Updates section | mobile | P3-36, P3-19 | yes | M |
| P3-40 | Image picker, upload, and progress | mobile | P3-21, P3-22 | no | L |
| P3-41 | Attachment viewer and hero image | mobile | P3-40 | no | M |
| P3-42 | Explicit Plan-to-list side effects: Meal ingredients and Watch items | mobile | P3-13, P3-17, P3-12, P3-26, P1-25 | no | L |
| P3-43 | Follow-up suggestions after completion | mobile | P3-16, P3-17 | no | M |
| P3-44 | E2E: the worked examples, a list that links to nothing, and a plan with no date | ci | P3-34, P3-35, P3-42, P3-38 | no | L |

P3-23 is mechanical; follow the canonical sections and skip the discussion.

Three creation labels are cross-task contracts:

- Global `+` → `List item` opens a required list picker before any item fields. No default,
  recent list, title text, template, behaviour or model may choose the destination.
- List detail uses the exact contextual action `+ Add an item`; the current list fixes the
  destination and the final action is `Add to {list name}`.
- Plan detail uses the exact contextual action `+ Add a prep task`; the parent fixes the
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

- Validate `details.behaviour === list.behaviour` at the schema boundary, the same rule
  `Activity.details.kind` follows.
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

**Approach.** A fractional-index string generator: `lexoRankBetween(a?, b?)` returns a
string strictly between `a` and `b` in lexicographic order, with `undefined` meaning "no
bound". Base-62 over `0-9A-Za-z`, appending a character when the gap between neighbours is
exhausted rather than renumbering.

The whole point is that reordering changes **one logical item**, never renumbers the list.
P3-04's stable-id locator moves in the same transaction; that bookkeeping row is not a
second ListItem or a fan-out write.

**The `(rank, itemId)` tie-break.** `lexoRankBetween` does not guarantee uniqueness across
concurrent callers, and it is not supposed to. Two members inserting at the same position at
the same time — two people in a shop, one of them offline — compute the **same** rank from
the same two neighbours, because the function is pure and neither knows about the other. That
is expected, not exceptional
([`../02-architecture/data-model.md#shared-lists`](../02-architecture/data-model.md#shared-lists)).

The resolution is a total order, not a lock: sort by `(rank, itemId)`. `itemId` is a ULID, so
the tie-break is deterministic and identical on every device without coordination. It is not
business chronology: an offline client's ULID carries its device clock. Export the comparator from this module —
`compareListItems(a, b)` — so there is one implementation that the repository, the projection
and the client all use. A comparator on `rank` alone leaves the order to the engine's sort
stability and is the bug this rule exists to prevent.

**Edge cases.**

- `lexoRankBetween(a, a)` is a programming error, not a rank — throw. **Two items holding the
  same stored rank is not**; it is the concurrent-insert case and is resolved by the
  comparator.
- Repeated insertion at the same position grows the string. Cap the length at 64 characters
  and, on overflow, rebalance the whole list once in a background write. A 500-item cap
  makes this unreachable in practice; implement the guard anyway so the failure is a
  rebalance rather than a corrupt order.
- Ranks are opaque to the client. The client sends `afterItemId`; the server computes the
  rank. Never let the client send a rank.

**Tests.** Property test: 10,000 random insertions at random positions leave the list in the
intended order at every step. Unit: insert at head, at tail, between two adjacent ranks 200
times in the same gap and assert order holds and length stays under the cap.

Plus the concurrency test, which is the one that matters for Phase 6 and is written here
because the comparator lives here: given two items with an **identical** rank and different
`itemId`s, `compareListItems` returns the same order for both possible input orderings, and
sorting the pair produces the same array whether it started shuffled one way or the other.
Run the same assertion over 1,000 randomly shuffled arrays containing three groups of
equal-ranked items.

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
| `LIST#<l>` / `META` | The whole `List`: title, behaviour, capabilities, slot, counts, `archived`, `updatedAt` | Creation, and every list-level edit — **one write, whoever made it** |
| `USER#<u>` / `LIST#<l>` | `ListIndex`: `role` and `addedAt`, and nothing else | Creation for the owner; membership changes in Phase 6 |
| `LIST#<l>` / `ITEM#<rank>#<itemId>` | The item | Item writes |
| `LIST#<l>` / `ITEMID#<itemId>` | Stable identity locator containing the current `rank` | Item create, reorder and delete; never serialised |
| `LIST#<l>` / `MEMBER#<personId>` | A non-owner `ListMember`; the owner never has one | Phase 6 |

> **Decision:** the index entry carries no title, no icon and no counts. This is
> deliberately **not** how `ActivityIndex` works, and the asymmetry is justified in
> [`../02-architecture/data-model.md#33-list-partition`](../02-architecture/data-model.md#33-list-partition):
> an activity feed is time-ranged and sorted, so its index must carry sortable denormalised
> data; a user's lists are a small unordered set, so a batch get is cheap. In exchange,
> renaming a shared list is one write rather than one per active user, and a grocery list two
> people are ticking through generates no fan-out write per tick. A denormalised `title` on
> the pointer would reintroduce both.

Two read shapes, and no third:

- **The Lists tab** is access pattern 7: a paged `Query` on `pk = USER#<u>`, `sk begins_with
  LIST#` for 50 pointers, then **one `BatchGetItem`** for that page's `LIST#<l>` / `META`
  rows. Not a `GetItem` per list. The 100-list cap applies to Lists the user owns; incoming
  memberships may exceed it, so the cursor is not optional.
- **A list screen** is access pattern 8b: one `Query` on `pk = LIST#<l>`, returning `META`,
  every non-owner `MEMBER#` and every `ITEM#` in a single call — the same shape as access
  pattern 4 for a plan. The owner comes from `META.ownerId` plus their owner pointer, not a
  `MEMBER#` row.

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

- An item's sort key contains its rank, so a reorder is a delete-and-put, not an update. Do
  both and update `ITEMID#<itemId>.rank` in one transaction so an interrupted reorder cannot
  lose the item or leave its exact-id read pointing at the old key.
- Every list-scoped repository method takes the caller's `userId` and asserts a `USER#<u>` /
  `LIST#<l>` pointer exists before touching the `LIST#` partition. A `LIST#<l>` partition is
  not scoped by user, so the pointer **is** the access check. Phase 6 turns that check into
  the role-aware middleware (P6-32); this phase writes it once, in the repository, so the
  shape is already right.
- Deleting a list deletes the `META` row, every item, item locator, and pointer, then leaves
  `LIST#<listId>` / `TOMBSTONE` for the Phase 2.6 automatic-replay window. Deleting an item
  removes its locator and leaves `ITEM_TOMBSTONE#<itemId>` in the List partition for the same
  window. In this phase there is exactly one list pointer.

**Tests.** Integration on DynamoDB Local: create a list, add ten items, reorder the last to
the front, assert one query returns them in the new order and `itemCount` is still 10; a
reorder interrupted between delete, put and locator update is impossible (assert the
transaction is used); an exact item read follows the locator after that reorder;
renaming a list writes **exactly one item**, asserted by a repository spy; the Lists tab
issues exactly one `Query` and one `BatchGetItem` for 40 lists, asserted by a spy; a
`LIST#<l>` read by a user with no pointer returns `not_found`, not the list.

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
3. If `sourceActivityId` is present, verify it names an owned Plan and force the copied
   `slot` to `null`. A list made for one Plan must not silently become a standing destination.
4. Store `templateKey` as provenance and analytics only, and never read it to render. Create
   rejects client-supplied `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy`;
   users change only the supported settings later in List settings.

Step 2 is a copy. The stored list is the whole truth about what it can do, and no read path
consults the catalogue. That is the point of ADR-032 and it is one line away from being
implemented wrongly.

Creation writes two items in one transaction: `LIST#<l>` / `META` — the canonical list — and
`USER#<owner>` / `LIST#<l>` — the owner's pointer, with `role: 'owner'`. `GET /v1/lists` is
access pattern 7: one `Query` for the pointers, one `BatchGetItem` for the `META` rows
(P3-04). `DELETE` removes the `META` row, every item and **every** pointer in chunked
transactions, deletes every `LNK#` row, and clears `listItemId` / `listId` on Activities
named by those links — it never deletes an Activity. In this phase there is one member
pointer, but potentially many item-link rows; the delete is
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
stores `sourceActivityId` and `slot: null`; deleting a list clears the
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
an array of the same create shape, including one optional `itemId` per item, and is what the
ingredients flow uses. `GET /v1/lists/:id/items/:itemId` is the authoritative exact-id read
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

**Edge cases.**

- **Item cap 500 per list.** Beyond it, `POST` returns `validation_failed` with the message
  `List is full.`
- `checked` is validated against **`capabilities.checkable` on the list row**, not against a
  hard-coded set of list types. `checked: true` on a list whose `checkable` is false returns
  `validation_failed`. There is no list of "checkable kinds" anywhere in the code — that is
  the whole point of the capability.
- `location` is accepted only when `capabilities.supportsLocation` is true, by the same rule
  and with the same error.
- `details` is accepted only when the list's behaviour has a `details` shape, and must carry
  the matching `behaviour` discriminant.
- Checked items **stay in place**, struck through and de-emphasised. They do not jump to the
  bottom. Re-sorting under the user's finger is disorienting and makes an accidental
  double-tap destructive.
- `bulk` is a single transaction when it fits within DynamoDB's 100-action limit after its
  identity locators and receipt are counted, and a resumable chunked sequence otherwise. It
  must be idempotent both under the `Idempotency-Key` and, after that receipt expires, under
  the stable per-item ids.

**Tests.** Integration: the 501st item `400`s with the exact message; `checked: true` on a
list with `checkable: false` `400`s and on the same list after `PATCH`ing `checkable: true`
succeeds — the same item, the same request, a different capability; `location` on a list
with `supportsLocation: false` `400`s; `details` with the wrong `behaviour` discriminant
`400`s; a bulk insert of 30 items produces 30 rows in the sent order; repeating the bulk call
with the same key or replaying its stable item ids after receipt expiry produces no
duplicates. Response-loss, create → delete → replay, malformed-id, foreign-collision and
atomic explicit-remap tests are the ListItem versions of P2-49.

---

### P3-09 — Capability and behaviour changes on `PATCH /v1/lists/:id`

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
| `behaviour` `watch` or `meals` → anything else | **Destructive.** Requires `?confirmDataLoss=true`. Without it, `409 conflict`. |
| `slot` | Free. Changes no items. |
| `templateKey` | Immutable. A `PATCH` containing it is `validation_failed`. |

The `409` body must name the fields that would be lost and the **exact count of items
affected**, so the client can render "…will remove season, episode and watch status from 7
items." A generic conflict message forces the user to guess what they are agreeing to.

**Approach.** Compute the diff against the stored list, classify each field as additive or
destructive, and reject the whole request if any field is destructive and unconfirmed —
never apply half a patch. Item back-fill on an upgrade is chunked transactions over the
item partition, in the same request, with `itemCount` unchanged.

**Edge cases.**

- Upgrading a 500-item list writes 500 items. Chunk it, and make the whole operation
  idempotent so a retry after a partial failure converges.
- `watch` → `meals` is destructive in the same way as `watch` → `collection`; it is not a
  sideways move.
- Setting `slot` on a list when another list already holds that slot is allowed. Slots are
  eligibility, not exclusivity; `user.defaultLists` breaks the tie (P3-12).
- When a PATCH changes or clears a slot and that exact `(slot, listId)` is the profile
  default, the list service removes only that nested default in the same transaction as the
  List update. The conditional profile write must not clear a different destination selected
  concurrently on another device.

**Tests.** One test per row. Specifically: `collection → watch` initialises `details` on
every existing item with `watchStatus: 'want'` and leaves titles and ranks untouched;
`watch → collection` without `confirmDataLoss` returns `409` and writes **nothing**, and the
body names the affected field list and the item count; the same call with
`?confirmDataLoss=true` succeeds and drops `details`; `checkable` true → false → true
restores the original `checked` values; a `PATCH` carrying `templateKey` `400`s.

---

### P3-10 — `clear-checked`, `uncheck-all`, archive

**Files.** `services/api/src/handlers/clearChecked.ts`, `unCheckAll.ts`, `archiveList.ts`,
`apps/mobile/src/features/lists/components/ListHeaderMenu.tsx`.

**Approach.** Three small endpoints from
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists)
§2.7. `clear-checked` and `uncheck-all` are offered only when `capabilities.checkable`;
`archive` sets `archived: true` and writes nothing else.

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

`uncheck-all` is not destructive at all — it sets a boolean back — so it gets neither a dialog
nor a toast.

**Edge cases.**

- Undo re-creates the items with their **previous ranks**, not appended at the end. A
  restored shopping list in a different order is a failed undo.
- The network call fires immediately, not at the end of the window (the P2-24 rule). Undo is
  a compensating call. Closing the app mid-window leaves the deletion committed, which is the
  correct outcome.
- On a **shared** list, undo restores the items for everybody, because the delete removed
  them for everybody. A second member who added an item during the 10 seconds is unaffected —
  the undo names the deleted ids, it does not restore a snapshot.
- `Clear checked` on a list with zero checked items is absent from the menu rather than
  present and disabled.

**Tests.** Integration: seven checked and three unchecked items → seven deleted, three
untouched, `itemCount` and `uncheckedCount` both correct afterwards; undo within the window
restores seven items with byte-identical `rank` values; the endpoint on a
`checkable: false` list returns `400`. Client: a test asserting **no confirmation dialog is
rendered** on tap — written as an assertion on the absence of the dialog component, so
re-adding one fails — and that the toast appears with a 10-second window.

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
next call returns `use` with `wasDefault: true`; passing a one-off override to the ingredients
endpoint uses that list and leaves `defaultLists` unchanged. **Opening a list does not change
the default**—a `GET /v1/lists/:id` against the non-default list, then a re-resolve, still
returns the original default; deleting the default list falls back to `ask`. With no candidates
the result is exactly `{ kind: 'none', slot: 'groceries' }` and contains no template or title.
A no-destination Watch case returns `none`, then the client presents exactly the three Watch
styles unselected without `resolveSlot` returning or persisting a `templateKey`. A profile
integration test starts with all three slots, sets `groceries`, then clears `watch` with
`null`, proving each request preserves every omitted slot.

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
  creationTarget: { objectKind: 'plan', type: PlanType },
  audience: { mode: 'just_me' },
  title?, notes?, schedule?, recurrence?, reminders?, location?, details?, attachmentIds?,
  sourceUrl?
}
```

`PlanType = Exclude<ActivityType, 'task'>`. `creationTarget` is required and `type` must be
the Plan kind the user selected:
`General → custom`, `Meal → meal`, `Watch → watch`, or `Event → event`. The server never
reads `behaviour`, `templateKey` or any capability to
select or pre-select it. In this single-player phase only
`audience: { mode: 'just_me' }` is accepted; the `selected_people` union shape is already in
the shared schema but returns `validation_failed` with `Sharing is coming soon.` until Phase 6.

One `TransactWriteItems` writes:

1. `ACT#<newId>/META` — a Plan Activity with `listItemId` and `listId` provenance,
2. `USER#<caller>/IDX#<newId>` — the caller's index entry in the correct GSI1 bucket,
3. `LIST#<listId>/LNK#<callerUserId>#<itemId>` — the caller's current
   `ListItemActivityLink`.

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
- The response is `{ activity, item, viewerLink }`; `viewerLink` belongs to the caller and no
  other viewer's pointer may be serialised.

**Tests.** Integration: `Zahav` with explicit `creationTarget.type: 'event'` and
`audience.mode: 'just_me'` produces exactly one new Activity, one index entry and one caller
link while leaving the item byte-identical. Missing `creationTarget`, missing audience, a
Plan target with no type, and `details.kind` that differs from the selected type each return
`400` and write nothing. Run the same title with each explicit Plan kind and assert the stored
type follows the request every time, even when it contradicts `behaviour` or the template.
Changing either list field has no effect on the target. A repeated idempotency key creates one
Plan; a fresh confirmed action replaces only this caller's pointer.

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
| Plan completed / un-completed / skipped / rescheduled / unscheduled | Keep the `LNK#` pointer while the Plan exists. The state line is derived from that Activity for this viewer only. **Never** check, uncheck, delete or rewrite the ListItem. |
| Plan deleted | Delete only `LNK#` rows that still point to it. **The item survives.** |
| ListItem deleted | Delete its current `LNK#` rows and clear `Activity.listItemId` / `.listId` on those Plans. **Every Plan survives.** |
| Viewer schedules again | Replace only `LNK#<viewerUserId>#<itemId>`; the older Plan remains an ordinary Plan and v1 exposes no link history. |
| Viewer loses list access | Remove or invalidate that viewer's pointers; Plan access is unchanged and is enforced separately. |

Neither side ever cascade-deletes the other.

**Tests.** One test per row, all in
`services/api/src/services/__tests__/listLinkLifecycle.test.ts`. Plus a test that deletes an
Activity and asserts the item is byte-identical. Completing a Plan linked from a checkable
list leaves `checked` byte-identical. A projection seeded with links for two viewers returns
only the caller's link and never attempts to load the other viewer's Activity.

---

### P3-16 — Watch progress and status transitions

**Approach.** Completing a watch session with `outcome: 'watched'` does exactly two things:

1. Writes `status: 'completed'`, `completedAt`, `outcome` on the Activity.
2. Returns a follow-up **suggestion** to update a compatible watch item, when one is visible
   to the caller.

The suggestion creates and updates nothing. Confirming it issues an ordinary explicit item
`PATCH` that advances `season`/`episode` and may set `want → watching`; dismissal leaves the
item byte-identical. `watching → watched` is manual only: the app does not know how many
episodes there are.

**Edge cases.** For a `movie`, the follow-up is `Update {list name} item to Watched?` rather
than a next episode. A code path that writes an Activity from the follow-up is a bug, not a shortcut. If
the linked item's list has since been changed away from `behaviour: 'watch'`, its `details`
are gone: skip the progress write and return no follow-up rather than resurrecting the
fields.

**Tests.** Integration: completing S2 E5 leaves the item at S2 E4 and returns the suggestion;
dismissing writes nothing; confirming advances it to S2 E5 and `watching`. Completing a movie
does not set `watched` automatically, and no follow-up path creates a second Activity.

---

### P3-17 — Meal ingredients → a destination list, and the provenance label

**Files.** `packages/shared/src/lists/provenanceLabel.ts`,
`packages/shared/src/lists/formatIngredientTitle.ts`,
`services/api/src/services/ingredientsToListService.ts`.

**Approach.** The exact flow in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §7.3, with one
change: the destination is **resolved, not assumed**. There is no "the Groceries list" —
there is whichever `collection` the user's `groceries` slot resolves to under P3-12, and the
request may name a different one for this operation only. The service takes an optional
`listId`; when it is absent it calls `resolveSlot('groceries', …)` and returns an `ask` or
`none` result for the client to handle rather than picking a list or template itself.

Once the destination is known: one
`POST /v1/lists/:id/items/bulk` with the selected ingredients; each created item gets
`title` from the pure `formatIngredientTitle(name, quantity)` function: preserve the full
ingredient name and, when a non-empty quantity is present, append it in parentheses
(`Tortillas (8)`). If that would exceed `MAX_TITLE_LEN`, truncate only the quantity to the
remaining budget and end it with one ellipsis inside the parentheses. Thus the maximum
120-character name plus a maximum 120-character quantity still produces a valid,
deterministic 200-character ListItem title rather than making a valid meal fail bulk insertion.
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
`formatIngredientTitle` tests no quantity, an exact-boundary quantity and the 120 + 120
maximum; the last preserves all 120 name characters, has one ellipsis, and is exactly
`MAX_TITLE_LEN` characters. Integration for the duplicate rule in all three states (absent, present-unchecked,
present-checked). A test asserting the label is unchanged after the source meal is
rescheduled and after it is deleted. An integration test asserting that creating a meal with
four ingredients and never tapping the button leaves the destination list empty. Plus:
with two lists holding `slot: 'groceries'` and no default, the endpoint returns `ask` and
writes nothing; with an explicit `listId`, the items land there and `defaultLists` is
unchanged.

---

### P3-18 — Prep tasks

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

**Tests.** Integration: post then get returns newest first; a client-supplied
`kind: 'system'` `400`s; after a post, `lastActivityAt` has moved and `updatedAt` is
byte-identical, and the plan is at the head of the `#P` bucket ordering (ties into P3-20);
the cursor pages a 60-entry feed; the author deletes their own entry, a `system` entry
delete `400`s; the schedule path writes exactly one system entry per date change.

---

### P3-20 — `GET /v1/plans` — the three-stage Plans endpoint

**Files.** `services/api/src/routes/plans.ts`,
`services/api/src/services/plansService.ts`,
`packages/shared/src/schemas/plans.ts`.

**What to build.** The endpoint behind the Plans tab, exactly as specified in
[`../02-architecture/api-contract.md#22a-plans`](../02-architecture/api-contract.md#22a-plans).
One initial request, three stages, and no second call to render the screen. Later Upcoming
scrolls request another bounded date window from the same endpoint.

| Stage | Query | Order |
| --- | --- | --- |
| `needsDate` | `GSI1` `gsi1pk = U#<u>#P`, `ScanIndexForward=false` — access pattern 2b | `lastActivityAt` descending |
| `upcoming` | `GSI1` `gsi1pk = U#<u>#S`, from `upcomingFrom` through `upcomingTo`, plus the first later date as the continuation hint | date ascending |
| `past` | the same bucket, `gsi1sk < <today>T00:00`, `ScanIndexForward=false`, `?cursor=` | date descending |
| recurring input for `upcoming` | `GSI1` `gsi1pk = U#<u>#R` — access pattern 3 | expanded only inside the requested Upcoming window |

**Approach.**

1. Four logical `Query` streams, started concurrently: `#P`, the bounded future slice of
   `#S`, the cursor-paged past slice of `#S`, and `#R`. `needsDate` is capped as below. The initial
   request defaults `upcomingFrom` to today and `upcomingTo` to 61 days later; explicit
   windows may contain at most `MAX_AGENDA_DAYS` (62) inclusive calendar dates. The response
   returns `{ from, through, nextFrom }`, where `nextFrom` is the earliest one-off or recurring
   date after `through`, or `null` when neither source has one. It may jump an empty gap but
   never skips a row. Scrolling requests the next 62-day window from that date. `past` remains
   cursor-paginated per §Pagination of the API contract. The future `#S` stream stops after
   the first key beyond `through`; recurrence math supplies the corresponding next date for
   each bounded `#R` row, so calculating `nextFrom` never scans an empty calendar gap.
2. `upcoming` **expands recurring series** through the same `expandAgenda` path the agenda
   uses (P2-08), so a weekly dinner contributes one row per date. Do not reimplement
   expansion here: pass the `#R` rows and exact requested window to the shared service, merge
   them with `#S`, and propagate its recurrence warnings.
3. Items in `upcoming` and `past` are ordinary `AgendaItem` projections (P2-10). Items in
   `needsDate` are an `AgendaItem` **plus** `rsvpSummary` and `suggestionCount`.
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
- No stage-level count, total, unread marker or badge field is returned. Nested RSVP-group
  `count` values and the row-level `suggestionCount` are content, not backlog totals, and must
  never be bound to tab or heading chrome. There is nothing for a client to badge, enforcing
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.3.2.

**Tests.** Integration: three seeded activities in `#P` returned newest-`lastActivityAt`
first; touching the oldest one's `lastActivityAt` moves it to the head on the next call;
a `#N` activity appears in no stage; a recurring series contributes one row per date in
`upcoming` inside the first 62-day window; requesting its returned `nextFrom` produces the
next non-overlapping window; a 63-day request is `validation_failed`; `past` paginates and
the cursor is opaque and user-scoped. A schema test permits `rsvpSummary.*.count` and
`suggestionCount` but proves the response has no stage-level `count`, `total`, `unread` or
`badge`. A repository spy proves Phase 3 starts only the four bucket/range streams above,
pages them according to their documented caps, and performs no participant read, while
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
mock — a mock that accepts every presigned URL tests nothing.

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

1. **Confirm.** Verify the id resolves to the caller's pending key
   `tmp/u/<callerId>/<ulid>.<ext>` and that the object exists with the declared
   `Content-Type` and length (`HeadObject`). Copy it to `u/<callerId>/<ulid>.<ext>`, write
   `ACT#<id>` / `ATT#<attachmentId>`, then delete the `tmp/` object — in that order, so a
   crash leaves only a tmp object the 1-day lifecycle cleans, never a linked row with no
   bytes. All through `lib/s3.ts`; no local branch (P3-21's rule).
2. The `Attachment` row carries `attachmentId`, `key`, `contentType`, `byteSize`,
   `createdAt`, `schemaVersion`. The entity is named in the data model's key table but has
   no §4 shape; add it to
   [`../02-architecture/data-model.md#4-entity-shapes`](../02-architecture/data-model.md#4-entity-shapes)
   in the same PR. Never store or return a URL: media is served by unguessable key
   (ADR-023) and the API returns keys only for images the caller may see.
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
re-confirm is idempotent; delete removes row and object, and deleting the cover clears
`primaryAttachmentId` in the same write; confirm with no uploaded object `400`s and writes
nothing; setting the cover to a linked id succeeds and to an unlinked id `400`s; none of
these writes bumps `icsSequence`.

---

### P3-24 — Shared API client: lists, templates, items, attachments, updates

**Files.**
`packages/shared/src/client/endpoints/{lists,listItems,listTemplates,attachments,updates}.ts`.

**Approach.** Extends the P1-20 client the same way: one function per endpoint in
[`../02-architecture/api-contract.md#25-updates-the-plans-activity-feed`](../02-architecture/api-contract.md#25-updates-the-plans-activity-feed)
§2.5–§2.7, typed from the shared schemas, returning parsed data or throwing `ApiError`,
each registered with the OpenAPI harness as it is written. The task is mostly mechanical;
these contract points are not:

- `patchList` takes `confirmDataLoss?: boolean` and surfaces the destructive `409` as a
  **typed value** carrying the server's field list and affected-item count, so P3-32 can
  render it verbatim instead of re-deriving a count from a paginated cache.
- `scheduleListItem` sends `ScheduleListItemInput` exactly. No convenience overload defaults
  `creationTarget` or `audience`; an omitted field fails at the schema, loudly.
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
- List responses type `viewerLink` as the caller's link. There is no field for other
  viewers' links to filter client-side, because the server never serialises them.

**Tests.** Unit per endpoint with a stubbed `fetch`: request shape, response parsing, error
mapping. Plus: the `409` destructive-change mapping produces the typed fields-and-count
value; `putToUploadUrl` sends no `Authorization` header (spy on headers); a type-level or
grep test that no exported client function has a `rank` parameter.

---

### P3-25 — Lists index screen

**Files.** `apps/mobile/app/(app)/(tabs)/lists.tsx`,
`apps/mobile/src/features/lists/{hooks/useLists.ts, components/ListIndexRow.tsx}`.

**What to build.** The Lists tab over `GET /v1/lists`, plus the `+` that opens P3-26 and a
header `⋯` holding `Show archived`
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.6).

**Approach.**

- A row renders the List's own stored `icon`, its title, and a de-emphasised
  `n items` — with `· k checked` appended on a checkable list, mirroring the plan-detail
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
  filter over the same response, not a second endpoint.
- Empty state, verbatim from §5.9: `No lists yet` /
  `Keep things you want to remember, track, or organise together.` / `New list`.
- Pagination at 50 pointers per page, auto-fetch at 80 % scroll depth. Native pages are
  materialized into typed SQLite rows and served through repository subscriptions, with
  creates in the same transactional outbox; web uses its TanStack cache.

**Tests.** Render: a fixture whose catalogue record is mutated after creation still renders
the stored icon and copy; an archived list is absent until `Show archived`; the empty state
matches §5.9 exactly; rows render in response order for a deliberately shuffled fixture —
no client sort; a grep test that the feature directory imports no `LIST_TEMPLATES`;
navigation test that tapping a row opens list detail and issues no mutation.

---

### P3-26 — The template-first list creation sheet

**Files.** `apps/mobile/src/features/lists/NewListSheet.tsx`.

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
description from capabilities or claim a Plan kind will be selected. Title, behaviour,
capabilities and slot can be changed later in list settings (P3-32). `templateKey`, icon and
empty-state guidance remain the frozen values copied from the chosen style.

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

**Tests.** Enter `Try Zahav` through global `List item`, assert no form or capture call exists
before selecting `Restaurants to try`, and assert `Add to Restaurants to try` writes one item
there. Enter the same words through `+ Add an item` inside another list and assert they stay in
that list. A recent/default list is seeded and proved not to pre-select either route. Mutate
the selected catalogue record after creating an empty List and assert detail still renders
the stored guidance with `Nothing here`.

---

### P3-28 — The capability-driven item renderer

**Files.** `apps/mobile/src/features/lists/ListItemRow.tsx`.

**What to build.** **One** row component for every list in the product. It reads the list's
`behaviour` and `capabilities` and renders accordingly. If this component ever contains a
comparison against a template key, the model has been misunderstood.

| Input | Effect on the row |
| --- | --- |
| `capabilities.checkable` | Renders the checkbox and the struck-through checked state |
| `capabilities.supportsLocation` and `item.location` | Renders the location subtitle and the maps tap target |
| `behaviour: 'watch'` | Renders `S2 E4` and the status chip instead of a checkbox |
| `behaviour: 'meals'` | Renders the ingredient count |
| Caller-scoped `viewerLink` | Renders the state line (P3-34) |
| `item.sourceLabel` | Renders `— Sunday dinner` |

**Edge cases.**

- A row must render correctly for a list whose capabilities were changed a second ago —
  including a `watch` item whose `details` are still being back-filled by P3-09. Treat
  missing `details` as the default state rather than throwing.
- The subtitle slots are mutually exclusive by priority: state line, then source label, then
  location. Two subtitles on one row is a layout bug and a comprehension one.
- `checked` is retained on items of a list whose `checkable` is false. The renderer hides it;
  it does not clear it.

**Tests.** Render tests over a matrix of behaviour × capability combinations, asserting the
checkbox appears exactly when `checkable` is true. A test that the same item renders with and
without a checkbox purely as a function of the list row it is given. A lint-level assertion —
or a grep test in CI — that the file contains no template key string.

---

### P3-29 — List item sheet

**Files.** `apps/mobile/src/features/lists/ItemSheet.tsx`.

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
- When the response carries the caller's `viewerLink`, the state line renders with its own
  tap target opening the Activity (§6.2).

Each field edit commits one optimistic `PATCH /v1/lists/:id/items/:itemId`. Item writes
carry no `If-Match` and last write wins per field (§5.11.5). `Plan this item` opens P3-33
and is one action among several, never the primary one (§5.1). `Delete` deletes with **no
confirmation** and a 6-second undo restoring the previous rank
([`../01-product/interaction-contract.md#4-undo-policy`](../01-product/interaction-contract.md#4-undo-policy)).
Focus lands on the first control, is trapped, and returns to the row on close
(interaction contract §7.3).

**Edge cases.**

- A `watch` item whose `details` are missing mid back-fill (P3-09) renders defaults rather
  than throwing — P3-28's rule, applied here too.
- Renaming an item with a `viewerLink` renames the item only; the Plan title is
  independent after creation (P3-14).
- A status change made here regroups the row when the user returns to the list, at its
  rank within the new group (P3-31).

**Tests.** Render matrix over behaviour × capabilities asserting exactly the §5.7 field
set appears — a location field on a `supportsLocation: false` list is absent, not
disabled; delete shows no dialog and shows the undo toast; Playwright: rename an item,
open its linked Plan, assert the Plan title is unchanged; the CI grep for template keys.

---

### P3-30 — Drag to reorder

**Files.** `apps/mobile/src/features/lists/reorder.ts`, wiring in the list screen and
`ListItemRow.tsx`.

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
- Offline on native: one transaction appends the intent and materializes the row's new
  position with its `Pending` dot; web refuses the write while offline. The stable
  `Idempotency-Key` remains the server replay identity (interaction contract §5.4).

**Edge cases.**

- Dropping a row back where it started issues no write.
- Two members reordering concurrently produce identical ranks; the tie-break renders the
  same order on both devices.
- A failed `PATCH` reverts the row with the standard error toast and `Retry` (§5.3).
- Reduce Motion: the drag still tracks the finger — direct manipulation, not decorative
  motion (§6.5). No haptic on drop; haptics are completion and swipe-commit only.

**Tests.** A spy asserts the request carries `afterItemId` and no `rank`, and that one
drag enqueues exactly one mutation; a fixture with duplicate ranks renders in
`compareListItems` order both times it is shuffled; render test that the drag cannot cross
a watch group heading; a no-op drop issues no request.

---

### P3-31 — Watch behaviour: grouped items and progress UI

**Files.** `apps/mobile/src/features/lists/WatchSections.tsx`.

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

- Missing `details` during a P3-09 back-fill renders in `Want to watch` as the default
  state, without throwing.
- A list changed away from `watch` renders flat immediately; the sections component is
  chosen off the row's stored `behaviour`, nothing else.

**Tests.** Render: fixed group order with a shuffled fixture; movie vs show progress
line; a status `PATCH` regroups while preserving rank; an empty group's heading is
absent; unit test that the progress-update mutation applies `want → watching` only from
`want` and touches no other field; the template-key grep.

---

### P3-32 — List settings: title, capabilities, slot and behaviour

**Files.** `apps/mobile/src/features/lists/ListSettingsSheet.tsx`.

**What to build.** The client half of P3-09. Reached from the list's `⋯` menu: rename,
toggle `checkable` and `supportsLocation`, set or clear the default-destination `slot`, and
change behaviour. There is no setting for what Plan kind an item creates; `Plan this item`
always asks explicitly.

**Approach.** Which changes are additive and which are destructive, and the required shape
of a destructive confirmation, are fixed by
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a-product-wide-invariants)
§1a.1. Additive toggles apply optimistically with a 6-second undo toast. Behaviour changes
go through a confirmation in that shape:

- Upgrading (`collection → watch` or `meals`) states what is gained — "Items will gain a
  watch status, season and episode" — and applies on confirm.
- Downgrading (`watch` or `meals` → anything) sends the `PATCH` **without**
  `confirmDataLoss`, receives the `409`, and renders the server's field list and item count
  verbatim: "This will remove season, episode and watch status from 7 items. This cannot be
  undone." Only on confirm does it repeat the call with `?confirmDataLoss=true`.

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
  Additive ones get undo and no dialog.
- Clearing a slot that is the profile default also clears `defaultLists` for that slot, and
  the sheet says so. The one List PATCH performs the server-side conditional nested removal;
  the client does not issue a second profile request that could partially succeed.
- The sheet is a settings surface, not a wizard: every control is independent and applies on
  its own.

**Tests.** Playwright: turning off `checkable` hides the checkboxes and turning it back on
restores the previous checked state; a `watch → collection` change shows the exact server
count in the dialog, and cancelling it leaves every item's `details` intact; confirming it
succeeds; the undo toast on an additive toggle reverts the change.

---

### P3-33 — The `Plan this item` kind-and-audience sheet

**Approach.** One sheet, opened from the exact list-item action `Plan this item` or its swipe
equivalent. Step one requires `General`, `Meal`, `Watch`, or `Event`; nothing is
pre-selected from the list. Step two shows the chosen Plan-kind fields. Step three is a
required audience step. In this personal phase it contains `Just me`, initially unselected,
and the user must tap it; Phase 6 expands the same step to the final unselected `Just me` /
`Choose people` pair. Confirming issues one bridge call with required `creationTarget` and
the audience the user explicitly tapped.

The user can edit all compatible fields before confirming. The selected kind changes only by
returning to the explicit kind step; no title, behaviour, capability or parser result
changes it. Nothing is written until confirmation, whose final button reads `Save plan`.

**Edge cases.** After the user explicitly chooses `Watch`, structured watch fields may be
offered from the item and remain editable. A `watching` item at S2 E4 may offer S2 E5; that
offer does not select Watch and does not exist in another kind's form. `audience.mode` can
only become `just_me` in this phase, but only after the visible tap; it has no initial value.

**Tests.** Playwright: open `Plan this item` on `Severance`, assert all four kinds and no
selection, choose `Watch`, edit the offered S2 E5 to S2 E6, assert `Save plan` remains blocked
until `Just me` is tapped, then confirm and assert `creationTarget.type: 'watch'`,
`audience.mode: 'just_me'` and S2 E6. Repeat on a watch list
while choosing `General`; the result is `custom`, proving the list never chooses the kind.

---

### P3-34 — The caller-scoped Plan state line on a list item

**Approach.** The item stays in its list, in place. When the list-detail response includes the
caller's `viewerLink`, that caller alone sees a state line:

```
Restaurants to try
  Zahav
  Planned Saturday · 7 PM                    →
```

Rules that are easy to get wrong:

- The state line shows the caller-linked Activity's date and time in the relative format used
  elsewhere: weekday name within 7 days, otherwise `d MMM`.
- **Tapping the state line opens the Activity. Tapping the title opens the item detail.**
  Both targets are ≥ 44 pt and are separate accessibility elements.
- A caller-linked item is distinguished by the state line **alone**. No colour change, no
  strike-through, no move.
- An item on a checkable list is still checkable once scheduled. Checking one does not
  complete the Activity, and completing the Activity does not check it — except where the
  list's own `checkable` capability makes the tick meaningful (P3-15).

**Tests.** Render test asserting two separate accessibility elements with the labels from
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2.
Playwright asserting each tap target navigates to the correct screen. A projection test seeds
two viewers with different pointers and proves each response and render contains only that
viewer's Plan; a third member sees the ordinary item with no state line.

---

### P3-35 — The Plans tab: three stages

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
- `Past` paginates on scroll with the response's cursor. `needsDate` does not paginate.
  `Upcoming` loads one bounded 62-day date window initially and requests the next window from
  `upcomingWindow.nextFrom` only when the user reaches its end. A zero-row window with a
  non-null `nextFrom` retains that end sentinel, so the far-future row remains reachable; a
  null value renders the ordinary final empty line and issues no further request.
- Nothing on this screen ages, archives, greys out or re-sorts for being old.
- Pull-to-refresh refetches all three stages in the one request.

**Tests.** Render tests for all three empty states and the all-three-empty state from
§1.3.3; one needs-a-date fixture for each of the four Plan types, each with no checkbox or
date chip, and a contract fixture proving an undated task is absent; unit tests
over `rsvpSummary` for the five cases; a test asserting the rendered order equals the
response order for a deliberately unsorted fixture. Tapping either Plans `Add` empty-state
action opens the global **Task / Plan / List item** chooser with all three unselected; it does
not open a Plan form. A **grep test over
`src/features/plans/`** asserting the directory contains no badge component and no numeric
count bound to a stage length — the same shape of test P2-28 uses for unresolved items.
An Upcoming test begins with an empty 62-day window whose `nextFrom` jumps to a plan six
months out, reaches the sentinel, and renders that plan after exactly one further window load.

---

### P3-36 — Plan detail screen: full anatomy

**Approach.** One screen, one `GET /v1/activities/:id`, one DynamoDB `Query`. The ten
sections in
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1, in fixed order,
with the visibility rules in §2.2.

The rule that shapes the screen: **a section with nothing in it collapses to a single "add"
affordance rather than disappearing**, so the plan's capabilities stay discoverable. The
exceptions are the hero image (hidden with no `primaryAttachmentId`), Expenses (hidden below
2 participants and 0 expenses — Phase 7) and Updates (hidden when private with no entries).

Sections that belong to later phases render their affordance in a disabled state with copy
naming what is coming: People and Updates-from-others in Phase 6, Expenses in Phase 7.

The when/where block is **one tap target** opening the reschedule sheet, with the address row
as a separate target opening the platform maps app. It is never inline-editable.

**The reminders row shows the caller's own reminders and says so.** The response already
contains only those (P1-10 rule 6), so the client renders what it is given and adds no filter
of its own. On a shared plan the copy is `Your reminders` rather than `Reminders`, because a
plan has one schedule and many reminder sets and the screen should not imply otherwise. There
is no affordance anywhere for seeing, setting or removing somebody else's.

A plan with **no date** renders the same ten sections. The when/where block reads
`Needs a date` and opens the same sheet. Nothing about the screen treats an undated plan as a
lesser or unfinished object: a plan is an Activity with commitment or coordination, and a date
changes its scheduling state, not its identity
([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §1). The date-suggestion
section that fills this gap for participants arrives in Phase 6 (P6-51).

**Tests.** Render tests for each visibility rule. A network assertion that opening the screen
issues exactly one request. A render test over an undated plan asserting the same section set
as a dated one, with `Needs a date` in the when/where block and no copy calling it incomplete.
A test that the reminders row renders exactly the reminders in the response and that the
component contains no `userId` comparison.

---

### P3-37 — Prep section inside a plan

**Approach.** The empty PREP section renders the exact contextual action
`+ Add a prep task`. The parent Plan is already explicit, so this action fixes
`{ objectKind: 'task', type: 'task', parentActivityId }` and opens the Task form directly;
it does not reopen the global chooser or parse the title to choose a kind. The final action
reads `Save task`.

**Tests.** Create `Book hotel` from `+ Add a prep task` and assert the request contains
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

**Edge cases.** `List.sourceActivityId` is the **only** link. Deleting the plan does not
delete its lists — it clears the back-link and the lists keep their items. Completing a plan
does not archive its lists. A list of things you own is not owned by the trip. A list created
this way forces `slot: null` regardless of the selected template, so one Plan's list never
becomes a standing destination without a later explicit settings change.

**Tests.** Integration: creating an `event` writes zero lists; `Add list` initially shows the
same full unselected catalogue as general `New list`; explicitly choosing and confirming `Packing`
writes exactly one with `sourceActivityId` set, `behaviour: 'collection'` and `slot: null`;
deleting the plan leaves the list with its items and `sourceActivityId` cleared. A test runs
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
- Posting bumps `lastActivityAt` server-side (P3-19); the client refetches Plans so a
  discussed needs-a-date plan resorts. No client-side bump.

**Tests.** Render: newest first from an unsorted fixture; the §2.2 visibility matrix
(private + 0 entries hidden, private + n shown, shared + 0 shown); a system entry has no
delete affordance and no author name; optimistic post renders before the response; the
cursor fetch fires on scroll and not on open.

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

> **Decision:** `Remember this choice` is checked by default in the `ask` case, and
> unchecking it makes the choice one-off. A user with two grocery lists is asked once, which
> is the point of storing the answer; leaving it unchecked by default would ask them forever.
> Changing the destination from the `use` case never writes the default — that path has no
> `Remember` control at all.

Once the write lands, each added ingredient shows `Added` and cannot be added twice from the
same meal.

The Watch Plan's separate `Also add a list item to…` toggle is off in every context. Turning
it on resolves the `watch` slot and always shows the named destination before a write. If no
eligible destination exists, `New list` opens P3-26 constrained to exactly `watchlist`,
`movies-to-watch`, and `tv-shows`, in their canonical relative order and with none selected.
That filter comes from the user's explicit Watch-destination control; title and capture text
are not inputs. `Create list` writes only the List and returns here. Only the later named
`Save plan and add <title> to <list>` action creates the item, then submits the reviewed Plan
through P3-13's `/schedule` bridge, which creates the Plan and caller's viewer-local `LNK#`
pointer. The queued combined operation stores a stable bridge idempotency key distinct from
the item-create key, so retrying the bridge cannot create a duplicate Plan. If the item write
succeeds while scheduling is offline, the item remains a valid saved ListItem and the queued
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
A forced offline gap after item creation shows `Plan will finish syncing`; replaying the stable
bridge key creates exactly one Plan and one caller pointer, then clears that state.

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
| `meal` with ingredients | `Add ingredients to a list?` | Opens the ingredient picker and then the destination sheet (P3-42); writes only what the user selects, where they chose. |
| ≥ 1 participant and ≥ 1 expense | `Review expenses?` | Navigation only. Phase 7. |
| ≥ 2 participants and 0 expenses | `Add an expense?` | Opens the sheet. No write until saved. Phase 7. |
| Recurring occurrence | **Nothing.** The next occurrence already exists. | — |

**Tests.** An integration test asserting that dismissing every follow-up produces zero
writes. A test that a recurring completion offers no follow-up at all.

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
4. `PATCH`ing a `collection` to `behaviour: 'watch'` initialises `details` with
   `watchStatus: 'want'` on every existing item and preserves titles and ranks. `PATCH`ing a
   `watch` list back to `collection` **without** `?confirmDataLoss=true` returns `409`,
   writes nothing, and names both the fields lost and the exact number of items affected;
   with the flag it succeeds.
5. Slot resolution behaves correctly in all four cases: one eligible list is used silently
   but still shown; several with a default use the default; several with none ask once and
   store the answer; none offers creation and writes nothing until confirmed. **Opening a
   list never changes the default** — verified by resolving, opening a different eligible
   list, and resolving again to the same answer.
6. List creation shows the explicit template/style catalogue before the title field, starts
   with no selection, and enables `Create list` only after a style tap and a non-empty visible
   title. No `/v1/lists/suggest-template` route or title matcher exists.
7. `Plan this item` for `Zahav` requires an explicit Plan kind and `Just me`. Confirming an
   Event creates exactly one Activity and one caller `LNK#` row while leaving exactly one
   byte-identical ListItem; missing kind or audience writes nothing.
8. The item stays in place. Only a response carrying the caller's `viewerLink` renders a
   state line, with no colour change, strike-through or reorder; tapping the title opens item
   detail and tapping the state line opens an Activity the caller may read.
9. The item title seeds the Plan title once. Editing either title or note afterwards leaves
   the other object byte-identical.
10. Deleting the Activity deletes only matching `LNK#` pointers and leaves the item intact.
    Deleting the item clears every current pointer and each linked Activity's provenance;
    every Activity survives.
11. Completing a watch session at S2 E5 leaves the watch item at S2 E4 and returns an explicit
    progress-update suggestion. Dismissal writes nothing; confirming advances it to S2 E5 and
    may set `want → watching`.
12. The `Create a Plan for S2 E6?` follow-up creates nothing when dismissed and opens `Plan this item` —
    not an Activity — when tapped, verified by a table item count.
13. Creating a meal with four ingredients writes zero list items. Tapping `Add 3 selected`
    and confirming the destination writes exactly three, into the list the user confirmed,
    each with `sourceActivityId` and a `sourceLabel` of `Sunday dinner`. A valid maximum-length
    ingredient name and quantity succeeds with a deterministic `MAX_TITLE_LEN` title that
    preserves the full name and truncates only the quantity with an ellipsis.
14. Adding the same ingredient again while the existing row is unchecked extends its label to
    `Sunday dinner · Thursday lunch` and creates no second row; doing it while the row is
    checked creates a second row.
15. Rescheduling the source meal does not change any existing item's label; deleting the meal
    leaves the items and their labels intact.
16. Reordering a 200-item list changes exactly one logical ListItem, verified by a repository
    spy asserting one `TransactWriteItems` with exactly three domain actions: delete the old
    ranked row, put the new ranked row, and update its identity locator. No other ListItem row
    is written.
17. Adding a 501st item to a list returns `400` with the message `List is full.`
18. `checked: true` is rejected with `400` on a list whose `capabilities.checkable` is false
    and accepted on the same list after that capability is turned on. No endpoint, service or
    component contains a list of "checkable kinds".
19. `Clear checked (7)` deletes seven items with **no confirmation dialog**, shows a
    10-second undo toast, and is undoable for that window; undo restores all seven with their
    previous ranks and in their previous order. After the window the deletion is permanent.
20. A prep task created inside a plan appears on Today on its own date with the plan's title
    as its subtitle, and deleting the plan leaves it as an ordinary task with its schedule
    intact.
21. Creating a prep task on a prep task returns `400`.
22. Creating an `event` writes zero lists; confirming `Packing` in the suggestion
    sheet writes exactly one, with `behaviour: 'collection'` and `slot: null`; deleting the
    plan leaves the list and its items with `sourceActivityId` cleared.
23. A presigned upload URL rejects a different `Content-Type` than declared, rejects a body
    over the declared length, and is unusable after five minutes.
24. An uploaded image round-trips through the local store: the presigned `PUT` succeeds, the
    confirm step moves the key out of `tmp/`, and the app renders the image from the key the
    API returned. Serving through the media domain is Phase 5.
25. Setting an attachment as the cover sets `primaryAttachmentId` and the plan detail
    renders it as the hero.
26. The three worked examples in
    [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §9 pass as
    executable E2E flows, step for step, alongside the unlinked-list flow in P3-44.
27. The canonical list is `LIST#<l>` / `META` and the `USER#<u>` / `LIST#<l>` row carries
    `role` and `addedAt` and nothing else — asserted by reading both items after creation and
    comparing the pointer's attribute set to a checked-in literal list.
28. Renaming a list writes **exactly one item**, verified by a repository spy. The Lists tab
    with 40 lists issues exactly one `Query` and one `BatchGetItem`.
29. Two items stored with an identical `lexoRank` and different `itemId`s render in the same
    order on two independently seeded clients, and `compareListItems` returns the same result
    for both input orderings. No comparator in the codebase sorts list items on `rank` alone.
30. `GET /v1/plans` returns three stages in one initial request. `needsDate` is the `#P` bucket
    ordered by `lastActivityAt` descending; touching the oldest plan's `lastActivityAt` moves
    it to the head. Upcoming merges `#S` with `#R` expansion inside a 62-day window and
    supplies the next window boundary. An undated `objectKind: 'task'` appears in no stage.
31. The Plans tab renders all three stage headings when every stage is empty, renders no
    backlog badge or stage count, and renders `needsDate` in the server's order without
    re-sorting.
32. Needs-a-date rows for `custom`, `meal`, `watch`, and `event` have no checkbox or date
    chip. Tapping any needs-a-date row opens plan detail and writes nothing.
33. Global `+` → `List item` requires a visible list choice before fields or capture; its
    final button is `Add to {list name}`. List detail's `+ Add an item` fixes that list, and
    neither route consults a default or recent destination.
34. Plan detail's `+ Add a prep task` fixes `type: 'task'` and the current
    `parentActivityId`, ends with `Save task`, and never classifies the entered title.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Participants, the participant picker beyond a disabled control, RSVP, invitations, the public invite page | Phase 6 |
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
| The bridge duplicates instead of linking | `Zahav` appears twice and the two copies drift | Acceptance criterion 7 counts table items before and after. The canonical doc calls this the most commonly mis-implemented rule in the product; it gets its own test file (P3-15). |
| A cascade delete removes the other side | A user deletes a plan and loses their packing list, or deletes a watch item and loses the session | Every row of the §6.3 table is a test. Both directions clear pointers and never delete. |
| Prep tasks are cascade-deleted with their parent by pattern-matching the `PART#`/`EXP#` cascade | Real to-dos vanish when a trip is cancelled | P3-18's explicit test, and a comment at the cascade site naming the exception. |
| Provenance is implemented as a viewer link | Checking off `Chicken` marks the meal as cooked, or deleting the meal deletes the groceries | §6.5 is a separate test group; `sourceActivityId` records origin while `LNK#` is caller-scoped Plan navigation, with deliberately different behaviour. |
| The provenance label is recomputed on read | Labels change after a meal is rescheduled and become lies after it is deleted | Computed once at creation and stored; acceptance criterion 15. |
| Ingredients are added to a list automatically | The user's shopping list fills with things they did not ask for, or lands somewhere they did not choose | Acceptance criterion 13 asserts zero writes before the tap and that the destination is confirmed. This is the "suggest, never auto-create" rule and it has a test. |
| Reordering renumbers the list | A 400-item list write on every drag | `lexoRankBetween` plus acceptance criterion 16's one-logical-item assertion. |
| **The list is stored in the owner's partition** with a mirror at `LIST#`, which is the obvious layout and the wrong one | It works perfectly for one user. Phase 6 then needs a migration, and every rename becomes one write per member | The canonical row is `LIST#<l>` / `META` from the first line of P3-04, the pointer carries `role` and `addedAt` only, and acceptance criteria 27 and 28 assert both. ADR-041 and ADR-042 record why. |
| A denormalised `title` or `itemCount` is added to the `USER#` pointer "to save a `BatchGetItem`" | Renaming a shared list becomes one write per member, and a grocery list two people are ticking generates fan-out writes per tick | Acceptance criterion 27 compares the pointer's attributes to a literal list and fails on any addition. The one saved call is a `BatchGetItem` over at most 100 keys. |
| A list-item comparator sorts on `rank` alone | Two devices show two orders for the same data, and only when two people inserted at the same spot — so it is discovered by a user, not a test | One exported `compareListItems`, the `(rank, itemId)` pair, acceptance criterion 29 and the concurrency test in P3-03. |
| The Needs-a-date stage grows a stage count, a badge or an age sort | Plans becomes the backlog the stage was designed not to be | The endpoint returns no stage total to badge (P3-20), the client re-sorts nothing (P3-35), and both a schema-shape test and a directory grep test enforce it. |
| Completion mutates watch progress without confirmation | A session is marked done and the source list advances even when the user meant to keep its position | Completion returns a suggestion only; acceptance criterion 11 proves dismissal is a zero-write path. |
| A template is resolved at read time instead of copied at creation | A shipped change to the catalogue silently alters a list the user is standing in a shop reading | Acceptance criterion 3 mutates a template and asserts an existing list is unaffected. The catalogue module is importable only by creation services, the templates route, and creation-choice projections—never a stored-List read path or renderer. |
| The three behaviours grow back into eight kinds under another name | A `templateKey` comparison appears in a renderer, service or creation-target map | Plan kind is never derived from a list; the item renderer is one component (P3-28) with a CI grep asserting it holds no template key. The test for a fourth behaviour is in ADR-031. |
| A destructive behaviour change ships without the confirmation | A user turns a watch list into a checklist and loses season, episode and status on every item with no warning | Acceptance criterion 4: the unconfirmed call `409`s and writes nothing, and the dialog renders the server's own field list and item count (P3-32). |
| The ingredients flow hard-codes "the Groceries list" | The first user with two shopping lists has items land in the wrong one, or the flow breaks when the list is renamed | One `resolveSlot` implementation (P3-12), used by every add-to flow, with the destination always shown before the write. |
| Most-recently-used creeps back in as a convenience | Opening a list to check something silently redirects tomorrow's ingredients | ADR-033 rejects it explicitly; acceptance criterion 5 opens a list between two resolutions and asserts the answer is unchanged. |
| A title matcher or default style is reintroduced | `Costco run` silently becomes Groceries while an ambiguous title becomes the `Blank` / `simple-list` style, so the words—not the user's tap—choose structure | P3-07 accepts no title, P3-26 starts with no selection, and criterion 6 asserts the suggestion route and symbol do not exist. |
| An attachment upload path that goes through Lambda | 6 MB payload failures and burnt duration | Presigned `PUT` only; the API never touches image bytes. |
| The media bucket is made public "to make the images load" | Every user's images are world-readable by URL | Block Public Access on all four settings with a CDK assertion test (P0-26), since MinIO cannot catch this. The deployed check that a direct S3 `GET` returns `403` is Phase 5. |
| MinIO is treated as "close enough" and the S3 client grows a local branch | An `if (STAGE === 'local')` in the attachment path, and the deployed path is first executed in Phase 4 having never run | Endpoint and path style are read from `S3_ENDPOINT` in `lib/s3.ts` and nowhere else, exactly as `DDB_ENDPOINT` is read in `lib/ddb.ts`. A review that finds a stage check in a route, service or repository rejects the pull request. |
