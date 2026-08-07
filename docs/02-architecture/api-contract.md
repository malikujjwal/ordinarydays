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
| `Idempotency-Key` | request | Required on all `POST` that create. UUID from the client. |
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

Error codes are a closed enum in `packages/shared/src/errors.ts`:
`unauthenticated`, `forbidden`, `not_found`, `validation_failed`, `conflict`,
`rate_limited`, `series_limit_exceeded`, `participant_limit_exceeded`,
`invite_expired`, `invite_revoked`, `internal`.

### Pagination

Cursor-based only. `?limit=` (default 50, max 200) and `?cursor=` (opaque base64 of the
DynamoDB `LastEvaluatedKey`). Never offset pagination.

### Validation

Zod schemas in `packages/shared/src/schemas/`. **The same schema object is imported by
both the Lambda and the client** — that is the whole reason for the shared package. The
Lambda validates on the way in; the client validates on the way out and gets types for
free.

### Idempotency

`POST` creates write an `IDEM#<userId>#<key>` item with a 24 h TTL holding the response body.
A repeat with the same key returns the stored response with `200` instead of creating a
duplicate. Required because mobile networks retry.

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
| `PATCH` | `/v1/me` | `displayName`, `timezone`, `currency`, `weekStartsOn`, `defaultReminderOffset` |
| `POST` | `/v1/me/devices` | Register an Expo push token. Body: `{ expoPushToken, platform, deviceName }` |
| `DELETE` | `/v1/me/devices/:deviceId` | |
| `DELETE` | `/v1/me` | Account deletion. Soft-deletes, purges after 30 days. Required by App Store. |
| `GET` | `/v1/me/export` | Data export. Returns a presigned link, valid 24 hours, to a JSON file of the user's activities, lists and settings. Phase 4. |
| `GET` | `/v1/me/suggestions?kind=meal` | Derived suggestions — the FAVOURITES group on the Add screen. Computed from completed activities, cached one hour. Never a stored flag. Phase 8. |

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
    "warnings": []
  }
}
```

Each entry is an **AgendaItem**, a trimmed projection — not the full Activity:

```ts
interface AgendaItem {
  activityId: string;
  occurrenceDate?: string;    // present iff this came from a recurring series
  type: ActivityType;
  title: string;
  status: ActivityStatus | 'completed_occurrence' | 'skipped_occurrence';
  time?: string;              // HH:mm effective time (after snooze override)
  endTime?: string;
  isRecurring: boolean;
  isSnoozed: boolean;
  hasCheckbox: boolean;       // true iff type === 'task'
  participantAvatars: { personId: string; displayName: string; avatarUrl?: string }[];
  participantCount: number;
  locationLabel?: string;
  subtitle?: string;          // "Meal · Chicken tacos", "S2 E4", "Zahav"
  isPast: boolean;
}
```

Additional `AgendaItem` field:

```ts
  overdueFromDate?: string;   // YYYY-MM-DD — set when this item rolled forward from a
                              // past date. The stored activity is NOT mutated.
```

Query parameters:

| Param | Effect |
| --- | --- |
| `include=anytime_unscheduled` | Merges the undated Anytime bucket into the first day. Today uses this; a multi-day Plans view does not. |
| `include=overdue` | Rolls incomplete, non-recurring **tasks** with a date in the past forward onto the first day, each carrying `overdueFromDate`. Capped at 30 days back. Never applies to recurring occurrences or non-task types. See `../01-product/today-and-tasks.md` §7. |

Both may be combined: `?include=anytime_unscheduled,overdue`.
- Window capped at 62 days → `400 validation_failed`.
- Response is cacheable client-side for 60 s; server sends `ETag`.

Also:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities?filter=inbox\|upcoming\|past\|saved&type=&cursor=` | Flat, paginated lists. Not for Today. |

