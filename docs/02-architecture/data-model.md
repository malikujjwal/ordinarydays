# Data model

**Status:** canonical. Do not invent tables, entities, or key patterns that are not in
this document. If you need a new access pattern, add it to the Access Patterns table below
in the same PR and explain the key design.

---

## 1. Core modelling decision: there is only one schedulable entity

The product language has three nouns — **Today**, **Plans**, **Lists** — plus six activity
types. That does **not** mean three or nine tables.

| Product word | What it actually is |
| --- | --- |
| **Activity** | The single stored entity. Everything the user creates is one of these. |
| **Plan** | An Activity that has a confirmed schedule (`schedule.date` is set), and often participants. **Not a separate entity.** |
| **Today** | A *query* over Activities for one date. Owns no data. |
| **Lists** | A separate, deliberately simple entity (`List` + `ListItem`) for things with no committed date. A ListItem can *link* to an Activity. |
| **Task / Meal / Watch / Event / Outing / Custom** | The `type` field on Activity, plus a type-specific `details` sub-document. **Not six tables.** |

> If you find yourself writing a `Plan` table or a `Meal` table, stop. You have
> misunderstood the model.

### Why

The founding insight of the product is that meals, TV, expenses, lists, and people are not
separate mini-apps — they all move through the same lifecycle. The storage model has to
reflect that or the code will fragment into six half-products.

---

## 2. Storage choice

**Amazon DynamoDB, single-table design.**

- Table name: `od-main-{env}` (`od-main-dev`, `od-main-prod`).
- Billing mode: **on-demand** (`PAY_PER_REQUEST`). At personal / early-beta scale this is
  a few cents a month. The always-free 25 GB of storage still applies.
- Point-in-time recovery: **on** in prod.
- TTL attribute: `ttl` (epoch seconds) — used by invite tokens and idempotency records.
- Streams: **on** (`NEW_AND_OLD_IMAGES`) from Phase 6 onward, for balance recalculation
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

The canonical Activity **and everything that hangs off it** live in one partition, so the
plan-detail screen is a single `Query`.

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| Activity | `ACT#<activityId>` | `META` | `Activity` |
| Participant | `ACT#<activityId>` | `PART#<personId>` | `Participant` |
| Expense | `ACT#<activityId>` | `EXP#<expenseId>` | `Expense` |
| Update / note entry | `ACT#<activityId>` | `UPD#<isoTs>#<updateId>` | `ActivityUpdate` |
| Occurrence override | `ACT#<activityId>` | `OCC#<yyyy-mm-dd>` | `Occurrence` |
| Attachment | `ACT#<activityId>` | `ATT#<attachmentId>` | `Attachment` |
| Child pointer | `ACT#<activityId>` | `SUB#<childActivityId>` | `ChildPointer` |

`SUB#` items are thin pointers written when an activity is given a `parentActivityId` —
a prep task under a plan. They carry `childActivityId`, `title`, `status` and `rank` so the
plan-detail screen renders its prep tasks from the same single `Query` as everything else,
without a second lookup. The child Activity remains the source of truth; the pointer is
updated in the same transaction as the child's title or status.

### 3.2 User partition

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| Profile | `USER#<userId>` | `PROFILE` | `User` |
| Activity index entry | `USER#<userId>` | `IDX#<activityId>` | `ActivityIndex` |
| List | `USER#<userId>` | `LIST#<listId>` | `List` |
| Person (contact) | `USER#<userId>` | `PERSON#<personId>` | `Person` |
| Person↔activity link | `USER#<userId>` | `PLINK#<personId>#<sortTs>#<activityId>` | `PersonLink` |
| Cached balance | `USER#<userId>` | `BAL#<personId>#<currency>` | `Balance` |
| Settlement | `USER#<userId>` | `SETTLE#<personId>#<isoTs>#<settlementId>` | `Settlement` |
| Push device | `USER#<userId>` | `DEVICE#<deviceId>` | `Device` |
| Custom-activity shortcut | `USER#<userId>` | `SHORTCUT#<shortcutId>` | `Shortcut` (Phase 8) |

