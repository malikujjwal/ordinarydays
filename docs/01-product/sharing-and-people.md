# Sharing and people

**Status:** canonical for participants, invitations, guests and the People layer. Entities
are owned by
[`../02-architecture/data-model.md#47-person-and-participant`](../02-architecture/data-model.md#47-person-and-participant)
and
[`../02-architecture/data-model.md#49-invite`](../02-architecture/data-model.md#49-invite);
endpoints by
[`../02-architecture/api-contract.md#24-participants-and-rsvp`](../02-architecture/api-contract.md#24-participants-and-rsvp)
and
[`../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface`](../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface).

---

## 1. The model in one paragraph

A **Person** is a contact in one user's address book. A **Participant** is a Person
attached to one Activity, with an RSVP. A Person may or may not be a registered app user;
if they are, `person.linkedUserId` is set and they get the plan on their own Today. If they
are not, they are a **guest** and get a public invite link instead. There is no friend
graph, no mutual connection, no request-and-accept. People exist because plans were shared
with them. See
[`overview.md`](overview.md#6-non-goals).

---

## 2. Adding people to a plan

### 2.1 Where

| Surface | Affordance |
| --- | --- |
| Creation form (meal, watch, event, outing, custom) | The `People` field |
| Plan detail | `Add people` in the PEOPLE section, and the `Share` action in the header |
| Person view | `Plan something with Alice` — starts an Add flow with Alice pre-added |

Adding the first participant flips `activity.visibility` to `shared` and starts the updates
feed. Removing the last one does **not** flip it back; a plan that was shared stays shared,
because its updates feed and any expenses are now history.

> **Decision:** `visibility` is one-way. Silently un-sharing a plan that people have seen,
> commented on, or spent money on would erase context. Owners who want it private again
> delete it.

### 2.2 The participant picker

One sheet, one search field, three buckets:

```
┌─────────────────────────────────────────┐
│  Add people                      Done   │
│  ┌───────────────────────────────────┐  │
│  │ Search or type a name             │  │
│  └───────────────────────────────────┘  │
│  Selected:  (A) Alice  ✕                │
│                                         │
│  FREQUENT                               │
│    Alice          ✓                     │
│    Ben                                  │
│    Chloe                                │
│                                         │
│  RECENT                                 │
│    Dev                                  │
│    Priya                                │
│                                         │
│  ─────────────────────────────────      │
│    + Add "Marcus" as a new person       │
└─────────────────────────────────────────┘
```

Data comes from `GET /v1/people/suggested`
([`../02-architecture/api-contract.md#28-people`](../02-architecture/api-contract.md#28-people)).

| Bucket | Definition | Order | Size |
| --- | --- | --- | --- |
| **FREQUENT** | People with the most shared activities in the last 180 days, minimum 3 | Count descending, then `lastActivityAt` descending | Up to 8 |
| **RECENT** | People with a shared activity in the last 30 days who are not in FREQUENT | `lastActivityAt` descending | Up to 8 |
| **Search results** | Case-insensitive substring match on `displayName` and `email` across all the user's people | Match quality, then FREQUENT membership, then name | Up to 20 |

> **Decision:** the FREQUENT thresholds (180 days / ≥ 3 shared activities) and RECENT
> window (30 days) are chosen so a new user's picker is not empty and a heavy user's is not
> noise. They are server-side constants in one place and tunable without a client release.

Behaviour:

- Tapping a row toggles selection. Selected people appear as removable chips above the
  buckets.
- Typing a name with no match offers `+ Add "<name>" as a new person`, which opens a
  two-field inline form: display name (pre-filled) and optional email.
- If the typed text is a valid email address that matches an existing app user's verified
  email, the row shows a `Has the app` badge and adding them creates a linked Person, not a
  guest.
- Selection is applied on `Done`, as one `POST /v1/activities/:id/participants` per person.
  On a not-yet-created activity, selections are held locally and sent inside
  `CreateActivityInput.participants[]`.
- The cap is **50 participants per activity**; the 51st selection is refused inline with
  `You can add up to 50 people to a plan.` See
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).

### 2.3 What happens on add

| Person type | Server does | Person receives |
| --- | --- | --- |
| Registered app user (`linkedUserId` set) | Writes `PART#`, an `ActivityIndex` entry in **their** partition, and `PLINK#` rows both ways | An in-app invitation and a push notification (§3) |
| Guest with an email | Writes `PART#`, the owner's `PERSON#`, `PLINK#`, and an `INVITE#<token>` | An email from SES containing the public invite link (§4) |
| Guest with no email | Writes the same minus the email send | Nothing automatic — the owner gets a copyable link to send however they like |

The owner always sees the invite link on the participant's row and can copy or re-send it.

---

## 3. App-user invitations

### 3.1 The invitation

An invited app user gets:

1. A push notification (`invitation_received`, on by default — see
   [`notifications.md`](notifications.md#7-notification-catalogue)).
2. An entry in the in-app notification inbox.
3. The plan on their **Today** and in **Plans** immediately, with `rsvp: 'pending'` and a
   pending badge. It is not hidden until they respond; a dinner on Thursday is information
   they need whether or not they have tapped a button.

### 3.2 RSVP

Three responses: **Going**, **Maybe**, **Decline**. There is no fourth, no free-text reply
in the RSVP control, and no "seen" state.

`PATCH /v1/activities/:id/participants/:personId` with `{ rsvp }`. A participant may only
change their own; the owner may change anyone's (for the case of relaying a reply that came
by text message).

| Response | Effect |
| --- | --- |
| `going` | Row stays on Today and Plans, badge clears. Counts toward the plan's `Going` count. |
| `maybe` | Row stays on Today and Plans with a `Maybe` badge. |
| `declined` | The plan is removed from the invitee's Today, Plans and agenda: the `ActivityIndex` entry is deleted. It remains visible in their notification inbox for 30 days, and re-accepting from there restores it. The owner sees them listed as `Declined`. |

Every RSVP change writes a system entry to the updates feed (`Alice is going`) and notifies
the owner (`rsvp_changed`). Changing an RSVP later is always allowed, including after the
plan's date.

### 3.3 What appears on the invitee's Today

The same `AgendaItem` the owner sees, with these differences:

- A pending-RSVP badge and inline `Going · Maybe · Decline` actions until they respond.
- The owner's name in the subtitle when the plan has no location:
  `From Alice`.
- No prep tasks of the owner's that are not shared (prep tasks on a shared plan are
  visible; a prep task on a *private* plan is not, because the plan is not shared).

### 3.4 What a participant can and cannot change

Enforced in one authorisation middleware, per
[`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules).

| Action | Owner | Participant (app user) | Guest |
| --- | --- | --- | --- |
| Read the full plan | Yes | Yes | No — public projection only (§4.2) |
| Change their own RSVP | Yes | Yes | Yes, via the token |
| Change someone else's RSVP | Yes | No | No |
| Post an update | Yes | Yes | No |
| Add an expense | Yes | Yes | No |
| Edit or delete **their own** expense | Yes | Yes | No |
| Edit or delete someone else's expense | Yes | No | No |
| Mark their own occurrence complete | Yes | Yes | No |
| Complete the plan for everyone | Yes | No | No |
| Rename, reschedule, change location, change type | Yes | No | No |
| Add or remove participants | Yes | No | No |
| Leave the plan | n/a — the owner deletes it | Yes (`DELETE .../participants/:self`) | No |
| Add attachments | Yes | No | No |
| Delete the plan | Yes | No | No |
| Add prep tasks | Yes | Yes | No |
| Complete a prep task | Yes | Yes | No |

A participant attempting an owner action gets `403 forbidden`. A non-participant gets
`404 not_found`, never `403`, so the API never confirms that an activity exists.

> **Decision:** participants may add prep tasks and complete them. A shared trip where only
> the owner can add "book the rental car" makes the owner a bottleneck, and prep tasks are
> low-risk: they cannot change when or where the plan happens.

> **Decision:** participants may **not** add attachments in v1. Attachment uploads are the
> one place a participant could push arbitrary bytes into the owner's S3 prefix, and the
> moderation and quota questions that follow are out of scope for v1.

---

## 4. Guests and the public invite page

Requiring an install to attend a dinner is the friction the product exists to remove.

### 4.1 The link

`https://ordinarydays.app/invite/<token>`

- `token` is 22 characters of base62 from `crypto.randomBytes(16)` — **not** a ULID, so it
  leaks neither creation order nor guessable structure
  ([`../02-architecture/data-model.md#8-ids`](../02-architecture/data-model.md#8-ids)).
- A **personalised** invite has `personId` set and pre-fills that guest's name and RSVP
  state. A **shareable** invite (`POST /v1/activities/:id/invites`) has no `personId` and
  collects a name from whoever opens it.
- The page is server-rendered-equivalent static content hydrated from
  `GET /public/v1/invites/:token`. It is the only unauthenticated screen in the product.

### 4.2 Exactly what the page shows

The page renders these fields and no others:

| Shown | Source |
| --- | --- |
| Plan title | `activity.title` |
| Date, start time, end time, timezone | `activity.schedule` |
| Location label and address | `activity.location.label`, `.address` |
| Description | `details.description` (`event`) — **not** `activity.notes` |
| Poster / cover image | The activity's `primaryAttachmentId`, served through CloudFront |
| Organiser display name | The owner's `displayName`. Never their email. |
| RSVP counts | Aggregate integers only: `4 going · 1 maybe` |
| The invited person's own name and current RSVP | Only for a personalised invite |
| Ticket link and price | `details.ticketUrl`, `details.priceCents` (`event` only) |

```
┌───────────────────────────────────────────┐
│           [ poster image ]                │
│                                           │
│   Food Festival                           │
│   Saturday 16 August · 12:00 – 6:00 PM    │
│   Eastern Time (US & Canada)              │
│   Penn's Landing, Philadelphia            │
│                                           │
│   An all-day street food festival …       │
│   $25 · Tickets ↗                         │
│                                           │
│   From Ujjwal · 4 going · 1 maybe         │
│                                           │
│   Are you coming?                         │
│   ┌────────┐ ┌────────┐ ┌────────┐        │
│   │ Going  │ │ Maybe  │ │Can't go│        │
│   └────────┘ └────────┘ └────────┘        │
│                                           │
│   Add to calendar                         │
│   Google · Apple · Download .ics          │
│                                           │
│   Made with Ordinary Days                 │
└───────────────────────────────────────────┘
```

### 4.3 Fields the public projection must never expose

This is an allow-list, enforced by a projection function in `services/api` and covered by a
snapshot test that fails when any key is added
([`overview.md`](overview.md#7-success-criteria-for-v1) S8).

Never returned by `/public/v1/invites/:token`, under any circumstance:

- `activity.notes`
- Any expense: amounts, splits, payers, settlement state, `expenseTotalCents`
- Any other participant's name, email, phone, avatar, or RSVP **individually** (only the
  aggregate counts)
- Any email address at all, including the organiser's
- Any `userId`, `personId`, `activityId`, or other internal identifier
- Any other activity of the owner's, including prep tasks and children
- Any list, list item, or list content
- Any attachment other than the single cover image
- The updates feed, in whole or in part
- `recurrence`, `reminders`, or occurrence data
- `location.lat` / `location.lng` when `location.address` is absent — do not leak precise
  coordinates for a plan whose address the owner chose not to write
- `sourceUrl` when it is not `details.ticketUrl`

A field that is not on the §4.2 list is not on the page. When in doubt, it is excluded.

### 4.4 The RSVP flow with no account

Three taps, under 30 seconds
([`overview.md`](overview.md#7-success-criteria-for-v1) S4).

1. Open the link. The page loads with no interstitial, no cookie banner, no "get the app"
   overlay.
2. Tap `Going`, `Maybe` or `Can't go`.
3. If the invite is personalised, the response is recorded immediately and the page shows
   `You're going. See you Saturday.` If it is a shareable link, a single name field appears
   with the button `Confirm`; email is offered but explicitly optional and labelled
   `Optional — only used to send you updates about this plan.`

`POST /public/v1/invites/:token/rsvp` is rate-limited to 30 requests per minute per IP
([`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits)).
The response updates the `Participant` row, writes a system entry to the updates feed, and
notifies the owner.

A guest may change their response any number of times by revisiting the link. The page
always shows their current answer.

There is **no** account creation prompt above the fold. A single unobtrusive line at the
bottom (`Made with Ordinary Days`) links to the marketing page. No modal, no interstitial,
no email capture wall.

### 4.5 Calendar export

Three options, all available without an account:

| Option | Endpoint | Behaviour |
| --- | --- | --- |
| Google | `GET /public/v1/invites/:token/calendar/google` | `302` to a Google Calendar template URL with title, start, end, location and description pre-filled |
| Apple | `GET /public/v1/invites/:token/ics` | Serves `text/calendar`; iOS opens it in Calendar directly |
| Download `.ics` | Same endpoint, `Content-Disposition: attachment` | For desktop and everything else |

The `.ics` contains only the fields in §4.2, a `UID` derived from the token (not the
activity id), and no `ATTENDEE` lines — exporting a plan must not leak the guest list. It
carries no `RRULE`: a public invite is always for one occurrence.

Authenticated users get the same file from `GET /v1/activities/:id/ics`.

> **Decision:** the `.ics` omits `ATTENDEE` entirely rather than including the exporting
> guest. Some clients treat `ATTENDEE` as an invitation to reply by email, which would
> route replies somewhere the app does not read.

### 4.6 Token lifetime and revocation

| Property | Value |
| --- | --- |
| Expiry | 90 days after the plan's `schedule.date`. For an unscheduled activity, 90 days after the invite was created. |
| Expired behaviour | `410 invite_expired`. The page renders `This invitation has expired.` and nothing about the plan — not the title, not the date. |
| Revocation | `DELETE /v1/activities/:id/invites/:token` sets `revoked: true`. Immediately returns `410 invite_revoked` with the same blank page. |
| Removal of a participant | Revokes their personalised token as part of the same transaction. |
| Deletion of the plan | Revokes every token for it. |
| Rescheduling the plan | Does **not** revoke tokens. The page shows the new time; that is the point of a link being the source of truth. |
| Storage TTL | `invite.ttl` = `expiresAt` + 30 days, after which DynamoDB removes the row and the token resolves to `404`. |
| Rotation | The owner can rotate a shareable link (`POST` a new invite, `DELETE` the old). Personalised tokens are not rotatable; remove and re-add the person. |

---

## 5. Guest → registered user linking

When a guest later signs up, their history should attach to their account rather than
duplicate.

### 5.1 The trigger

On successful Cognito signup with a **verified** email, the API:

1. Writes `EMAIL#<lowercased-email>` → `USER` (access pattern 14 in
   [`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
2. Searches for `Person` rows across all owners whose `email` matches, case-insensitively,
   and which have no `linkedUserId`.
3. For each match, sets `person.linkedUserId` to the new user id and creates an
   `ActivityIndex` entry in the new user's partition for every non-completed activity that
   person participates in.

### 5.2 The rules

- **Verified email only.** An unverified address never links anything. Cognito's own
  verification is the gate; the API checks the `email_verified` claim.
- **No merge prompt on the guest's side.** The new user opens the app and their plans are
  already there. Asking "are you the Chloe that Ujjwal invited?" is both confusing and a
  disclosure of Ujjwal's address book.
- **The owner is not notified.** Their contact silently gains a `Has the app` badge.
- Completed and cancelled activities are **not** back-filled into the new user's index —
  they would arrive as history the user never chose to keep. They remain visible through
  the Person view when the relationship is used again.
- Guest expenses transfer with the person: the `Participant` and `Expense` rows already
  reference `personId`, which is unchanged, so balances continue to compute correctly and
  now appear on both sides.
- The reverse case — the owner adds an email to an existing guest Person that matches a
  registered user — links immediately on save, with the same effects.
- Duplicate contacts (the same human added twice with different spellings) are resolved by
  `POST /v1/people/:id/merge`, which is user-initiated from the Person view and moves
  `PLINK#`, `Participant` and `Expense` references onto the surviving `personId`.

> **Decision:** phone numbers are not a linking key in v1. Only verified email links a
> guest to an account. Phone is stored for the user's own reference and never matched.

---

## 6. The People layer

### 6.1 How people are derived

Contacts appear because plans were shared, and for no other reason.

| Source | Creates a Person |
| --- | --- |
| Adding someone to a plan | Yes |
| Someone adding *you* to a plan | Yes — the owner becomes a Person in your address book |
| A guest RSVPing to a shareable link | Yes, in the owner's address book only |
| `POST /v1/people` from the People page | Yes — the one manual route |
| Following, friending, importing a contact list, syncing an address book | **No such route exists** |

There is no reciprocal relationship object. Alice being in Ujjwal's people does not put
Ujjwal in Alice's people unless Alice has also been in a plan with him — which, in
practice, she has, because that is how she got there.

`person.upcomingCount` and `person.lastActivityAt` are denormalised counters maintained on
write. `PLINK#<personId>#<sortTs>#<activityId>` rows are the shared-activity feed
(access pattern 10).

### 6.2 Where People lives

Not in primary navigation. People is reached from **Profile → People** and from search.
This is deliberate: promoting it to a tab would make the app feel like a social product,
which it is not (concept §22).

### 6.3 The People page

`GET /v1/people?sort=relevance`. One flat list, no sections, no avatars grid.

Sort order, applied in this precedence:

1. `upcomingCount` descending — people you have plans with, first.
2. Absolute outstanding balance descending — people you owe or who owe you.
3. `lastActivityAt` descending — recent shared activity.
4. `displayName` ascending — stable final tie-break.

Each row shows: display name, a one-line summary, and a balance chip when non-zero.

```
Alice        3 upcoming · Alice owes you $42.50
Ben          1 upcoming
Chloe        You owe Chloe $18.00
Dev          Last together 12 Jul
```

A `Sort` control in the header offers `Relevance` (default), `Name`, `Balance`. The
alternate sorts are client-side re-orderings of the same response.

### 6.4 The Person view

`GET /v1/people/:id`. Answers two questions: *what are we doing together?* and *do we owe
each other anything?*

```
┌───────────────────────────────────────────┐
│  ‹ People                            ⋯    │
│                                           │
│   (A)  Alice                              │
│        alice@example.com · Has the app    │
│                                           │
│   3 upcoming together                     │
│   Alice owes you $42.50            ›      │   (tappable)
│                                           │
│   UPCOMING                                │
│     Dinner at Zahav              Aug 9    │
│     Food Festival                Aug 16   │
│     Watch Severance              Aug 23   │
│                                           │
│   RECENT                                  │
│     Movie Night     Attended · $18 unsettled │
│     Beach Trip      Attended · Settled    │
│                                           │
│   Plan something with Alice               │
└───────────────────────────────────────────┘
```

| Element | Rule |
| --- | --- |
| Header | Display name, email if known, `Has the app` badge when `linkedUserId` is set. Editable name and email via `⋯ → Edit`. |
| `n upcoming together` | Count of shared activities with a future `schedule.date`. Tappable — opens the full list. Never rendered without a drill-down. |
| Balance line | Net figure with direction stated in words, never a bare signed number. **Always tappable**, opening the expense breakdown ([`expenses.md`](expenses.md#5-balances)). Hidden entirely when the net is zero and there are no unsettled expenses. |
| UPCOMING | Shared activities with a future date, ascending. Max 5, then `See all`. |
| RECENT | Shared activities with a past date, descending, showing outcome and settlement state. Max 5, then `See all`. |
| `Plan something with Alice` | Opens Add with Alice pre-selected as a participant. |
| `⋯` | Edit, Merge with another person, Delete. Delete is blocked with `409` while they participate in any non-completed activity, and the UI explains which plans block it. |

---

## 7. Anti-goals

These do not exist and will not be added. Each is listed because a "people" feature invites
it.

| Not built | Why |
| --- | --- |
| Followers, following, friend requests, mutual connections | Relationships come from plans. A second, parallel relationship system would immediately disagree with the first. |
| A feed of what other people are doing | The app has exactly one feed, and it belongs to a single plan. |
| Likes, reactions, emoji responses | RSVP is the only reaction. Updates take text. |
| Public profiles, usernames, discoverability, search-for-people-by-name across the app | The only way to reach a person is to have shared a plan with them or to know their email. |
| Relationship scores, streaks, "you haven't seen Ben in a while" nudges | Quantifying friendships is the opposite of what a life planner should do. FREQUENT in the picker is a convenience ordering, is never shown as a number, and is never surfaced outside the picker. |
| Activity visible to "friends of friends", or to anyone not explicitly added | The only sharing primitive is adding a specific person or generating a specific link. |
| Contact-list import / address-book sync | An install-time contacts permission prompt is a trust cost with no matching benefit; people arrive through plans instead. |
| Direct messaging | Updates on a plan are scoped to that plan. There is no inbox between two people. |

---

## 8. Privacy rules a reviewer would check

Each is a specific, verifiable assertion.

| # | Rule | How it is verified |
| --- | --- | --- |
| P1 | A non-participant asking for an activity gets `404`, never `403`, so existence is not confirmed. | Integration test on `GET /v1/activities/:id` with a third user's token. |
| P2 | The public invite projection returns only the §4.2 allow-list. | Snapshot test with an explicit key allow-list; adding a key fails CI. |
| P3 | No endpoint returns another user's email except to the owner of the `Person` row holding it. | Contract review of every response schema; `email` appears only on `Person`, `Participant` (owner-scoped) and `/v1/me`. |
| P4 | An invite token cannot be enumerated. | 128 bits of entropy, base62. Rate limit of 30/min per IP on `/public/v1/*`. Invalid tokens return `404` with a constant-time-ish response and no distinguishing body. |
| P5 | Revoking an invite takes effect on the next request, with no cache window. | The public endpoint sets `Cache-Control: no-store`; CloudFront does not cache `/public/v1/*`. |
| P6 | Images are never publicly readable from S3. | Bucket is private with OAC; objects are served only through CloudFront at unguessable keys (`u/<userId>/<ulid>.<ext>`). A direct S3 URL returns `403`. |
| P7 | A declined participant retains no read access. | Their `ActivityIndex` entry is deleted and the `PART#` row's `rsvp` is `declined`; the authorisation middleware treats `declined` as a participant for RSVP changes only, and `404`s every other route. |
| P8 | Deleting an account removes or anonymises the user's data within 30 days. | `DELETE /v1/me` soft-deletes, purges after 30 days. Activities they own are deleted; their participation in others' plans is replaced by the display name only, with `linkedUserId` cleared. |
| P9 | Notes are never shared. `activity.notes` is owner-only, even on a shared plan. | Response schema for `GET /v1/activities/:id` strips `notes` for non-owners. Test with a participant token. |
| P10 | Location coordinates are not exposed publicly unless the owner wrote an address. | §4.3. Test with an activity that has `lat`/`lng` but no `address`. |
| P11 | Adding a person never notifies anyone other than that person. | No fan-out on `POST /v1/activities/:id/participants` beyond the added person and, for RSVP changes, the owner. |
| P12 | Guest email addresses are used only to send that guest's invite and updates for that plan. | SES sends are triggered only from invite creation and `plan_changed` / `plan_cancelled` on plans the guest is on. There is no marketing send path and no list export. |
