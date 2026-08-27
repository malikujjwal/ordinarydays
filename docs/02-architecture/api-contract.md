# API contract

**Status:** canonical. The client never calls an endpoint that is not here. If you need
one, add it here first.

---

## 1. Shape

- REST over HTTPS, JSON only, `Content-Type: application/json; charset=utf-8`.
- Base URL: `https://api.ordinarydays.app` (prod), `https://api.dev.ordinarydays.app` (dev).
- Every route is prefixed `/v1`. Public, unauthenticated routes are prefixed
  `/public/v1` and are the **only** routes reachable without a bearer token.
- One Lambda function serves all routes via a [Hono](https://hono.dev) router. Route
  handlers live in `services/api/src/routes/`, one file per resource.

### Auth

```
Authorization: Bearer <Cognito ID token>
```

Verified with `aws-jwt-verify` (cached JWKS, verified in a module-scope singleton so it
survives warm invocations). Rejections return `401` with `code: "unauthenticated"`.

### Standard headers

| Header | Direction | Purpose |
| --- | --- | --- |
| `X-Request-Id` | both | Correlation. Echoed in every log line and error body. |
| `Idempotency-Key` | request | Required on **every mutating `POST`**. UUID from the client, allocated once when the logical mutation is enqueued and reused by every transport retry, offline resume or process-death replay. Read-only `POST`s, if one is ever introduced, must be explicitly registered as non-mutating rather than silently opting out. |
| `X-Client-Timezone` | request | IANA tz. Used when the body omits one. |
| `X-Client-Version` | request | `ios/1.4.0` or `web/1.4.0`. Enables server-side kill switches. |

### Envelope

Success (`200`/`201`):

```json
{ "data": { }, "meta": { "requestId": "req_..." } }
```

Lists:

```json
{ "data": [ ], "meta": { "requestId": "req_...", "nextCursor": "eyJwayI6..." } }
```

Error (`4xx`/`5xx`):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Human-readable, safe to show the user.",
    "details": [{ "path": "schedule.time", "message": "Expected HH:mm" }],
    "requestId": "req_..."
  }
}
```

> **`DELETE` answers `200` with the envelope, never `204`** (recorded in P1-08, the first
> `DELETE` built). A `204` has no body, so it cannot carry the `{ data, meta }` this section
> requires of every endpoint, and a client that must read `meta.requestId` off a failed
> deletion would have to special-case the one status that never provides it. `data` names
> what was removed — `{ deviceId }`, `{ activityId }` — which makes the response
> self-describing in a log rather than an empty success that could have been about anything.

Error codes are a closed enum in `packages/shared/src/errors.ts`:
`unauthenticated`, `forbidden`, `not_found`, `validation_failed`, `payload_too_large`,
`conflict`, `rate_limited`, `series_limit_exceeded`, `participant_limit_exceeded`,
`reminder_limit_exceeded`, `invite_expired`, `invite_revoked`, `not_implemented`,
`upgrade_required`, `internal`.

> **Amended in P0-13.** `payload_too_large` (413) was added because `tech-stack.md` §4.2
> requires `bodyLimit` to reject an oversized body with 413 and no code mapped to it.
> `not_implemented` (501) and `upgrade_required` (426) were already in `tech-stack.md` §4.4
> but missing from this sentence.

Any endpoint may return `503 internal` with `Retry-After` when storage pressure remains after
bounded retries or when a bounded repair/migration drain has not yet cleared a read/write gate.
The response still uses the standard safe error envelope and never exposes the underlying
table, key or provider message.

### Pagination

Cursor-based only. `?limit=` (default 50, max 200) and `?cursor=` (opaque base64 of the
DynamoDB `LastEvaluatedKey`). Never offset pagination.

### Validation

Zod schemas in `packages/shared/src/schemas/`. **The same schema object is imported by
both the Lambda and the client** — that is the whole reason for the shared package. The
Lambda validates on the way in; the client validates on the way out and gets types for
free.

### Idempotency

Every mutating `POST` writes an `IDEM#<userId>#<key>` item with a 24 h TTL holding the
successful response's **status and body**. For a single-transaction operation, the receipt and
domain mutation are members of the same `TransactWriteItems`: repositories accept the
conditional receipt put as an extra item, and transaction builders reserve capacity for it.
There is no separate durable `in-flight` reservation that can survive a crash after the domain
write.

A multi-phase operation writes its main domain state, receipt, and an
`ACT#<activityId>/CLEANUP#<userId>#<key>` work item in the **same main transaction**. The work item
records the remaining phases and their progress; the receipt points to it. The response is
committed after that main transaction and does not wait for cleanup as a client-visible part
of success. Cleanup is nevertheless attempted inline immediately, drained before a replay
returns the stored response, and drained opportunistically before the next mutation touching
the same Activity. Each phase is idempotent and deletes the work item only when all phases are
complete. Unschedule reminder deletion, reminder-offset normalisation that exceeds transaction
capacity, and the >45-participant RSVP reset use this shape. A crash can delay cleanup but
cannot strand unrecorded work.

A repeat with the same key returns the stored status and body unchanged — `201` remains `201`;
no replay path hard-codes `200`. When the receipt references outstanding cleanup, the replay
path drains it before returning that stored response; it is not an unconditional middleware
short-circuit. Concurrent first attempts race on the conditional idempotency put; the loser
uses a strongly consistent read with bounded retry to return the winner's committed record
instead of executing a second domain write. A failed domain transaction
stores no successful response. P2-38 hardens the
Phase 1 middleware and existing creating routes to this rule before Phase 2 adds further
mutating `POST`s. Required because mobile networks retry and persisted mutations survive
process death.

---

## 2. Endpoints

### 2.0 Web auth token exchange (public)