`Balance` is keyed by `(personId, currency)` because expenses are never converted between
currencies. A user who owes €20 and is owed $30 by the same person has two balance rows
and the UI shows two figures. `sk begins_with BAL#<personId>#` still satisfies access
pattern 11.

### 3.3 List partition

| Item | `pk` | `sk` | `entity` |
| --- | --- | --- | --- |
| List metadata mirror | `LIST#<listId>` | `META` | `ListMeta` |
| List item | `LIST#<listId>` | `ITEM#<lexoRank>#<itemId>` | `ListItem` |

`lexoRank` is a fractional-index string (see `04-conventions/coding-standards.md`) so
reordering is a single-item write, never a renumber of the whole list.

### 3.4 Lookup partitions

| Item | `pk` | `sk` | Notes |
| --- | --- | --- | --- |
| Invite token | `INVITE#<token>` | `META` | `ttl` set; resolves to activityId + personId |
| Email → user | `EMAIL#<lowercased-email>` | `USER` | for matching guests to new signups |
| Guest email → person refs | `GUESTEMAIL#<lowercased-email>` | `OWNER#<ownerId>#PERSON#<personId>` | reverse index so guest→account linking is a `Query`, never a `Scan` |
| Idempotency record | `IDEM#<userId>#<key>` | `META` | `ttl` = now + 24 h |
| Rate-limit counter | `RATE#<scope>#<subject>` | `<windowStart>` | `ttl` = window end |

> Idempotency keys are **user-scoped**. A bare `IDEM#<key>` partition would let one user's
> client-generated key return another user's stored response. This is a security
> requirement, not a nicety.

`GUESTEMAIL#` items are written whenever a guest participant is created with an email, and
deleted when that guest is linked to an account or removed. On signup, the
post-confirmation trigger queries `GUESTEMAIL#<verified email>` to find every guest record
across every owner's contact list and merges them. Merging without a **verified** email is
forbidden — see `security-privacy.md`.

### 3.5 GSI1 buckets

`GSI1` is populated **only on `ActivityIndex` items** (`USER#<u>` / `IDX#<a>`).

| Bucket | `gsi1pk` | `gsi1sk` | Serves |
| --- | --- | --- | --- |
| Scheduled | `U#<userId>#S` | `<localDateTime>#<activityId>` — e.g. `2026-08-06T19:30#a_01H…` | Today, Plans, date ranges |
| Unscheduled | `U#<userId>#N` | `<createdAt>#<activityId>` | Anytime / Inbox |
| Recurring series | `U#<userId>#R` | `<seriesStartDate>#<activityId>` | Recurrence expansion |
| Archived | *(attribute removed)* | — | Completed + past items drop out of GSI1 after 60 days via a maintenance job |

`localDateTime` is the **user's local** wall-clock time, stored as `YYYY-MM-DDTHH:mm` with
no offset. Reasoning: "Today" is a wall-clock concept. The absolute UTC instant is stored
separately in `scheduledAtUtc` for reminders and `.ics` export.

> An `ActivityIndex` item exists for the **owner and every participating app user**. That
> is how a shared plan appears on someone else's Today. Guests (non-users) get no index
> entry — they only have the invite page.

---

## 4. Entity shapes

TypeScript definitions live in `packages/shared/src/types/`. These are the authoritative
shapes; the table above only describes where they are stored.

### 4.1 Activity

```ts
type ActivityType = 'task' | 'meal' | 'watch' | 'event' | 'outing' | 'custom';

type ActivityStatus =
  | 'saved'       // exists, no date committed
  | 'scheduled'   // has a date (and optionally a time)
  | 'completed'
  | 'skipped'
  | 'cancelled';

interface Activity {
  activityId: string;          // ULID, prefixed: "act_01J..."
  ownerId: string;             // USER id of creator
  type: ActivityType;
  status: ActivityStatus;

  title: string;
  notes?: string;

  // Schedule — all optional. Presence of `date` is what makes it a "Plan".
  schedule?: {
    date: string;              // YYYY-MM-DD, user-local
    time?: string;             // HH:mm, user-local. Absent => all-day / anytime-that-day
    endTime?: string;          // HH:mm
    timezone: string;          // IANA, e.g. "America/New_York"
    scheduledAtUtc?: string;   // ISO instant, derived; absent for all-day
    endAtUtc?: string;
  };

  recurrence?: Recurrence;     // see §4.2
  reminders?: Reminder[];      // see §4.3

  location?: {
    label: string;
    address?: string;
    lat?: number;
    lng?: number;
    mapUrl?: string;
  };

  // Relationships
  parentActivityId?: string;   // prep task belonging to a plan
  listItemId?: string;         // the List item this was scheduled from (§10 of concept)
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

  icsSequence: number;         // starts at 0; RFC 5545 SEQUENCE for calendar exports

  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}
```