### 2.3 Activities

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/activities` | Create. Body = `CreateActivityInput`. Requires `Idempotency-Key`. |
| `GET` | `/v1/activities/:id` | Full detail: activity + participants + expenses + updates + attachments + children. One DynamoDB Query. |
| `PATCH` | `/v1/activities/:id` | Partial update. Optimistic concurrency via `If-Match: <updatedAt>`; mismatch → `409 conflict`. |
| `DELETE` | `/v1/activities/:id` | Owner only. Cascades per `data-model.md` §7. |
| `POST` | `/v1/activities/:id/schedule` | `{ date, time?, endTime?, timezone }`. Also used to *unschedule* with `{ date: null }`. |
| `POST` | `/v1/activities/:id/complete` | `{ occurrenceDate?, outcome? }`. With `occurrenceDate` → writes an Occurrence, never touches the series. |
| `POST` | `/v1/activities/:id/uncomplete` | Reverses the above. |
| `POST` | `/v1/activities/:id/skip` | `{ occurrenceDate? }` |
| `POST` | `/v1/activities/:id/snooze` | `{ occurrenceDate, until }` — `until` is `HH:mm` (same day) or an ISO instant. |
| `POST` | `/v1/activities/:id/duplicate` | |
| `GET` | `/v1/activities/:id/ics` | Single-event `.ics`. Authenticated variant of the public one. |

`CreateActivityInput`:

```ts
{
  type: ActivityType;
  title: string;                       // 1..200
  notes?: string;                      // ..4000
  schedule?: { date, time?, endTime?, timezone };
  recurrence?: Recurrence;
  reminders?: { offsetMinutes: number }[];
  location?: { label, address?, lat?, lng?, mapUrl? };
  details?: ActivityDetails;           // must match `type`
  parentActivityId?: string;
  fromListItem?: { listId: string; itemId: string };
  participants?: ({ personId: string } | { displayName: string; email?: string })[];
  attachmentIds?: string[];
  sourceUrl?: string;
}
```

### 2.4 Participants and RSVP

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/activities/:id/participants` | Add one. Existing contact by `personId`, or new by `{ displayName, email? }`. Returns the created `Participant` and, for guests, an `inviteUrl`. |
| `PATCH` | `/v1/activities/:id/participants/:personId` | `{ rsvp }`. A participant may only change their own RSVP; the owner may change anyone's. |
| `DELETE` | `/v1/activities/:id/participants/:personId` | Owner only, or self (leave a plan). |
| `POST` | `/v1/activities/:id/invites` | Create a shareable (non-personalised) link. Returns `{ token, url, expiresAt }`. |
| `DELETE` | `/v1/activities/:id/invites/:token` | Revoke. |

Cap: 50 participants per activity → `422 participant_limit_exceeded`.

### 2.5 Updates (the plan's activity feed)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/updates?cursor=` | Newest first. |
| `POST` | `/v1/activities/:id/updates` | `{ body }`. System entries ("Alice is going", "Time changed to 8 PM") are written server-side with `kind: 'system'`. |

### 2.6 Attachments

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/attachments/upload-url` | `{ contentType, byteSize }` → `{ attachmentId, uploadUrl, key }`. Presigned S3 `PUT`, 5-minute expiry, 10 MB cap, image MIME types only. |
| `POST` | `/v1/activities/:id/attachments` | Confirm the upload and link it. |
| `DELETE` | `/v1/activities/:id/attachments/:attachmentId` | |

Images are served through CloudFront with a signed-URL or a per-object random key path
(`u/<userId>/<ulid>.<ext>`). Never make the bucket public.

### 2.7 Lists

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/lists` | |
| `POST` | `/v1/lists` | `{ kind, title, sourceActivityId? }` |
| `GET` | `/v1/lists/:id?includeItems=true` | |
| `PATCH` | `/v1/lists/:id` | |
| `DELETE` | `/v1/lists/:id` | |
| `GET` | `/v1/lists/:id/items?cursor=` | |
| `POST` | `/v1/lists/:id/items` | `{ title, note?, details?, afterItemId? }` — `afterItemId` drives the lexo rank. |
| `POST` | `/v1/lists/:id/items/bulk` | `{ items: [...] }` — used by "add ingredients to Groceries". |
| `PATCH` | `/v1/lists/:id/items/:itemId` | `{ title?, checked?, note?, details?, afterItemId? }` |
| `DELETE` | `/v1/lists/:id/items/:itemId` | |
| `POST` | `/v1/lists/:id/items/:itemId/schedule` | **The Lists → Plans bridge.** Body is a `CreateActivityInput` minus `type` (inferred from `list.kind`). Creates the Activity, links it to the item, returns both. Does not duplicate the item. |
| `POST` | `/v1/lists/:id/clear-checked` | |

List kind → default activity type when scheduling:

| `list.kind` | activity `type` |
| --- | --- |
| `watchlist` | `watch` |
| `meals` | `meal` |
| `restaurants` | `outing` |
| `places` | `outing` |
| `groceries`, `shopping`, `packing` | `task` |
| `general` | `custom` |

The client may override the inferred type. It is a suggestion, per the product principle.

### 2.7a Shortcuts — Phase 8

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
| `GET` | `/v1/people?sort=relevance` | Sorted by upcoming shared plans → outstanding balance → recency (concept §22). |
| `GET` | `/v1/people/suggested` | FREQUENT + RECENT buckets for the participant picker (concept §23). |
| `POST` | `/v1/people` | Create a contact manually. |
| `GET` | `/v1/people/:id` | The person view: upcoming together, recent together, net balance. |
| `PATCH` | `/v1/people/:id` | |
| `DELETE` | `/v1/people/:id` | Blocked with `409` if they participate in any non-completed activity. |
| `POST` | `/v1/people/:id/merge` | `{ intoPersonId }`. Used when a guest registers. |