The iOS client holds tokens in `expo-secure-store` and talks to Cognito directly. The web
client must not put a refresh token in `localStorage`, so it exchanges through the API and
receives an `HttpOnly; Secure; SameSite=Lax` refresh cookie scoped to the API domain. See
`auth.md` for the full rationale.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/public/v1/auth/token` | `{ code, codeVerifier, redirectUri }` → exchanges the Cognito PKCE authorization code. Returns `{ idToken, accessToken, expiresIn }` in the body and sets the refresh cookie. |
| `POST` | `/public/v1/auth/refresh` | Reads the refresh cookie, returns a fresh `{ idToken, accessToken, expiresIn }`. Rotates the cookie. |
| `POST` | `/public/v1/auth/logout` | Revokes the refresh token at Cognito and clears the cookie. |

Rate limits: 10 req/min per IP on all three, and additionally 60/hour per IP on
`/refresh`. These routes are the only `/public/v1` routes that set cookies.

### 2.1 Me

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/me` | Profile, preferences, timezone, currency, onboarding state |
| `PATCH` | `/v1/me` | `displayName`, `timezone`, `currency`, `weekStartsOn`, `defaultReminderOffset` (integer `[-10080, 0]`, including `0` for At the time; `null` clears to Off), `defaultLists` (a nested per-slot patch: each supplied value is `listId | null`; omission preserves that slot and `null` removes only that key — see [`data-model.md`](data-model.md#default-slots)) |
| `POST` | `/v1/me/devices` | Register an Expo push token. Body: `{ expoPushToken, platform, deviceName }` — `deviceName` optional; a simulator reports none. Returns `201` with the stored `Device` **including the server-minted `deviceId`**, which is the only way the client learns the id it must later delete. The body carries no id: rotation is delete-then-create, not an upsert (P5-16), so a `deviceId` in the request is `400`. Creating, so an `Idempotency-Key` is required. `platform` is `ios` in v1 ([`data-model.md`](data-model.md#40a-device) §4.0a) |
| `PUT` | `/v1/me/devices/:deviceId/reminder-ack` | Phase 5 (P5-16 second amendment). Body: `{ reminderStateVersion, scheduledThrough }` — the device's claim, made only after **verified** local arming, that it has scheduled every reminder up to `scheduledThrough` at reminder-state version `reminderStateVersion`. Absolute desired state, idempotent, so no `Idempotency-Key`. The reminder Lambda reads it to suppress visible pushes for locally-armed reminders. `404` when the device row is gone — the client re-registers before re-acking |
| `DELETE` | `/v1/me/devices/:deviceId` | Unregister one device, so push stops immediately. Called on sign-out **before** tokens are cleared, and on token rotation ([`auth.md`](auth.md) §3.4 step 2). Returns `200` with `{ deviceId }`. `404` when this user has no such device — whether the id was never theirs or the row is already gone; a retried sign-out `DELETE` lands there, and for that caller `404` means "already gone" |
| `DELETE` | `/v1/me` | Account deletion. Soft-deletes, purges after 30 days. The confirmation discloses that shared-plan financial history survives the purge: Expenses and Settlement audit rows on shared plans with surviving participants are retained with the display name replaced by `Deleted user`, balances involving the account become read-only history, and owned shared plans are cancelled with notification first (`data-model.md` §7, decision 2026-08-07). Whole-Settlement Undo applies only to financial rows nothing retains; the purge checkpoints this cleanup so no retained Expense points to missing Settlement history. Required by App Store. |
| `GET` | `/v1/me/export` | Data export. The export object remains available for 24 hours; each request returns a fresh short-lived presigned link to a JSON file of the user's activities, lists and settings. A literally 24-hour link is unachievable with Lambda role credentials — see phase-05 P5-24. Phase 5. |
| `GET` | `/v1/me/suggestions?kind=meal` | Derived suggestions — the FAVOURITES group on the Add screen. Computed from completed activities, cached one hour. Never a stored flag. Phase 9. |

### 2.1a Health

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/health` | Unauthenticated by exception in `routeSplit`. Returns `200` with the deployed git SHA. Used by smoke tests and the hello-world client. |

### 2.2 Agenda — powers Today and Plans

```
GET /v1/agenda?from=2026-08-06&to=2026-08-06&tz=America/New_York
```

The single most important endpoint. Returns everything for a date window, with recurring
series already expanded and occurrence overrides applied (see
`data-model.md` §6).

```json
{
  "data": {
    "days": [
      {
        "date": "2026-08-06",
        "upNext": { "activityId": "act_…", "…": "…" },
        "schedule": [ { "…": "timed items, ascending" } ],
        "anytime":  [ { "…": "dated but untimed items" } ],
        "earlier":  [ { "…": "timed items already past, this date only" } ]
      }
    ],
    "warnings": [],
    "projectionVersions": [
      { "activityId": "act_…", "version": "2026-08-14T18:00:00.000Z" }
    ]
  }
}
```

Each entry is an **AgendaItem**, a trimmed projection — not the full Activity:

```ts
interface AgendaItem {
  activityId: string;
  occurrenceDate?: string;    // present iff this came from a recurring series
  parentActivityId?: string;  // present iff the source Activity is a prep task
  type: ActivityType;
  title: string;
  status: ActivityStatus | 'completed_occurrence' | 'skipped_occurrence';
  time?: string;              // HH:mm effective time (after snooze override)
  endTime?: string;
  isRecurring: boolean;
  recurrenceDescription?: string; // server-authored; present when isRecurring
  isSnoozed: boolean;
  originalTime?: string;      // HH:mm before snooze; present only when the time changed
  hasCheckbox: boolean;       // true iff type === 'task'
  capabilities: {
    complete: boolean;
    skip: boolean;
    snooze: boolean;
  };                          // server-derived for this caller; client never re-derives authz
  participantAvatars: { personId: string; displayName: string; avatarUrl?: string }[];
  participantCount: number;
  locationLabel?: string;
  subtitle?: string;          // "Meal · Chicken tacos", "S2 E4", "Zahav"
  isPast: boolean;
  reminders?: Reminder[];     // present only with include=reminders; caller's rows only
}
```

The server computes all three `capabilities` booleans at projection time by applying the
existing authorisation policies to the authenticated caller and projected activity. They
are part of the one agenda response; clients consume them and never reconstruct ownership,
parent-participant access or any other authorisation rule. For a prep task, the hydrated
context includes the parent Plan's `ownerId`: the child owner, parent owner or parent
participant may act. This preserves inherited parent-owner access when somebody else created
the child.

`projectionVersions` contains an Activity only when the GSI row selected for this read has
the same stamped `updatedAt` as the canonical META row hydrated for it. A missing or older
entry is a stale agenda body and may not replace protected rows for an acknowledged
recurrence edit. Ordinary refresh still installs fresh rows for every unaffected Activity.

Recurrence-PATCH reconciliation does not wait for GSI convergence. It uses:

```
GET /v1/agenda/activities/:id?from=2026-08-06&to=2026-08-06&tz=America/New_York
```

This authenticated, `private, no-store` read queries the target `ACT#<id>` base-table
partition with strong consistency, authorises from its META/participant rows, applies stored
`OCC#` and `MOVE#` history, and expands only that Activity for the requested window. It
returns `{ activityId, activityVersion, rows: [{ date, item }] }`. `rows: []` is an
authoritative projection that removes the Activity from that window; a timeout or network
failure proves nothing and leaves the protected rows intact. Once `activityVersion` is at
least the PATCH-acknowledged version, the client atomically replaces only that Activity in
each cached window and clears its durable reconciliation state. Manual agenda refresh retries
this targeted read while protection is active.

The server also authors the row's recurrence and snooze presentation. For a recurring item,
`recurrenceDescription` is computed with `describeRecurrence` against the request window's
`from` date in the requested `tz`, never the server wall-clock, so the same window has stable
presentation and a deterministic ETag. When a snooze changes the displayed time,
`originalTime` is the viewer-timezone projection of the schedule time or recurrence segment
in force for that occurrence. Clients render both fields verbatim and do not derive them
for a server-known Activity. The sole pre-acknowledgement exception is a client-created
pending series: it may use the same shared `describeRecurrence` function against the cached
window's `from` date while locally expanding the user-supplied create input. The `201` and
then the version-proven agenda response replace that provisional presentation.

For a prep task, `parentActivityId` is copied from the source Activity so the client can
select the prep-task gesture set and open the parent Plan. It is absent on every other row.
It is not an authorisation input: the client consumes only `capabilities` for that purpose.

Additional `AgendaItem` field:

```ts
  overdueFromDate?: string;   // YYYY-MM-DD — set when this item rolled forward from a
                              // past date. The stored activity is NOT mutated.
```

Query parameters:

| Param | Effect |
| --- | --- |
| `include=anytime_unscheduled` | Merges the undated Anytime bucket into the first day. Today uses this; a multi-day Plans view does not. |
| `include=overdue` | Rolls incomplete, non-recurring **tasks** with a date in the past forward onto the first day, each carrying `overdueFromDate`. A rolled task completed on that viewer-local day remains in the projection as completed so Today progress stays coherent. Capped at 30 days back. Never applies to recurring occurrences or non-task types. See `../01-product/today-and-tasks.md` §7. |
| `include=reminders` | Attaches the authenticated caller's own `REM#<userId>#` rows to the AgendaItems emitted for the requested window. Never returns another user's row. Reserved for the local notification scheduler's independent eight-day background request; the Today screen does not request it. |

Tokens may be combined. Today requests `from=today&to=today` with
`?include=anytime_unscheduled,overdue` in exactly one screen-owned request. The notification
scheduler does not derive from that response: on its independent cadence it issues one
`from=today&to=today+7d&include=reminders` request, covering the seven-day maximum reminder
offset without being triggered or awaited by Today.

> **Today request ruling — 2026-08-11.** The former `to=tomorrow` and
> `include=reminders` Today variant was pre-amendment residue. Product behaviour is the
> one-day, two-token request above. `include=reminders` remains part of the endpoint contract
> solely for P2-34's separately-cadenced scheduler request.
- Window capped at 62 days → `400 validation_failed`.
- Response is cacheable client-side for 60 s; server sends `ETag`, computed from a canonical
  serialisation of `data` only. Volatile envelope metadata such as `meta.requestId` is excluded,
  so identical agendas produce the same ETag and the second conditional request returns `304`.

Agenda **never** returns activities in the `#P` (Needs a date) bucket. An undecided group
plan is not a thing you have to do today.

Agenda warnings are successful-response diagnostics, not error codes:

- `series_limit_exceeded` means only the first `MAX_ACTIVE_SERIES` `#R` rows were expanded;
  `#S` and `#N` are never capped and are paged to exhaustion.
- `duplicate_occurrence:<activityId>` means two assembled candidates had the same
  `(activityId, occurrenceDate?)`; the deterministic first candidate was retained and the
  duplicate was dropped. This is a storage/merge invariant warning and clients must not try
  to reconcile the rows themselves.

### 2.2a Plans

```
GET /v1/plans?mode=initial
GET /v1/plans?mode=upcoming_window&upcomingFrom=YYYY-MM-DD&upcomingTo=YYYY-MM-DD
GET /v1/plans?mode=past_window&pastFrom=YYYY-MM-DD&pastBefore=YYYY-MM-DD&cursor=...
GET /v1/plans?mode=past_cursor&cursor=...
```

Powers the Plans tab, which has three stages:

```json
{
  "data": {
    "mode": "initial",
    "needsDate": [ { "…": "AgendaItem + rsvpSummary + suggestionCount, most recently discussed first" } ],
    "upcoming":  [ { "date": "2026-08-15", "items": [ ] } ],
    "past":      [ { "…": "newest first, paginated" } ],
    "upcomingWindow": {
      "from": "2026-08-15",
      "through": "2026-10-15",
      "nextFrom": "2026-10-16"
    },
    "pastPage": { "nextCursor": "…" },
    "warnings": []
  }
}
```

The query and response are a discriminated union. Inactive stages are absent, not empty
arrays, so a continuation response cannot overwrite a different stage in the client:

| Mode | Query streams | Response members |
| --- | --- | --- |
| `initial` | `#P`, future `#S`, past `#S`, `#R` | `needsDate`, `upcoming`, `upcomingWindow`, `past`, `pastPage`, `warnings` |
| `upcoming_window` | future `#S`, `#R` | `upcoming`, `upcomingWindow`, `warnings` |
| `past_window` | bounded past `#S` | `past`, `pastCoverage`, `warnings` |
| `past_cursor` | past `#S` | `past`, `pastPage`, `warnings` |

| Stage | Source | Order |
| --- | --- | --- |
| `needsDate` | `GSI1` `gsi1pk = U#<u>#P` | `lastActivityAt` descending — the plan being discussed floats up, not the oldest |
| `upcoming` | `GSI1` `gsi1pk = U#<u>#S`, queried with the access-pattern-1 two-day overlap, timezone-converted and filtered to the exact requested viewer window, merged with expansion of `U#<u>#R` | viewer-local date ascending |
| `past` | the same dated-Activity bucket with a two-day overlap above the viewer-local today boundary, timezone-converted and filtered to dates before today; `past_window` additionally filters to the exact `[pastFrom, pastBefore)` viewer-local range | viewer-local date descending |

`mode=initial` uses today through 61 days later for its inclusive 62-day Upcoming window.
`mode=upcoming_window` requires both Upcoming bounds, and the inclusive window may not exceed
`MAX_AGENDA_DAYS` (62); a wider or reversed range is `validation_failed`.
`upcomingWindow.nextFrom` is `WallDate | null`: the earliest scheduled
or recurring Activity date after `through`, so it may jump an empty gap without skipping a
row; it is `null` only when neither source has a later item. An Upcoming scroll requests a new 62-day
window beginning there in `upcoming_window` mode. Only `initial` starts all four concurrent
Query streams. Continuations launch only the streams in the table above. Both `#S` reads obey access
pattern 1 by widening stored-key bounds two calendar days. Scheduled and recurring Tasks
share `#S` and `#R` with Plans and remain in those streams: hydrate every candidate and pass
every bounded recurring row to the shared expansion path. Convert effective
timed rows from their projected stored `timezone` into the request timezone, then filter to
the exact viewer-local stage/window. The future stream continues until it has a converted
one-off candidate after `through` or is exhausted; `nextFrom` uses that converted date, never
the raw key date. The opaque Past cursor remains backed by a raw DynamoDB continuation key, but the server
refills across boundary candidates removed by viewer-local filtering. Recurrence math finds
each bounded series' first later occurrence, so no empty date gap is scanned to calculate
`nextFrom`. The shared agenda expansion path expands recurring rows only inside the exact
response window. Its
successful-response warnings, including `series_limit_exceeded` and duplicate-occurrence
diagnostics, are returned in `warnings`. No request assumes an unbounded future response.

`mode=past_window` requires both `pastFrom` and exclusive `pastBefore`; its optional cursor
must have been issued for the same mode and bounds. The response carries:

```ts
pastCoverage: {
  requestedFrom: WallDate;
  requestedThrough: WallDate;
  coveredFrom: WallDate;
  coveredThrough: WallDate;
  complete: boolean;
  nextCursor?: string;
}
```

Coverage describes the viewer-local date interval actually exhausted by the bounded query,
not merely dates that returned rows. A dense 42-day grid may therefore return `complete:
false`; the client repeats `past_window` with the same bounds and `nextCursor` until the grid
is complete. Only then may the calendar interpret an unmarked date as loaded-and-empty.
`past_cursor` is the ordinary older-history continuation and accepts only a cursor issued by
`initial` or `past_cursor`. Supplying fields from another mode is `validation_failed` rather
than silently launching unrelated streams.

The calendar navigator (`plans-and-lists.md` §1.3) is the intended caller on both sides. It
requests the **visible grid range** rather than the nominal month — a month grid can show up
to 42 days once adjacent-month cells are included — which stays comfortably inside
`MAX_AGENDA_DAYS`. It selects the window; it never becomes a second pagination model.

`warnings` is `Array<AgendaWarning | 'needs_date_limit_exceeded'>`. The additional value
means the response contains the first 200 Needs-a-date rows; it is a diagnostic, never a
badge input.

`needsDate` items carry an `rsvpSummary` so the row can render
`Alice interested · Ben hasn't replied` without a second call. Counts alone are not enough
for that string, so each group carries the first two display names as well:

```ts
interface RsvpSummary {
  interested: { count: number; names: string[] };   // names: first 2; count supplies remainder
  maybe:      { count: number; names: string[] };
  pass:       { count: number; names: string[] };
  pending:    { count: number; names: string[] };
}
```

`needsDate` items also carry authoritative/projection `lastActivityAt` for monotonic client
reconciliation and `suggestionCount: number`, which drives the row's third line
(`2 dates suggested`). The suggestions themselves are not inlined — the row shows a count,
the detail screen shows the list.

After a mutation returns a newer authoritative `lastActivityAt`, the client must not replace
it with an older value from an immediate eventually consistent GSI1 refetch. It merges the
field monotonically and lets a later converged response confirm the same ordering.

The group keys are the **undated** labels because this field only ever appears on
needs-a-date rows. They map to the stored values in
[`data-model.md` §7.1](data-model.md#71-rsvp-consent-does-not-survive-a-date-change) and
introduce no new enum member.

**Needs a date never nudges.** No badge, no stage count on the tab, no reminder. Nested RSVP
group counts and `suggestionCount` describe one row; they are never stage totals or badge
inputs. It is a place to look, not a backlog to clear — the same reason Today is not allowed
to become a guilt list.

Also:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities?filter=upcoming\|past\|saved\|needs_date&type=&cursor=&limit=` | Flat, paginated lists. Not for Today. Each filter reads **one** GSI1 bucket, so a page is one Query and one cursor. Nothing is expanded: a recurring series is one row carrying `isRecurring`, never one row per occurrence. `filter` is required and has no default. `type` narrows the page **after** the Query, so a page may be shorter than `limit` — even empty — while `nextCursor` is still set; clients page until the cursor is absent, not until a page is short. `upcoming` and `past` split at the caller's current date, taken from `X-Client-Timezone` and falling back to UTC. |

| Filter | Bucket | Order | Serves |
| --- | --- | --- | --- |
| `upcoming` | `#S`, today forward | date ascending | Plans → Upcoming |
| `past` | `#S`, before today | date descending | Plans → Past |
| `needs_date` | `#P` | `lastActivityAt` descending | Plans → Needs a date |
| `saved` | `#N` | newest first | Today's ANYTIME `See all` |

> **Amended in P1-16 — `inbox` removed, `saved` split from `needs_date`.** The enum read
> `inbox|upcoming|past|saved`, and two of those could not be built as written.
>
> **`inbox` had no definition anywhere.** No product surface, no GSI1 bucket, no access
> pattern in [`data-model.md`](data-model.md#5-access-patterns) §5 — and
> [`../01-product/overview.md`](../01-product/overview.md) §"Why it must stay three" names
> Inbox among the fourth nouns the product deliberately does not have. A member of a closed
> enum that no handler can implement is a value every client must handle and will never see.
>
> **`saved` was aimed at two buckets by two product docs.**
> [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §2.3 points the
> ANYTIME `See all` footer at it (`#N`, undated **tasks**), while
> [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5 routes an undated
> Meal Plan to it (`#P`, undated **plans**). Those are separate partitions: one filter cannot
> page across both without a composite cursor no document defines, and merging them would put
> undecided plans on the ANYTIME screen — which `today-and-tasks.md` calls "the model's
> largest product error" two paragraphs above the line citing the filter. `saved` keeps the
> `#N` meaning; `needs_date` names the stage that already had its own name, access pattern
> (2b) and empty-state copy. §2.2a's stage table is unchanged and now matches this one.

### 2.3 Activities

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/activities` | Create a **Task or Plan chosen by the client**. Body = `CreateActivityInput`; both `objectKind` and `type` are required. When `recurrence` is present it contains **exactly one** segment; more is `validation_failed`. Stored recurrence still supports 1–20 segments, which grow only through the all-future PATCH path. Requires `Idempotency-Key`. |
| `GET` | `/v1/activities/:id` | Full detail: activity + optional authoritative `occurrence` projection + caller-specific `capabilities` + first bounded page of participants, expenses, updates, attachments, children and related Lists + **the caller's own reminders** + date suggestions. A strongly consistent `GetItem ACT#<id>/META` establishes authoritative `404` and owner authority; bounded strongly consistent sort-key-prefix Queries then assemble the named sections. Updates are newest-first with `Limit: 50` and a cursor. Prep children are capped by `MAX_PREP_TASKS_PER_PLAN = 50`, so one `SUB#` Query with `Limit: 50` is their complete collection and supplies exact done/open counts; creating a 51st child is `validation_failed`. Every other collection observes its documented cap/page limit. The service never `queryAll`s the user-growing Activity partition. `SOURCE_LIST#` ids are hydrated with one bounded `BatchGetItem` for current List META rows, never one read per List. Parent-inherited access may strongly read the parent META separately. `?occurrenceDate=YYYY-MM-DD` explicitly targets one nominal recurring occurrence and returns its effective date, time, end time, status and snooze state after the stored override; without it the read is activity/series-only and never guesses an occurrence from agenda cache. A date the recurrence does not emit is `400 validation_failed`. Response shape is `ActivityDetail` (`packages/shared/src/types/activityDetail.ts`), an object of named paged collections so each one is **added** as its phase lands rather than changing the envelope. Phase 2 adds `completedOccurrenceCount`, the real count of stored completed Occurrence rows used by recurrence-removal and whole-series-delete confirmations. `capabilities` uses the same server-authored `{ complete, skip, snooze }` verdict as `AgendaItem`, including prep-task inheritance, so detail never re-derives ownership. Detail remains within the three-round-trip budget by running bounded independent reads concurrently; reminder reads use only the caller prefix. Stored `listId` / `listItemId` are included only when the caller also passes `assertListAccess`; a Plan participant outside the list receives no reverse link. |
| `PATCH` | `/v1/activities/:id` | Partial update, including the explicit Task↔Plan conversion described below. **Does not accept `schedule` or unschedule fields**; `POST .../schedule` is the single scheduling write path. A recurrence edit may additionally carry `editedFromDate?: WallDate`. When supplied, it must be a date emitted by the current stored active rule and becomes the server-written `effectiveFrom` of the one appended segment; when absent, the server uses today in the Activity's timezone. Any `effectiveFrom` values inside client-supplied segments are ignored. One founder-approved exception allows a changed last segment with the same length when that active segment starts today: the server replaces it only if the transaction proves `OCC#<today>` does not exist; otherwise history remains append-only and the request is `validation_failed`. **`recurrence: null` is always `validation_failed` on PATCH**: removing a series requires the explicit occurrence target and surviving effective schedule of `POST .../recurrence/convert`; a non-recurring no-op is not a second removal contract. **Adding a recurrence to a `completed` or `skipped` activity is rejected** with `validation_failed` on `status` (added 2026-08-13, ADR-053). A recurring activity never holds a terminal series status: `POST .../complete` and `.../skip` refuse to set one, and this is the other way in — completing a one-off and then making it repeat left `status: 'completed'` on a row that had become a series, which `agendaService` then rendered onto every un-overridden occurrence. `cancelled` is exempt; a cancelled series is legitimate and its occurrences inherit it. The guard is on the transition, not on later edits of an existing series. **A `details` replacement retains each ingredient's server-owned `addedToListId`, matched by `ingredientId`** (P3-17, corrected in review). The field is rejected on input — a client able to author it could fabricate the `Added` state for any well-formed `lst_` — so the server is the only thing that can preserve it, and without that an ordinary rename, quantity fix or reorder silently cleared every marker on the meal. An id new to the patch is a new row with nothing to inherit; a removed row takes its marker with it. Optimistic concurrency via `If-Match: <updatedAt>`; mismatch → `409 conflict`. |
| `POST` | `/v1/activities/:id/recurrence/convert` | Atomic **Does not repeat** conversion. Body = `{ occurrenceDate }`, naming one nominal occurrence emitted by the current series. Requires `Idempotency-Key`. The server resolves that occurrence through its active segment and stored override, condition-checks the META and occurrence version/absence it read, copies the effective date/time/end time to the Activity schedule while retaining its timezone, removes `recurrence`, and rewrites every required ActivityIndex row in the same transaction. Stored Occurrence history is untouched. |
| `DELETE` | `/v1/activities/:id` | Owner only. Returns `409 settlement_conflict` with every distinct blocking Settlement id when any child Expense has a settled obligation; the user must explicitly Undo those Settlements first. Otherwise cascades per `data-model.md` §7, clears `sourceActivityId` on Lists named by `SOURCE_LIST#` without deleting them, and deletes every child Expense locator with its row. The cascade deletes children and external pointers first and `ACT#/META` **last**, so an interrupted retry can still authorise; after META is gone, a replayed `404` is success for the client. **The settlement guard and the Expense-locator half of the cascade arrive in Phase 7 (P7-08), not Phase 1 (P1-14)** — see the note below. |
| `POST` | `/v1/activities/:id/schedule` | The **single schedule write path**: `{ date, time?, endTime?, timezone, occurrenceDate? }`; unschedule is `{ date: null }`. Requires `Idempotency-Key`. Changing the date resets every non-declined participant's RSVP to `pending` and re-notifies; a time-only change does not. The response includes `rsvpReset: true` only when it happened. A timed → date-only transition retains reminders, coerces sub-day offsets to the nearest whole-day multiple (half-day ties choose the earlier reminder), and returns `reminderOffsetsNormalized: true` whether or not a row changed, so no participant's reminder existence is disclosed. Status is server-derived from schedule presence (unless terminal), and `icsSequence` increments once iff an exported schedule field changed. Shared `toUtcInstant` derives UTC values; the spring gap `2026-03-08 02:30 America/New_York` moves forward to `03:00`. With `occurrenceDate`, writes the nominal override and, for a cross-day move, its destination marker in one transaction while leaving META unchanged. |
| `POST` | `/v1/activities/:id/complete` | `{ occurrenceDate?, outcome? }`. Requires `Idempotency-Key`; replay returns the original `2xx`. Returns `ActivityCompletionResult { activity, occurrenceDate?, occurrence?, outcome?, followUp? }`. With `occurrenceDate` → writes an Occurrence, never touches the series. Plan completion is global and owner-only; ADR-051 allows the prep-task owner, parent-plan owner or a parent-plan participant to complete a prep task. Without `occurrenceDate`, META and every denormalised ActivityIndex status change in one transaction — **and a recurring activity rejects the unscoped form with `validation_failed` on `occurrenceDate`** (added 2026-08-13). Completing a series set `status: 'completed'` on META, and `agendaService.mergeNominal` renders an occurrence with no override using the series status, so one unscoped write crossed off every future occurrence. `snooze` has always refused this; `complete` and `skip` now match it. **`followUp` is data, not a write** (P3-16, `../01-product/activities.md` §5.3). A non-recurring `watch` completion with a positive outcome may carry one `CompletionFollowUp` describing an update to the caller's linked watch item — `watch_progress` offering the session's season/episode, or `watch_watched` for a movie — with the list id and title, the item id, `mediaKind` and the item's current progress, so the client renders it without a second read. **Each arm pins both halves of its own row**: `watch_progress` takes `mediaKind: 'show'` or none and a target naming a season, an episode, or both — never an empty one, which would render `Update to ?` and confirm as a status-only write; `watch_watched` requires `mediaKind: 'movie'`, because that row exists only because the item says so. A `show` can therefore never be offered the manual-only watched transition, and a movie can never be handed an episode to advance to. It requires the caller's own `ListItemActivityLink` to resolve to **this** Activity, a list still on `behaviour: 'watch'`, and an item with typed watch `details`; any miss, a recurring occurrence, and a negative outcome all omit the field silently. Confirming is an ordinary `PATCH /v1/lists/:id/items/:itemId`; there is no confirm endpoint and dismissal issues no request. |
| `POST` | `/v1/activities/:id/uncomplete` | `{ occurrenceDate? }`. Requires `Idempotency-Key`; replay returns the original `2xx`. Returns the same `ActivityCompletionResult`, omitting completion fields that were reversed. Reverses the above under the same ADR-051 policy and transaction/occurrence split. **Deliberately still accepts the unscoped form on a recurring activity**, unlike `complete` and `skip`: it is the only route back for a series whose META was completed before those two were guarded. **This exception is temporary and closes as a Phase 4 gate item** (ADR-053; `00-open-decisions.md` item 11; the deliverable checklist in `../03-implementation/phase-04-deploy-and-identity.md`), after the local table is verified free of series-`META` completions. A deployed environment starts empty and can never hold a row this recovers, so shipping it would leave a standing rule-3 violation in the public API with no beneficiary. |
| `POST` | `/v1/activities/:id/skip` | `{ occurrenceDate? }`. Requires `Idempotency-Key`; replay returns the original `2xx`. Uses the same ADR-051 policy; without an occurrence, META plus every index status are one transaction. **A recurring activity rejects the unscoped form**, as `complete` does and for the same reason (added 2026-08-13). |
| `POST` | `/v1/activities/:id/snooze` | `{ occurrenceDate?, until }` — `until` is `HH:mm` (same day) or an ISO instant. Requires `Idempotency-Key`. Without `occurrenceDate`, writes one-off META snooze fields; with it, writes a series Occurrence override and, when the effective date changes, its destination marker. |
| `POST` | `/v1/activities/:id/unsnooze` | `{ occurrenceDate? }`. Requires `Idempotency-Key`. Compensating Undo operation: without `occurrenceDate`, deletes one-off META snooze fields; with it, deletes only the snoozed source override and its destination-marker reference and cannot erase completion, skip or reschedule. Idempotent. |
| `POST` | `/v1/activities/:id/duplicate` | |
| `GET` | `/v1/activities/:id/ics` | Single-event `.ics`. Authenticated variant of the public one. |

Whenever a prep task gains, edits or removes recurrence, the same transaction rewrites its
parent `SUB#` projection's `isRecurring`. Completion follow-ups use that stored discriminator
to exclude recurring children; they never infer or invent an `occurrenceDate`.

**`parentActivityId` is subject to the same rules on `PATCH` as on `POST`** (P3-18). Setting
it requires write access to the named parent — a caller with no relationship gets `404`, the
same answer as for an activity that does not exist — and both structural limits are checked
from both ends: the target may not itself be a prep task, and a task that already has prep
tasks of its own may not become one, which is the only way a `PATCH` could assemble the third
level a `POST` refuses. An activity may not be its own parent. **Only a Task may carry
`parentActivityId`**: a `POST` creating a Plan with a parent and a `PATCH` converting an
already-attached prep task into a Plan both answer `validation_failed` with
`Only a task can be a prep task.` and write nothing. The check is on the state the write
produces, because the conversion changes no parent and so is invisible to every check that
fires when the relationship moves. **The parent must be a Plan**: a `parentActivityId` naming
a Task is `validation_failed` with `A prep task belongs to a plan.`

The attach and the Plan → Task conversion each condition on what the other changes, because
`childCount` moves by `ADD` and deliberately does not advance `updatedAt`. The conversion —
legal only at `childCount === 0` — pins the count it validated, and the attach pins the
parent's `objectKind`. Exactly one of a concurrent pair commits; without both, a stale
conversion `Put` would satisfy its `updatedAt` condition and reinstate `childCount: 0` on a
parent that had just gained a child, stranding that child and its `SUB#` pointer on a Task. A plan already holding
`MAX_PREP_TASKS_PER_PLAN` prep tasks refuses the next one — on `POST` and on `PATCH` alike —
with `validation_failed` on `parentActivityId` and the exact message
`Plan has too many prep tasks.`, writing nothing. Setting, clearing or changing the field
moves the parent's pointer and both plans' `childCount` values in the same transaction as the
child, so no plan ever renders a prep-task count it cannot produce the rows behind.

For a non-owner detail read, META alone is not authority: the service strongly reads the exact
`USER#<caller>/IDX#<activityId>` access grant, or the documented parent grant, before
projecting sections. It never scans participants to discover whether the caller is allowed.

For occurrence-scoped schedule/snooze writes, `overrideDate` and the Activity-local date of an
ISO `snoozedUntil` must be within 60 calendar days of `occurrenceDate`; farther moves return
`400 validation_failed`. A cross-day write commits the nominal source override and destination
`MOVE#` marker together. Reschedule Undo calls the same schedule route with the occurrence's
in-force segment date/time; when they match the unmodified occurrence the server deletes the
source override and marker reference. Unsnooze likewise removes both references together.

> **Amended 2026-08-08 — when `settlement_conflict` becomes real.** §1 above enumerates the
> closed `ErrorCode` union and **`settlement_conflict` is not in it**, while this section and
> `data-model.md` §7 both require it. That contradiction predates Phase 1 and is resolved in
> favour of the behaviour: the code is legitimate and is added to
> `packages/shared/src/errors.ts` — and to §1's enumeration — by **P7-08**, the task that
> also writes the first `EXP#` row, the `settlementIdByPersonId` map and the guard on this
> route.
>
> **Phase 1's `DELETE` (P1-14) ships the partition cascade with no settlement guard**, because
> there is no Expense schema, no `EXP#` key builder and no row it could block. Nothing between
> P1-14 and P7-08 writes an Expense, so the window is closed by absence rather than by a check.
> Do not add the code to the union early: a member of a closed union that no handler can return
> is an error clients must handle and will never see.

`CreationTarget` is the contract shared by Global Add, contextual entry points, and capture:

```ts
type PlanType = Exclude<ActivityType, 'task'>;

type CreationTarget =
  | { objectKind: 'task'; type: 'task' }
  | { objectKind: 'plan'; type: PlanType }
  | { objectKind: 'listItem'; listId: string };
```

It is selected by the client or fixed by the entry point **before** a create or capture call.
The server never derives it from title text, list behaviour, participants, a date, or model
output.

`CreateActivityInput`:

```ts
interface ActivityCreateFields {
  title: string;                       // 1..200
  notes?: string;                      // ..4000
  schedule?: { date, time?, endTime?, timezone };
  recurrence?: Recurrence & { segments: [RecurrenceSegment] }; // create is exactly one segment
  reminders?: { offsetMinutes: number }[];
  location?: { label, address?, lat?, lng?, mapUrl? };
  details?: ActivityDetails;           // must match `type`
  parentActivityId?: string;
  attachmentIds?: string[];
  sourceUrl?: string;
}

type ParticipantInput =
  | { personId: string }
  | { displayName: string; email?: string };

type CreateActivityInput = ActivityCreateFields & (
  | { objectKind: 'task'; type: 'task'; participants?: never }
  | { objectKind: 'plan'; type: PlanType; participants?: ParticipantInput[] }
);
```

**There is no title-only Activity request and no server default.** Omitting `objectKind` or
`type` returns `400 validation_failed`. Task requires `type: 'task'` and cannot carry direct
participants. Plan requires one of the four visible Plan kinds — `custom` (General), `meal`,
`watch`, `event` — and may be private or shared. There is no hidden
`objectKind: 'plan', type: 'task'` combination. Dates, participant changes, and type changes
never silently rewrite `objectKind`.

`reminders` requires `schedule.date`; a create carrying reminders without a date is
`400 validation_failed`. On date-only create, every offset is a whole-day multiple. The
unschedule main transaction commits the META/index schedule change, successful receipt and
persisted cleanup work together; the worker then removes reminder rows idempotently in
bounded batches (`data-model.md` §7). The row deletion is not atomic with META/index state,
but the obligation to finish it is durable before the response can be returned.

The entry points map to writes as follows. There is deliberately no generic `/v1/add`
endpoint whose handler guesses what the user meant.

| Entry point | Selected target | Create endpoint |
| --- | --- | --- |
| Global Add → Task | `{ objectKind: 'task', type: 'task' }` | `POST /v1/activities` |
| Global Add → Plan | `{ objectKind: 'plan', type: <the PlanType the user chose> }` | `POST /v1/activities` |
| Global Add → List item | `{ objectKind: 'listItem', listId: <the list the user chose> }` | `POST /v1/lists/:listId/items` |
| Today inline `Add a task` | Task target, fixed by the labelled affordance; date supplied by context | `POST /v1/activities` |
| Plan detail `Add prep task` | Task target, fixed by the labelled affordance; `parentActivityId` supplied by context | `POST /v1/activities` |
| List inline `Add item` | List-item target, fixed by the list path | `POST /v1/lists/:listId/items` |
| List item `Plan this item` | Plan target, with Plan kind and audience explicitly confirmed in the creation sheet | `POST /v1/lists/:listId/items/:itemId/schedule` |

**Client-minted ids — added 2026-08-17 (Phase 2.6, ADR-055).** `POST /v1/activities`
accepts an optional `activityId: act_<ULID>`, and the reminder-create path an optional
`reminderId: rem_<ULID>`, so an offline create can carry the permanent id the client already
projected. The server validates prefix and encoding (`validation_failed` otherwise), derives
ownership from the authenticated principal exactly as before, and writes conditionally —
transactionally checked against the deletion tombstone (`data-model.md` §4, §8). A collision
returns a generic error with no owner or entity metadata; the client's documented recovery
is a `GET` of its own id, never an automatic re-mint. Omitting the field keeps today's
server-minted behaviour byte-identical, and the `Idempotency-Key` requirement is unchanged —
the client id is identity, not replay protection.

`fromListItem`, `listId`, and `itemId` are not accepted by `POST /v1/activities`. Only the
list-scoped scheduling endpoint may establish that relationship, after list access has been
checked.

**Explicit Task↔Plan conversion.** An ordinary patch keeps `objectKind` unchanged. Editing
the title, notes, schedule, recurrence, type, or participants never infers or triggers a
conversion.

- Task → Plan requires one request containing both `objectKind: 'plan'` and a
  **user-selected** `type: PlanType`. The server does not choose the Plan type from the
  Task's text or other fields.
- Plan → Task requires one request containing `{ objectKind: 'task', type: 'task' }` and is
  accepted only when `participantCount === 0`, `expenseTotalCents === 0`, and
  `childCount === 0`.
- If any Plan → Task precondition is non-zero, the server returns `409 conflict`. The error's
  `details` array names every blocking field and its current value, for example
  `participantCount: 2` and `expenseTotalCents: 5400`; zero-value fields are omitted. The
  client uses those blockers to explain what must be removed or resolved before trying again.
- A type that is incompatible with the current `objectKind`, without the matching explicit
  conversion, returns `400 validation_failed` rather than changing identity.

### 2.4 Participants and RSVP

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/activities/:id/participants` | Add one. Existing contact by `personId`, or new by `{ displayName, email? }`. Returns the created `Participant` and, for guests, an `inviteUrl`. |
| `PATCH` | `/v1/activities/:id/participants/:personId` | `{ rsvp }`. A participant may only change their own RSVP; the owner may change anyone's. The server stamps `rsvpForDate` from the plan's current date **read in the same transaction** as the RSVP write, so a response racing a date change cannot record consent to the new date (`data-model.md` §4.7, §7.1). |
| `DELETE` | `/v1/activities/:id/participants/:personId` | Owner only, or self (leave a plan). |
| `POST` | `/v1/activities/:id/invites` | Create a shareable (non-personalised) link. Returns `{ token, url, expiresAt }`. |
| `DELETE` | `/v1/activities/:id/invites/:token` | Revoke. |

Cap: 50 participants per activity → `422 participant_limit_exceeded`.
Participant and invite endpoints require `objectKind: 'plan'`; a Task returns
`400 validation_failed`. Prep-task collaboration comes only from its parent Plan's access
rule and does not create direct participant rows.

### 2.4a Reminders — per user

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/reminders` | **The caller's own reminders only.** Never anyone else's, on any plan, ever. |
| `POST` | `/v1/activities/:id/reminders` | `{ offsetMinutes, reminderId? }`. Any participant, for themselves. Max 3 per user per activity → `422 reminder_limit_exceeded`. `Idempotency-Key` is required: replay returns the original 2xx response, while a new logical request at an existing offset returns the business-rule `409`. **`reminderId` is optional and client-minted** (added 2026-08-17, P2-57), validated for prefix and encoding like `activityId` above and carrying no authority — `userId` is still the caller's and every derived field is still the server's. It exists so a reminder set offline can be armed locally against the id it will keep. Omitted, the server mints one exactly as before. |
| `DELETE` | `/v1/activities/:id/reminders/:reminderId` | Only your own. |

All three management routes require the Activity to have `schedule.date`; reminders on an
undated Activity are `400 validation_failed`, consistent with `notifications.md` §2/§3.
For a timed Activity, `offsetMinutes` is any integer in `[-10080, 0]`. For a date-only
Activity it must also satisfy `offsetMinutes % 1440 === 0`; schema and service both enforce the
schedule-aware rule. Clearing an Activity's time retains its reminder rows and normalises any
sub-day offsets as specified by the schedule endpoint above.
The client generates the reminder-create idempotency key once at the public action boundary
and reuses it across transport retry or persisted replay.

On a shared plan there is **one schedule and many reminder sets**. `CreateActivityInput`'s
`reminders` field creates rows for the **creator only**. When somebody joins a shared plan, an
explicitly set `defaultReminderOffset` creates their own row—including `0`; `null`/absent
creates none. Nobody inherits the creator's.

### 2.4b Date suggestions

Turns Needs a date into a planning surface rather than a holding area. Any participant may
propose; only the owner may decide.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/suggestions` | Included in the activity detail response; this exists for polling. |
| `POST` | `/v1/activities/:id/suggestions` | `{ date, time?, note? }`. Any participant. Max 5 per activity → `422`. |
| `DELETE` | `/v1/activities/:id/suggestions/:suggestionId` | Author or owner. |
| `POST` | `/v1/activities/:id/suggestions/:suggestionId/works` | Toggles the caller in `worksFor`. An availability signal, not a vote. |

The owner schedules from one with
`POST /v1/activities/:id/schedule { fromSuggestionId }`, which copies the date and time and
then runs the ordinary scheduling path — including the RSVP reset. All suggestions are
deleted once the activity is scheduled. Guests cannot suggest; they read and RSVP.

### 2.5 Updates (the plan's activity feed)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/updates?cursor=` | Newest first, 50 per page. The first page and cursor are embedded in Activity detail. A Plan converted to a Task retains its existing entries as read-only history, so this route continues to page them. |
| `POST` | `/v1/activities/:id/updates` | Plan-only. `{ body }` → `{ update, lastActivityAt }`. System entries ("Alice is going", "Time changed to 8 PM") are written server-side with `kind: 'system'`. The returned timestamp is authoritative while the GSI projection converges. A Task, including a converted Plan, rejects new entries. |
| `DELETE` | `/v1/activities/:id/updates/:updateId` | Author only, and only on `kind: 'user'` entries — including the author's retained entries after Plan → Task conversion. A system entry is the record of what happened and is undeletable. Anything else → `404`. Matches phase-03 P3-19. |

### 2.6 Attachments

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/attachments/upload-url` | `{ contentType, byteSize }` → `{ attachmentId, uploadUrl, key }`. Creates the caller's durable pending-upload record, then returns a presigned S3 `PUT`, 5-minute expiry, 10 MB cap, image MIME types only. |
| `POST` | `/v1/activities/:id/attachments` | Confirm the upload and link it. Confirmation marks the pending record before permanent copy and is resumable/repairable at every cross-store crash point. |
| `DELETE` | `/v1/activities/:id/attachments/:attachmentId` | |

`Set as cover` is `PATCH /v1/activities/:id { primaryAttachmentId }`; the server validates
the id against the activity's own `ATT#` rows before accepting it (phase-03 P3-22).

Confirmation is a cross-store state machine. Before copying to the permanent key, the server
records the target Activity and marks the caller's pending-upload record `confirming`; after a verified copy it
transactionally creates the `ATT#` row and consumes that record, then deletes the temporary
object. Retry resumes the recorded state. Before another upload URL is issued and on later
attachment/detail access, one caller-scoped bounded drain completes or deletes expired
pending confirmations before deleting their rows. The set is capped at 20, so no scan,
DynamoDB Stream or scheduled worker is required. A crash after copy therefore cannot create
an undiscoverable permanent orphan.

Images are served through CloudFront with a signed-URL or a per-object random key path
(`u/<userId>/<ulid>.<ext>`). Never make the bucket public.

### 2.7 Lists

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/lists?cursor=` | Pages all of the caller's List access pointers 50 at a time, then BatchGets that page's current `META` rows, including archived Lists. The endpoint does not filter by `archived`; active/archived presentation is client-side and a filtered-empty page may still have `nextCursor`. The 100 cap applies to Lists the caller owns, not memberships received from other owners. |
| `POST` | `/v1/lists` | `{ listId?, title, templateKey, sourceActivityId? }`. `title` and `templateKey` are required; `templateKey` must be the template/style the user selected. Optional `listId` is the permanent client-minted `lst_<ULID>` for durable offline creation. The server copies behaviour, capabilities, icon, empty-state copy and slot from that exact catalogue entry; it never matches the title or substitutes another template. When `sourceActivityId` is present and names an owned Plan, the copied `slot` is forced to `null` and the same transaction writes an id-only `ACT#<sourceActivityId>/SOURCE_LIST#<listId>` reverse projection. Create rejects client-supplied `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy`; only explicit later settings may change their supported subset. |
| `GET` | `/v1/lists/:id?includeItems=true` | Returns META plus the first 50 items and an opaque item cursor bound to the META `rankVersion`. The service strongly reads META, uses `ConsistentRead: true` for the item Query, then strongly rereads META; both reads must have the same version with neither `rankRepairId` nor `behaviourMigrationId`. A marker or changed fence returns `503 internal` with `Retry-After: 1` and no item rows after attempting the bounded drain. A linked row includes the caller's `viewerLink` and its trimmed `viewerPlan` together; an unlinked or unreadable row includes neither. Links belonging to other members are removed before the one bounded Activity hydration and before serialisation. It never returns the whole List partition. |
| `PATCH` | `/v1/lists/:id` | `{ title?, capabilities?, slot?, archived? }`, under a required `If-Match` carrying the `updatedAt` the client read and a required `Idempotency-Key`; omitting either is `validation_failed`, and a stale version is `409` whose `details[0]` carries the current version. The receipt preserves the exact opaque settings Undo token after a lost success response and is retained through `MAX_AUTOMATIC_INTENT_AGE_DAYS`, matching the durable outbox rather than the ordinary 24-hour receipt window. See the change rules below. `capabilities` is a partial patch of the two flags, merged onto the stored pair. `slot` is nullable: absent leaves it alone, `null` clears it. Additive changes return the server-recorded settings Undo token; a rename alone returns none, because renaming a list has no undo row in `../01-product/interaction-contract.md` §4.1. A member may rename; capabilities, slot and archive are owner-only (§3). `behaviour` and `templateKey` are both rejected here — the first uses the dedicated replay-protected action below and the second is immutable — so a body carrying either is `validation_failed` naming it. |
| `POST` | `/v1/lists/:id/behaviour` | `{ behaviour, confirmation? }`. Owner only. Requires `If-Match` and `Idempotency-Key`; every direction uses the gated resumable migration below, and the operation is identified by that key so a replay resumes its own work instead of starting a second migration. A destructive transition **that would actually lose something** first returns a typed `409 conflict` with `{ confirmation: { fromBehaviour, toBehaviour, itemVersion, itemCount, fields } }` without starting a migration or writing a receipt. The confirmed action uses a newly minted key and echoes that whole object. Posting the behaviour a list already has is a no-op that answers with current truth. |
| `DELETE` | `/v1/lists/:id` | Owner only. Writes the replay-window tombstone and removes the List's `SOURCE_LIST#` reverse projection when present before the chunked cascade removes every partition row (items, locators, members, links, Undo, repair and behaviour-migration work) plus every member pointer and `LLINK#` relationship; it does not delete owner-scoped People records. |
| `GET` | `/v1/lists/:id/items?cursor=` | Pages 50 strongly consistent `ITEM#` rows at a time, with only the caller's readable `viewerLink` / trimmed `viewerPlan` pair for that page. The caller filter precedes the one bounded Activity hydration; another viewer's Activity is never loaded. Strong META reads before and after the Query must match the cursor/each other and contain neither repair nor behaviour-migration marker. A failed fence returns `503 internal` with `Retry-After: 1`; the client retains its committed projection and restarts from page one. No response can span a reorder, repair or behaviour migration. |
| `GET` | `/v1/lists/:id/items/:itemId` | Authoritative exact-id read for durable-create reconciliation. Strong META reads before and after the strongly consistent locator/item reads must keep the same `rankVersion` with no repair/behaviour-migration gate, and locator/item revisions must match; a failed fence returns `503 internal` with `Retry-After: 1`, while a missing or tombstoned item is `404`. |
| `POST` | `/v1/lists/:id/items` | `{ itemId?, title, note?, location?, details?, afterItemId? }` — `afterItemId` drives the lexo rank; optional `itemId` is the permanent client-minted `itm_<ULID>`. |
| `POST` | `/v1/lists/:id/items/bulk` | `{ items: [{ itemId?, title, note?, location?, details?, afterItemId? }] }`. Ordinary item creation only; provenance and source-ingredient fields are rejected. Every offline item carries its own stable id. **Amended in P3-08: the batch takes one position, on its first member.** `afterItemId` on a later member is `validation_failed` naming it. The batch is one ordered sequence whose ranks come from a single `rankVersion` read and advance that version once per chunk (see the edge cases in `phase-03` §P3-08); honouring a position per member would mean an allocation each, which is the fan-out the single sequence exists to prevent. The member shape stays identical to ordinary creation so there is one schema, not two. |
| `PATCH` | `/v1/lists/:id/items/:itemId` | `{ title?, checked?, note?, location?, details?, afterItemId? }`. No client `If-Match`; the service conditionally advances the ranked row and locator's shared internal `itemRevision`. A conflict re-resolves the locator and reapplies only supplied fields, preserving per-field last-write-wins while preventing a stale reorder image from replacing another edit. A position and ordinary fields may arrive **together and land together**: the reorder already re-puts the whole row at its new key, so the supplied fields fold into that put and the write stays the same four domain actions (P3-08). `null` on `note` or `location` clears the field, and clearing is gated exactly as setting is — a hidden retained value cannot be removed while its capability is off. |
| `DELETE` | `/v1/lists/:id/items/:itemId` | Removes the ranked row and identity locator, leaves the replay-window item tombstone, and returns an opaque token for the 6-second Undo window. |
| `POST` | `/v1/lists/:id/items/:itemId/schedule` | **The optional bridge to Activities.** Body = `ScheduleListItemInput` below. Creates an explicit Plan and the permitted per-viewer link pointers; the ListItem itself is not replaced or given a global Activity id. A Watch Plan's explicitly enabled second-object action may create the item first and then call this endpoint with the reviewed Plan fields; the endpoint still requires type and audience and infers neither from the item. |
| `POST` | `/v1/activities/:id/ingredients/add-to-list` | `{ listId, ingredients: [{ ingredientId, itemId? }] }`. Owner-only meal action. Every stored meal ingredient has a stable client-minted `ing_<ULID>` retained across edits/reorders. The server resolves the selected current ids and explicit writable collection destination, derives item titles/provenance, writes/deduplicates them, and records each source ingredient's `addedToListId` idempotently. A missing/replaced id rejects the whole action, and so does the same id twice; array position is never source identity. The destination is **given, never resolved**: slot resolution is the client's (P3-12/P3-42) and the user has seen the list's name before this is called, so the server validates `listId` and never falls back to a slot. `behaviour` must be `collection` — a `watch` or `meals` list requires typed `details` an ingredient has none to give — and this check plus capacity are repeated against the exact fenced List META basis conditioned by the transaction. One canonical label is computed for the operation from activity-keyed labels other meals have already used on that list. Selections are grouped by case-insensitive trimmed title: a group uses one matching **unchecked** row or creates one new row, while a **checked** match is already bought and does not absorb the group. A replay-bound destination still answers its exact ingredient after check/rename, but it may absorb fresh selections in the group only while currently unchecked with the same normalized title. Each stored row retains ordered, storage-only `{ activityId, label }` provenance segments and renders `sourceLabel` by joining them; the service never infers ownership or replay by splitting display text, because a rule-5 segment may itself contain ` · `. The dedicated rendered bound is 4,000 characters, accepts every canonical 200-character meal-title label, never truncates, and is validated before a transaction is composed. The write-back locates each row by `ingredientId` and conditions the write on that id still occupying the index, so a concurrent reorder fails rather than flagging a neighbour, and it **advances** the meal's `updatedAt`: `addedToListId` is rendered — it is what makes an ingredient row say `Added` — and it lives inside `details`, which `PATCH` replaces wholesale under `If-Match`, so a client holding the pre-write copy would both draw stale rows and pass its next concurrency check. **The whole action is one `TransactWriteItems`** — created rows, structured/rendered label extensions, authoritative identities/aliases, List META, the meal's markers and new `updatedAt`, and the idempotency receipt — so a receipt can never be stored without the provenance it describes and a conflict leaves nothing behind. For at most 30 selections the worst case remains 94 actions: a created destination costs three; grouped/labelled selections consume aliases or one two-row extension instead of another created destination; four fixed actions cover the deletion gate, META, Activity and receipt. Every condition is tied to the read — List `rankVersion` **and storage-only `itemVersion`**, each extended row's `itemRevision`, each ingredient's position, and the meal's `updatedAt` — and a condition failure re-runs the whole read/classify/commit cycle. `rankVersion` catches structural changes; `itemVersion` also catches a rename, check, delete, restore or behaviour finalization that changes classification without moving a row. Every public item mutation advances `itemVersion` once; gated repair/migration workers advance it when their final transaction makes the rewritten rows visible. Item-page cursors remain bound only to `rankVersion`. `itemId` is optional. When omitted and creation is needed, the server mints one. When supplied, `ITEMID#<itemId>` is authoritative for ordinary locators and absorbed aliases alike. It permanently records the exact source Activity, ingredient and original outcome; only that tuple is replay, an id reused for another ingredient returns `409`, and ordinary item creation cannot take an alias id. A deleted alias target also yields `409` rather than releasing the requested identity. So does a supplied `itemId` that a retained `ITEM_TOMBSTONE#` still owns, **whether the selection would create a row under it or be absorbed into another**: only the matching Undo may reclaim a deleted item's id. Created rows carry a per-row condition for that; an absorbed one writes its alias to the same `ITEMID#` key and cannot add one without breaching the 94-action budget, so both tombstones are read in the fenced snapshot and refused before classification. Returns `AddIngredientsToListResult`: the destination, the one label, the meal's new `activityUpdatedAt`, and per ingredient whether it was `created` or `labelled`. |
| `POST` | `/v1/lists/:id/clear-checked` | Only when `behaviour === 'collection' && capabilities.checkable`; anything else is `validation_failed`, so the hidden `checked` values a behaviour change retained cannot be reached. Deletes immediately, with **no confirmation dialog** — the single deliberate exception to `../01-product/interaction-contract.md` §1a.1, recorded in `../00-open-decisions.md` item 33 — and returns an opaque token for the 10-second bulk Undo window. Each deleted item leaves a tombstone holding its exact snapshot under **one** operation, however many transactions the delete needs. |
| `POST` | `/v1/lists/:id/uncheck-all` | Only when `behaviour === 'collection' && capabilities.checkable`, on the same terms. Sets every currently checked item to unchecked, records **exactly the ids it changed**, and returns an opaque token for the 10-second bulk Undo window. Compensation re-checks the surviving members of that set and skips one deleted meanwhile. |
| `POST` | `/v1/lists/:id/undo` | `{ undoToken }`, strictly — a client never sends deleted row contents back as authority. Requires its own `Idempotency-Key`. Applies the server-recorded compensation for one retained, unused single-delete, `clear-checked`, `uncheck-all`, archive, or additive settings operation. It is the only route allowed to reclaim an item id protected by `ITEM_TOMBSTONE#`; settings compensation applies only while its recorded preconditions remain true. Answers the `ListUndoResult` union below. |
| `GET` | `/v1/list-templates` | The exact shared template catalogue. Static and cacheable for 24 h. The mobile creation chooser bundles a projection of the same shared module so first-launch offline does not depend on this request; no client owns a second map of labels or defaults. |
| `GET` | `/v1/lists/:id/members` | The first response row is the owner, synthesised from `List.ownerId`, the owner's `ListIndex` pointer and profile; there is no owner `MEMBER#` row. The owner then receives every non-owner active and invited row. A member receives the synthesised owner and active non-owner roster only; pending identities and addresses are removed server-side. |
| `POST` | `/v1/lists/:id/members` | `{ personId }` or `{ displayName, email }`. Owner only and always an explicit confirmation. A registered add is active immediately and creates/reuses reciprocal owner-scoped People records plus active `LLINK#` rows on both sides. If the email belongs to no account, it creates an invited member and owner-side invited `LLINK#`, sends email, and writes no recipient pointer. Invited members count toward `memberCount` and the cap of 20 people total, including the owner, but not `sharedListCount`. |
| `DELETE` | `/v1/lists/:id/members/:personId` | Owner removes any non-owner; a member may remove **themselves** (leave). Deletes the member's index entry and both active `LLINK#` rows, or the owner's invited link for a pending member. Authored items and both People records stay. |

**Durable List and ListItem creation — Phase 3 extension of ADR-055.** Native clients mint
monotonic `lst_` and `itm_` ids before committing the visible SQLite row and outbox intent.
The server validates a supplied id but still derives ownership, timestamps, ranks and copied
template fields. Omission retains server-minted behaviour for online callers. List creation
conditionally puts `META` while condition-checking `LIST#/TOMBSTONE`; item creation and
reorder allocate server-owned ranks under a conditional `META.rankVersion` advance (bulk
allocates one sequence under one advance), re-reading neighbours and retrying on conflict;
item creation
conditionally puts its `ITEMID#<itemId>` identity locator and condition-checks
`ITEM_TOMBSTONE#<itemId>`. Deletes leave tombstones through
`MAX_AUTOMATIC_INTENT_AGE_DAYS`, exactly as Activity deletion does. Each reversible delete
also stores the exact item, rank, current viewer links and linked Activity provenance under a
server-side Undo operation. `POST /v1/lists/:id/undo` validates the opaque token's retained and
unused operation state, requires every reclaimed tombstone to name that operation, and
conditionally restores the same item ids while deleting those tombstones. Retention-expired,
mismatched and reused tokens write nothing. `uncheck-all` stores only the ids it changed and
compensation rechecks the surviving members of that set. Additive list settings mutations
store their inverse and preconditions under the same operation model. A behaviour-upgrade
inverse names the prior behaviour and only the default item fields it created; if those
fields or affected settings have since changed, compensation returns
`no_longer_applicable` and writes nothing. This dedicated inverse may undo an upgrade without
destructive confirmation; an ordinary behaviour downgrade may not. A slot inverse includes the
exact profile-default entry removed by the forward mutation and restores it only if no newer
default occupies that slot.

Reversible item/bulk mutations return
`{ affectedCount, undoToken, undoExpiresAt }` (`affectedCount: 1` for single delete), while
additive settings mutations return `{ list, undoToken, undoExpiresAt }`.
`undoExpiresAt` is the client presentation deadline: the UI must stop offering a new Undo at
that instant. The opaque server-side record owns the compensation; clients must not send
deleted row contents back as authority. Once the user accepts Undo while it is offered, the
inverse requires its own `Idempotency-Key`, is replay-safe, and may arrive after
`undoExpiresAt`. The single-use token remains server-valid through
`MAX_AUTOMATIC_INTENT_AGE_DAYS`, matching the durable outbox and tombstone retention, so an
accepted offline inverse cannot expire in transit.

**What the route returns — amended in P3-10.** This paragraph previously said the route
"returns `{ affectedCount }`" while the same section said a mismatched, consumed or
retention-expired token "returns the typed expired/no-longer-applicable result and writes
nothing". A bare count cannot express the second, and neither case is a failed request, so
neither earns an `ErrorCode`. It answers `200` with one **discriminated union**, defined once
as `ListUndoResult` in `packages/shared/src/schemas/list.ts` and mapped by the client in
P3-24:

```ts
{ outcome: 'applied'; affectedCount: number }
| { outcome: 'expired' }
| { outcome: 'no_longer_applicable' }
```

- `applied` — the inverse ran. `affectedCount` is what it touched: items restored, items
  re-checked, or `1` for a settings or archive inverse.
- `expired` — the token names no operation, its hash does not match, or the operation is past
  its replay retention. The three are **deliberately indistinguishable**: telling a caller
  their token is well-formed but stale would tell them something about an operation they may
  not own.
- `no_longer_applicable` — the operation is retained and correctly addressed, but has already
  been used, or a settings inverse's recorded preconditions no longer hold.

The last two write nothing. `undoExpiresAt` is **never** consulted by this route: it governs
whether a client may offer a new Undo, never whether an accepted inverse may run.

A metadata-free collision is reconciled by the authenticated exact read: `200` means the
earlier response was lost and the server representation wins wholesale; `404` is ambiguous
and parks the intent for explicit Retry or Discard. Retry mints a fresh entity id and mutation
id and atomically remaps the local row plus every dependent outbox payload, ordering key,
dependency and compensation. Remapping a List includes its dependent local ListItems. There
is no automatic re-mint. For bulk creates, every item retains its own id across resumable
chunks, so replay after the 24-hour idempotency receipt expires reconciles committed items and
cannot duplicate a partially completed batch.

`ScheduleListItemInput` is deliberately not `CreateActivityInput` with fields removed by
convention. It is a separate schema so neither audience nor type can be inferred:

```ts
interface ScheduleListItemInput {
  activityId: string;                    // required permanent client-minted act_<ULID>
  creationTarget: { objectKind: 'plan'; type: PlanType };
  audience:
    | { mode: 'just_me' }
    | { mode: 'selected_people'; participants: ParticipantInput[] }; // at least one
  title?: string;                       // omitted => copy item title once
  notes?: string;
  schedule?: { date, time?, endTime?, timezone };
  recurrence?: Recurrence & { segments: [RecurrenceSegment] }; // this path also creates
  reminders?: { reminderId: string; offsetMinutes: number }[]; // caller only; id required here
  location?: { label, address?, lat?, lng?, mapUrl? };
  details?: ActivityDetails;            // must match creationTarget.type
  attachmentIds?: string[];
  sourceUrl?: string;
}
```

The bridge conditionally creates `ACT#<activityId>`. The native client persists that id in the
same SQLite transaction as the bridge intent, so replay remains duplicate-safe after the
24-hour idempotency receipt expires. If that exact Activity already exists with the same owner,
`listId` and `listItemId`, the request is the earlier successful action: return existing truth
without rewriting a current `LNK#` that may now point to a newer action. Any other collision
uses the metadata-free durable-create conflict. Every genuinely new scheduling action mints a
new id.

This offline-capable create path also requires a permanent client-minted `reminderId` for each
reminder and persists those ids in SQLite with the intent. Its single transaction extends the
ordinary durable Activity-create write set: Activity tombstone check, META, owner index, one
caller `REM#` row per reminder, idempotency receipt and every row required by other accepted
create fields, plus the caller's list `LNK#`. The three core Activity/index/link rows are a
minimum, not a complete write inventory; accepted reminders are never silently dropped.

The schedule sheet labels the two audience choices **Just me** and **Choose people**. It
does not preselect every list member. `just_me` creates a private Plan owned by the caller.
`selected_people` creates a Plan with exactly the people supplied; list membership grants no
Plan access by itself, and a selected participant need not be a member of the source list.
The server never reads `List.behaviour`, `templateKey`, or `capabilities` to choose the
Activity type.

The global Plan → Watch form has no separate audience step. In Phase 3 its explicitly enabled
second-object action supplies `{ mode: 'just_me' }`; in Phase 6 it maps the reviewed People
field to `selected_people`. This is caller construction, not a bridge default: the endpoint
still rejects a missing audience and never derives one from the item, list, or title.

The response is `{ activity, item, viewerLink }`, where `viewerLink` is the caller's
`ListItemActivityLink`. For a private Plan, only the caller gets a link pointer. For a shared
Plan, the caller and each selected registered participant who is also an active member of
the source list get one. Guests and selected people outside the list get Plan access but no
list pointer. Consequently:

- a nonparticipant list member sees the ordinary item with no state line and no Activity id;
- each visible state line opens an Activity the caller is authorised to read;
- different members may schedule the same shared item independently; an existing pointer
  owned by somebody else is never a `409` condition;
- one viewer has at most one current pointer per item. A later scheduling action replaces
  that viewer's pointer only; v1 does not expose link history or fall back to an older link;
- adding or removing a Plan participant adds or removes their pointer only when they are an
  active member of the source list. Leaving the list makes every pointer there unreachable;
- the item title seeds the Plan title once. Later title edits are independent. A member who
  can edit a shared list must never rename another member's private Plan indirectly.

The list-detail projection filters `LNK#` rows to the authenticated user **before** it looks
up linked Activities and before it serialises the response. The Activity access check still
runs; a stale pointer is omitted and queued for cleanup rather than producing a dead link.
The link may remain present when its Activity is unscheduled. A scheduled/completed state line
requires `schedule.date`; `cancelled` is the deliberate exception and renders `Cancelled`
without a date.

**What the row carries — added in P3-15.** A row that has a `viewerLink` also has a
`viewerPlan`: `ListItemPlanState`, the caller's linked Plan trimmed to `type`, `status` and an
optional `schedule`. The Activity's id is on the link alone, so the two cannot disagree about
which Plan they describe.

`ListDetailItem` is a **union of two strict shapes** — item alone, or item with both halves —
rather than one shape with two optional fields. A row carrying only the pointer cannot tell a
scheduled Plan from an unscheduled or completed one, and state without a pointer names a Plan
the row cannot navigate to; independent optionals are what would let a server emit half a pair
and a client believe it.

**Plan → Task removes the Plan-specific relationship atomically.** The conversion transaction
deletes every `LNK#` row that still points to that Activity and writes the Task without
`listId` / `listItemId`. A moved pointer is re-read rather than deleted. The ListItem and Task
both survive independently, and no invisible pointer remains for a projection that can no
longer describe it. A cancelled Activity remains a Plan: its link is retained and
`viewerPlan.status: 'cancelled'` renders the `Cancelled` state line.

It is deliberately **not** the Activity. **Three fields**, each earning its place: `type`
selects the verb (`Planned` for an event, `Next session` for a watch session, which the list's
own behaviour cannot supply for a `custom` Plan made from a `watch` list), `status` separates
`Done Saturday` from `Planned Saturday`, and `schedule` is both the rendered date and the
display gate. The state line's **tap target is `viewerLink.activityId`** — the id lives on the
link alone, so the two halves cannot disagree about which Plan they describe. Absent by
design: that `activityId`; the Plan's `title`, which is independent of the item's after the
one-time seed; watch progress, which comes from the item's own `details`; and `outcome`, since
every completion renders `Done` and a skip removes the pointer entirely. Returning the whole Activity would make the list
projection a second Activity-detail contract and carry a private Plan's every field into a
list response.

The Activities are hydrated with **one bounded batch** for the page, never one read per link,
and the caller filter still happens first, so no other viewer's Activity is loaded at all.

**List settings and behaviour change rules** — the product-wide additive/destructive rule
(`../01-product/interaction-contract.md`):

| Change | Behaviour |
| --- | --- |
| `capabilities.checkable` false → true | Applies immediately. Nothing is lost. |
| `capabilities.checkable` true → false | Applies immediately. `checked` is retained on items, not cleared, so re-enabling restores it. |
| `behaviour` `collection` → `watch` or `meals` | Applies immediately, initialising `details` on every item with the default status. |
| `behaviour` `watch` or `meals` → anything | **Destructive** whenever any item carries the typed data. The first call returns `409 conflict` with a typed confirmation naming the source/target behaviours, `itemVersion`, fields and exact number of items affected; the second echoes that object, so the client cannot authorize a different snapshot. |
| `slot` | Free. Changing it does not move any items. |

Every additive row, including `archived: false → true`, returns a retained settings Undo
operation as described above. Checkbox mutations and checkbox-derived bulk operations are
valid only when `behaviour === 'collection' && capabilities.checkable`; changing behaviour
retains the stored flag and item checks but removes their operational meaning until the list
is a qualifying collection again. Location mutations use the parallel
`behaviour === 'collection' && capabilities.supportsLocation` gate; stored locations are
retained while hidden.

**A lossless departure is additive in every respect, Undo included.** The same count
decides both halves of the row: a `watch` or `meals` list nothing is carrying data on leaves
that behaviour with no confirmation *and* with the standard settings Undo token, because
§1a.1 defines an additive change as one that loses nothing and §4 gives every additive change
an undo. Only a departure that actually removes something is confirmed rather than offered,
and only that one answers without a token.

**The destructive row is conditional, and a count of zero means no confirmation.**
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §1a.1 rule 3
names a behaviour change as exactly the kind of change that is destructive only *sometimes*,
and calls a confirmation that can appear with a count of `0` a bug. So an empty watchlist, or
a meals list nobody has put an ingredient on, leaves its behaviour like any additive settings
change: the migration still runs — every item must match the new behaviour — but no
confirmation is required and none is asked for. The count is the §1a.1 rule 2 count: items
**actually carrying** the data, never the list's size. Amended in P3-09; the product doc
outranks this one on behaviour, and the two now agree.

**How the `409` preview is encoded.** The error envelope carries a typed top-level object:

```ts
{
  confirmation: {
    fromBehaviour: 'watch',
    toBehaviour: 'collection',
    itemVersion: 42,
    itemCount: 7,
    fields: ['Watch status', 'Season', 'Episode']
  }
}
```

Each `fields` member is one user-facing label, in the order the confirmation should read them
(§1a.1 rule 4), and only fields some item actually carries are named. The client composes the
dialog sentence around its own list title; the server never sends a pre-joined one.

**Confirmation is bound to what the user saw.** Every item mutation advances the storage-only
`List.itemVersion`. Migration installation conditions on the echoed version, then snapshots
under the migration gate and verifies both `itemCount` and the ordered `fields` against the
echoed preview. Any intervening mutation or mismatch returns a fresh `409`; no item is
rewritten under a stale confirmation.

**The Undo offer is a pair.** `undoToken` and `undoExpiresAt` are present together or absent
together; the response schema is a union of exactly those two shapes. A token without the
deadline it is offered until is an offer no client can time.

Capabilities, slot and archive use `PATCH /v1/lists/:id`; behaviour rows use the dedicated
replay-protected `POST /v1/lists/:id/behaviour`. Deleting a list is a list mutation like any
other: it drains standing work first and answers the same retryable `503` when work remains,
rather than failing the marker condition as an ordinary edit conflict. Every behaviour
change—upgrade, confirmed destructive change, and behaviour Undo—uses one resumable
migration. The first transaction
leaves public `List.behaviour` unchanged, creates
`BEHAVIOUR_MIGRATION#<operationId>` and sets `META.behaviourMigrationId`. While present, every
item read or list/item mutation attempts a bounded drain and otherwise returns `503 internal`
with `Retry-After: 1` and no rows or writes. Private worker chunks transform the stable
at-most-500 item snapshot against the recorded target shape while conditionally advancing each row and
locator's matching `itemRevision`. The final transaction alone changes
`List.behaviour`, clears the marker, advances `rankVersion` to invalidate old item cursors,
records the Undo/receipt and removes the work row. **The receipt it writes is the one stored
on the work record**, not one built by whoever is finishing: any caller may drain a migration
to completion, and a reader that finishes somebody else's must still record that operation's
answer under that operation's key. Otherwise the author's replay finds no receipt and is then
told its `If-Match` conflicts — by the very write it asked for — with the Undo token gone
along with the work row. Public schema validation therefore never
observes `details.behaviour !== List.behaviour`, including after a crash or retry.

Changing or clearing a slot also removes `user.defaultLists[oldSlot]` when, and only when,
that exact slot still points to this List. The conditional nested removal is in the same
transaction as the List update; a concurrent choice of a different default survives. The
client does not compose this invariant from a second `PATCH /v1/me`.

`templateKey` is immutable after creation. It records provenance and analytics only; the
stored List carries its copied icon and empty-state copy, so no read path resolves the key.

**Default-slot resolution.** Any "add these to X" flow (ingredients to a shopping list,
save to a watchlist) follows the four-step rule in
[`data-model.md`](data-model.md#default-slots): one eligible list, use it; several with a
default, use the default and let the user override for this operation only; several with no
default, ask once and store the answer in `user.defaultLists`; none, return no destination.
The client may then offer `New list`. General and ingredient flows open the full standard
catalogue with no selection. A Watch destination—the user already enabled the typed Watch
second-object control—shows exactly `watchlist`, `movies-to-watch`, and `tv-shows` in their
canonical relative order, with no selection. This is an eligibility constraint, not title or
model inference. `Create list` and the later named add-to-list action are separate requests
and confirmations. Opening a list must never change where future items go.

### 2.7a Shortcuts — Phase 9

Reusable templates for `custom` activities only (concept §30). Stored at
`USER#<u>` / `SHORTCUT#<shortcutId>`. Cap: 12 per user, so the list needs no pagination.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/shortcuts` | |
| `POST` | `/v1/shortcuts` | Created from an existing `custom` activity, never from a blank form. |
| `PATCH` | `/v1/shortcuts/:shortcutId` | |
| `DELETE` | `/v1/shortcuts/:shortcutId` | Does not touch activities created from it. |

### 2.8 People

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/people?sort=relevance` | Returns every owner-scoped Person plus computed `sharedListCount` from active `LLINK#` rows. Sorted by upcoming shared plans → outstanding balance → recency → display name (concept §22); list membership is a summary fallback, never a relevance key. |
| `GET` | `/v1/people/suggested` | FREQUENT + RECENT buckets for the participant picker (concept §23). |
| `POST` | `/v1/people` | Create a contact manually. |
| `GET` | `/v1/people/:id?listsCursor=` | The person view: upcoming together, recent together, net balance, and active Lists one of you explicitly shared with the other. `listsCursor` continues only the `listsTogether` projection. |
| `PATCH` | `/v1/people/:id` | |
| `DELETE` | `/v1/people/:id` | Blocked with `409` if they participate in any non-completed activity or have any invited/active List membership. `details[]` names each blocker and its `plan` or `list` type. |
| `POST` | `/v1/people/:id/merge` | `{ intoPersonId }`. Moves Plan, expense and List membership/link references onto the survivor; see merge rules below. |

`GET /v1/people/:id` returns the bounded list projection in addition to the existing fields:

```ts
interface PersonListTogether {
  listId: string;
  title: string;
  icon: string;
  itemCount: number;
  addedAt: string;
}

interface PersonViewResponse {
  person: Person & { sharedListCount: number };
  upcoming: ActivitySummary[];
  recent: ActivitySummary[];
  balances: BalanceSummary[];
  listsTogether: PersonListTogether[];
  listsTogetherCursor?: string;
}
```

`listsTogether` follows active `LLINK#` rows newest first, then re-checks the caller's exact
`USER#/LIST#` access before returning current List metadata. It means Lists one of the two
people explicitly shared with the other — it does **not** turn two non-owner co-members into
People. The initial response includes up to 20 and `listsTogetherCursor`; `See all` sends it
back as `listsCursor` for 20-row pages. Do not treat the owned-list creation cap as a cap on memberships
received from other owners. Invited links are omitted. `Nothing together yet` requires no
shared Plans, no active shared Lists and no balance.

People merge is resumable and idempotent, and List membership mutation for either Person is
locked while it runs. A source-only membership moves to the target; if the target is linked,
it activates with a recipient pointer, reciprocal Person and both active links, otherwise its
invited link and Person-level email locator move. If both People occur on one List, one
membership survives: active wins over invited, the earlier immutable `addedAt` is retained,
redundant links are removed and `memberCount` is decremented once. Two different
`linkedUserId` values still refuse the merge.

### 2.9 Expenses and settlement

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/expenses` | Includes a computed `owes` summary for the activity. |
| `POST` | `/v1/activities/:id/expenses` | `{ description, amountCents, currency, paidByPersonId, splitMode, splits }`. Server validates that splits sum exactly to `amountCents`. |
| `PATCH` | `/v1/activities/:id/expenses/:expenseId` | Returns `409 settlement_conflict` when any pairwise obligation on the Expense is settled. The response names the blocking Settlement ids; the user must explicitly undo them first. No settlement state is cleared as a side effect of editing. |
| `DELETE` | `/v1/activities/:id/expenses/:expenseId` | Uses the same settlement guard. It never edits or deletes Settlement history implicitly. |
| `GET` | `/v1/balances` | All net balances. |
| `GET` | `/v1/people/:id/balance?include=expenses` | Net figure **plus** the underlying expense lines. The client must never render a balance without being able to drill in. |
| `POST` | `/v1/settlements` | `{ personId, coversExpenseIds }` with 1–25 distinct ids → marks those pairwise expense obligations settled. The server derives exact per-Expense debtor provenance, `direction`, `currency`, and display-only `amountCents`; the request schema rejects every caller-supplied payment detail, including `amountCents`, `note`, `method`, `reference`, and `remainder`. |
| `GET` | `/v1/settlements?personId=` | Two-sided history (decision 2026-08-07): returns settlements the caller created **and** settlements where the caller is the counterparty. The counterparty rows are derived from the covered Expenses' `settlementIdByPersonId` (`data-model.md` access pattern 12b) — no second audit row is ever written. Every row names who marked it settled and when. |
| `DELETE` | `/v1/settlements/:settlementId` | Undo a settlement. Resolves the id through its locator, verifies the caller owns the audit row, then removes only that Settlement's exact debtor id from each covered Expense and recomputes its all-debtors roll-up. Other debtors remain untouched. Creator-only by decision (2026-08-07): a counterparty sees the settlement in history but cannot undo it. |
| `POST` | `/v1/balances/recalculate` | Full rebuild of the caller's balances from `Expense` rows and their per-person settled state. `Settlement` rows are audit history and are **not** subtracted as deltas. 3 / hour per user. Returns the rebuilt balances and the rows written and deleted. |

The balance drill-down, settlement, and Undo services may follow a `finance_only` PersonLink
after somebody leaves a Plan. That link authorises only the exact Expense-person obligations
returned by the financial projection; it does not authorise `GET /v1/activities/:id`, expose
the Plan title/notes/participants, or restore an Activity index entry. Ordinary Person
history filters it out. The plan name a finance-only drill-down shows is the Expense's own
`activityTitle` snapshot (`data-model.md` §4.8) — one shared denormalised field, rewritten
on rename for every viewer — never a live plan read.

Split arithmetic rule: distribute remainder cents to the first N participants in
`personId` sort order so totals reconcile exactly. Unit-test it. Never round to floats.

For `POST /v1/settlements`, `coversExpenseIds` contains **1–25 distinct, globally unique**
ids. Each resolves through an Expense locator to an unsettled obligation between the caller
and their caller-local `personId`; the service then authorises the resolved Activity. All
selected obligations must have the same currency and direction. Duplicate, mixed-currency,
mixed-direction, already-settled, unrelated, or missing ids return `400 validation_failed`
and write nothing. In one transaction the server:

1. computes each pairwise obligation from `paidByPersonId` and `splits`;
2. sums those obligations to the positive, display-only `amountCents` and derives
   `direction: 'they_owed_user' | 'user_owed_them'` plus `currency`;
3. derives and stores each source Expense's exact owner-scoped debtor id—never blindly the
   request's caller-local `personId`—in the Settlement's `coverage`;
4. conditionally adds that debtor to each Expense's `settledPersonIds`, stores
   `settlementIdByPersonId[debtor]`, and recomputes its all-debtors `settled` boolean; and
5. writes the immutable Settlement audit row plus its `SETTLEMENT#<id>` locator and returns it.

Balance computation then reads Expense contributions exactly once: a contribution whose
debtor is in `settledPersonIds` contributes zero; every other pairwise contribution keeps its
sign. It never subtracts `Settlement.amountCents` again. Deleting a Settlement resolves the
locator, then reverses only step 4 for the exact `(activityId, expenseId, debtorPersonId)`
triples whose reverse map still names that Settlement. It deletes the audit and locator rows
and triggers the same Expense-only balance recomputation.

### 2.10 Public (unauthenticated) invite surface

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/public/v1/invites/:token` | Plan details for the public page. Returns only what the invite is allowed to reveal: title, date/time **or `dateStatus: 'undecided'`**, location, description, poster image, organiser display name, RSVP counts. **Never** returns expenses, notes, reminders, date suggestions, other participants' emails, or any other activity. |
| `POST` | `/public/v1/invites/:token/rsvp` | `{ response: 'going'\|'maybe'\|'declined', displayName?, email? }`. Rate-limited by IP. An `email` that matches a **verified** `EMAIL#` record attaches the RSVP to that existing user instead of creating a guest; an unverified or absent email takes the guest path unchanged. |
| `GET` | `/public/v1/invites/:token/ics` | `text/calendar` download. |
| `GET` | `/public/v1/invites/:token/calendar/google` | `302` to a Google Calendar template URL. |
| `GET` | `/public/v1/invites/:token/stop` | Revokes the token and returns a plain confirmation page. The entire unsubscribe mechanism for invite emails. |

**The guest page uses the same date-sensitive vocabulary as the app.** An undated plan's
page says the date is still being decided and offers **Interested / Maybe / Pass**; a dated
one offers **Going / Maybe / Decline**. Asking "Are you coming?" about a plan with no date
is incoherent, and a guest is exactly the person least equipped to work out what it means.
The stored values are the same four in both cases — see
[`data-model.md` §7.1](data-model.md#71-rsvp-consent-does-not-survive-a-date-change).

A guest who responded to an undated plan is reset and re-emailed when the date lands, on the
same rule as an app user. Guests cannot add date suggestions.

Invite tokens expire 90 days after the plan's date, or 90 days after creation while it has
no date. Expired → `410 invite_expired`.

### 2.11 Capture — Phase 8, stubbed earlier

These ship as **stubs returning `501 not_implemented` from Phase 1**, so the client
integration is written once and the AI work slots in behind a stable contract.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/capture/parse` | `{ text, tz, creationTarget }` → `ParsedCapture` |
| `POST` | `/v1/capture/extract` | `{ attachmentId, creationTarget }` → `ParsedCapture` |
| `POST` | `/v1/capture/link` | `{ url, creationTarget }` → `ParsedCapture` |

```ts
interface ParsedCapture {
  creationTarget: CreationTarget;       // exact echo of the request, never model-selected
  confidence: number;                  // 0..1 overall
  fields: Record<string, {
    value: unknown;
    confidence: number;                // < 0.7 => client highlights it for review
    sourceSpan?: [number, number];     // character range in the input text
  }>;
  ignored?: {
    reason: 'incompatible_with_target' | 'sharing_requires_user_action';
    sourceSpan?: [number, number];
  }[];
  rawModelOutput?: string;             // dev only, stripped in prod
}
```

The request is invalid without `creationTarget`; there is no compatibility default. The
allow-list for `fields` is selected from that target, not from what the model thinks the
input resembles:

| Target | Fields capture may return |
| --- | --- |
| `{ objectKind: 'task', type: 'task' }` | `title`, `notes`, `schedule`, `recurrence`, `location`, `sourceUrl` |
| `{ objectKind: 'plan', type: PlanType }` | The common Activity fields above plus only the `details` fields valid for that already-selected visible Plan type |
| `{ objectKind: 'listItem', listId }` | `title`, `note`, `location`, and only `details` fields valid for the target list's stored behaviour. The route checks list membership before parsing. |

`objectKind`, `type`, `listId`, `participants`, `audience`, `visibility`, membership,
`reminders`, `offsetMinutes`, and notification actions are never model output and never appear
inside `fields`. A phrase such as “with Alice” may be retained in `ignored` for the review UI,
but capture does not resolve Alice, add her, or turn a Task into a Plan. A phrase such as
“remind me an hour before” remains source text and never changes the visible Reminder control.
Sharing and reminder setup are always separate user actions; the only reminder value that may
already be visible is the user's explicitly saved default.

**The server never creates a Task, Plan, or ListItem from a parse result.** It returns a
target-compatible draft; the client shows the matching review form; the user confirms; the
client calls the endpoint named by `creationTarget`. This is a hard product rule (concept
§13) and a security property.

### 2.12 Notifications

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/notifications?cursor=` | In-app inbox. |
| `POST` | `/v1/notifications/:id/read` | |
| `POST` | `/v1/notifications/read-all` | |
| `GET`/`PATCH` | `/v1/me/notification-preferences` | Per-category toggles + quiet hours. |

Categories, which are the toggle keys and a closed enum in
`packages/shared/src/notifications.ts`. The authoritative catalogue of individual
notification keys, their triggers and their copy lives in
[`../01-product/notifications.md`](../01-product/notifications.md) §7.

| Category | Covers |
| --- | --- |
| `reminders` | The caller's own `REM#` rows firing. Never anyone else's, on any plan. |
| `invitations` | Plan invitations and list invitations |
| `rsvp` | Someone responded, or a response was reset by a date change |
| `plan_changes` | `plan_date_set`, `plan_date_changed`, time and location edits |
| `plan_activity` | Posted updates on a shared plan. Off by default. |
| `expenses` | An expense was added or edited on a shared plan |
| `unsettled` | Outstanding balance nudges. Off by default. |
| `lists` | `added_to_list` and the batched `list_items_added` digest |

`lists` is batched, never per-item. The digest rule is in
[`../01-product/notifications.md`](../01-product/notifications.md) §3.7.

---

## 3. Authorisation rules

Baseline read/write/owner access is enforced in the shared middleware, not scattered through
handlers. Complete/uncomplete/skip/snooze are the deliberate exception: the service first
hydrates Activity + parent context, then both route guards and agenda projection call the same
pure `deriveActionCapabilities(ctx)` policy.

| Actor | Can |
| --- | --- |
| Owner | Everything on their activity, including delete and removing participants. |
| Participant (app user) | Read the activity, change **their own** RSVP, manage **their own** reminders, add and withdraw date suggestions, mark a suggestion as workable, add updates, add expenses. **Cannot complete, skip or snooze the plan** — that is global and owner-only. Cannot reschedule, rename, delete, or remove others. |
| Parent owner or participant, on a **prep task** of that plan | May complete, uncomplete and edit it, whoever created it. This **does** require a rule beyond the child owner check: *the parent owner or a parent participant may act on a child*. See the decision below. |
| List owner | Everything on their list, including delete, member management, and changing `behaviour`, `capabilities` or `slot`. |
| List member | Full CRUD on **items**, plus rename the list, schedule an item using an explicit audience, and leave it. Can receive only their own per-viewer Activity link in a list response. Cannot change behaviour or capabilities (destructive under the interaction contract), delete the list, or remove anyone but themselves. |
| Guest with valid invite token | Read the public projection, set their own RSVP. Nothing else. |
| Anyone else | `404 not_found` — never `403`, to avoid leaking existence. |

Ownership is checked by loading `ACT#<id>/META` and comparing `ownerId`, plus a
`PART#<personId>` lookup for participant access. When the activity has a
`parentActivityId`, action-context hydration also loads the parent `ownerId` and consults the
**parent's** participant set. For lists, the
same middleware requires the caller's exact `USER#<userId>` / `LIST#<listId>` pointer, then
loads `LIST#<id>/META` for ownership and capabilities. `MEMBER#` is roster and lifecycle
state; `LLINK#` is People discovery state. **Neither can substitute for the pointer or
authorise a list read.** Never trust an ID in the path.

The owner has no `MEMBER#` row: their roster entry is derived from `LIST#/META`, their owner
pointer and profile. Consequently `memberCount` is the owner plus physical non-owner member
rows, and a private list has `memberCount: 1` with zero `MEMBER#` rows.

> **Decision: completion authority follows the object, and a prep task is not a plan.**
>
> Completing a *plan* asserts a shared fact about an event — it happened, or it did not —
> so only the owner may say so. Completing a *prep task* ticks an item on a shared
> checklist. If Alice books the hotel for a trip we are planning together, she must be able
> to tick "Book hotel" whether or not she typed it.
>
> So a prep task behaves like an item on a **shared list**, not like a plan outcome, and
> that is the consistent reading rather than a special case: in both places, a collaborator
> may check a shared checklist item. It costs one pure service-layer rule — the child owner,
> parent owner or a parent participant may act on the child — applied by both projection and
> endpoint guards, not reimplemented per endpoint.

**Two self-service exceptions**, both of which must be explicit in the middleware rather
than emergent from an owner check:

- A participant may `DELETE /v1/activities/:id/participants/:personId` **for themselves** —
  leaving a plan.
- A list member may `DELETE /v1/lists/:id/members/:personId` **for themselves** — leaving a
  list.

Everything else under those two paths is owner-only. A member with
`status: 'invited'` who has not yet signed up can read nothing: they have no `userId`, so
no request can authenticate as them.

List membership and Plan participation are independent grants. Access to a shared ListItem
does not grant access to a Plan another member created from it. Every list response therefore
projects `ListItemActivityLink` by the token's user id and then applies ordinary Activity
authorisation to the referenced id; it never returns another viewer's pointer for the client
to hide.

---

## 4. Rate limits

Applied per user (authenticated) or per IP (public), enforced in Lambda with a DynamoDB
counter, `429 rate_limited` with `Retry-After`.

| Scope | Limit |
| --- | --- |
| Authenticated, general | 120 req / min |
| `POST /v1/capture/*` | 20 req / hour (protects the model spend) |
| `POST /v1/attachments/upload-url` | 60 / hour |
| `/public/v1/*` | 30 req / min per IP |
| `POST /public/v1/auth/token\|refresh\|logout` | 10 req / min per IP (overrides the line above) |
| `POST /public/v1/auth/refresh` | additionally 60 / hour per IP |

---

## 5. Versioning and deprecation

- Additive changes (new optional field, new endpoint) ship without a version bump.
- Breaking changes create `/v2` for that resource only; `/v1` stays for 90 days.
- The mobile client sends `X-Client-Version`; the server may return
  `426 upgrade_required` with an `updateUrl` to force an update for a genuinely broken
  build. Wire this in Phase 5, before the first TestFlight.

---

## 6. OpenAPI

`packages/shared/src/openapi.ts` generates the spec from the Zod schemas via
`zod-to-openapi`. It is written to `docs/generated/openapi.json` by
`pnpm run gen:openapi` and **checked in**. CI fails if it is stale. This is how a new
agent discovers the API without reading every handler.