**Rules**

- `status` is derived on write, never set freely by the client:
  `completed`/`skipped`/`cancelled` are set by the completion endpoints; otherwise
  `schedule?.date ? 'scheduled' : 'saved'`.
- An Activity with `schedule.date` set **is a Plan**. There is no `isPlan` flag.
- `type` is never immutable — the user can change a Watch into a Custom. Changing type
  keeps `details` fields that still apply and drops the rest (log what was dropped).
- `icsSequence` increments **only** when a field that appears in an exported calendar
  event changes: `title`, `schedule.date`, `schedule.time`, `schedule.endTime`,
  `schedule.timezone`, `location`, `status → cancelled`, and the event description. It
  never increments for notes, expenses, participants, or attachments. Calendar clients use
  a decreasing or static `SEQUENCE` as a signal to ignore an update.

### 4.2 Recurrence

```ts
interface Recurrence {
  mode: 'fixed' | 'after_completion';   // Phase 2 ships `fixed` only
  freq: 'daily' | 'weekly' | 'monthly' | 'interval_days' | 'weekdays' | 'custom';
  interval?: number;                    // for interval_days / every-N-weeks
  byWeekday?: (0|1|2|3|4|5|6)[];        // 0 = Sunday
  byMonthDay?: number[];
  startDate: string;                    // YYYY-MM-DD
  endDate?: string;
  count?: number;
  rrule?: string;                       // RFC 5545 string for `custom`
}
```

**Recurring activities are never materialised into future rows.** One Activity row holds
the series. The agenda endpoint expands the series for the requested date window at read
time and merges in `Occurrence` overrides. See §6.

### 4.3 Reminder

```ts
interface Reminder {
  reminderId: string;
  offsetMinutes: number;   // negative = before start. -0 == at start time
  channel: 'push';         // email/sms are out of scope for v1
}
```

### 4.4 Type-specific details

```ts
type ActivityDetails =
  | { kind: 'task'; }
  | { kind: 'meal';
      mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      ingredients?: { name: string; quantity?: string; addedToListId?: string }[];
      recipeUrl?: string; }
  | { kind: 'watch';
      mediaTitle: string;
      mediaKind?: 'movie' | 'show';
      season?: number;
      episode?: number;
      episodeTitle?: string;
      service?: string;          // free text: "Netflix", "Apple TV+"
      watchlistItemId?: string; }
  | { kind: 'event';
      description?: string;
      priceCents?: number;
      currency?: string;
      ticketUrl?: string;
      organiser?: string; }
  | { kind: 'outing';
      placeName?: string;
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
  completedAt?: string;
}
```

> Snoozing or completing an occurrence must never mutate the parent `Recurrence`. This is
> an explicit product requirement (concept §6) and a required test case.

### 4.6 List and ListItem

```ts
type ListKind =
  | 'watchlist' | 'meals' | 'restaurants' | 'places'
  | 'groceries' | 'shopping' | 'packing' | 'general';

interface List {
  listId: string;
  ownerId: string;
  kind: ListKind;
  title: string;
  sourceActivityId?: string;   // "this Packing list came from the New York Trip plan"
  itemCount: number;
  archived: boolean;
}

interface ListItem {
  itemId: string;
  listId: string;
  rank: string;                // lexo rank
  title: string;
  note?: string;
  checked: boolean;            // for groceries/packing/shopping
  linkedActivityId?: string;   // set when scheduled — the item is NOT duplicated
  sourceActivityId?: string;   // "Chicken — Sunday dinner"
  sourceLabel?: string;        // human string rendered next to the item
  details?: {
    // watchlist progress lives here
    mediaKind?: 'movie' | 'show';
    watchStatus?: 'want' | 'watching' | 'watched';
    season?: number;
    episode?: number;
  };
}
```