### 2.9 Expenses and settlement

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/activities/:id/expenses` | Includes a computed `owes` summary for the activity. |
| `POST` | `/v1/activities/:id/expenses` | `{ description, amountCents, currency, paidByPersonId, splitMode, splits }`. Server validates that splits sum exactly to `amountCents`. |
| `PATCH` | `/v1/activities/:id/expenses/:expenseId` | |
| `DELETE` | `/v1/activities/:id/expenses/:expenseId` | |
| `GET` | `/v1/balances` | All net balances. |
| `GET` | `/v1/people/:id/balance?include=expenses` | Net figure **plus** the underlying expense lines. The client must never render a balance without being able to drill in. |
| `POST` | `/v1/settlements` | `{ personId, amountCents, currency, note?, coversExpenseIds }` → marks those expenses settled. |
| `GET` | `/v1/settlements?personId=` | |
| `DELETE` | `/v1/settlements/:settlementId` | Undo a settlement. Clears `settledPersonIds` on each covered expense. |
| `POST` | `/v1/balances/recalculate` | Full rebuild of the caller's balances from `Expense` and `Settlement` rows. 3 / hour per user. Returns the rebuilt balances and the rows written and deleted. |

Split arithmetic rule: distribute remainder cents to the first N participants in
`personId` sort order so totals reconcile exactly. Unit-test it. Never round to floats.

### 2.10 Public (unauthenticated) invite surface

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/public/v1/invites/:token` | Plan details for the public page. Returns only what the invite is allowed to reveal: title, date/time, location, description, poster image, organiser display name, RSVP counts. **Never** returns expenses, notes, other participants' emails, or any other activity. |
| `POST` | `/public/v1/invites/:token/rsvp` | `{ response: 'going'\|'maybe'\|'declined', displayName?, email? }`. Rate-limited by IP. |
| `GET` | `/public/v1/invites/:token/ics` | `text/calendar` download. |
| `GET` | `/public/v1/invites/:token/calendar/google` | `302` to a Google Calendar template URL. |
| `GET` | `/public/v1/invites/:token/stop` | Revokes the token and returns a plain confirmation page. The entire unsubscribe mechanism for invite emails. |

Invite tokens expire 90 days after the plan's date. Expired → `410 invite_expired`.

### 2.11 Capture — Phase 7, stubbed earlier

These ship as **stubs returning `501 not_implemented` from Phase 1**, so the client
integration is written once and the AI work slots in behind a stable contract.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/capture/parse` | `{ text, tz }` → `ParsedCapture` |
| `POST` | `/v1/capture/extract` | `{ attachmentId }` → `ParsedCapture` (image → event) |
| `POST` | `/v1/capture/link` | `{ url }` → `ParsedCapture` |

```ts
interface ParsedCapture {
  suggestedType: ActivityType;
  confidence: number;                  // 0..1 overall
  fields: {
    [K in keyof CreateActivityInput]?: {
      value: unknown;
      confidence: number;              // < 0.7 => client highlights it for review
      sourceSpan?: [number, number];   // character range in the input text
    }
  };
  unresolvedPeople?: string[];         // names we couldn't match to a contact
  rawModelOutput?: string;             // dev only, stripped in prod
}
```

**The server never creates an activity from a parse result.** It returns a draft; the
client shows the review screen; the user confirms; the client calls
`POST /v1/activities`. This is a hard product rule (concept §13) and a security property.

### 2.12 Notifications

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/notifications?cursor=` | In-app inbox: invitations, RSVP changes, plan changes, expense additions. |
| `POST` | `/v1/notifications/:id/read` | |
| `POST` | `/v1/notifications/read-all` | |
| `GET`/`PATCH` | `/v1/me/notification-preferences` | Per-category toggles + quiet hours. |

---

## 3. Authorisation rules

Enforced in a single middleware, not scattered through handlers.

| Actor | Can |
| --- | --- |
| Owner | Everything on their activity, including delete and removing participants. |
| Participant (app user) | Read the activity, change **their own** RSVP, add updates, add expenses, mark their own occurrence complete. Cannot reschedule, rename, delete, or remove others. |
| Guest with valid invite token | Read the public projection, set their own RSVP. Nothing else. |
| Anyone else | `404 not_found` — never `403`, to avoid leaking existence. |

Ownership is checked by loading `ACT#<id>/META` and comparing `ownerId`, plus a
`PART#<personId>` lookup for participant access. Never trust an ID in the path.

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
  build. Wire this in Phase 4, before the first TestFlight.

---

## 6. OpenAPI

`packages/shared/src/openapi.ts` generates the spec from the Zod schemas via
`zod-to-openapi`. It is written to `docs/generated/openapi.json` by
`pnpm run gen:openapi` and **checked in**. CI fails if it is stale. This is how a new
agent discovers the API without reading every handler.
