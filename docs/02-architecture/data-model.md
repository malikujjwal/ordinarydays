# Data model

**Status:** canonical. Do not invent tables, entities, or key patterns that are not in
this document. If you need a new access pattern, add it to the Access Patterns table below
in the same PR and explain the key design.

**Scope (ADR-057, 2026-08-18).** This document is the server data model: DynamoDB tables,
key patterns and access paths. The native client's on-device store is a separate,
domain-specific SQLite application model — ADR-057 in [`decisions.md`](decisions.md) and
[`tech-stack.md`](tech-stack.md#34-offline-and-optimistic-updates) §3.4 mechanism 5, with
its tables specified by
[`phase-02-6-sync-hardening.md`](../03-implementation/phase-02-6-sync-hardening.md)
P2-61…P2-63. Local tables never mirror this document's `PK`/`SK`/GSI shapes, and nothing
about the native store relaxes this document's rules for server storage.

---

## 1. Core modelling decision: there is only one schedulable entity

The product language has three nouns — **Today**, **Plans**, **Lists** — plus five activity
types. That does **not** mean three or eight tables.

| Product word | What it actually is |
| --- | --- |
| **Activity** | The single stored schedulable entity. Tasks and Plans are both Activities. |
| **Task** | An Activity created with `objectKind: 'task'`. It is explicit intent, not the fallback for an ambiguous title. |
| **Plan** | An Activity created with `objectKind: 'plan'`. It may be private or shared and **may not have a date yet**: "Dinner at Zahav, sometime" is a plan that needs a date. **Not a separate entity.** |
| **Today** | A *query* over Activities for one date. Owns no data. |
| **Lists** | A separate entity (`List` + `ListItem`) for things worth remembering. A list is a complete thing on its own; a ListItem may optionally *link* to an Activity, and most never do. Lists are shareable. |
| **Activity type** | `task` / `meal` / `watch` / `event` / `custom` in the `type` field, plus a type-specific `details` sub-document. Task uses `task`; Plan uses one of the other four visible kinds (General maps to `custom`). **Not five tables.** |

> **The canonical rule, and the only one. A Plan is an Activity whose stored
> `objectKind` is `plan`, selected explicitly by the user or a labelled contextual entry
> point. A date changes its scheduling state, not its identity.**
>
> A list item is a *possibility*; a plan is an *intention*. The presence of a date, a
> non-task `type`, or another person is not what makes something a plan, and no document may
> infer one from those fields. §3.5 has the rule that implements it.

> If you find yourself writing a `Plan` table or a `Meal` table, stop. You have
> misunderstood the model.

### Why

The founding insight of the product is that meals, TV, expenses, lists, and people are not
separate mini-apps — they all move through the same lifecycle. The storage model has to
reflect that or the code will fragment into five half-products.

---

## 2. Storage choice

**Amazon DynamoDB, single-table design.**

- Table name: `od-main-{env}` (`od-main-dev`, `od-main-prod`).
- Billing mode: **on-demand** (`PAY_PER_REQUEST`). At personal / early-beta scale this is
  a few cents a month. The always-free 25 GB of storage still applies.
- Point-in-time recovery: **on** in prod.
- TTL attribute: `ttl` (epoch seconds) — used by invite tokens and idempotency records.
- Streams: **on** (`NEW_AND_OLD_IMAGES`) from Phase 7 onward, for balance recalculation
  and notification fan-out.

One GSI only:

| Index | Partition key | Sort key | Purpose |
| --- | --- | --- | --- |
| `GSI1` | `gsi1pk` | `gsi1sk` | Time-ordered per-user feeds (Today, Plans, Inbox, recurring series) |

Keep it to one GSI. Every extra index is a second write on every mutation.

---

## 3. Key schema

All items carry: `pk`, `sk`, `entity` (discriminator string), `createdAt`, `updatedAt`,
`schemaVersion` (int, starts at `1`).

### 3.1 Activity partition

The canonical Activity, its child records and every reverse-projection id live in one
partition, so plan detail starts with one authoritative `Query`. Objects that remain canonical
in another aggregate—related Lists—are hydrated from returned `SOURCE_LIST#` ids with one
bounded `BatchGetItem`, never a scan or one read per List.

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| Activity | `ACT#<activityId>` | `META` | `Activity` |
| Participant | `ACT#<activityId>` | `PART#<personId>` | `Participant` |
| Expense | `ACT#<activityId>` | `EXP#<expenseId>` | `Expense` |
| Update / note entry | `ACT#<activityId>` | `UPD#<isoTs>#<updateId>` | `ActivityUpdate` |
| Occurrence override | `ACT#<activityId>` | `OCC#<yyyy-mm-dd>` | `Occurrence` |
| Inbound occurrence-move marker | `ACT#<activityId>` | `MOVE#<yyyy-mm-dd>` | `OccurrenceMoveMarker` |
| Attachment | `ACT#<activityId>` | `ATT#<attachmentId>` | `Attachment` |
| Child pointer | `ACT#<activityId>` | `SUB#<childActivityId>` | `ChildPointer` |
| Source-list reverse pointer | `ACT#<activityId>` | `SOURCE_LIST#<listId>` | `SourceListPointer` — id-only access projection |
| **Reminder** | `ACT#<activityId>` | `REM#<userId>#<reminderId>` | `Reminder` — **per user** |
| Date suggestion | `ACT#<activityId>` | `SUGG#<isoTs>#<suggestionId>` | `DateSuggestion` |
| Durable cleanup work | `ACT#<activityId>` | `CLEANUP#<userId>#<idempotencyKey>` | `CleanupWork` — internal, never projected to clients |

> **Reminders are per user, not per activity.** A shared plan has **one schedule and many
> reminder sets**. If Ujjwal wants "leave in 15 minutes", that is his reminder; Alice must
> not receive it because he created the plan. Keying on `userId` inside the activity
> partition means one bounded `REM#` prefix Query serves the scheduler, while detail reads
> only the caller's `REM#<userId>#` prefix; it is symmetric with `PART#` and `EXP#`.
>
> When someone joins a shared plan, their own explicitly set `User.defaultReminderOffset`
> creates their own `REM#` row. `0` means At the time; absent/null means Off and creates no
> row. Nobody inherits anybody else's.

`CLEANUP#` rows are internal durability records for successful multi-phase mutations. Detail
assembly never selects that prefix; they are never included in `ActivityDetail` or
any agenda response.

`SUB#` items are thin pointers written when an activity is given a `parentActivityId` —
a prep task under a plan. They carry `childActivityId`, `title`, `status`, `rank` and
`isRecurring` so the
plan-detail screen renders its prep tasks from one bounded `SUB#` prefix Query inside the
same HTTP response, without a child lookup. The child Activity remains the source of truth; the pointer is
updated in the same transaction as the child's title, status or recurrence. The recurrence bit
lets the completion follow-up count and act only on incomplete one-off children; it never
guesses an occurrence for a recurring prep task.

### 3.2 User partition

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| Profile | `USER#<userId>` | `PROFILE` | `User` |
| Activity index entry | `USER#<userId>` | `IDX#<activityId>` | `ActivityIndex` |
| List index entry | `USER#<userId>` | `LIST#<listId>` | `ListIndex` — a pointer, see §3.3 |
| Person (contact) | `USER#<userId>` | `PERSON#<personId>` | `Person` |
| Person↔activity link | `USER#<userId>` | `PLINK#<personId>#<sortTs>#<activityId>` | `PersonLink` |
| Person↔list link | `USER#<userId>` | `LLINK#<personId>#<addedAt>#<listId>` | `PersonListLink` |
| Cached balance | `USER#<userId>` | `BAL#<personId>#<currency>` | `Balance` |
| Settlement | `USER#<userId>` | `SETTLE#<personId>#<isoTs>#<settlementId>` | `Settlement` |
| Push device | `USER#<userId>` | `DEVICE#<deviceId>` | `Device` |
| Pending attachment upload | `USER#<userId>` | `UPLOAD#<attachmentId>` | `PendingUpload` — internal cross-store confirmation state |
| Custom-activity shortcut | `USER#<userId>` | `SHORTCUT#<shortcutId>` | `Shortcut` (Phase 9) |

`Balance` is keyed by `(personId, currency)` because expenses are never converted between
currencies. A user who owes €20 and is owed $30 by the same person has two balance rows
and the UI shows two figures. `sk begins_with BAL#<personId>#` still satisfies access
pattern 11.

`PersonLink.scope` is `'shared_activity' | 'finance_only'`. Normal Plan sharing writes
`shared_activity`. When somebody leaves or is removed, an Activity with no retained Expense
reference deletes both directional links; an Activity with any Expense reference downgrades
them to `finance_only`. A finance-only link does not grant Plan access, count as an upcoming
or shared-together Activity, or appear in People activity history. It exists solely so balance
rebuild, expense drill-down, settlement, and Undo can still find the retained obligations.
When the last referencing Expense is deleted, the finance-only link is deleted too.

`PersonListLink` is the reverse projection for an **explicitly confirmed** list share. The
owner gets one for every invited or active membership; a registered active member also gets
one keyed to their reciprocal owner-scoped Person. Active rows power `sharedListCount` and
`LISTS TOGETHER`. Invited rows exist only for signup and lifecycle checks. They never count
as already sharing a list, never affect `upcomingCount`, `lastActivityAt`, FREQUENT, RECENT
or People relevance, and — critically — never authorise access. The exact
`USER#<userId>` / `LIST#<listId>` pointer remains the list access grant.

### 3.3 List partition

**The canonical list lives here**, not in the owner's partition. The `USER#<u>` / `LIST#<l>`
rows in §3.2 are index entries: one for the owner and one for each **active** non-owner,
exactly as `IDX#` works for activities. An invited person has no pointer and no access.

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| List | `LIST#<listId>` | `META` | `List` |
| Non-owner member | `LIST#<listId>` | `MEMBER#<personId>` | `ListMember` |
| List item | `LIST#<listId>` | `ITEM#<lexoRank>#<itemId>` | `ListItem` |
| List item identity | `LIST#<listId>` | `ITEMID#<requestedItemId>` | The authoritative namespace for every supplied item id. An ordinary locator stores the actual `itemId`, current `rank` and matching storage-only `itemRevision`; an ingredient-created locator also stores its exact source Activity, ingredient and original outcome. An id absorbed by deduplication stores a permanent alias to the actual item with that same source identity/outcome and no rank. Alias and locator forms have no TTL, make later ordinary creates fail on the same key, and are never serialised |
| Per-viewer Activity pointer | `LIST#<listId>` | `LNK#<viewerUserId>#<itemId>` | `ListItemActivityLink` |
| List deletion tombstone | `LIST#<listId>` | `TOMBSTONE` | Owner, deletion time and replay-window TTL; `GET` remains `404` |
| List-item deletion tombstone | `LIST#<listId>` | `ITEM_TOMBSTONE#<itemId>` | Deletion time, replay-window TTL, Undo operation id, the exact deletion snapshot and any ingredient identity carried by its locator; blocks recreation while deleted and restores the same identity owner on Undo |
| List Undo operation | `LIST#<listId>` | `UNDO#<operationId>` | Operation kind, affected item ids or settings inverse/preconditions, token hash, UI offer deadline, replay-retention TTL and consumed state; internal and never serialised. The opaque token the client holds is `<operationId>.<secret>` — the first half addresses this row with one `GetItem`, the second is what authorises, and only the hash of the whole is stored. That is what lets `POST /v1/lists/:id/undo` resolve a token without a second index or a query across a month of retained operations (P3-10) |
| List rank repair | `LIST#<listId>` | `RANK_REPAIR#<operationId>` | Stable `(rank,itemId)` snapshot progress/cursor for exceptional equal-rank or length repair; while referenced by META it gates every item-page read, and is internal and never serialised |
| List bulk operation | `LIST#<listId>` | `BULK_OP#<operationId>` | The answer a `clear-checked` or `uncheck-all` committed to before it finished committing it: the prepared Undo token and its deadline, the stable id snapshot, the progress cursor and the response receipt the last chunk stores. The operation id is derived from the caller's `Idempotency-Key`, so a retry **resumes** rather than minting a second operation and stranding the first chunks' rows behind a token nobody received. Internal, never serialised, and deleted by the transaction that finishes the operation — which is what bounds the plaintext token's life to the run (P3-10) |
| List behaviour migration | `LIST#<listId>` | `BEHAVIOUR_MIGRATION#<operationId>` | From/to behaviours, the exact target `details` value, the stable item id/rank/revision snapshot, the gated count of items whose data the change removes, the progress cursor, the `updatedAt` the operation was accepted under, its prepared response receipt and — when the change loses nothing — its prepared Undo offer; while referenced by META it gates every item read and mutation, and is internal and never serialised. **It carries no `ttl`**, unlike every other internal row here: its `META` marker has no expiry, so a work record that aged out would leave a gate nothing can drain, finish or roll back. It is removed by the final transaction, by the rollback of an untouched install, or by the delete cascade |

`lexoRank` is a fractional-index string (see `04-conventions/coding-standards.md`) so
reordering changes one logical item, never renumbers the whole list. The transaction
delete-and-puts the ranked row, updates the locator's `rank`, and conditionally advances
`List.rankVersion`. Single create uses the same condition; bulk allocates its ordered
sequence under one version advance. On conflict the server re-reads neighbours and retries,
so new writes do not intentionally publish duplicate ranks. Items still sort by
**`(rank, itemId)`** as a defensive total order for Undo-restored, legacy or seeded
duplicates within one committed generation.

Exceptional repair never turns that defensive comparator into a mixed-generation read.
Pattern 8 strongly reads META, rejects `rankRepairId` or `behaviourMigrationId`, performs its
item Query with `ConsistentRead: true`, then strongly reads META again before serialisation.
The two reads must carry the same `rankVersion` and no marker; otherwise the whole page is a
`503 internal` response with `Retry-After: 1` and no items. Every item cursor encodes that
fenced version. The final repair or behaviour-migration transaction clears its marker and
advances the version,
so a pre-operation cursor receives the same `503` and restarts at page one instead of resuming through
changed rows. A reorder that races between either META read is detected by the same post-fence.

The locator is what makes a client-minted item id stable while rank remains server-owned and
mutable. Create conditionally puts `ITEMID#<itemId>` and the ranked item together with matching
`itemRevision` values; exact read gets the locator, then its current ranked key. Every field
mutation conditionally advances both revisions while updating only supplied fields. Reorder
condition-checks the old row/revision, moves a freshly read row and the locator to the next
revision, and advances `rankVersion` in one transaction. A race with a field edit makes one
operation re-resolve/retry rather than allowing a stale full-row put to erase that edit. Delete
removes both and writes the tombstone. Ordinary creates always
condition-check tombstone absence. The authenticated Undo service is the sole exception: an
opaque retained, unused token must resolve to the matching `UNDO#` operation and every
tombstone must name it before the same item id, ranked row and locator can be restored and the
tombstone removed. Delete snapshots include the current viewer links and corresponding Activity
provenance so compensation is an inverse rather than a fresh item create. A full-list
projection ignores identity, Undo, tombstone, repair and behaviour-migration rows.

`List.itemVersion` is the storage-only generation of the complete item set. Every public
transaction that creates, patches, checks, reorders, deletes or restores items advances it once
(per bounded chunk). A gated rank repair or behaviour migration advances it in the final
transaction that removes its marker, because public deciding reads cannot observe its partial
chunks. Unlike `rankVersion`, it is not a page-cursor fence: checkbox taps
must not invalidate an unrelated reader's pagination. It exists for operations such as P3-17
that classify against **all item fields** and then write from that decision. Those operations
take a strong META/query/META snapshot, require both generations unchanged, and condition their
transaction on both. Legacy META rows have no counter; absence is version zero and DynamoDB's
first atomic increment installs version one, so adoption is lazy and scan-free.

> **The list index entry is a near-pure pointer.** It carries `role` and `addedAt` and
> nothing else — no title, no counts. The Lists tab is one `Query` for the pointers plus one
> `BatchGetItem` for the `META` rows.
>
> This is deliberately **not** how activity index entries work, and the asymmetry is
> justified: an activity feed is time-ranged and sorted, so its index must carry sortable
> denormalised display data. A user's lists are a small unordered set, so a batch get is
> cheap — and in exchange, renaming a shared list is **one write** instead of one per
> member, and a grocery list two people are ticking through does not generate a fan-out
> write per tick.

`LNK#` is intentionally keyed by **viewer first**. A shared list item can lead to Alice's
private Plan, Ben's private Plan, or a Plan they explicitly share; there is no global link on
the item. The fixed key gives each viewer at most one current state line per item and lets
member removal query and delete that user's pointers with `begins_with
LNK#<viewerUserId>#`. A list-detail query may read other viewers' rows internally, so its
projection must discard them before any Activity lookup or response serialisation (access
pattern 8b and `security-privacy.md` §1 row 15a).

### 3.4 Lookup partitions

| Item | `pk` | `sk` | Notes |
| --- | --- | --- | --- |
| Invite token | `INVITE#<token>` | `META` | `ttl` set; resolves to activityId + personId |
| Email → user | `EMAIL#<lowercased-email>` | `USER` | for matching guests to new signups |
| Guest email → person refs | `GUESTEMAIL#<lowercased-email>` | `OWNER#<ownerId>#PERSON#<personId>` | reverse index so guest→account linking is a `Query`, never a `Scan` |
| Expense id → activity | `EXPENSE#<expenseId>` | `META` | thin `ExpenseLocator`; resolves a globally unique expense id to `activityId`, then the service authorises the caller against that Activity |
| Settlement id → history row | `SETTLEMENT#<settlementId>` | `META` | thin `SettlementLocator`; resolves to `ownerId` + the exact `SETTLE#…` sort key for guarded undo |
| Idempotency record | `IDEM#<userId>#<key>` | `META` | Stored successful response status + body and optional cleanup reference; `ttl` = now + 24 h; conditionally written in the main domain transaction |
| Deletion tombstone (Phase 2.6) | `ACT#<activityId>` | `TOMBSTONE` | Written in the delete transaction; carries `ownerId`, `deletedAt`; `ttl = deletedAt + MAX_AUTOMATIC_INTENT_AGE_DAYS` (`packages/shared`) — the same constant that bounds client auto-replay, imported by both, so the two windows cannot be tuned apart. A client-minted create is a `TransactWriteItems`: `ConditionCheck` on this item's absence + conditional `Put` on `META`. `GET` for a tombstoned id stays `404`. Removed at account purge. DynamoDB's lazy TTL deletion is slack, never the margin |
| Rate-limit counter | `RATE#<scope>#<subject>` | `<windowStart>` | `ttl` = window end |

> Idempotency keys are **user-scoped**. A bare `IDEM#<key>` partition would let one user's
> client-generated key return another user's stored response. This is a security
> requirement, not a nicety.

`GUESTEMAIL#` items are written whenever a guest Person is created with an email, and
deleted when that Person is linked to an account, its email is removed, or the Person itself
is deleted. Removing one Plan participation or List membership does **not** delete this
Person-level locator; the same contact may still be referenced elsewhere. On signup, the
post-confirmation trigger queries `GUESTEMAIL#<verified email>` to find every guest record
across every owner's contact list and merges them. Merging without a **verified** email is
forbidden — see `security-privacy.md`.

### 3.5 GSI1 buckets

`GSI1` is populated **only on `ActivityIndex` items** (`USER#<u>` / `IDX#<a>`).

| Bucket | `gsi1pk` | `gsi1sk` | Serves |
| --- | --- | --- | --- |
| Scheduled | `U#<userId>#S` | `<localDateTime>#<activityId>` — e.g. `2026-08-06T19:30#a_01H…` | Today, Plans → Upcoming, date ranges |
| Needs a date | `U#<userId>#P` | `<lastActivityAt>#<activityId>` | Plans → Needs a date. **Never Today.** |
| Anytime | `U#<userId>#N` | `<createdAt>#<activityId>` | Today's Anytime section |
| Recurring series | `U#<userId>#R` | `<seriesStartDate>#<activityId>` | Recurrence expansion. `seriesStartDate` = the first segment's `effectiveFrom` (§4.2) — immutable, so the index key never rewrites on a segment append |
| Archived | *(attribute removed)* | — | **Undated terminal items only** (decision 2026-08-07): the 60-day maintenance sweep strips the index attributes from `#N` and `#P` items 60 days after they reach `completed`, `skipped` or `cancelled`, and from nothing else. It never touches `#S` items — a past dated row is Plans → Past, which is permanent product history, not a rolling window |

#### Bucket derivation

Exactly one pure function decides the bucket. It lives in
`packages/shared/src/activity/bucket.ts`, has no I/O, and has its own test matrix.

```ts
function deriveGsi1Bucket(a: Activity): 'S' | 'P' | 'N' | 'R' {
  if (a.recurrence)                              return 'R';
  if (a.schedule?.date)                          return 'S';
  if (a.objectKind === 'plan')                   return 'P';
  return 'N';
}
```

Order matters. Do not reorder the conditions.

**Why `#P` and `#N` are different buckets.** Both hold activities with no date, but they
mean opposite things. `#N` means *today, whenever* — "Submit the insurance form". `#P` means
*someday, undecided* — "Dinner at Zahav with Alice and Ben, date TBD". Putting them in one
bucket was the model's largest product error: it sent an undecided group plan to Today's
Anytime list next to a solo errand.

**Why `objectKind` is the test.** The client already asked whether this is a Task or a Plan.
Re-deriving that answer from `type`, people, or prose would erase the user's decision. A
private, undated Plan belongs in Needs a date; a Task stays in Anytime. Adding people, setting
a date, or choosing a presentation type cannot silently change that identity.

The bucket must be recomputed, and the index entry rewritten, whenever any input changes:
a date is set or cleared, `objectKind` is explicitly changed, or a recurrence is added or
removed. Participant and `type` changes are not bucket inputs.

**`lastActivityAt` is a distinct field from `updatedAt`.** It is bumped by RSVP changes,
posted updates and added expenses — anything that means "this plan is being discussed" —
and it sorts the Needs-a-date list descending, so the plan people are actually talking
about floats to the top rather than the oldest one. `updatedAt` is bumped only by edits to
the Activity itself, because it backs the `If-Match` optimistic-concurrency header. Bumping
one field for both purposes would make a participant's RSVP spuriously fail an unrelated
open edit sheet with `409`.

The repository helper takes the complete post-write value:
`touchLastActivity(activity, at, indexedUserIds, tx)`, mirroring `patchActivity`. It updates
the projected `lastActivityAt` for every ActivityIndex row. Only a `#P` row rewrites `gsi1sk`
to `<lastActivityAt>#<activityId>`; `#S`, `#R` and `#N` preserve their bucket-specific
`gsi1pk`/`gsi1sk` strings byte-for-byte.

`localDateTime` is the **user's local** wall-clock time, stored as `YYYY-MM-DDTHH:mm` with
no offset. Reasoning: "Today" is a wall-clock concept. The absolute UTC instant is stored
separately in `scheduledAtUtc` for reminders and `.ics` export.

Every scheduled `ActivityIndex` projection also stores the Activity schedule's IANA zone as
`ActivityIndex.timezone`. Agenda reads widen the `#S` key range by two days on each side,
convert each timed row from that stored zone into the requested viewer zone, and only then
filter to the exact requested dates. Without the projection, New York evening rows viewed
from Tokyo can fall outside the unconverted key range and disappear.

**Mixed-generation read rule.** Index rows written from P2-08 onward carry `timezone`.
Phase 1 rows may not. Agenda already hydrates every scheduled candidate's `ACT#/META`; when
the thin row has no `timezone`, it uses `META.schedule.timezone` as the canonical fallback.
It never substitutes the viewer's zone. The next ordinary write rebuilds the entire index
projection and stamps `timezone` opportunistically. This is deliberately **not** a
`schemaVersion` migration: the old index row does not contain enough information to derive
the zone, so `migrate.ts` is untouched and there is no scan or one-off backfill.

`ActivityIndex.status` is denormalised presentation state. Any non-occurrence operation that
changes META status must update **every** owner/participant index row in the same
transaction; readers do not repair stale status after the fact.

> An `ActivityIndex` item exists for the **owner and every participating app user**. That
> is how a shared plan appears on someone else's Today. Guests (non-users) get no index
> entry — they only have the invite page.

---

## 4. Entity shapes

TypeScript definitions live in `packages/shared/src/types/`. These are the authoritative
shapes; the table above only describes where they are stored.

### 4.0 User

> **Added in P1-06.** This section did not exist: `User` was the only entity in the model
> with no shape written down, despite being the tenant record every other item is keyed by.
> Its fields were spread across `api-contract.md` §2.1 (what `PATCH /v1/me` accepts),
> `auth.md` (the defaults the post-confirmation trigger writes), `notifications.md`
> (`defaultReminderOffset`, quiet hours), §4.6 below (`defaultLists`), and two phase-task
> prose tables. Consolidated here so the schema has one source, the way every sibling entity
> already did.

```ts
type WeekStart = 0 | 1;                    // 0 = Sunday
type OnboardingState = 'new' | 'done';

interface User {
  userId: string;              // "usr_01J..." — but see the note below
  displayName: string;
  timezone: string;            // IANA, e.g. "America/New_York"
  currency: string;            // ISO 4217
  weekStartsOn: WeekStart;

  defaultReminderOffset?: number | null;   // minutes, [-10080, 0]. See below.
  allDayReminderHour?: number;             // 0–23, local

  quietHours?: { enabled: boolean; start: string; end: string };   // Phase 5 (P5-11)
  // Monotonic counter bumped transactionally by every reminder-relevant write: reminder
  // create/delete, schedule or recurrence change, completion, participant change. Devices
  // acknowledge the version they armed against (§4.0a); the reminder Lambda compares the
  // two to suppress visible pushes for locally-armed reminders (P5-16 second amendment).
  reminderStateVersion?: number;                                   // Phase 5 (P5-16)
  notificationPrefs?: Record<string, boolean>;                     // Phase 5 (P5-11)

  defaultLists?: Partial<Record<DefaultSlot, string>>;             // §4.6. Phase 3.

  // Phase 4. Written by the post-confirmation trigger, the only thing that creates a
  // profile. Absent on the seeded local dev row, which has no account behind it.
  email?: string;
  cognitoSub?: string;
  onboardingState?: OnboardingState;

  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}
```

**Rules**

- **`defaultReminderOffset` has three states and they are not interchangeable.** A negative
  number is "that many minutes before"; `0` is a real *At the time* reminder; `null` or
  absent is **Off** and creates no `REM#` row at all. A new account ships Off. A schema that
  collapsed `0` into absent would silently turn "at the time" into "no reminder" for every
  joiner (ADR-047).
- **`userId` is not asserted as a ULID.** `LocalIdentityProvider` runs as the constant
  `usr_local_dev` for the whole of Phases 1–3, so the shared check is a prefixed-string one
  (`usr_`, 5–40 characters) and the strict ULID assertion lives at the point of generation —
  `newUserId()` in P1-07. A validator that rejects the id the system is currently running as
  is a validator that gets deleted under pressure (P1-01).
- **The whole shape exists from Phase 1**, including the fields Phases 3, 4 and 5 populate.
  They are optional and unset until then. Adding a field to a stored shape later is a
  migration; declaring it optional now is a line.
- `PATCH /v1/me` accepts a strict subset — `displayName`, `timezone`, `currency`,
  `weekStartsOn`, `defaultReminderOffset`, `defaultLists` — and rejects anything else by
  name rather than ignoring it. `defaultLists` is a nested per-slot patch whose input values
  are `string | null`: omission preserves a slot, a string sets it and `null` removes that
  key. The stored map remains `Partial<Record<DefaultSlot, string>>`; it never stores null.
  `email`, `cognitoSub` and `onboardingState` belong to the auth flow, not to the user.

### 4.0a Device

> **Added in P1-08.** The same gap §4.0 closed for `User`: `Device` had a key row in §3.2 and
> an access pattern at §5 row 15, but no shape anywhere — its fields existed only as a body
> in `api-contract.md` §2.1 and a retention row in `security-privacy.md` §3. Written down
> here so the two endpoints that produce it have one source.

```ts
type DevicePlatform = 'ios';

interface Device {
  deviceId: string;            // "dev_01J..."
  expoPushToken: string;       // "ExponentPushToken[...]"
  platform: DevicePlatform;
  deviceName?: string;         // "Ada's iPhone" — operator debugging only
  // Local-first delivery acknowledgement (Phase 5, P5-16 second amendment). Written only by
  // PUT /v1/me/devices/:deviceId/reminder-ack after the device has VERIFIED arming; read by
  // the reminder Lambda's suppression check. Absent = no local coverage, always push.
  reminderStateVersion?: number;   // matches USER#/PROFILE's counter when current
  scheduledThrough?: string;       // ISO instant: last locally-armed fire time (iOS 64-cap horizon)
  reminderAckAt?: string;          // ISO instant of the acknowledgement

  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}
```

**Rules**

- **One row per install, never per token.** Token rotation is delete-then-create rather than
  an upsert: the registration body carries no `deviceId`, the server mints one and returns
  it, and the client stores that id and `DELETE`s it when the token changes or the user signs
  out (P5-16). Keying the row on the token instead would make the id unnecessary and the
  delete unaddressable.
- **`updatedAt` never moves.** A device row is created and deleted, not edited. The field
  exists because every item carries it (§3), not because anything bumps it.
- **`platform` has one member in v1.** iOS is the only platform that registers: the web build
  has no push at all and there is no Android build. ADR-009 records that Android will work
  through the same API, and this is the change it needs — one more member. A union of two
  today would store a value nothing produces and nothing reads.
- **Nothing renders a device.** There is no device-list screen in v1 and P5-16 says not to
  build one. The rows exist so the reminder Lambda can fan out over access pattern 15, and
  they are removed by four paths and no others: the `DELETE` endpoint, a
  `DeviceNotRegistered` push receipt (P5-13), account deletion (`auth.md`), and nothing else.
- **The Expo push token is a device identifier** in the privacy classification
  (`security-privacy.md` §3), retained until sign-out, device removal or account deletion —
  which is why the sign-out sequence deletes the row *before* clearing tokens rather than
  after (`auth.md` §3.4 step 2).

### 4.1 Activity

```ts
type ActivityType = 'task' | 'meal' | 'watch' | 'event' | 'custom';
type ActivityObjectKind = 'task' | 'plan';
type PlanType = Exclude<ActivityType, 'task'>;

type ActivityStatus =
  | 'saved'       // exists, no date committed
  | 'scheduled'   // has a date (and optionally a time)
  | 'completed'
  | 'skipped'
  | 'cancelled';

interface ActivityBase {
  activityId: string;          // ULID, prefixed: "act_01J..."
  ownerId: string;             // USER id of creator
  status: ActivityStatus;

  title: string;
  notes?: string;

  // Schedule — all optional. Its presence sets the scheduling state, not the identity (§1).
  schedule?: {
    date: string;              // YYYY-MM-DD, user-local
    time?: string;             // HH:mm, user-local. Absent => all-day / anytime-that-day
    endTime?: string;          // HH:mm
    timezone: string;          // IANA, e.g. "America/New_York"
    scheduledAtUtc?: string;   // ISO instant, derived; absent for all-day
    endAtUtc?: string;
  };

  recurrence?: Recurrence;     // see §4.2
  // NO reminders[] here. Reminders are per-user items — see §3.1 and §4.3.

  location?: {
    label: string;
    address?: string;
    lat?: number;
    lng?: number;
    mapUrl?: string;
  };

  // Relationships
  parentActivityId?: string;   // prep task belonging to a plan
  listItemId?: string;         // the List item used by the explicit "Plan this item" action
  listId?: string;             // owning list of that item
  sourceUrl?: string;          // pasted link
  primaryAttachmentId?: string;

  // Denormalised counters, maintained on write
  participantCount: number;
  childCount: number;
  expenseTotalCents: number;

  visibility: 'private' | 'shared';

  details: ActivityDetails;    // discriminated on `type` — see §4.4

  completedAt?: string;
  outcome?: 'done' | 'attended' | 'watched' | 'had_it' | 'didnt_happen' | 'didnt_go';
  snoozedUntil?: string;       // one-off only; recurring snooze is an Occurrence override

  icsSequence: number;         // starts at 0; RFC 5545 SEQUENCE for calendar exports

  createdAt: string;
  lastActivityAt: string;      // discussion activity; sorts #P, never backs If-Match
  updatedAt: string;
  schemaVersion: 1;
}

type Activity = ActivityBase & (
  | { objectKind: 'task'; type: 'task' }
  | { objectKind: 'plan'; type: PlanType }
);
```

**Rules**

- `status` is derived on write, never set freely by the client:
  `completed`/`skipped`/`cancelled` are set by the completion endpoints; otherwise
  `schedule?.date ? 'scheduled' : 'saved'`.
- A date is a **scheduling state, not an identity** (§1). `objectKind` is selected explicitly
  at creation and is the sole source of truth for Task versus Plan. It is not inferred from
  `schedule`, `type`, `participantCount`, title text, or capture output.
- `objectKind: 'task'` requires `type: 'task'` and no direct participants. A prep task may
  still be visible to the parent Plan's participants through the parent-authorisation rule
  without carrying its own participant rows.
- **`parentActivityId` requires `objectKind: 'task'` and `type: 'task'`** (added in P3-18).
  The field sits on the shape both arms share, so nothing structural refused an attached
  Plan — but a Plan with a parent takes a `SUB#` pointer and a slot against
  `MAX_PREP_TASKS_PER_PLAN`, renders in a PREP section
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §3 defines as tasks,
  and would be swept up by P3-43's `Complete all` while Plan completion is owner-only and
  global ([`../01-product/activities.md`](../01-product/activities.md) §5.1). The rule is
  enforced on the **resulting** state of any write, so both `POST` with a parent and the
  `PATCH` that converts an already-attached task are refused; the pairing with §7's
  *Create activity* and *Patch a prep task* rows is what keeps the pointer and counter
  describing tasks alone.
- `objectKind: 'plan'` requires `PlanType`: `custom` (the visible **General** kind), `meal`,
  `watch`, `event`. It may have zero participants; private Plans are first-class
  Plans. There is no hidden task-flavoured Plan. Adding or removing participants changes
  `visibility` and access only; it never changes `objectKind`.
- `objectKind` changes only when `PATCH /v1/activities/:id` explicitly carries it. No title,
  notes, schedule, recurrence, type, or participant mutation infers or triggers conversion.
- Task → Plan requires the same patch to carry `objectKind: 'plan'` and a **user-selected**
  `type: PlanType`; the server never derives that Plan type from the existing Task.
- Plan → Task requires the same patch to carry `{ objectKind: 'task', type: 'task' }` and is
  allowed only when `participantCount === 0`, `expenseTotalCents === 0`, and
  `childCount === 0`. Any non-zero value returns `409 conflict` with every blocking field
  and its current value, so shared, financial, or prep-task data cannot be hidden by a kind
  change.
- `type` remains editable within the current object kind — for example, the user can change
  a Watch into a Custom. Changing type keeps `details` fields that still apply and drops the
  rest (log what was dropped). A type incompatible with the current `objectKind`, without
  the matching explicit conversion, is invalid.
- `icsSequence` increments **only** when a field that appears in an exported calendar
  event changes: `title`, `schedule.date`, `schedule.time`, `schedule.endTime`,
  `schedule.timezone`, `location`, `status → cancelled`, and the event description. It
  never increments for notes, expenses, participants, or attachments. Calendar clients use
  a decreasing or static `SEQUENCE` as a signal to ignore an update.
- A non-recurring snooze writes `snoozedUntil` on this META row and keeps `status` derived
  from schedule. Undo/unsnooze deletes the field. A recurring snooze never writes it here;
  it writes the `Occurrence` in §4.5.
- **`childCount` moves with an `ADD` and never touches `updatedAt`** (P3-18). It is a
  denormalised count of `SUB#` rows rather than an edit to the plan: bumping the plan's
  concurrency token because somebody added a prep task would `409` an unrelated `If-Match`
  edit of the plan itself, and `GSI1_PROJECTED_ATTRIBUTES` carries no `childCount`, so no
  index entry is rewritten either. `ADD` also means two concurrent children each apply their
  own delta rather than one overwriting the other's read-modify-write. The increment is
  conditional on `attribute_exists(pk) AND childCount < MAX_PREP_TASKS_PER_PLAN`, so the cap
  is enforced where the count is authoritative rather than by a service precheck that a
  concurrent create can outrun; the decrement is conditional on the count being above zero.

### 4.2 Recurrence

```ts
interface Recurrence {
  mode: 'fixed' | 'after_completion';   // Phase 2 ships `fixed` only
  segments: RecurrenceSegment[];        // ordered, effectiveFrom strictly ascending; 1–20
  endDate?: string;                     // series-level Ends: On a date
  count?: number;                       // series-level Ends: After N occurrences, counted
                                        // across all segments from the first anchor
}

interface RecurrenceSegment {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
      | 'interval_days' | 'weekdays' | 'custom';
  interval?: number;                    // for interval_days / every-N-weeks / every-N-months
  byWeekday?: (0|1|2|3|4|5|6)[];        // 0 = Sunday
  byMonthDay?: number[];
  byMonth?: (1|2|3|4|5|6|7|8|9|10|11|12)[];   // yearly only
  rrule?: string;                       // RFC 5545 string for `custom`
  effectiveFrom: string;                // YYYY-MM-DD; the segment's expansion anchor.
                                        // First segment: schedule.date when recurrence was
                                        // set. Appended segment: the date the "all future"
                                        // edit took effect.
  time?: string;                        // HH:mm; the time in force during this segment,
                                        // snapshotted from schedule at segment creation
  endTime?: string;                     // HH:mm
}
```

Segments are **append-only** except for the same-day correction below. An "all future
occurrences" edit (rule or time) normally appends a segment; it never mutates or deletes an
existing one. A segment is in force from its
`effectiveFrom` to the day before the next segment's `effectiveFrom`; the last segment runs
until `endDate`/`count`, or forever. The 21st segment is rejected with `validation_failed`.
`schedule.time`/`schedule.endTime` mirror the **active** (last) segment so detail rendering,
reminders and `scheduledAtUtc` derivation are unchanged; past segments keep their own
snapshot so history renders at the time in force. Lazy migration (§9): a pre-segment
`Recurrence` reads as `{ mode, endDate, count, segments: [{ …ruleFields, effectiveFrom:
startDate, time: schedule.time, endTime: schedule.endTime }] }`. See
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §6.2 for the product
decision (segmented recurrence, 2026-08-07: history always renders under the rule in force
at the time).

**Same-day correction (founder-approved 2026-08-12).** If the active segment's
`effectiveFrom` equals today in the Activity timezone, the client may replace only that last
segment instead of appending, provided `ACT#<id>/OCC#<today>` does not exist. The META/index
rewrite and `attribute_not_exists` condition on the occurrence key share one transaction, so
an occurrence action racing the edit cannot lose history. Any stored occurrence override,
any earlier active date, or any attempt to change an earlier segment keeps the append-only
rule. This is correction-before-history, not an "edit all occurrences" operation.

`Recurrence` remains a 1–20-segment stored shape, but `CreateActivityInput` accepts exactly
one segment. Supplying more on create is `validation_failed`; the only way stored history
grows is the all-future append path below.

The server owns every `effectiveFrom`. On PATCH, optional top-level
`editedFromDate: WallDate` must be a date emitted by the current stored active rule and becomes
the appended segment's anchor; when absent, the anchor is today in the Activity's timezone.
Any client-supplied `effectiveFrom` inside the segment is ignored. The first segment remains
anchored to `schedule.date` when recurrence is created.

**`yearly`** exists because birthdays and anniversaries are the most common recurring events
in a life planner, and forcing them through a hand-written `rrule` would put the single most
obvious use case behind the least accessible option.

The Repeat sheet **always writes explicit anchors** — `byMonth` and `byMonthDay` for
`yearly`, `byMonthDay` for `monthly` — rather than relying on the segment's `effectiveFrom`.
The expansion function falls back to the segment's `effectiveFrom` when they are absent, so
a hand-constructed series still works, but the client never depends on that.

> **Decision:** explicit anchors, uniformly. If a yearly series anchored on its segment's
> `effectiveFrom` and
> the user rescheduled the first occurrence, every future year would silently move with it.
> A birthday must not drift because you shifted this year's dinner. The same argument
> applies to monthly, so both behave identically rather than each having its own rule.

Leap-day handling follows the **same clamping rule as monthly**: a yearly series on
29 February emits **28 February** in non-leap years. Never skipped, never spilled into
March. See `../01-product/today-and-tasks.md` §6.1.

**Recurring activities are never materialised into future rows.** One Activity row holds
the series. The agenda endpoint expands the series for the requested date window at read
time and merges in `Occurrence` overrides. See §6.

#### Recurrence-changing operations

The three user-facing phrases below are separate domain operations. They must not share a
generic `Never` branch:

| Phrase | Required target | Stored result |
| --- | --- | --- |
| **Does not repeat** | An explicit nominal occurrence date for an existing series; no target is needed on a new draft | Resolve the selected occurrence through its active segment and `OCC#<date>` override, copy its effective date/time/end time to `ACT#/META.schedule`, retain the Activity timezone, then remove `recurrence`. Other virtual occurrences stop rendering. Existing `OCC#` rows remain stored. |
| **End series** | An explicit occurrence date | Preserve `recurrence` and set its series-level `endDate` inclusively. Earlier occurrences and their override rows continue to render. |
| **No end** | Activity/series scope | Preserve `recurrence` and clear both `endDate` and `count`, so expansion continues indefinitely. |

Converting an existing series is an optimistic transaction, not a PATCH assembled from
client cache state. The server consistently reads the Activity and selected `OCC#` row,
resolves the effective schedule, then condition-checks the versions/absence it read while
rewriting `ACT#/META` and every required `USER#/IDX#` row. A concurrent occurrence edit or
series edit fails the conversion rather than choosing a different survivor. The occurrence
row is not deleted; once recurrence is absent, agenda expansion simply cannot reach it.

An Activity-only target returns series state and can perform only series actions. It never
derives a nominal occurrence from today's date, the next cached agenda row, or the most recent
cached row. Any operation whose result depends on one occurrence requires the date in its
discriminated target.

> **Recorded by P2-52 from the founder's 2026-08-14 decisions.** The table above is the
> storage half of two accepted decisions and does not restate either: `decisions.md`
> **ADR-054** owns why the three operations are three, what the conversion survivor is, and
> which alternatives were rejected; **ADR-053** owns why scope travels as a discriminated
> `ActivityScope` rather than an optional `occurrenceDate`, and why the wire and the persisted
> offline mutation variables deliberately keep the old shape. The product-facing halves are
> [`../01-product/today-and-tasks.md#61-the-options-list`](../01-product/today-and-tasks.md#61-the-options-list)
> §6.1 and §6.3. A change to this table that is not also a change to ADR-054 is a defect in
> this table.

### 4.3 Reminder

```ts
interface Reminder {
  reminderId: string;
  activityId: string;
  userId: string;          // whose reminder this is — never inherited from the creator
  offsetMinutes: number;   // negative = before start. -0 == at start time
  channel: 'push';         // email/sms are out of scope for v1
}
```

`Activity` has **no** `reminders[]` field. Reminders are separate items (§3.1) because a
shared plan has one schedule and many reminder sets. Any code path that reads reminders
must filter by the caller's `userId`; any code path that *schedules* them reads all of them
and fans out per user.

A reminder requires `Activity.schedule.date`. Create and reminder-management writes reject
an undated reminder. A timed Activity accepts every integer offset in `[-10080, 0]`; a
date-only Activity additionally requires `offsetMinutes % 1440 === 0`. Both shared schema and
service enforce the schedule-aware rule. When an Activity keeps its date but loses its time,
sub-day offsets are retained and coerced to the nearest whole-day multiple; an exact half-day
tie chooses the earlier reminder (away from zero).

Unscheduling commits the cleared META/index state, idempotency receipt and a persisted
`CLEANUP#` reminder-delete work item in the same **main** transaction. Reminder rows are then
deleted in resumable bounded batches, not in that transaction. This is the notifications
§2/§3 rule, not a client convenience.

### 4.3a DateSuggestion

Lets a participant move an undated plan forward without being able to decide for everyone.
Without this, Needs a date is a holding area rather than a planning tool.

```ts
interface DateSuggestion {
  suggestionId: string;
  activityId: string;
  suggestedBy: string;              // userId
  date: string;                     // YYYY-MM-DD
  time?: string;                    // HH:mm
  note?: string;                    // "before the show"
  worksFor: string[];               // userIds who marked it as workable
  createdAt: string;
}
```

- Any participant may add a suggestion. Cap **5 per activity** — this is a nudge toward a
  date, not a scheduling poll.
- `worksFor` is an availability signal, not a vote and not a like. It is the only
  reaction-shaped thing in the product and it earns its place by being the actual
  coordination signal.
- **Only the owner can schedule.** `POST /v1/activities/:id/schedule` accepts
  `fromSuggestionId`, which copies the date and time and then runs the normal scheduling
  path, including the RSVP reset in §7.1.
- Guests on the public invite page cannot suggest dates. They read and RSVP.
- Suggestions are deleted when the activity is scheduled.

### 4.3b Durable cleanup work

```ts
interface CleanupWork {
  activityId: string;
  userId: string;                    // receipt owner; never client-selectable
  idempotencyKey: string;
  phases: Array<{
    kind: 'delete_reminders' | 'normalise_untimed_reminders' | 'reset_rsvp';
    cursor?: string;                 // opaque progress within the bounded phase
    complete?: boolean;
  }>;
}
```

The main mutation transaction creates this row together with its domain write and successful
idempotency receipt. The service then drains it inline. If that process dies, idempotent replay
drains the receipt-linked row before returning the stored response, and the next mutation of
the same Activity queries and drains any outstanding `CLEANUP#` rows before writing. Every
phase is idempotent; already-deleted or already-normalised rows are success. Delete the work
item only when every phase is complete. A cleanup row is post-success work, not an `in-flight`
idempotency reservation, and never changes the response status/body already stored.

### 4.3c Attachment and pending upload

```ts
interface PendingUpload {             // USER#<userId> / UPLOAD#<attachmentId>; internal
  attachmentId: string;
  userId: string;
  tmpKey: string;
  finalKey: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/heic' | 'image/webp';
  byteSize: number;
  state: 'awaiting_upload' | 'confirming';
  activityId?: string;                 // set when confirmation starts
  createdAt: string;
  cleanupAfter: string;                // one day; serviced before later upload/detail work
}

interface Attachment {               // ACT#<activityId> / ATT#<attachmentId>
  attachmentId: string;
  activityId: string;
  key: string;                        // permanent object key, never a URL
  contentType: PendingUpload['contentType'];
  byteSize: number;
  createdAt: string;
  schemaVersion: number;
}
```

The upload-url mutation writes `PendingUpload` before returning a presigned URL. Confirm
records the target Activity and marks it `confirming` before permanent copy, verifies the
copy, then transactionally writes `Attachment` and deletes the pending row. A retry resumes
that recorded state. Before issuing another upload URL, and when opening/confirming the
caller's attachments, the service performs one bounded `UPLOAD#` Query (maximum 20 unresolved
records): expired `awaiting_upload` rows delete their temporary object and row; a
`confirming` row completes its verified Activity link or, if that Activity no longer exists,
deletes both keys before its row. No DynamoDB Stream or scheduled worker is required in this
phase. A crash after copy is therefore durably tracked, while a crash after linking can leave
at most a temporary object for the S3 lifecycle rule.

### 4.4 Type-specific details

```ts
type ActivityDetails =
  | { kind: 'task'; }
  | { kind: 'meal';
      mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      ingredients?: { ingredientId: string; name: string; quantity?: string; addedToListId?: string }[];
      recipeUrl?: string; }
  | { kind: 'watch';
      mediaTitle: string;
      mediaKind?: 'movie' | 'show';
      season?: number;
      episode?: number;
      episodeTitle?: string;
      service?: string; }        // free text: "Netflix", "Apple TV+"
  | { kind: 'event';
      description?: string;
      priceCents?: number;
      currency?: string;
      ticketUrl?: string;
      organiser?: string;
      reservation?: { name?: string; time?: string; partySize?: number; reference?: string }; }
  | { kind: 'custom'; shortcutId?: string };
```

`details.kind` must always equal `activity.type`. Validate this at the schema boundary.

### 4.5 Occurrence

One row per *modified* occurrence of a recurring series. Unmodified occurrences have no
row — absence means "scheduled, not yet acted on".

```ts
interface Occurrence {
  activityId: string;
  date: string;                     // YYYY-MM-DD, the series' nominal date
  status: 'completed' | 'skipped' | 'snoozed' | 'rescheduled';
  snoozedUntil?: string;            // HH:mm same day, or ISO instant
  overrideTime?: string;            // HH:mm
  overrideDate?: string;            // YYYY-MM-DD — a this-occurrence-only reschedule to
                                    // another date. Expansion emits the occurrence on this
                                    // date instead of `date`, rendered with a
                                    // "moved from <date>" affix. The series is untouched.
  completedAt?: string;
}

interface OccurrenceMoveMarker {
  activityId: string;
  destinationDate: string;          // YYYY-MM-DD in the series timezone
  movedFrom: string[];              // sorted, unique nominal dates targeting this date
}
```

A cross-day occurrence move writes the nominal `OCC#<date>` override and updates the
destination's `MOVE#<destinationDate>` marker in one transaction. `MOVE#` is a separate key
namespace so a moved-in occurrence cannot overwrite the real occurrence or override already
due on the destination date; the sorted `movedFrom` list permits more than one nominal
occurrence to target that date. Removing or undoing a move removes only its nominal date from
the marker and deletes the marker row when the list becomes empty. Replacing one destination
with another removes the old marker reference in the same transaction as the source and new
marker writes.

An occurrence-targeted detail read is an authoritative projection, not a lookup in the
client's agenda window. It returns the nominal date plus the effective date, time, end time
and status after applying the active recurrence segment and any `OCC#<date>` override. A moved
or snoozed occurrence therefore has the same detail values whether the agenda cache is warm,
cold or outside the requested day. Activity-targeted detail returns the Activity and series
state without manufacturing an occurrence projection.

`overrideDate` and a cross-day `snoozedUntil` are accepted only when the absolute calendar-day
distance from the nominal `date` is at most **60 days**. The API returns
`400 validation_failed` beyond that bound. An `HH:mm` snooze remains on the nominal day; an
ISO-instant snooze is converted in the Activity's timezone before applying the bound and
choosing the destination marker.

> **Occurrences carry no participant identity, and that is deliberate: completion is global
> and action policy is object-scoped.** An `Occurrence` says *the thing happened*, not *I
> attended*. On a shared plan only the owner may complete, skip or snooze. A prep task follows
> ADR-051: its owner, the parent Plan owner or a parent participant may act. In every case the
> result is one global occurrence with no actor identity, visible to everyone.
>
> This resolves a genuine ambiguity rather than papering over it. Per-participant completion
> would need `OCC#<date>#<userId>`, and then the agenda expansion has to answer "whose
> occurrence am I looking at?" for every row. That is a real feature with a real cost and it
> is deferred, not forgotten — see `../00-open-decisions.md`. A participant who did not go
> sets their RSVP to declined; a participant who wants the plan off their day leaves it.

> Snoozing or completing an occurrence must never mutate the parent `Recurrence`. This is
> an explicit product requirement (concept §6) and a required test case.

### 4.6 List and ListItem

Lists are **independent collections**. A list that never produces an activity is a
complete, finished thing — "Favourite restaurants" is not an unfinished "Restaurants to
try". The connection to Activities is optional in both directions. Do not model lists as a
staging area.

#### Behaviour versus template

Two separate concepts, and conflating them is the most likely modelling error here.

| | What it is | How many | Who decides |
| --- | --- | --- | --- |
| **Behaviour** | What the *application* does differently: how items render, what typed fields they carry, what cross-entity flows exist | **Exactly three.** Adding a fourth requires a product decision and new UI code | engineering |
| **Template** | A declarative chooser label and summary plus an editable default title, icon, behaviour, capability defaults, slot, and empty-state copy | Unbounded. Adding one is a config entry, never a code branch | product |

```ts
type ListBehaviour = 'collection' | 'watch' | 'meals';
```

| Behaviour | Why it exists |
| --- | --- |
| `collection` | An ordered list of items. Capabilities are configuration, not code. Covers groceries, shopping, packing, places, restaurants, reference lists, anything. |
| `watch` | Items **group under status headings** (`Watching` / `Want to watch` / `Watched`) and carry season and episode. The only behaviour whose item list is grouped rather than flat. |
| `meals` | Items carry structured `ingredients` that feed the ingredients-to-list flow. Justified because `Activity.details` for `type: 'meal'` already types `ingredients`; a generic Collection field meaningful for exactly one scheduling target would be worse. |

> The test for whether something is a behaviour: **does the application actually behave
> differently, or does only the label differ?** `Simple` and `Checklist` fail this test —
> they are `collection` with `checkable` false and true. So do `groceries`, `packing`,
> `shopping`, `restaurants` and `places`. Do not reintroduce them as behaviours.

#### Templates

Templates live in `packages/shared/src/lists/templates.ts` as a plain data array. They are
**seeds, not live references.** Structural and presentation fields are resolved from the
template at creation and copied onto the `List`. Changing or removing a template later must
never retroactively alter an existing list — the same freezing principle as `sourceLabel`.
The exact seventeen v1 records and every visible string are canonical in
[`../01-product/plans-and-lists.md#53-the-template-catalogue`](../01-product/plans-and-lists.md#53-the-template-catalogue);
clients and services consume that shared array rather than recreate labels or defaults.

Creation is selection-first: the client presents the catalogue, the user chooses a
`templateKey`, then confirms an editable `defaultTitle`. `POST /v1/lists` requires both the
visible title and that key. The server resolves
only the selected entry; it never ranks templates from the title, and there is no implicit
`simple-list` fallback.

If creation carries an explicit `sourceActivityId`, it must name an owned Plan and the new
list stores `slot: null` even when the selected template normally seeds a standing slot. The
relationship is per-occasion; promoting that list to a standing destination is a later,
explicit settings change.

That creation transaction also writes `ACT#<sourceActivityId>` /
`SOURCE_LIST#<listId>`. This row contains ids only: it is a reverse access projection for Plan
detail and Plan deletion, while `List.sourceActivityId` remains the only domain link. Keeping
title and counts off the projection preserves one-write List renames and item mutations. Plan
detail obtains the current List rows with one bounded `BatchGetItem`. Detaching or deleting a
List removes the projection in the same transaction; deleting a Plan queries the projection
ids, clears matching List back-links in bounded idempotent chunks, and never deletes a List.

```ts
interface ListTemplate {
  templateKey: string;             // 'groceries', 'restaurants-to-try', 'bars-to-try', …
  chooserLabel: string;            // visible style name; simple-list uses 'Blank'
  summary: string;                 // one-line capability description in the chooser
  defaultTitle: string;            // editable prefill after explicit template selection
  icon: string;
  behaviour: ListBehaviour;
  capabilities: ListCapabilities;  // copied onto the List at creation
  slot: DefaultSlot | null;        // seeds List.slot
  emptyStateCopy: string;
}
```

Adding "Bars to try" is one entry in that array: `behaviour: 'collection'`,
`capabilities: { checkable: true, supportsLocation: true }`, `slot: null`. No schema
change, no branch, no migration. A later scheduling action supplies its Activity type
explicitly; the template does not decide it.

#### The entities

```ts
type DefaultSlot = 'groceries' | 'watch' | 'meals';

interface ListCapabilities {
  checkable: boolean;              // collection only; watch uses watchStatus instead
  supportsLocation: boolean;       // collection only
}

interface List {
  listId: string;
  ownerId: string;
  behaviour: ListBehaviour;
  templateKey: string;             // immutable provenance + analytics only; never read to render
  title: string;
  icon: string;                    // frozen presentation copy from the selected template
  emptyStateCopy: string;          // frozen presentation copy from the selected template
  capabilities: ListCapabilities;  // frozen copy from the template, user-editable
  slot: DefaultSlot | null;        // eligibility for a default destination
  sourceActivityId?: string;       // "this Packing list came from the New York Trip plan"
  itemCount: number;
  uncheckedCount: number;
  memberCount: number;             // owner + non-owner MEMBER# rows; 1 when private
  rankVersion: number;             // serialises server rank allocation; never client-authored
  itemVersion?: number;            // complete-item-set generation; absent means legacy zero; never serialised
  rankRepairId?: string;           // blocks rank mutations and item-page reads until repair completes; never serialised
  behaviourMigrationId?: string;   // blocks item reads/mutations until behaviour migration commits; never serialised
  archived: boolean;
  updatedAt: string;               // backs If-Match on list-level edits
  lastItemActivityAt: string;      // last write to any item in this list; never backs If-Match
}

interface ListIndex {              // USER#<u> / LIST#<l> — owner + each active non-owner
  listId: string;
  userId: string;
  role: 'owner' | 'member';
  addedAt: string;
}

interface ListMember {
  listId: string;
  personId: string;
  userId?: string;                 // absent while status is 'invited'
  reciprocalPersonId?: string;     // member's Person for the owner; required for active non-owner members
  displayName: string;
  email?: string;
  role: 'member';                  // the owner has no MEMBER# row
  status: 'invited' | 'active';
  invitedBy: string;
  addedAt: string;                   // immutable; copied into ListIndex and both LLINK keys
  joinedAt?: string;
}

interface ListItem {
  itemId: string;
  listId: string;
  rank: string;                    // lexo rank
  itemRevision: number;            // storage-only mutation fence mirrored by ITEMID; never client-authored
  title: string;
  note?: string;
  checked: boolean;                // meaningful only for collection + capabilities.checkable
  location?: { label: string; address?: string; lat?: number; lng?: number };
  sourceActivityId?: string;       // "Chicken — Sunday dinner"
  sourceLabel?: string;            // joined display, max 4,000; segments never recomputed/truncated
  sourceProvenance?: {             // storage-only ordered ownership; never serialised
    activityId: string;
    label: string;
  }[];
  details?: ListItemDetails;       // present only for watch and meals behaviours
}

type ListItemDetails =
  | { behaviour: 'watch';
      mediaKind?: 'movie' | 'show';
      watchStatus: 'want' | 'watching' | 'watched';
      season?: number;
      episode?: number; }
  | { behaviour: 'meals';
      ingredients?: { ingredientId: string; name: string; quantity?: string; addedToListId?: string }[]; };

interface ListItemActivityLink {   // LIST#<listId> / LNK#<viewerUserId>#<itemId>
  listId: string;
  itemId: string;
  viewerUserId: string;
  activityId: string;
  linkedAt: string;
}
```

**Two timestamps on a List, two jobs.** `updatedAt` backs `If-Match` on list-level edits and
moves only when the List row itself changes — a rename, a capability toggle, a slot change.
`lastItemActivityAt` moves when any **item** is created, edited, checked, deleted, reordered
or touched by a bulk operation, and backs nothing. The Lists index renders the second
(`design-system.md` §7.2): a card that still said `Updated 3 days ago` immediately after the
user checked three things off, while moving the moment they renamed the list, would be
backwards from what the line means to a reader. One field for both would also make an
ordinary item write bump the concurrency token every open list-settings sheet is holding.

This is the same split ADR-039 already made between `lastActivityAt` and `updatedAt` on an
Activity, for the same reason and with the same rule: **the display timestamp never backs a
precondition, and the precondition timestamp is never displayed.** It is stored on the `META`
row the Lists index already batch-reads, so it costs no extra read, no index and no query.

#### Default slots

A slot is a **semantic destination**, not a behaviour. Once `groceries` and `packing` are
both `collection`, behaviour alone cannot say which one "add these ingredients" should
target.

```ts
// on User — declared with the rest of the profile in §4.0
defaultLists?: Partial<Record<DefaultSlot, string>>;  // slot → listId
```

The stored map contains only resolved ids. `PATCH /v1/me` accepts
`defaultLists?: Partial<Record<DefaultSlot, string | null>>` as a nested patch: omitted slots
survive, a string replaces one slot, and `null` removes one slot rather than replacing the
whole map. Both maps assert a `lst_` ULID (P3-12); a destination nothing can resolve is not a
value worth storing.

**Mechanically, that is document paths, not an assignment.** The repository applies each
supplied slot as `SET defaultLists.<slot>` or `REMOVE defaultLists.<slot>` and never emits
`SET defaultLists = :map`, which would carry whatever the caller read moments earlier and
silently undo a sibling slot chosen on another device in between. A profile predating the map
has none to write a path into, so one is created holding just the supplied slots under
`attribute_not_exists(defaultLists)` — the single case where assigning the whole map is
correct, because there are no siblings to lose — and a writer that loses that race retries the
nested operation. Removing the last key leaves an empty map rather than deleting the
attribute; empty and absent are the same state to every reader.

**Resolution reads both sides strongly.** The profile `GetItem` and every page of the list
index — its pointer `Query` and its `META`/tombstone `BatchGetItem` alike — are issued with
`ConsistentRead` when a slot is being resolved, and only then. The four-step rule turns on
current state the user may have changed a moment ago: the default they have just chosen, a
list they have just archived, a membership just revoked, and the pointer count that separates
"exactly one" from "several". Serving those from a stale replica manufactures the dead end the
read-side guard exists to prevent. Ordinary list browsing keeps the cheaper eventually
consistent read.

Resolution rule for any "add to X" flow:

1. Exactly one list with `slot === 'groceries'` → use it, do not ask.
2. Several, and `user.defaultLists.groceries` is set → use it, show it in the sheet,
   let the user change it **for this operation only**.
3. Several, and no default set → ask once, remember the answer.
4. None → return `none`; the client may offer `New list`. General and ingredient flows open
   the ordinary full catalogue with no template selected. A Watch destination, already
   chosen explicitly by the user, opens exactly the three `watch` templates in canonical
   relative order, also unselected. Creating the List and adding the items are separate
   named confirmations. Slot resolution never returns a `templateKey`.

Opening a list must never change where future items go. Most-recently-used is explicitly
rejected.

`slot` lives on the `List`, seeded from the template and changeable in settings — so a user
who built a plain collection for their shopping can promote it. Templates whose lists are
per-occasion (packing) seed `null`.

#### Linking

**The no-extra-item rule (concept §10):** scheduling a ListItem creates an Activity but does
not create, replace, check, or hide a second ListItem. The Activity carries `listId` and
`listItemId`; the list partition carries one `ListItemActivityLink` per viewer who is allowed
to see the current link. The ListItem itself carries no Activity id.

The pointer is **singular per `(viewerUserId, itemId)` in v1**. A private Plan writes only the
caller's pointer. A shared Plan writes the caller's pointer plus one for every selected
registered participant who is also an active member of that list. A nonparticipant member
sees no state line and receives no Activity id. Different members may therefore schedule the
same shared item independently without racing on a global field.

A new scheduling action overwrites only the pointers of its viewers. Full link history is
not queryable in v1; each Activity's `listId` and `listItemId` preserve provenance. Deleting
an Activity deletes only `LNK#` rows that still point to it. Deleting the ListItem clears its
current `LNK#` rows and the back-pointers of those Activities, but never deletes an Activity.

Completion, uncompletion and rescheduling retain the pointer and derive its state line from
the Activity. Unscheduling also retains the pointer but renders no state line until a schedule
returns. Skipping / `didnt_happen` on a non-occurrence removes the state line and clears
matching viewer pointers even though the Plan survives. An occurrence-only completion or skip
writes only its `OCC#` row and never mutates the series pointer. None of these lifecycle
transitions mutates the ListItem.

The Activity title is initialised from `ListItem.title` when the request omits `title`, then
the two titles are independent. Mirroring would let a list member rename another member's
private Plan and is therefore forbidden.

> **Completing an activity never checks its source list item.** The list owns its state;
> the activity owns its state. Any cross-object change is an explicit suggestion the user
> confirms. See `../01-product/interaction-contract.md`.

#### Shared lists

Lists are shareable, using the same People layer as Plans. One sharing system, two
shareable objects.

| Role | Can |
| --- | --- |
| `owner` | Everything: delete the list, add and remove members, change `behaviour`, `capabilities` and `slot` |
| `member` | Add, edit, check, reorder and delete **items**; rename the list; leave it. Cannot change behaviour or capabilities — those are destructive under the interaction contract — and cannot delete the list or remove anyone. |

Constraints:

- **The owner is not a `ListMember` row.** Ownership comes from `List.ownerId` and the
  owner's `ListIndex` pointer with `role: 'owner'`. The members response synthesises the
  owner's first roster row from those records and the owner's profile. Every physical
  `MEMBER#` row is therefore a non-owner with `role: 'member'`; a private list has zero such
  rows, and `memberCount` is `1 + count(MEMBER# rows)`. This avoids inventing a self-`Person`
  solely to key an owner membership and prevents counting the owner twice.
- **App users only.** There is no guest list editing, because every item mutation needs an
  identity to attribute it to. An invitee who has no account gets an email, installs, signs
  up, and the list appears — reusing the `GUESTEMAIL#` linking machinery. Until then their
  `ListMember` row has `status: 'invited'`, no `userId`, no `reciprocalPersonId`, and **no
  recipient index entry**, because there is no partition to write it into. The owner's
  invited `LLINK#` remains a lifecycle projection, not access or an active People count.
- **20 people total per list, including the owner and pending invitations**, lower than the
  50 for a plan. This is a household feature, not a broadcast one. `memberCount` is the owner
  plus every physical non-owner member row, including invited rows.
- A registered add creates or reuses two owner-scoped `Person` records: the member in the
  list owner's partition and the owner in the member's partition. It then writes active
  `LLINK#` rows on both sides. These are local contacts, not a global relationship graph.
- Removing or leaving deletes the owner and member `LLINK#` rows; deleting a list deletes
  every link for that list. Neither operation deletes a `Person`. Renaming remains one write
  because links contain ids and `addedAt`, not list titles.
- A shared plan **suggests** sharing its generated lists with the same people. It never
  does so automatically. For packing in particular, auto-sharing would be actively wrong —
  each person packs their own bag.
- Scheduling an item never inherits list membership. The caller submits an explicit Plan
  target and either `just_me` or `selected_people`. Only the caller and selected Plan
  participants receive Activity access; only those who are also active list members receive
  `LNK#` pointers. List membership alone reveals no Plan id or schedule.

**Concurrency.** Shared lists have a problem shared plans do not: two members editing items
at the same time, often offline, often in different shops. Three rules, all required:

| Situation | Rule |
| --- | --- |
| Two members check the same item | Not a conflict. `checked` is set, not toggled, so the operation is idempotent and commutative and survives the offline queue without merge logic. Never write `SET checked = NOT checked`. |
| Two members insert at the same position | Rank allocation is serialised by conditional `List.rankVersion`; one caller retries with fresh neighbours and receives a distinct rank. Sort by `(rank, itemId)` defensively so Undo-restored, legacy or seeded duplicates within one committed generation still render identically. Strong pre/post META fences and a repair marker gate item reads, so mixed generations never render. |
| One member reorders while another edits a field | The ranked row and locator share `itemRevision`. Reorder conditionally moves the freshly read revision; a field PATCH conditionally advances the same revision while updating only supplied fields. The loser re-resolves and reapplies its operation, so rank movement cannot overwrite a concurrent title, note, check or typed-detail edit. |
| Two members add the same title | Two rows. **Never auto-merge.** Silently swallowing someone's entry is worse than a visible duplicate they can delete. |

Item writes carry **no `If-Match`**. Optimistic concurrency on every checkbox in a grocery
list would produce constant spurious `409`s for no benefit; last write wins on a field is
the correct behaviour here. The internal `itemRevision` is a retry fence, not a client-visible
conflict: the service retries the supplied field assignment against the current row. List-*level* edits — title, capabilities, behaviour — do use
`If-Match`, because those are the changes worth protecting.

### 4.7 Person and Participant

```ts
interface Person {              // a contact in the owner's address book
  personId: string;
  ownerId: string;              // whose contact list this is
  displayName: string;
  email?: string;
  phone?: string;
  linkedUserId?: string;        // set when this person is a registered app user
  avatarUrl?: string;
  upcomingCount: number;        // denormalised, refreshed on write
  lastActivityAt?: string;
}

interface PersonListLink {      // USER#<u> / LLINK#<personId>#<addedAt>#<listId>
  personId: string;
  listId: string;
  addedAt: string;
  status: 'invited' | 'active';
}

interface Participant {
  activityId: string;
  personId: string;
  ownerScopedPersonRef: string; // "<ownerId>:<personId>", so the PART row is unambiguous
  userId?: string;              // if a registered user
  displayName: string;
  email?: string;
  rsvp: 'pending' | 'going' | 'maybe' | 'declined';
  rsvpForDate?: string;         // the schedule.date the response was given against
  role: 'owner' | 'participant';
  invitedAt: string;
  respondedAt?: string;
  isGuest: boolean;
}
```

`rsvpForDate` is stamped by the server from the plan's `schedule.date` **read in the same
transaction** as the RSVP write — never from a client-supplied value or an earlier read —
so a response racing a date change cannot record consent to a date the responder never saw
(§7.1, [`api-contract.md`](api-contract.md#24-participants-and-rsvp) §2.4).

### 4.8 Expense, Balance, Settlement

```ts
interface Expense {
  expenseId: string;
  activityId: string;
  activityTitle: string;        // plan-title snapshot: copied at write time, rewritten by
                                // the plan-rename write path (a write that by definition
                                // comes from someone who still has access). Drill-downs —
                                // finance_only ones especially — render this snapshot and
                                // never read the live Activity; a stale title after access
                                // is lost is deliberate (expenses.md §5.3, 2026-08-07)
  description: string;
  amountCents: number;          // integers only. Never floats for money.
  currency: string;             // ISO 4217, default from user profile
  paidByPersonId: string;
  splitMode: 'equal' | 'exact' | 'shares';
  splits: { personId: string; amountCents: number; shares?: number }[];
  note?: string;
  createdBy: string;
  settledPersonIds: string[];  // sorted API view of a DynamoDB String Set of owner-scoped debtor ids
  settlementIdByPersonId: Record<string, string>; // same keys; active audit row for exact guard/undo
  settled: boolean;            // derived: every non-payer debtor is in settledPersonIds
}

interface Balance {            // USER#<a> / BAL#<personId b>#<currency>
  ownerId: string;
  personId: string;
  netCents: number;            // > 0 => they owe the owner. < 0 => owner owes them.
  currency: string;
  unsettledExpenseCount: number;
  lastRecalculatedAt: string;
}

interface Settlement {
  settlementId: string;
  ownerId: string;
  personId: string;
  amountCents: number;         // server-computed display total; never a balance delta
  currency: string;            // server-derived from covered obligations
  direction: 'they_owed_user' | 'user_owed_them'; // server-derived audit context
  settledAt: string;
  coversExpenseIds: string[];  // 1–25 distinct ids; canonicalised from the strict request
  coverage: {                  // server-derived exact provenance; never accepted from a client
    activityId: string;
    expenseId: string;
    debtorPersonId: string;    // id in that source Activity owner's Person namespace
  }[];
}
```

`Balance` is a **cache**. `GET /v1/people/:id/balance` must be able to recompute from the
underlying expenses and must always be able to list them. No unexplained number.

Settlement changes **Expense state**, not balance arithmetic. In storage,
`settledPersonIds` is a DynamoDB String Set so conditional `ADD` / `DELETE` operations are
atomic; the API serialises it as a stable sorted array. Its members must exactly equal the
keys of `settlementIdByPersonId`. The map makes `409 settlement_conflict` and exact undo
addressable without scanning Settlement history. For a pairwise contribution, identify the
debtor from `paidByPersonId` and `splits`; if that debtor is in `settledPersonIds`, the
contribution is zero, otherwise it contributes normally. A
`Settlement` row is immutable audit history describing which status changes were made and
the server-computed total at that moment. It is never subtracted from a Balance. Therefore a
full rebuild needs Expense rows only and cannot double-count a settlement.

An Expense with a non-empty `settledPersonIds` is not editable or deletable. The API returns
`409 settlement_conflict` with the distinct values from `settlementIdByPersonId`; only the
explicit Undo settlement action may delete those audit rows and reopen the covered
obligations. Expense mutation never rewrites `coversExpenseIds` or clears settlement state
behind the user's back.

`POST /v1/settlements` accepts only `personId` and **1–25 distinct**
`coversExpenseIds`. Each globally unique id resolves through `EXPENSE#<expenseId>`; after
Activity authorisation, the server derives `amountCents`, `currency`, `direction`, and the
exact owner-scoped debtor id for every source Expense. The caller's `personId` names their
relationship view; it is never copied blindly into an Expense owned by somebody else. The
server stores those exact triples in `coverage`. There is no note, method, reference, or
remainder field: the app records closed obligations, not details of what happened outside
it. It rejects duplicate ids, mixed currencies, mixed directions, unrelated expenses, and
any obligation already settled.

Undo first resolves `SETTLEMENT#<settlementId>`, verifies its `ownerId`, and loads the exact
history row. For every `coverage` entry it removes only that entry's `debtorPersonId`, and
only when `settlementIdByPersonId[debtorPersonId]` still equals this Settlement. It then
recomputes the Expense's all-debtors `settled` roll-up and deletes both history and locator
rows. Other debtors on the same Expense are untouched. Overlapping active Settlements for
one pairwise obligation are forbidden, so undo is unambiguous.

### 4.9 Invite

```ts
interface Invite {
  token: string;               // 22-char base62 from crypto.randomBytes — not a ULID
  activityId: string;
  personId?: string;           // personalised invite; absent => shareable link
  createdBy: string;
  expiresAt: string;
  revoked: boolean;
  ttl: number;                 // epoch seconds, = expiresAt + 30 days
}
```

---

## 5. Access patterns

Every query the app performs. If your feature needs something not listed, add a row here
before writing the code.

| # | Pattern | Operation |
| --- | --- | --- |
| 1 | Today / date range for a user | `Query GSI1` `gsi1pk = U#<u>#S` and `gsi1sk BETWEEN <from − 2 days>T00:00 AND <to + 2 days>T23:59`; hydrate the widened candidate set, apply one-off/occurrence overrides before conversion, convert effective timed rows from projected stored `timezone` or the mixed-generation META fallback into request `tz`, then filter to exact `[from, to]` viewer-local dates |
| 1a | Caller reminders for an agenda window (`include=reminders`) | After pattern 1/3 establishes the bounded distinct Activity ids emitted in the exact window, query each `ACT#<a>` with `sk begins_with REM#<callerUserId>#` and attach those rows to its AgendaItems. This is bounded repository fan-out behind the one agenda HTTP request and can never read another user's prefix |
| 2 | Anytime items (undated solo tasks) | `Query GSI1` `gsi1pk = U#<u>#N` |
| 2b | Needs a date — Plans, most recently discussed first | `Query GSI1` `gsi1pk = U#<u>#P`, `ScanIndexForward=false` |
| 3 | Active recurring series for a user | `Query GSI1` `gsi1pk = U#<u>#R` |
| 4 | Full plan detail (activity + first page of each section) | Strongly consistent `GetItem ACT#<a>/META` first, so `404` and owner authority are canonical; a non-owner also requires the exact strongly consistent `USER#<caller>/IDX#<a>` access grant (or documented parent grant). Drain pattern 6b before projecting attachments. Then bounded strongly consistent prefix Queries assemble the one HTTP response: newest-first `UPD#` with `Limit: 50` and cursor; caller-only `REM#`; and `PART#`, `ATT#`, `SUGG#`, `SUB#`, expenses and `SOURCE_LIST#` under their documented caps/page limits. Hydrate the bounded source-list ids with one `BatchGetItem`, never one read per List. Never `queryAll` the user-growing Activity partition. Parent-inherited access may strongly read the parent META and caller grant separately. |
| 4b | Every reminder on an activity, for scheduling | Strongly consistent `Query pk = ACT#<a>`, `sk begins_with REM#`; bounded by the reminder cap, retaining every user's rows for fan-out |
| 4c | Outstanding durable cleanup for an Activity | `Query` `pk = ACT#<a>`, `sk begins_with CLEANUP#` before a new mutation; idempotent replay instead follows the receipt's exact cleanup reference. Internal only, never serialised. |
| 4d | Canonical agenda projection for one Activity after a recurrence PATCH | Strongly consistent base-table `Query pk = ACT#<a>` to read `META`, `OCC#`, `MOVE#`, caller reminders and participant proof without GSI discovery; expand server-side for the requested cached window and return both the canonical rows (including an authoritative empty array) and the META `updatedAt` used. Parent-inherited authorisation may read the parent separately, but target projection never comes from a GSI. |
| 5 | Occurrence overrides and moved-in markers for a series window | Exact-key `BatchGetItem`: `OCC#<nominalDate>` for emitted nominal dates and `MOVE#<destinationDate>` for every calendar date in the timezone-widened request window. A bounded second `BatchGetItem` hydrates the source `OCC#<movedFrom>` rows named by returned markers. Never use one Query per series. |
| 5a | Completed occurrence count for whole-series delete confirmation | `Query pk = ACT#<a>`, `sk begins_with OCC#`, repository-owned `status = completed` filter, `Select: COUNT`, paged to exhaustion. The consumer is the `Delete whole series` confirmation copy; no denormalised counter is stored. |
| 6 | User profile | `GetItem` `USER#<u>` / `PROFILE` |
| 6b | Unresolved attachment confirmations for a user | Bounded `Query pk = USER#<u>`, `sk begins_with UPLOAD#`, maximum 20. Drain expired/resumable rows before issuing another upload URL and on attachment/detail access. Internal only. |
| 7 | Lists for a user | Paged `Query` `pk = USER#<u>`, `sk begins_with LIST#` (50 pointers per API page), then one `BatchGetItem` for that page's `LIST#<l>` / `META` rows. The 100 cap is on owned-list creation, not incoming memberships. |
| 7b | Members of a list | `GetItem` `LIST#<l>` / `META`, get the owner's `USER#<ownerId>` / `LIST#<l>` pointer and profile, then `Query` `pk = LIST#<l>`, `sk begins_with MEMBER#`. Prepend the synthesised owner DTO; the query itself returns non-owners only. |
| 8 | Items in a list | Strongly read exact META first, reject either repair/migration marker and validate the cursor version; then page `Query pk = LIST#<l>, sk begins_with ITEM#`, `Limit: 50`, `ConsistentRead: true`, sorted by `(rank, itemId)`. Strongly reread META before serialisation and require the same `rankVersion` with no marker. A failed pre/post fence drains bounded work when applicable, then returns `503 internal` with `Retry-After: 1` and no item rows; the client restarts at page one. The opaque cursor binds the fenced version. |
| 8b | List detail (META + first item page + caller-visible Activity state) | Pattern 8's fenced first page plus META. For only those item ids, one bounded `BatchGetItem` reads `LNK#<callerUserId>#<itemId>` keys, followed by one bounded Activity hydration and ordinary Activity authorisation. A surviving row projects the caller's `viewerLink` and trimmed `viewerPlan` together; a missing or unreadable link projects neither. Members use 7b and later items use 8. Never query the whole List partition, expose a mixed rank/behaviour generation, load or serialise another viewer's Activity, or read one Activity per link. An unscheduled Activity may remain linked but is not state-line eligible. |
| 8c | Remove every Activity pointer for one list member | `Query` `pk = LIST#<l>`, `sk begins_with LNK#<viewerUserId>#`, then batch delete. Used on leave/removal. |
| 8d | Exact ListItem by stable id | After the exact `USER#<u>` / `LIST#<l>` access check, use pattern 8's strong META pre/post fence around strongly consistent reads of `ITEMID#<itemId>` and its current `ITEM#<rank>#<itemId>` key; require matching locator/item revisions. A changed version, marker or revision mismatch returns `503 internal` with `Retry-After: 1`; missing locator/item or a tombstoned list is `404`. |
| 8e | Every item on one list, for a bounded worker or a destructive-change preview | After the exact `USER#<u>` / `LIST#<l>` access check, `Query pk = LIST#<l>`, `sk begins_with ITEM#`, `ConsistentRead: true`, unpaged and bounded by the 500-item cap. Internal to rank repair, behaviour migration and the `409` data-loss count; never a response projection. A caller that **decides a write** from these rows rather than merely reporting them takes the stricter form instead: strong META pre/post fence around the query, returning both `rankVersion` and storage-only `itemVersion`, which its transaction must then commit under. P3-17 also strongly BatchGets the at-most-30 requested `ITEMID#` identity records inside that same fence and recognizes replay only when the stored Activity and ingredient both match. The first generation catches structural creates/reorders, while the second catches field patches, checks, deletes, restores and identity writes without invalidating ordinary page cursors on every checkbox tap. A worker reads it **under its own marker**, where the rows may be a mix of source- and target-shaped; the preview form requires both fences absent, because a count taken across a running migration would describe a list in two shapes at once. |
| 8f | One completed watch session's follow-up source (P3-16) | After the exact `USER#<u>` / `LIST#<l>` access check, one strong META pre/post fence around three keyed strongly consistent reads issued together: `LNK#<callerUserId>#<itemId>`, and pattern 8d's `ITEMID#<itemId>` locator plus its current `ITEM#<rank>#<itemId>` row. META that is not `behaviour: 'watch'` answers before either the pointer or the item is read. **One fence, not three**: composing patterns 7, 8b and 8d would read the pointer under one `rankVersion` and the item under the next, which is the mixed generation the fence exists to refuse, and would cost roughly thirteen round trips on a completion that is already several reads deep. A missing list, a non-`watch` one, a missing pointer and a missing item are all the same empty answer; a fence failure raises as it does everywhere else and the caller turns it into no follow-up. Read-only, and never on the write path. |
| 9 | All people for a user | `Query` `pk = USER#<u>`, `sk begins_with PERSON#`, plus a paged `LLINK#` Query grouped by Person to compute active `sharedListCount`; do not assume the owned-list creation cap bounds memberships from other owners. The four-key People sort still ignores list membership. |
| 9a | Lists shared or pending with one Person | `Query` `pk = USER#<u>`, `sk begins_with LLINK#<personId>#`; retain only `status = 'active'` and re-check exact `USER#/LIST#` access for the Person view, but retain both statuses for signup, delete guards and lifecycle work |
| 10 | Activities shared with one person, newest first | `Query` `pk = USER#<u>`, `sk begins_with PLINK#<p>#`, `ScanIndexForward=false`, retaining only `scope = 'shared_activity'` for the product history |
| 10a | Expense source Activities for one relationship | The same bounded `PLINK#<p>#` Query, accepting both `shared_activity` and `finance_only`; only balance/expense/settlement services may use this projection |
| 11 | All balances for a user | `Query` `pk = USER#<u>`, `sk begins_with BAL#` (one row per person × currency) |
| 12 | Settlement history with a person | `Query` `pk = USER#<u>`, `sk begins_with SETTLE#<p>#` |
| 12a | Resolve a selected Expense id or an Undo-settlement id | `GetItem` `EXPENSE#<expenseId>` / `META` or `SETTLEMENT#<settlementId>` / `META`, followed by authorisation against the resolved Activity or owner; never a `Scan` |
| 12b | Settlement history where the viewer is the **counterparty** (decision 2026-08-07) | Derived read, no new write path: the bounded pattern-10a `PLINK#<p>#` projection loads the relationship's Expense rows, and each `settlementIdByPersonId` value resolves through its `SETTLEMENT#<settlementId>` locator (pattern 12a) to the creator's audit row. No counterparty `SETTLE#` row exists or is ever written; undo stays creator-only |
| 13 | Resolve an invite token (public, unauthenticated) | `GetItem` `INVITE#<t>` / `META` |
| 14 | Find user by email | `GetItem` `EMAIL#<e>` / `USER` |
| 14b | Find every guest record for a verified email (account linking) | `Query` `pk = GUESTEMAIL#<e>` |
| 15 | Push devices for a user | `Query` `pk = USER#<u>`, `sk begins_with DEVICE#` |
| 16 | Child / prep tasks of a plan | `Query pk = ACT#<parent>, sk begins_with SUB#`, `Limit: MAX_PREP_TASKS_PER_PLAN` (50), **strongly consistent** — both consumers act on what they read, since plan detail composes `3 of 5 done` inside pattern 4's authoritative read and the completion follow-up counts children straight after a write that may have changed one of these pointers. Creation rejects a 51st child, so this bounded page is the complete collection and may compute exact done/open counts. Never use the GSI alternative or `queryAll`. |
| 16a | Resolve one prep task while its parent is being deleted (P3-18) | `GetItem ACT#<child>/META`, **strongly consistent**. The pointer and the child commit in one transaction, so a strong `SUB#` page that sees the pointer proves the child exists; a default-consistency miss here would be read as "already gone" by the orphaning pass, which then deletes the only row that could repair it. The child is released only when its `parentActivityId` still names the activity being deleted — one moved to another plan is left alone, pointer and counter intact. |

No `Scan` anywhere in application code. A `Scan` in a PR is an automatic rejection outside
of one-off migration scripts under `infra/scripts/`.

---

## 6. Recurrence expansion algorithm

This is the trickiest piece of logic in the product. It lives in exactly one place:
`packages/shared/src/recurrence/expand.ts`, is pure, and is unit-tested hard.

> **P2-01 correction — 2026-08-10.** An amendment-era version of the pseudocode below
> called `expandRecurrence` once per segment and left series termination outside the engine.
> That drifted from the canonical P2-01/P2-08 signature and cannot enforce a cross-segment
> `count` without duplicating termination logic in the agenda service. The agenda now calls
> `expandRecurrence` **once per hydrated series** with the complete `Recurrence`; the function
> walks the ordered segments internally and applies series-level `endDate` and `count` across
> their combined occurrence stream. Each segment still self-anchors on `effectiveFrom` and is
> expanded only inside its own in-force window.

```
expandAgenda(userId, fromDate, toDate, tz):
  1. candidates = Query GSI1 U#<u>#S BETWEEN (from-2d)..(to+2d)
  2. scheduled  = BatchGetItem ACT#<id>/META for every candidate
       // canonical one-off snoozedUntil lives on META, not the index projection
       // Phase 1 index rows may lack timezone; META.schedule.timezone is the fallback
       // retain the complete widened set; do not exact-window filter nominal/base times
  3. seriesIdx  = Query GSI1 U#<u>#R, capped at 200           // thin index rows only
  4. series     = BatchGetItem ACT#<id>/META for every seriesIdx row
       // hydrate every selected #R row before expansion; chunk at 100, retry
       // UnprocessedKeys, and never treat an ActivityIndex projection as Recurrence
  5. for each s in series:
       dates = expandRecurrence(
         s.recurrence,
         from-2d,
         to+2d,
         s.schedule.timezone,
       )                                                       // pure, no I/O; one call per series
       // Inside expandRecurrence: walk ordered segments; intersect each requested window
       // with [g.effectiveFrom .. dayBefore(next.effectiveFrom)]; self-anchor each rule on
       // g.effectiveFrom; apply series-level endDate / count across the combined stream.
       // retain the widened nominal set; no exact viewer-window filter yet
  6. overrides = BatchGetItem OCC#<date> for every (series, nominal date) pair produced in 5,
                 plus MOVE#<destinationDate> for each series and each date in the widened window
       // MOVE keys are exact and collision-free even when a normal occurrence is due there
       movedSources = BatchGetItem OCC#<movedFrom> named by returned MOVE markers
       // this second bounded pass is required: BatchGet cannot follow a pointer discovered
       // in its own response. The 60-day write cap bounds the source set.
  7. for each (series, date):
       t = time of the segment in force for date (falling back to schedule.time)
        if override.overrideDate          -> source emits nothing at its nominal date
       if override.status == 'skipped'   -> emit as SKIPPED (hidden by default — client presentation, P2-35)
       if override.status == 'completed' -> emit as COMPLETED
       if override.status == 'snoozed'   -> emit at override.snoozedUntil
       else                               -> emit at t
     for each hydrated (MOVE marker, moved source override):
       emit the source once at its overrideDate / cross-day snoozedUntil
       with "moved from <source date>"; never emit the marker as its own occurrence
     for each one-off scheduled item:
       if activity.snoozedUntil           -> emit at activity.snoozedUntil
  8. convert every effective scheduled/occurrence instant to viewer tz,
       filter exact viewer-local [from..to], merge scheduled + expanded, then de-duplicate
  9. if include=reminders:
       query REM#<callerUserId># for each bounded distinct emitted Activity and attach rows
       to that Activity's AgendaItems in [from..to]
 10. sort by effective viewer-local time, partition into
       UP NEXT / SCHEDULE / ANYTIME / EARLIER TODAY
```

Constraints:

- The read order is normative: **expand → fetch overrides for the widened candidate set →
  apply `overrideTime` / `overrideDate` / `snoozedUntil` → filter the exact viewer window**.
  Filtering a nominal date or base time before override application can drop an occurrence
  that moves into the requested day. The named New York → Tokyo cross-midnight override test
  locks this order.

- Window is capped at **62 days**. Reject wider requests with `400`.
- `#S` and optional `#N` queries are paged to exhaustion. Only `#R` is capped; it returns
  `series_limit_exceeded` when another page exists.
- Segments per series are capped at **20** (`validation_failed` on append beyond it),
  bounding expansion cost per series; the 62-day window and 200-series limits are unchanged.
- Scheduled META hydration (step 2), series META hydration (step 4), marker discovery and
  both occurrence-override passes (step 6) are `BatchGetItem`, chunked at 100 keys with `UnprocessedKeys`
  retried. If a user has > 200
  active series, hydrate only the bounded set and return a `series_limit_exceeded` warning
  in the response rather than timing out.
- If assembly encounters the same `(activityId, occurrenceDate?)` twice, it retains the
  deterministic first candidate and returns `duplicate_occurrence:<activityId>`. This warns
  about a storage or override-merge invariant breach; it is not a client reconciliation
  mechanism and does not turn the successful agenda response into an error.
- `after_completion` mode (Phase 9+): next occurrence = last completion date + interval.
  If never completed, use the active segment's `effectiveFrom`. It produces **at most one** future occurrence — do
  not project a series into the future for completion-relative recurrence.
- DST: expand and derive instants in the activity's stored `timezone` using
  `Temporal`-style date arithmetic (`date-fns-tz`), then convert to viewer `tz`. A 6 PM
  daily task stays 6 PM in its stored zone across a DST boundary. A nonexistent local time
  moves to the first valid time after the gap: `2026-03-08 02:30 America/New_York` becomes
  `03:00`, not `03:30` and not a dropped occurrence.

---

## 7. Write paths that touch multiple items

Use `TransactWriteItems` for these. They are the only places transactions are required.
Every operation reached through a mutating POST includes the conditional
`IDEM#<userId>#<key>` response receipt in its main transaction (P2-38); transaction-size
calculations reserve one item for it. A multi-phase operation additionally writes a
`CLEANUP#<userId>#<key>` item in that main transaction and reserves a second item. Replay
executes no second main domain write; it drains receipt-linked cleanup before returning the stored
status/body.

| Operation | Items written |
| --- | --- |
| Create activity | `ACT#/META`, `USER#<owner>/IDX#`, one `ACT#/REM#<owner>#<id>` per supplied reminder, and — when `parentActivityId` is set — `ACT#<parent>/SUB#<child>` with `isRecurring` plus the parent's `ACT#<parent>/META` `childCount` increment, conditioned on the parent existing and being under `MAX_PREP_TASKS_PER_PLAN` (**amended in P1-09**: §3.1 already required the pointer to be written when an activity is given a parent, and this row listed only the first two; **amended in P3-18**: the counter joins the same transaction, so the cap is a condition rather than a precheck and the pointer can never outlive the count) |
| Create list | Conditional `LIST#/META`, owner `USER#/LIST#` pointer and list-tombstone absence check, plus `ACT#<sourceActivityId>/SOURCE_LIST#<listId>` when sourced from a Plan; the POST receipt joins the same transaction |
| Create list item | Read neighbours and `rankVersion`; conditionally write `LIST#/ITEM#<rank>#<itemId>` and `LIST#/ITEMID#<itemId>` locator with the same initial `itemRevision`, condition-check item-tombstone and both migration/repair gates absent, and advance META counters, `rankVersion` and `itemVersion`. On version conflict re-read and retry. Bulk allocates an ordered sequence under one version advance per receipt-aware chunk. |
| Patch list item fields | Resolve the locator/ranked row, update only supplied fields while conditionally advancing the row and locator's matching `itemRevision`, atomically advance `META.itemVersion`, and require both migration/repair gates absent. A condition conflict is retried internally against current truth; no client `If-Match` and no unrelated field replacement. |
| Reorder list item | Delete the old ranked row only at the revision read, put that freshly read row at the new rank with the next revision, conditionally move the locator from the same rank/revision, and conditionally advance `META.rankVersion` plus `META.itemVersion` with both gates absent. On any conflict re-read the row/neighbours and retry. No other ListItem changes during normal reorder. |
| Repair list ranks | Conditionally install `META.rankRepairId` plus a `RANK_REPAIR#<operationId>` snapshot, then rewrite only bounded chunks while the marker gates item reads/mutations. Every item page uses strong pre/post META fences around a strongly consistent Query. The final transaction clears the marker and advances `rankVersion` plus `itemVersion`, invalidating pre-repair cursors and whole-list snapshots. |
| Change List behaviour | Replay-protected `POST /v1/lists/:id/behaviour`, under `If-Match` and its idempotency receipt, leaves public behaviour unchanged while conditionally installing `META.behaviourMigrationId` plus `BEHAVIOUR_MIGRATION#<operationId>`, which carries the receipt every finisher must write and no `ttl` of its own. Snapshot the stable at-most-500 item ids/ranks/revisions and transform bounded chunks, conditionally advancing each ranked row and locator revision, while all public item reads/mutations are gated. The final transaction changes behaviour, clears the marker, advances `rankVersion` plus `itemVersion`, records Undo and deletes the work row. An install whose gated loss count disagrees with the count its caller previewed is instead rolled back at `cursor = 0`, leaving the list untouched. Confirmed downgrade and Undo use the same path. |
| Delete list item / clear checked | Delete ranked rows and locators, write `ITEM_TOMBSTONE#<itemId>` snapshots through `MAX_AUTOMATIC_INTENT_AGE_DAYS`, write a single-use `UNDO#<operationId>` with the same replay retention, advance `itemVersion`, update List counters, remove current viewer links and clear linked Activity provenance while advancing those Activities' `updatedAt`; bounded receipt-aware chunks preserve one logical Undo operation and never delete an Activity |
| Uncheck all | Change only currently checked items to unchecked, advance `itemVersion` once per applied chunk, and write one single-use, replay-retained `UNDO#<operationId>` containing exactly those item ids; bounded receipt-aware chunks preserve one logical operation |
| Meal ingredients to a list | **One transaction** (P3-17). Selections are classified by normalized-title group. Per matching **unchecked** row, update the rendered `sourceLabel` plus storage-only activity-keyed `sourceProvenance` under that row's `itemRevision`; per created group, use the ordinary conditional item/identity puts and tombstone check; and per supplied id absorbed by a labelled/grouped outcome, conditionally put a permanent alias in the same authoritative `ITEMID#` namespace. A created identity and every alias store the exact source Activity, ingredient and original outcome; only that exact tuple is a replay. The META `rankVersion`, `itemVersion` and counters advance; one conditional `ACT#/META` `SET details.ingredients[i].addedToListId` per selected row is conditioned on its resolved `ingredientId` still occupying that index and on the meal's read `updatedAt`, which it also advances; the idempotency receipt joins the same write. For `n <= 30` selections and `g` destination groups, creates cost `3g` while aliases/extensions replace rather than add another three actions per grouped selection; the worst case remains `3n + 4 = 94`. The META condition names both **snapshot generations** and the service validates `behaviour = collection` plus capacity from that exact basis, so a create, rename, check, delete or completed behaviour migration landing after preflight cancels or refuses the operation instead of laundering a stale decision into a commit. A condition failure re-runs the entire read/classify/build cycle. A bound replay target answers its own ingredient even after rename/check, but it may absorb fresh same-title selections only while it is still unchecked and its normalized title still matches. Every supplied id remains occupied by its no-TTL `ITEMID#` record even after the receipt expires or an alias target is deleted. |
| Undo List operation | Resolve a retained, unused opaque token to `UNDO#<operationId>`; a compensation spends it in the **same transaction** that applies the inverse — including the behaviour-upgrade migration's final transaction — so no crash can leave a spent inverse looking unspent; `undoExpiresAt` governs only whether the client may offer a new Undo, not whether an already accepted durable inverse may replay. For delete, conditionally recreate the same ranked rows and locators, advance `rankVersion` and `itemVersion`, restore still-live viewer links and Activity provenance while advancing those Activities' `updatedAt`, delete matching item tombstones and update counters; for `uncheck-all`, recheck only affected ids that still exist and advance `itemVersion`; for an additive settings/archive change, apply its recorded inverse only while the exact preconditions still hold. Behaviour-upgrade compensation removes only defaults that operation created and bypasses the ordinary destructive-downgrade confirmation. Retention-expired, mismatched, edited or reused operations write nothing. |
| Request attachment upload | Drain the caller's bounded pending set, then put `USER#<u>/UPLOAD#<attachmentId>` with declared temporary/final keys, type, size, `awaiting_upload` state and one-day `cleanupAfter` before returning the presigned URL. Reject more than 20 unresolved rows. |
| Confirm attachment | Record the target Activity and mark the pending upload `confirming`, copy and verify the final object, then transactionally put `ACT#<a>/ATT#<attachmentId>` and delete the pending row; retry or the caller's next bounded drain resumes. Expired cleanup deletes both object keys before deleting a row. |
| Schedule / reschedule | One main transaction writes `ACT#/META` plus `USER#<u>/IDX#` for owner **and every participating user** (the GSI1 bucket, sort key, projected timezone and status may change), plus `ACT#<parent>/SUB#<child>` when a prep task's derived status changes. An occurrence-only cross-day move instead writes its nominal `OCC#` override plus destination `MOVE#` marker and never META. RSVP reset follows §7.1: it may join through 45 participants; above that the main transaction writes `rsvpResetPending`, receipt and `CLEANUP#` work, then bounded idempotent phases rewrite participants and clear the marker. Unscheduling's main transaction similarly persists receipt + reminder-delete cleanup before bounded deletion. A timed → date-only change normalises sub-day reminder offsets, using persisted cleanup when the fan-out cannot fit. None of those reminder rows is falsely claimed to be atomic with META/index state. |
| Add participant (app user) | `ACT#/PART#`, `USER#<invitee>/IDX#`, `USER#<owner>/PLINK#`, `USER#<invitee>/PLINK#`, counter update on `ACT#/META` |
| Add participant (guest) | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `INVITE#<token>/META` |
| Add list member (app user) | `LIST#/MEMBER#`, invitee `USER#/LIST#`, owner and reciprocal `USER#/PERSON#` when absent, both active `USER#/LLINK#` rows, and `LIST#/META` member counter — at most 7 items |
| Invite list member (no account) | `LIST#/MEMBER#`, owner `USER#/PERSON#`, owner invited `USER#/LLINK#`, `GUESTEMAIL#` Person locator, and `LIST#/META` member counter — at most 5 items and no recipient pointer |
| Activate invited list member | Update `LIST#/MEMBER#`, write invitee `USER#/LIST#`, create/reuse reciprocal `USER#/PERSON#`, change owner `LLINK#` to active and write invitee active `LLINK#` |
| Remove or leave shared list | Delete `LIST#/MEMBER#`, invitee `USER#/LIST#` when active, owner `LLINK#`, invitee reciprocal `LLINK#` when active, and decrement `LIST#/META`; then asynchronously remove that viewer's `LNK#` rows. The Person-level `GUESTEMAIL#` locator remains until link, email removal or Person deletion. |
| Delete shared list | Write `LIST#/TOMBSTONE` through `MAX_AUTOMATIC_INTENT_AGE_DAYS`, remove its `ACT#/SOURCE_LIST#` projection when present, then cascade every List-partition row (`META`, members, items, locators, links, Undo, repair and behaviour-migration work), every member pointer and every owner/member `LLINK#`; owner-scoped `PERSON#` rows survive and the tombstone is removed only by TTL or account purge |
| Schedule a list item | Extend the durable Activity-create transaction: condition-check its tombstone; conditionally create the required client-minted `ACT#<activityId>/META`, owner/selected-participant `USER#/IDX#` and `ACT#/PART#` rows, one caller `ACT#/REM#<caller>#<reminderId>` per supplied stable reminder id, the receipt and rows required by other accepted create fields; plus `LIST#/LNK#<viewer>#<item>` for the caller and selected registered participants who are active list members. The `LIST#/ITEM#` row is unchanged. Replay after receipt expiry adopts a matching existing Activity and never rolls a newer current pointer back. |
| Add expense | `ACT#/EXP#`, `ACT#/META` (total), `EXPENSE#<expenseId>/META` locator, any missing `USER#/PERSON#` rows for pairs in the payer + split set who do not yet hold each other as People — the same `personId` mirrored into each affected registered user's partition, `displayName` copied, `linkedUserId` carried when set, no email or phone copied; a guest's mirrored side waits for account linking — and required directional `PLINK#` rows marked `shared_activity` or retained for finance, then **async** balance recalc via stream for both sides of each pair ([`../01-product/expenses.md`](../01-product/expenses.md) §5.1). Edit updates the affected relationship set, creating Person rows for newly paired participants the same way; delete removes the locator and any `finance_only` link no remaining Expense needs. |
| Mark obligations settled | Update each covered `ACT#/EXP#` (`settledPersonIds`, `settlementIdByPersonId`, derived `settled`) + write one `USER#/SETTLE#` audit row and one `SETTLEMENT#<settlementId>/META` locator. Server derives amount/currency/direction and exact per-Expense coverage before the transaction; balance recompute reads Expenses only. |
| Undo settlement | Resolve and delete the `USER#/SETTLE#` row and its `SETTLEMENT#` locator + conditionally remove only each recorded debtor/Settlement pair from the covered `ACT#/EXP#` items, recompute their roll-ups, then recompute balances from Expenses |
| Purge account | **Shared-plan financial records survive the purge — retain and anonymise, never unwind (decision 2026-08-07).** Expenses and Settlement audit rows, with their locators, on shared plans that still have surviving participants are retained for those participants, with the deleted user's display name replaced by `Deleted user` wherever those rows render it. Balances involving the deleted account become read-only history: no further settlement, no recompute against a partition that no longer exists. Owned **shared** plans are cancelled, with notification to the participants, before any removal, and their partitions are retained for the survivors. Checkpoint and run exact whole-Settlement Undo only for financial rows nothing retains — Settlements whose covered Expenses sit on plans with no surviving participant. Then cascade owned private Activities and owned Lists (all pointers/`LLINK#`/`LNK#`) and remove the user from other-owned Lists (`MEMBER#`, both links, pointer, counter, viewer links) while retaining other users' `PERSON#` rows. Only after cross-partition cleanup may the user partition be deleted; see `auth.md` §8. |
| Patch a prep task's title or recurrence | Child `ACT#/META`, every required index row, and parent `ACT#/SUB#<child>` in one transaction. The pointer mirrors title/status plus `isRecurring`, so follow-up eligibility does not inspect or guess a child occurrence. P2-13 repairs the Phase 1 omission that updated the child title without rewriting this denormalised pointer; P3-18 adds `isRecurring` to that rewrite and to the same-transaction obligation. |
| Set, clear or change a prep task's `parentActivityId` | Child `ACT#/META`, every required index row, and — in the same transaction — the old parent's conditional `SUB#<child>` delete with its `childCount` decrement and the new parent's `SUB#<child>` put with its capped `childCount` increment (P3-18). Membership never exists on two plans or on none, and the nesting cap is checked on both sides: the target may not itself be a prep task and the task being attached may not already have children. |
| Correct a recurrence segment that starts today | `ACT#/META` plus every required `USER#/IDX#` row, with a condition in the same transaction that `ACT#/OCC#<today>` does not exist. No occurrence is written; any existing occurrence makes the correction fail without changing the series. |
| Convert a selected series occurrence to **Does not repeat** | Resolve the explicitly targeted nominal occurrence from `ACT#/META` plus `ACT#/OCC#<date>`; condition-check the versions/absence read; then rewrite `ACT#/META`, every required `USER#/IDX#` row and, for a prep task, parent `ACT#/SUB#<child>.isRecurring = false` in one transaction. META keeps the selected effective schedule and timezone and drops `recurrence`; `OCC#` history is neither deleted nor invented. |
| **End series** / set **No end** | Rewrite `ACT#/META.recurrence` plus every required recurring `USER#/IDX#` projection in one optimistic transaction. End series sets an explicit inclusive `endDate`; No end clears `endDate` and `count`. Neither operation writes an `OCC#` row. |
| Complete / uncomplete / skip a non-occurrence | `ACT#/META` plus every owner/participant `USER#/IDX#` status and, for a prep task, parent `ACT#/SUB#<child>` in one transaction, following the Phase 1 PATCH transaction pattern. Skip / `didnt_happen` also deletes matching `LIST#/LNK#` viewer pointers; complete and uncomplete retain them. |
| Complete / skip an occurrence | `ACT#/OCC#<date>` only (put or delete as appropriate). Never the series. |
| Cross-day occurrence reschedule / snooze / unsnooze | Nominal `ACT#/OCC#<date>` plus the destination `ACT#/MOVE#<date>` marker in one transaction; replacing a destination also removes the prior marker reference. Never the series. Same-day snooze remains one `OCC#` write. |
| Snooze / unsnooze a non-recurring one-off | Update or delete `ACT#/META.snoozedUntil`; never create an `OCC#` row |
| Delete activity | First query child Expenses: any non-empty `settlementIdByPersonId` makes the whole operation `409 settlement_conflict` with no tombstone or write. After explicit Undo clears them, the cascade begins: when the activity is itself a prep task, remove the parent's `ACT#<parent>/SUB#<child>` pointer and decrement `childCount` in one conditional transaction — the half of the cascade that lives in the *parent's* partition, idempotent so an interrupted delete resumes without double-counting (P3-18) — then use `SOURCE_LIST#` rows to clear matching `List.sourceActivityId` values without deleting Lists, then delete child rows and external pointers (`EXPENSE#` locators, every `USER#/IDX#` + `PLINK#`, and matching `LNK#` pointers) first, and delete `ACT#/META` **last**. Until that final delete a retry can re-authorise and resume the bounded idempotent cascade; after it, a replayed `404` is success. |

Participant fan-out is bounded: **cap participants at 50 per activity** in v1. Enforce it
in validation. The cap alone does **not** keep every write under DynamoDB's 100-item
transaction limit: the RSVP-reset reschedule is 103 items at the cap, so above 45
participants it runs as the P2-12/P6-15 two-phase reset — an `rsvpResetPending` marker,
successful receipt and `CLEANUP#` work item are committed with `ACT#/META` in phase one;
`PART#` rows are rewritten in idempotent batches and the marker is cleared in later recorded
phases, with every RSVP read returning `pending` while the marker is set. Inline, replay and
next-Activity-mutation drains all resume the same work rather than starting a new reset.

### 7.1 RSVP consent does not survive a date change

A participant who responded to an undated plan agreed to **the idea**, not to a time nobody
had picked yet. Carrying that response forward when a date lands claims consent they never
gave, in a product whose whole posture is *suggest, never assume*.

| Transition | Effect on every non-declined participant's `rsvp` (declined rows are neither reset nor notified — decision 2026-08-07, see phase-06 P6-15) |
| --- | --- |
| No date → a date | **Reset to `pending`**, clear `respondedAt`, set `rsvpForDate`, write a system update, notify. |
| Date changes (e.g. Sat → Sun) | **Reset to `pending`**, same as above. |
| Time changes only, same date | **Kept.** Notify, do not re-ask. |
| Date cleared, back to undecided | Kept, and `rsvpForDate` cleared. Re-asking to un-agree is noise. |

`rsvpForDate` exists so the client can render "Alice said yes to Saturday" and so a reset is
provably correct rather than inferred. The owner's own row is never reset, and neither is a
`declined` row — a declined participant left the conversation, and a date change is not an
invitation (their route back is `Rejoin`).

The rendered labels change with the same signal, while the stored values never do:

| Stored | Undated | Dated |
| --- | --- | --- |
| `going` | Interested | Going |
| `maybe` | Maybe | Maybe |
| `declined` | Pass | Decline |

Do not add `interested` to the enum. It is the same state with a different word on it, and
storing it would force a data migration every time somebody picks a date.

---

## 8. IDs

- Prefixed ULIDs: `act_`, `usr_`, `lst_`, `itm_`, `ing_`, `psn_`, `exp_`, `stl_`, `dev_`, `att_`,
  `upd_`, `rem_` (Reminder, §4.3), `sct_` (Shortcut, §3.2 — Phase 9). Generated with `ulid` —
  time-prefix sortable with no coordination needed, but not a business-chronology source when
  client-minted. `rem_` and `sct_` were added in P1-06,
  which needed a prefix for the two shapes that referenced ids this list had never named.
- `usr_` is the one exception to the ULID rule in practice: see §4.0: the local development
  identity is the constant `usr_local_dev`, so the shared validator checks the prefix and the
  ULID assertion lives at the generator.
- Invite tokens are **not** ULIDs (they'd leak creation order and be guessable). Use
  `crypto.randomBytes(16)` base62-encoded.
- Never expose raw DynamoDB `pk`/`sk` over the API. The API speaks in IDs.
- **`act_`, `rem_`, `lst_`, and `itm_` may be client-minted (Phases 2.6–3, ADR-055).** *"No coordination
  needed"* above is why: a device offline can generate the real, permanent id rather than a
  placeholder it later reconciles. The server validates the prefix and ULID encoding,
  refuses an id that already exists (conditional write, transactionally checked against the
  corresponding deletion tombstone; ranked ListItems use §3.3's stable identity locator as
  the conditional-create key), and derives ownership from the authenticated
  principal — **an id is an identifier, never a credential and never a claim.** Authority
  fields (`ownerId`, `createdAt`) stay server-set and are not accepted on input.
- **`ing_` is a client-minted embedded-row identity, not an entity id.** A meal form mints it
  before accepting a new ingredient row and retains it through edits and reordering. It has
  no independent endpoint or tombstone; its job is to let an offline action identify the
  same source row after the array moves. Removing/replacing the row makes that id stale.
- **The collision response is honestly an existence signal.** Success versus failure reveals
  whether an id exists no matter how generic the error copy is. That residual is accepted
  and bounded: 80 random bits are not enumerable, authorization is tenancy rather than id
  secrecy, and the error body carries no owner or entity metadata. The client's recovery is
  a read of its **own** id: `200` → its earlier create landed (acknowledge on identity and
  ownership; the server entity wins wholesale); `404` → foreign collision or tombstoned
  create-then-delete, surfaced to the user — never an automatic re-mint, which could bypass
  a tombstone.
- **Never derive business chronology from a ULID timestamp.** A client-minted id carries a
  device clock. Ordering comes from the explicit timestamp leading each `gsi1sk`; the id is
  uniqueness and a **stable tie-break**, nothing more. `monotonicFactory` orders ids within
  one generator only — concurrent Lambdas already made cross-instance order approximate.

---

## 9. Migration policy

`schemaVersion` on every item. Migrations are lazy: the repository layer upgrades an item
in memory on read and writes the upgraded shape on next write. Batch backfill scripts live
in `infra/scripts/migrations/` and are one-off, reviewed, and idempotent.

There is no shared production data yet. Until Phase 5 ships to TestFlight, a breaking
change may simply be applied by wiping `od-main-dev`. After that, migrations are required.

---

## 10. What is deliberately NOT modelled in v1

Do not add these without a product decision:

- Nutrition / calories / macros on Meal.
- Full recipe management (steps, servings, scaling).
- A social graph: friend requests, follows, feeds, likes, profiles, relationship scores.
- Payment rails: Venmo, bank links, card processing, budgets, financial analytics.
- Multi-currency conversion. One currency per user; expenses in a foreign currency are
  stored with their own `currency` and shown separately, not converted.
- **Date ranges.** `schedule` has a `date`, never an `endDate`. A three-day trip is one
  activity on its **start date**, with prep tasks and lists hanging off it. The honest
  consequence, which the UI must not pretend away: **it does not appear on Today on days two
  and three.** Supporting ranges means either an index entry per day of the range or a
  second query for straddling activities on every agenda read, and neither is worth it
  before somebody complains. No v1 screen, example or mock may show a date range.
- **Per-participant completion.** See §4.5 — completion is global. Plan actions are owner-only;
  a prep task may be acted on by its owner, parent owner or parent participant, but still
  writes one shared occurrence with no participant identity.
- Sub-lists, tags, labels, projects, priorities, custom fields.
- A fourth list behaviour. Templates are unbounded and free to add; behaviours are not.
- User-authored list templates. The catalogue ships with the app.
- Full link history between a list item and every Activity derived from it. The current
  pointer is singular **per viewer and item** in v1 — see §4.6.
- A category-management system. `type` is a closed enum plus `custom`. That is the point.