**The no-duplication rule (concept §10) is enforced here:** scheduling a ListItem creates
an Activity and sets `listItem.linkedActivityId` + `activity.listItemId`. Two rows, one
concept, bidirectionally linked. Deleting either one must clear the other's pointer, not
cascade-delete.

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

interface Participant {
  activityId: string;
  personId: string;
  ownerScopedPersonRef: string; // "<ownerId>:<personId>", so the PART row is unambiguous
  userId?: string;              // if a registered user
  displayName: string;
  email?: string;
  rsvp: 'pending' | 'going' | 'maybe' | 'declined';
  role: 'owner' | 'participant';
  invitedAt: string;
  respondedAt?: string;
  isGuest: boolean;
}
```

### 4.8 Expense, Balance, Settlement

```ts
interface Expense {
  expenseId: string;
  activityId: string;
  description: string;
  amountCents: number;          // integers only. Never floats for money.
  currency: string;             // ISO 4217, default from user profile
  paidByPersonId: string;
  splitMode: 'equal' | 'exact' | 'shares';
  splits: { personId: string; amountCents: number; shares?: number }[];
  note?: string;
  createdBy: string;
  settled: boolean;
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
  amountCents: number;
  currency: string;
  note?: string;
  settledAt: string;
  coversExpenseIds: string[];  // never a bare number with no provenance (concept §26)
}
```

`Balance` is a **cache**. `GET /v1/people/:id/balance` must be able to recompute from the
underlying expenses and must always be able to list them. No unexplained number.

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
| 1 | Today / date range for a user | `Query GSI1` `gsi1pk = U#<u>#S` and `gsi1sk BETWEEN <from>T00:00 AND <to>T23:59` |
| 2 | Unscheduled ("Anytime") items | `Query GSI1` `gsi1pk = U#<u>#N` |
| 3 | Active recurring series for a user | `Query GSI1` `gsi1pk = U#<u>#R` |
| 4 | Full plan detail (activity + participants + expenses + updates + attachments) | `Query` `pk = ACT#<a>` |
| 5 | Occurrence overrides for a series in a window | `Query` `pk = ACT#<a>`, `sk BETWEEN OCC#<from> AND OCC#<to>` |
| 6 | User profile | `GetItem` `USER#<u>` / `PROFILE` |
| 7 | All lists for a user | `Query` `pk = USER#<u>`, `sk begins_with LIST#` |
| 8 | Items in a list | `Query` `pk = LIST#<l>`, `sk begins_with ITEM#` |
| 9 | All people for a user | `Query` `pk = USER#<u>`, `sk begins_with PERSON#` |
| 10 | Activities shared with one person, newest first | `Query` `pk = USER#<u>`, `sk begins_with PLINK#<p>#`, `ScanIndexForward=false` |
| 11 | All balances for a user | `Query` `pk = USER#<u>`, `sk begins_with BAL#` (one row per person × currency) |
| 12 | Settlement history with a person | `Query` `pk = USER#<u>`, `sk begins_with SETTLE#<p>#` |
| 13 | Resolve an invite token (public, unauthenticated) | `GetItem` `INVITE#<t>` / `META` |
| 14 | Find user by email | `GetItem` `EMAIL#<e>` / `USER` |
| 14b | Find every guest record for a verified email (account linking) | `Query` `pk = GUESTEMAIL#<e>` |
| 15 | Push devices for a user | `Query` `pk = USER#<u>`, `sk begins_with DEVICE#` |
| 16 | Child / prep tasks of a plan | `Query GSI1` filtered by `parentActivityId`, **or** `Query pk = ACT#<parent>, sk begins_with SUB#`. Use the latter. |

