# AI capture

> **Phase 8.** `POST /v1/capture/parse`, `/v1/capture/extract` and `/v1/capture/link` ship
> as **`501 not_implemented` stubs from Phase 1** and stay that way until Phase 8. The
> client is written against the finished contract from the start so nothing has to be
> rewritten when the implementation lands. Every screen in this document must degrade to
> the manual path described in §6.2 while the stubs are in place, and that degraded path is
> what ships in v1.

**Status:** canonical for capture UX and the parse contract. The response type
`ParsedCapture` is owned by
[`../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier).

---

## 1. Scope

Three capabilities, one response shape, one review screen — all downstream of explicit
intent. Before any request, the client already knows **Task**, **Plan**, or **List item**;
for a Plan it also knows **General**, **Meal**, **Watch**, **Event**; for a
List item it knows the destination list.

| Capability | Endpoint | Runs only after | Typical source |
| --- | --- | --- | --- |
| **Natural-language capture** | `POST /v1/capture/parse` | The matching form is selected | The user chooses **Plan → Watch**, then types `Watch Severance Friday at 8` |
| **Image field extraction** | `POST /v1/capture/extract` | The matching form is selected | The user chooses **Plan → Event**, then photographs a poster |
| **Link field extraction** | `POST /v1/capture/link` | The matching form is selected | The user chooses **Plan → Event**, then pastes a restaurant page |

All three return `ParsedCapture`. All three are **drafts**. None of them writes anything.

Out of scope for Phase 8 and beyond unless a product decision reopens it: voice
transcription (iOS dictation covers it), continuous inbox scanning, email parsing, calendar
import, and any background processing the user did not initiate.

### 1.1 The hard rule

**Capture never chooses what the user means and never creates or shares anything.**

```
user chooses Task / Plan / List item
        → Plan kind or list destination, when required
        → capture endpoint returns compatible field suggestions
        → review in the already selected form
        → user activates Save task / Save plan / Add to <list name>
```

The response must not select or suggest object kind, Plan kind, participants, sharing,
privacy, list destination, saving, or a reminder/notification action. A type-like,
people-like, or reminder-like value returned by an older server is ignored and never rendered.
Capture can suggest compatible descriptive and schedule field values only. The visible
Reminder control remains `Off` or shows the user's explicitly saved default until the user
changes it.

This is a product rule (concept §13), a security property (an unauthenticated-ish input
path must not be able to write), and a testable one: integration tests assert that calling
any capture endpoint produces zero writes to `od-main-*` and cannot alter the client-owned
selection. See
[`overview.md`](overview.md#44-suggest-never-auto-create).

---

## 2. Where capture appears

Capture is never the first step and never a separate destination. It appears inside the
Task, Plan, or List-item form selected through
[`activities.md`](activities.md#22-the-global-object-chooser). Camera, Photos, Link, and
the text parser are unavailable until object kind, Plan kind when applicable, and list
destination when applicable are known.

| Trigger | When the call fires |
| --- | --- |
| Typing | After a 600 ms pause once the text is ≥ 8 characters. Only one in-flight request at a time; newer input cancels the older. Activating the named write button cancels the parse and saves only what is visible. |
| Camera / Photos | Immediately after the upload completes |
| Link | On paste into the already selected form |
| iOS share sheet | After the user makes the required object, Plan-kind, and destination choices; the payload is held locally until then |

While a parse is in flight the selected form stays fully usable. The user can keep typing,
use `Change` to return to a chooser (which cancels the parse), or activate `Save task`,
`Save plan`, or `Add to <list name>` (which cancels the parse and writes only what is on
screen). Parsing never blocks and can never invoke a write action.

---

## 3. The review screen

For text capture the review happens in the already selected form as compatible fields fill
in. Image and link capture use a dedicated review step inside that same selected form,
because there is more to check. Capture never transitions into another form.

### 3.1 Anatomy

```
┌─────────────────────────────────────────────────────┐
│  Cancel                                  Save plan  │
│                                                     │
│  [ source image thumbnail ]  Plan · Event   Change  │  (1)
│                                                     │
│  Check these before saving                          │  (2)
│                                                     │
│  Title                                              │
│  ┌───────────────────────────────────────────────┐  │
│  │ Philly Food Festival                          │  │  (3)
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Date                                     ⚠ Check   │
│  ┌───────────────────────────────────────────────┐  │
│  │ Sat 16 Aug 2026                               │  │  (4)
│  └───────────────────────────────────────────────┘  │
│  Read as "AUG 16" — year assumed                    │
│                                                     │
│  Start        12:00 PM      End        6:00 PM      │
│  Location     Penn's Landing                        │
│  Price        $25.00                      ⚠ Check   │
│  Tickets      eventbrite.com/e/…                    │
│  Description  An all-day street food …              │
│                                                     │
│  Couldn't read                                      │  (5)
│    Organiser                                        │
│                                                     │
│  ☑ Keep the photo attached                          │  (6)
└─────────────────────────────────────────────────────┘
```

| # | Element | Rule |
| --- | --- | --- |
| 1 | Source thumbnail + selected intent | `Plan · Event` is the user's existing selection, not a capture result. `Change` is an explicit user action that cancels capture and returns to the Plan-kind chooser; nothing is pre-selected there. |
| 2 | Header | `Check these before saving` when any field has `confidence < 0.7`; otherwise `Review and save`. Never `Done!` and never a claim of accuracy. |
| 3 | High-confidence field | Rendered as an ordinary editable form field. No badge, no highlight. |
| 4 | Low-confidence field | Amber left border, a `⚠ Check` chip in the label row, and a one-line explanation below the field describing what was read and what was assumed. |
| 5 | `Couldn't read` group | Fields the extractor attempted and failed. Rendered as empty, tappable rows at the bottom under that heading. Never pre-filled with a guess. |
| 6 | Attachment toggle | Default **on** for image capture. The source image stays attached as context (concept §13). |

### 3.2 Confidence handling

`ParsedCapture.fields[k].confidence` drives the presentation. Thresholds are constants in
`packages/shared`.

| Confidence | Presentation | Named-write behaviour |
| --- | --- | --- |
| `>= 0.7` | Normal field | Included |
| `0.4 – 0.7` | Amber border, `⚠ Check` chip, explanation line | Included, but see §3.3 for `schedule.date` |
| `< 0.4` | Not pre-filled. Field appears empty under `Couldn't read`. | Not included |
| Field absent from the response | Not rendered at all unless the type's form shows it by default | Not included |

`ParsedCapture.confidence` (the overall figure) controls only the header copy. It never
selects, clears, or questions the already chosen object or Plan kind.

### 3.3 Per-field accept and edit

- Every field is directly editable. There is no accept/reject toggle per field, because a
  two-state control on top of an editable field is redundant: **editing is accepting**.
- Touching a low-confidence field clears its `⚠ Check` state immediately, whether or not
  the value changed. The user has looked at it; that is what the flag was asking for.
- A `Clear` affordance on each low-confidence field empties it in one tap.
- `sourceSpan` from the response, when present, is used on the **text** path to underline
  the characters a field came from, so the user can see why `Friday` became a date.
- The named final button is **never disabled by confidence**. Low confidence is
  information, not a validation error. It is disabled only when `title` is empty.

### 3.4 What the named final action does

The selection determines both the button and endpoint:

| Selection | Button | Write |
| --- | --- | --- |
| Task | `Save task` | One `POST /v1/activities` with `objectKind: 'task'`, `type: 'task'` |
| Plan | `Save plan` | One `POST /v1/activities` with `objectKind: 'plan'` and the explicitly selected Plan kind |
| List item | `Add to <list name>` | One `POST /v1/lists/:id/items` to the named destination |

Each request has its normal idempotency key and contains exactly what is on screen after the
user's edits. `ParsedCapture` itself is discarded. The server has no memory of the parse
and no ability to reconcile it against the created object. The client never omits Activity
`type` or relies on a default.

If the draft has a date, the confirmation toast reads
`Plan · planned for Sat, 16 Aug`; a Task says `Task · planned for Sat, 16 Aug`. A ListItem
says `Added to <list name>`. Sharing remains a separate, ordinary user action and is never
offered as a conclusion drawn by capture.

---

## 4. Image extraction

### 4.1 The pipeline

1. The client uploads the image with `POST /v1/attachments/upload-url` → presigned S3
   `PUT`. Image MIME types only, 10 MB cap, 5-minute URL expiry.
2. The client calls `POST /v1/capture/extract` with `attachmentId` and the already selected
   object/form context. The server treats that context as an allow-list, not a prediction target.
3. The Lambda reads the object, downsizes it to a bounded resolution (§7.2), and calls the
   Anthropic API with a fixed extraction prompt and a strict JSON output schema. The API
   key lives in Secrets Manager.
4. The model's output is validated against the compatible-field schema for that selected
   form. A response that fails validation is treated as an extraction failure (§6.1),
   never partially trusted.
5. The Lambda returns `ParsedCapture`. Nothing is written except the rate-limit counter.

### 4.2 Fields extracted

The table below is the allow-list when the user selected **Plan → Event**. Choosing another
form changes the allow-list; it does not ask the model which form would fit.

| Field | Maps to | Notes |
| --- | --- | --- |
| Title | `title` | The event's name, not the venue's name and not a tagline |
| Date | `schedule.date` | §4.3 |
| Start time | `schedule.time` | |
| End time | `schedule.endTime` | Only when the source states one. Never inferred from a typical duration. |
| Location | `location.label`, `location.address` | Label is the venue name; address only if fully written on the source |
| Reservation | `details.reservation.{name,time,partySize,reference}` | Only fields explicitly present on the source; the reservation name and time otherwise keep the form defaults |
| Description | `details.description` | Trimmed to 1000 characters, with the tail dropped rather than summarised |
| Price | `details.priceCents`, `details.currency` | Only when a single unambiguous price is stated. A range (`$25–$60`) or a qualifier (`from $25`) yields confidence `< 0.4` and lands in `Couldn't read`. |
| Ticket / registration link | `details.ticketUrl` | Includes a URL printed as text; excludes a QR code, which is not decoded in v1 |
| Organiser | `details.organiser` | |

For Task, capture may return only Task fields. For a Plan it may return only common Activity
fields plus fields belonging to the explicitly selected General, Meal, Watch, or Event
form. For a ListItem it may return only title, note, and capabilities already
supported by the selected destination list. Unsupported fields are discarded and never
used to create another object.

Reminder intent is never an extracted field. No target schema contains `reminder`,
`reminders`, `offsetMinutes`, or a notification action. Text such as `remind me an hour
before` stays visible in the source text while the form's separate Reminder control remains
authoritative. It may show a value only because the user explicitly set a saved default or
tapped that control—not because capture interpreted words.

The extractor does **not** return or suggest object kind, Plan kind, participant IDs,
unresolved people, sharing, privacy, destination list, or a save instruction. A restaurant
page selected under **Plan → Event** stays an Event form; a poster selected under
**List item → Ideas** stays a ListItem form.

### 4.3 How uncertainty is communicated

The explanation line under a flagged field is generated from a fixed set of templates. It
states **what was read** and **what was assumed** — never an apology and never a
probability.

| Situation | Explanation line |
| --- | --- |
| Year not printed on the source | `Read as "AUG 16" — year assumed` |
| Ambiguous numeric date | `Read as "08/09" — assumed 8 September` (using the user's locale order, and flagged) |
| Time with no meridiem | `Read as "8:00" — assumed evening` |
| Date already past | `This date has already passed` — and the field is flagged regardless of model confidence |
| Multiple candidate dates on the source | `The poster shows more than one date — 16 Aug chosen` |
| Price stated as a range | Field empty under `Couldn't read`, with `Source shows a price range` |
| Low-resolution or partial text | `Some text was hard to read` shown once at the top, not per field |
| Timezone stated on the source that differs from the profile | `Source says PST — saved as 12:00 PM Pacific` and the timezone field is shown explicitly |

Rules:

- A past date is **always** flagged, whatever the model reported, because the correction is
  almost always a missing year.
- The app never invents a year, a time, or a location that is not on the source. When a
  date has no year, the next occurrence of that date is proposed and flagged.
- The extractor never returns a value it did not read. "Probably a concert" is not a
  location.

---

## 5. Natural-language capture

`POST /v1/capture/parse` receives `text`, `tz`, and the already selected form context.
Parsing is relative to the request's timezone and to the server's clock; the client sends
`X-Client-Timezone` and the body's `tz` wins. Form context is an allow-list. It is not a
question asking the parser what the object is.

### 5.1 Worked examples

Assume the user's timezone is `America/New_York` and "now" is **Wednesday 5 August
2026, 10:14 AM**.

| Explicit selection before input | Input | Compatible fields suggested | Still requires explicit action |
| --- | --- | --- | --- |
| Plan → Watch | `Watch Severance with Alice Friday at 8` | `title` and `mediaTitle` `Severance`; date `2026-08-07`; time `20:00` | Alice is not resolved, suggested, or added. The user must open People and choose her. |
| List item → Movies to watch | `Watch Severance with Alice Friday at 8` | ListItem title `Severance`; the original text remains editable in the source field/note | No Activity, date, person, or sharing suggestion. Final action is `Add to Movies to watch`. |
| Plan → Event | `Dentist Tuesday 2:30` | title `Dentist`; date `2026-08-11`; time `14:30` | Plan kind stays Event because the user chose it. |
| Task | `Pick up groceries` | title `Pick up groceries` | Final action is `Save task`; the parser does not decide it is a Task. |
| Task | `Gym at 6pm every weekday` | title `Gym`; time `18:00`; date `2026-08-05`; recurrence weekdays | The recurrence remains visible for review. |
| Task | `Remind me to call Mum tomorrow at 9` | title `Call Mum`; date `2026-08-06`; time `09:00` | No reminder offset is extracted. The visible Reminder control stays `Off` or shows the user's saved default until they explicitly change it. |
| Plan → Meal | `Chicken tacos for dinner Sunday` | title `Chicken tacos`; slot Dinner; date `2026-08-09`; slot-derived time `19:00`, flagged | Final action is `Save plan`; no ListItem is created. |
| Plan → Event | `Zahav Saturday 7pm with Ben and Priya` | title and location label `Zahav`; date `2026-08-08`; time `19:00` | Ben and Priya are not resolved or added; People is explicit. |
| List item → Restaurants to try | `Zahav Saturday 7pm with Ben and Priya` | ListItem title `Zahav` and compatible place fields | No Plan, date, or participants. Final action is `Add to Restaurants to try`. |
| Contextual `+ Add prep task` | `Book flights for the New York trip` | title `Book flights for the New York trip` | `parentActivityId` comes only from the explicit plan context, never title matching. |

### 5.2 Resolution conventions

Fixed, deterministic rules the model output is post-processed against. They apply only when
the selected form has the target field; otherwise the value is discarded. They are
implemented in `packages/shared` and unit-tested independently of the model.

| Expression | Resolves to |
| --- | --- |
| A bare weekday (`Friday`) | The **next** occurrence, strictly after today. `Friday` on a Friday means next Friday. |
| `today`, `tonight` | Today. `tonight` adds `20:00` if no time is given. |
| `tomorrow` | Today + 1 |
| `this weekend` | The coming Saturday |
| `next week` | Monday of the following week, flagged at `0.45` |
| `the 15th` | The next 15th, this month or next |
| A bare hour 1–6 with no meridiem | PM |
| A bare hour 7–11 with no meridiem | AM if the word `morning` appears, otherwise PM for 7–11 in the evening reading; `7`–`11` alone resolve to PM and are flagged at `0.6` |
| `12` with no meridiem | Noon |
| `morning` / `afternoon` / `evening` / `night` with no clock time | No time is set. The item becomes all-day. The app does not invent 09:00. |
| A duration (`for 2 hours`) | `schedule.endTime` = start + duration |
| A past date with no year | The next occurrence of that date, flagged |

### 5.3 People, sharing, and reminders are not capture fields

Capture performs no contact lookup and returns no participant IDs, invite targets,
`unresolvedPeople`, sharing state, or participant chips. Names may help delimit the title
from date/time language, but they produce no UI action. The original text remains visible
and editable so information is not lost.

People are added only when the user opens the People picker and selects them. Every
list-item bridge asks **Just me / Choose people** and `Choose people` opens an empty picker,
even when the source list is private ([`plans-and-lists.md`](plans-and-lists.md) §6). This rule is identical
for unique, ambiguous, unknown, and common-word names.

Reminders are set only through the visible Reminder control or the user's explicitly saved
default. Capture never returns a reminder offset, toggles the control, or interprets `remind
me` as permission to schedule a notification. This is identical for text, image, and link
capture.

### 5.4 Ambiguous cases and how they resolve

| Selected form and input | Ambiguity | Resolution |
| --- | --- | --- |
| Plan → Meal; `Dinner with Alice` | No date, person named | No date set. Meal remains an undated Plan. Alice is not added. |
| Plan → General; `Meeting at 5` | AM or PM | PM per §5.2, flagged at `0.6` with `Read as "5" — assumed 5:00 PM` |
| Plan → Meal; `Lunch 12` | Noon or midnight | Noon, confidence `0.85`, not flagged |
| Plan → Event; `Concert 08/09` | 8 September vs 9 August | Uses the user's locale order (`en-US` → 9 August), flagged at `0.5`, explanation names the chosen reading |
| Plan → Event; `Trip 14-16 Aug` | Range | `date` = `2026-08-14`, `endTime` unused. Multi-day plans are a single dated activity in v1. The second date is not stored anywhere and is not rendered by the app; it survives only inside whatever the user typed. Flagged, with the explanation `Read as starting 14 August`. |
| Plan → Watch; `Severance S2E5 Friday` | Episode syntax | `season` `2`, `episode` `5`, both at `0.8`; title becomes `Severance` |
| Task; `Gym every 3 days` | Recurrence interval | `{ freq: 'interval_days', interval: 3 }`, shown in the Repeat field for confirmation |
| Task; `Call mum` | `mum` may be a relationship or name | No person lookup or participant suggestion. Title remains `Call mum`. |
| Any selected form; `Zahav` | The word alone could describe several objects | No routing question exists: the selection remains exactly what the user chose. Only compatible title/location fields may fill. |

> **Decision:** a multi-day range creates one activity on the first day, not one activity
> per day and not a new date-range field. Adding `schedule.endDate` to the model is a real
> change with consequences across the agenda, GSI1 and the `.ics` export, and it is not in
> v1 scope. The consequence the review screen must not paper over is stated in
> [`plans-and-lists.md`](plans-and-lists.md#24-one-date-never-a-range) §2.4: **the trip does
> not appear on Today on days two and three.**

---

## 6. Failure and fallback

### 6.1 The failure matrix

Every failure resolves to the same place: the manual form, with the user's input preserved.
Capture never loses what the user typed, photographed or pasted.

| Failure | Detection | What the user sees | State preserved |
| --- | --- | --- | --- |
| **Not implemented** (Phases 1–7) | `501` | Nothing on the text path — field suggestions simply never appear. On the image and link paths: `Add the details yourself for now.` | The selected object, Plan kind or list destination, text, image, and URL all stay fixed |
| **Parse produced nothing usable** | `200` with overall `confidence < 0.3` or no fields | `Couldn't work that out — here's a blank form.` | Full input becomes `title` (text) or stays attached (image/link) |
| **Parse failed server-side** | `500` | `Something went wrong reading that.` with a `Try again` action | Everything |
| **Model output failed schema validation** | Server-side | Treated as `500`. Logged with the raw output at `warn`. | Everything |
| **Offline** | No connectivity | No capture call is attempted. No error is shown for text input. Image and link show `You're offline — add the details yourself.` | Everything. The selected Task, Plan, or ListItem write queues and syncs later ([`interaction-contract.md`](interaction-contract.md#54-offline)) |
| **Rate limited** | `429` with `Retry-After` | `You've used up automatic capture for now. Try again in 40 minutes, or fill this in yourself.` | Everything |
| **Image unreadable** | `200` with every field `< 0.4` | The review screen opens with all fields under `Couldn't read` and a header `Couldn't read this image.` Two actions: `Try another photo`, `Fill in manually`. | Image stays attached |
| **Image too large / wrong type** | Client-side, before upload | `Pick a photo under 10 MB.` | — |
| **Link fetch failed / blocked** | Server-side | `Couldn't open that link.` The URL is still saved to `sourceUrl`. | Everything |
| **Link is a login-walled page** | Server-side, detected as a login page | `That page needs a login, so there was nothing to read.` | URL saved |
| **Timeout** | 12 s client-side deadline | Same as parse failed. The request is abandoned; a late response is discarded. | Everything |

### 6.2 The degraded path is the v1 path

Until Phase 8, every capture endpoint returns `501`. The product must be complete and
pleasant without any of it:

- Today's `+ Add a task` → type a title → `Save task`, or global `+` → **Task** → title →
  `Save task`. Under 5 seconds ([`overview.md`](overview.md#7-success-criteria-for-v1) S1).
  The request explicitly sends `objectKind: 'task'`, `type: 'task'`; no capture or server
  default chooses either.
- Global `+` → **Plan** → explicit Plan kind → Photos → complete the selected form manually
  → `Save plan`.
- Global `+` → **List item** → explicit destination → Link → complete the selected form
  manually → `Add to <list name>`.

Failures never reopen, change, or default the object or Plan-kind chooser. Manual creation
and automatic capture have the same explicit-intent sequence; they differ only in whether
compatible fields receive suggestions.

No screen shows a disabled "AI" button, a `Coming soon` label, or an upsell. The capability
is either working or invisible.

---

## 7. Cost and abuse controls

The cost target is effectively $0/month of AWS spend at personal scale (brief §11). Model
spend is the one line item that scales with use, so it is bounded at four levels.

### 7.1 Rate limits

Enforced in Lambda with a DynamoDB counter, per
[`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits).

| Scope | Limit | Response |
| --- | --- | --- |
| `POST /v1/capture/*`, per user | **20 per hour** | `429 rate_limited` with `Retry-After` |
| `POST /v1/attachments/upload-url`, per user | 60 per hour | `429` |
| Authenticated general | 120 per minute | `429` |

> **Decision:** a per-user **daily** ceiling of 100 capture calls and a per-account
> **monthly** ceiling of 1,000 are added on top of the hourly limit, tracked on the same
> counter items with different TTLs. The hourly limit stops a runaway client; the monthly
> ceiling stops a single account from being an unbounded bill. Both are configurable
> without a deploy via an SSM parameter read at cold start.

### 7.2 Request shaping

| Control | Value |
| --- | --- |
| Text input length | Truncated to 500 characters before the model call |
| Image resolution | Downsized server-side to a longest edge of 1568 px before the model call |
| Image size | 10 MB upload cap; anything larger is rejected before upload |
| Link fetch | 5 s timeout, 2 MB response cap, HTML only, no redirects beyond 3 hops, no private-IP or link-local destinations (SSRF guard) |
| Output tokens | Capped, with a strict JSON schema so there is no free-form generation |
| Model choice | The cheapest model that passes the extraction eval set. Reviewed per release, not per request. |
| Concurrency | The capture Lambda's reserved concurrency is capped so a burst cannot fan out into unbounded spend |

### 7.3 Budget guards

- AWS Budgets alerts at $5 and $20 (brief §14) cover the whole account, model spend
  included.
- A CloudWatch alarm on capture invocations per hour, at 3× the expected personal-scale
  peak, pages the owner.
- A kill switch: an SSM parameter `capture.enabled`. Set to `false`, every capture endpoint
  returns `501` immediately, and the client falls back to the manual path with no other
  change. This is the same code path the pre-Phase-8 build uses, so it is exercised
  continuously.

### 7.4 Abuse

| Vector | Control |
| --- | --- |
| Using the app as a free model proxy | The response is a strict `ParsedCapture` — no free text is returned to the client. `rawModelOutput` is present in dev only and stripped in prod. |
| Prompt injection from an image or a fetched page | The extraction prompt treats source content as data, not instructions. Output is schema-validated; anything outside the schema is discarded. The model has no tools and no ability to call the API. |
| SSRF via `/v1/capture/link` | Destination allow-listing by scheme and public-IP check before fetch; no redirects to private ranges. |
| Uploading non-images | MIME and magic-byte check server-side, not just `Content-Type`. |
| Enumerating other users' attachments | `attachmentId` is checked for ownership before the object is read. |

---

## 8. Privacy

Stated plainly here, and stated again in the app the first time a user takes a photo or
pastes a link for capture.

### 8.1 What the user is told

A one-time sheet, shown before the first image capture, dismissible and never shown again:

```
Reading this photo

To pull out the details, the photo is sent to Anthropic's API, which
reads it and sends back the text it found. It isn't used to train any
model and isn't kept after the request finishes.

The photo itself stays in your account unless you remove it.

                            [ Not now ]   [ OK ]
```

`Not now` returns to the manual form and the image is still attached. The sheet is repeated
verbatim, adapted, before the first link parse.

### 8.2 The facts behind the copy

| Fact | Detail |
| --- | --- |
| What leaves the account | The downsized image bytes, truncated text, or fetched page text, plus the selected form's field allow-list. Nothing else — no user id, email, contact list, participant data, list membership, or other activity. |
| Who it goes to | The Anthropic API, called from the Lambda in `us-east-1`. The API key lives in Secrets Manager and is never in the client. |
| Contact names | The user's contact list is **not** sent to the model or read by the capture Lambda. Capture returns no participant IDs or `unresolvedPeople`; People remains an explicit picker (§5.3). |
| Retention by the app | When the selected form supports attachments and `Keep the photo attached` is on, the image stays in S3 on that Activity, private, served only through CloudFront. Otherwise the upload is deleted after extraction. Deleting an attachment deletes the object. |
| Retention of the parse | None. `ParsedCapture` is not persisted. It exists in the response body and in the client's memory until the user saves or cancels. |
| Logging | Request metadata (user id, request id, latency, token counts, confidence) is logged. **Image bytes and input text are not logged in prod.** `rawModelOutput` is dev-only and stripped by the response serialiser in prod. |
| Training | Content sent to the API is not used to train models. This is a statement about the API's terms, restated in the copy; if the terms change, the copy changes. |
| Opt-out | Settings → `Automatic capture` toggle, on by default. Off means the capture endpoints are never called from that device and every selected form stays manual. The explicit object and Plan-kind sequence is unchanged. |

### 8.3 Reviewer checks

| # | Check |
| --- | --- |
| C1 | No capture endpoint writes any item other than the rate-limit counter. |
| C2 | `rawModelOutput` is absent from every prod response. Asserted by a response-serialiser test with `NODE_ENV=production`. |
| C3 | Input text and image bytes never appear in a log line. Asserted by a log-redaction test over the pino serialisers. |
| C4 | The contact list is never included in a model request payload. Asserted by a snapshot of the outbound request body. |
| C5 | The privacy sheet is shown before the first image or link capture per install, and `Not now` prevents the call. |
| C6 | The `capture.enabled` kill switch produces exactly the `501` path, with no client crash and no error toast on the text path. |
| C7 | A capture response cannot select or change object kind, Plan kind, participants, sharing, destination, reminder state, or save state. Snapshot tests reject those keys. With the same visible schedule fields, paired UI tests with and without `remind me` wording produce identical Reminder state: only the ordinary `Off`/explicitly saved-default rule applies. |