No `Scan` anywhere in application code. A `Scan` in a PR is an automatic rejection outside
of one-off migration scripts under `infra/scripts/`.

---

## 6. Recurrence expansion algorithm

This is the trickiest piece of logic in the product. It lives in exactly one place:
`packages/shared/src/recurrence/expand.ts`, is pure, and is unit-tested hard.

```
expandAgenda(userId, fromDate, toDate, tz):
  1. scheduled  = Query GSI1 U#<u>#S BETWEEN from..to        // one-off + already-dated
  2. series     = Query GSI1 U#<u>#R                          // all active recurring
  3. for each s in series:
       dates = expandRecurrence(s.recurrence, from, to, tz)   // pure function, no I/O
  4. overrides = BatchGetItem OCC#<date> for every (series, date) pair produced in 3
  5. for each (series, date):
       if override.status == 'skipped'   -> emit as SKIPPED (hidden by default)
       if override.status == 'completed' -> emit as COMPLETED
       if override.status == 'snoozed'   -> emit at override.snoozedUntil
       else                               -> emit at series time
  6. merge 1 + 5, sort by effective local time, partition into
       UP NEXT / SCHEDULE / ANYTIME / EARLIER TODAY
```

Constraints:

- Window is capped at **62 days**. Reject wider requests with `400`.
- If step 4 would exceed 100 keys, batch it; if a user has > 200 active series, return a
  `series_limit_exceeded` warning in the response rather than timing out.
- `after_completion` mode (Phase 8+): next occurrence = last completion date + interval.
  If never completed, use `startDate`. It produces **at most one** future occurrence — do
  not project a series into the future for completion-relative recurrence.
- DST: expand in the activity's stored `timezone` using `Temporal`-style date arithmetic
  (`date-fns-tz`). A 6 PM daily task stays 6 PM local across a DST boundary.

---

## 7. Write paths that touch multiple items

Use `TransactWriteItems` for these. They are the only places transactions are required.

| Operation | Items written |
| --- | --- |
| Create activity | `ACT#/META`, `USER#<owner>/IDX#` |
| Schedule / reschedule | `ACT#/META`, `USER#<u>/IDX#` for owner **and every participating user** (GSI1 sort key changes) |
| Add participant (app user) | `ACT#/PART#`, `USER#<invitee>/IDX#`, `USER#<owner>/PLINK#`, `USER#<invitee>/PLINK#`, counter update on `ACT#/META` |
| Add participant (guest) | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `INVITE#<token>/META` |
| Schedule a list item | `ACT#/META`, `USER#/IDX#`, `LIST#/ITEM#` (set `linkedActivityId`) |
| Add expense | `ACT#/EXP#`, `ACT#/META` (total), then **async** balance recalc via stream |
| Complete an occurrence | `ACT#/OCC#<date>` only. Never the series. |
| Delete activity | `ACT#` partition items + every `USER#/IDX#` + `PLINK#` + clear `listItem.linkedActivityId` |

Participant fan-out is bounded: **cap participants at 50 per activity** in v1 so a
transaction never exceeds DynamoDB's 100-item limit. Enforce it in validation.

---

## 8. IDs

- Prefixed ULIDs: `act_`, `usr_`, `lst_`, `itm_`, `psn_`, `exp_`, `stl_`, `dev_`, `att_`,
  `upd_`. Generated with `ulid` — sortable by creation time, no coordination needed.
- Invite tokens are **not** ULIDs (they'd leak creation order and be guessable). Use
  `crypto.randomBytes(16)` base62-encoded.
- Never expose raw DynamoDB `pk`/`sk` over the API. The API speaks in IDs.

---

## 9. Migration policy

`schemaVersion` on every item. Migrations are lazy: the repository layer upgrades an item
in memory on read and writes the upgraded shape on next write. Batch backfill scripts live
in `infra/scripts/migrations/` and are one-off, reviewed, and idempotent.

There is no shared production data yet. Until Phase 4 ships to TestFlight, a breaking
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
- Sub-lists, list templates, tags, labels, projects, priorities, custom fields.
- A category-management system. `type` is a closed enum plus `custom`. That is the point.
