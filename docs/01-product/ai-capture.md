# AI capture

> **Phase 7.** `POST /v1/capture/parse`, `/v1/capture/extract` and `/v1/capture/link` ship
> as **`501 not_implemented` stubs from Phase 1** and stay that way until Phase 7. The
> client is written against the finished contract from the start so nothing has to be
> rewritten when the implementation lands. Every screen in this document must degrade to
> the manual path described in §6.2 while the stubs are in place, and that degraded path is
> what ships in v1.

**Status:** canonical for capture UX and the parse contract. The response type
`ParsedCapture` is owned by
[`../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier).

---

## 1. Scope

Three capabilities, one response shape, one review screen.

| Capability | Endpoint | Input | Typical source |
| --- | --- | --- | --- |
| **Natural-language capture** | `POST /v1/capture/parse` | `{ text, tz }` | The user types `Watch Severance with Alice Friday at 8` into the Add screen |
| **Image to event** | `POST /v1/capture/extract` | `{ attachmentId }` | A photo of a poster, flyer, invitation, or a screenshot of an event page or a message |
| **Link parsing** | `POST /v1/capture/link` | `{ url }` | A pasted or shared event page, restaurant page, or recipe |

All three return `ParsedCapture`. All three are **drafts**. None of them writes anything.

Out of scope for Phase 7 and beyond unless a product decision reopens it: voice
transcription (iOS dictation covers it), continuous inbox scanning, email parsing, calendar
import, and any background processing the user did not initiate.

### 1.1 The hard rule

**The server never creates an Activity from a parse result.**

```
capture endpoint  →  ParsedCapture (draft)
                  →  review screen
                  →  user confirms
                  →  client calls POST /v1/activities
```

This is a product rule (concept §13), a security property (an unauthenticated-ish input
path must not be able to write), and a testable one: an integration test asserts that
calling any capture endpoint produces zero writes to `od-main-*`. See
[`overview.md`](overview.md#44-suggest-never-auto-create).

---

## 2. Where capture appears

Capture is never a separate screen. It is the Add screen doing more with the same input.
See [`activities.md`](activities.md#22-the-what-are-you-planning-screen).

| Trigger | When the call fires |
| --- | --- |
| Typing | On `Save`, or after a 600 ms pause once the text is ≥ 8 characters — whichever comes first. Only one in-flight request at a time; a newer input cancels the older. |
| Camera / Photos | Immediately after the upload completes |
| Link | On paste, or on `Save` if the field contains exactly one URL |
| iOS share sheet | On open of the Add screen with the shared payload |

While a parse is in flight the Add screen stays fully usable. The user can keep typing, tap
a type chip (which cancels the parse), or hit Save (which cancels the parse and creates
from what is on screen). Parsing never blocks.

---

## 3. The review screen

For text capture the "review screen" is the Add screen itself, transitioned into the
suggested type's form with fields filled. For image and link capture it is a dedicated
review step, because there is more to check.

### 3.1 Anatomy

```
┌─────────────────────────────────────────────────────┐
│  Cancel                                       Save  │
│                                                     │
│  [ source image thumbnail ]        Event ▾          │  (1)
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
| 1 | Source thumbnail + type control | The suggested type is a dropdown, always changeable. Changing it re-renders the form per [`activities.md`](activities.md#63-changing-an-activitys-type) and keeps every field that still applies. |
| 2 | Header | `Check these before saving` when any field has `confidence < 0.7`; otherwise `Review and save`. Never `Done!` and never a claim of accuracy. |
| 3 | High-confidence field | Rendered as an ordinary editable form field. No badge, no highlight. |
| 4 | Low-confidence field | Amber left border, a `⚠ Check` chip in the label row, and a one-line explanation below the field describing what was read and what was assumed. |
| 5 | `Couldn't read` group | Fields the extractor attempted and failed. Rendered as empty, tappable rows at the bottom under that heading. Never pre-filled with a guess. |
| 6 | Attachment toggle | Default **on** for image capture. The source image stays attached as context (concept §13). |

### 3.2 Confidence handling

`ParsedCapture.fields[k].confidence` drives the presentation. Thresholds are constants in
`packages/shared`.

| Confidence | Presentation | Save behaviour |
| --- | --- | --- |
| `>= 0.7` | Normal field | Included |
| `0.4 – 0.7` | Amber border, `⚠ Check` chip, explanation line | Included, but see §3.3 for `schedule.date` |
| `< 0.4` | Not pre-filled. Field appears empty under `Couldn't read`. | Not included |
| Field absent from the response | Not rendered at all unless the type's form shows it by default | Not included |

`ParsedCapture.confidence` (the overall figure) controls only the header copy and, below
`0.5`, whether a type is pre-selected at all
([`activities.md`](activities.md#24-how-the-type-suggestion-is-presented-and-overridden)).

### 3.3 Per-field accept and edit

- Every field is directly editable. There is no accept/reject toggle per field, because a
  two-state control on top of an editable field is redundant: **editing is accepting**.
- Touching a low-confidence field clears its `⚠ Check` state immediately, whether or not
  the value changed. The user has looked at it; that is what the flag was asking for.
- A `Clear` affordance on each low-confidence field empties it in one tap.
- `sourceSpan` from the response, when present, is used on the **text** path to underline
  the characters a field came from, so the user can see why `Friday` became a date.
- The Save button is **never disabled by confidence**. Low confidence is information, not a
  validation error. Save is disabled only when `title` is empty.

### 3.4 What Save does

One `POST /v1/activities` with `Idempotency-Key`, containing exactly what is on screen
after the user's edits. The `ParsedCapture` itself is discarded. The server has no memory
of the parse and no ability to reconcile it against the created activity.

If the draft has a date, the confirmation toast reads
`Planned for Sat, 16 Aug` and offers `Invite people` / `Share` / `Add to calendar` as
follow-ups, per concept §13. None of them fires automatically.

---

## 4. Image extraction

### 4.1 The pipeline

1. The client uploads the image with `POST /v1/attachments/upload-url` → presigned S3
   `PUT`. Image MIME types only, 10 MB cap, 5-minute URL expiry.
2. The client calls `POST /v1/capture/extract { attachmentId }`.
3. The Lambda reads the object, downsizes it to a bounded resolution (§7.2), and calls the
   Anthropic API with a fixed extraction prompt and a strict JSON output schema. The API
   key lives in Secrets Manager.
4. The model's output is validated against the same Zod schema the client uses. A response
   that fails validation is treated as an extraction failure (§6.1), never partially
   trusted.
5. The Lambda returns `ParsedCapture`. Nothing is written except the rate-limit counter.

### 4.2 Fields extracted

| Field | Maps to | Notes |
| --- | --- | --- |
| Title | `title` | The event's name, not the venue's name and not a tagline |
| Date | `schedule.date` | §4.3 |
| Start time | `schedule.time` | |
| End time | `schedule.endTime` | Only when the source states one. Never inferred from a typical duration. |
| Location | `location.label`, `location.address` | Label is the venue name; address only if fully written on the source |
| Description | `details.description` | Trimmed to 1000 characters, with the tail dropped rather than summarised |
| Price | `details.priceCents`, `details.currency` | Only when a single unambiguous price is stated. A range (`$25–$60`) or a qualifier (`from $25`) yields confidence `< 0.4` and lands in `Couldn't read`. |
| Ticket / registration link | `details.ticketUrl` | Includes a URL printed as text; excludes a QR code, which is not decoded in v1 |
| Organiser | `details.organiser` | |

Suggested type is `event` for a poster, flyer or ticket page; `outing` for a restaurant or
venue page with no fixed date; `watch` for a streaming or cinema listing; `meal` for a
recipe. The user can override all of it.

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

`POST /v1/capture/parse { text, tz }`. Parsing is relative to the request's timezone and to
the server's clock; the client sends `X-Client-Timezone` and the body's `tz` wins.

### 5.1 Worked examples

Assume the user's timezone is `America/New_York`, "now" is **Wednesday 5 August 2026,
10:14 AM**, and the user's contacts include `Alice` (`psn_alice`), `Alice Chen`
(`psn_alicec`), `Ben`, `Priya`.

| Input | `suggestedType` | Fields parsed | Notes |
| --- | --- | --- | --- |
| `Watch Severance with Alice Friday at 8` | `watch` | `title` `Severance`; `details.mediaTitle` `Severance`; `schedule.date` `2026-08-07`; `time` `20:00`; participant `psn_alice` | The concept's canonical example. `at 8` with no meridiem resolves to `20:00`, per §5.2. |
| `Dentist Tuesday 2:30` | `event` | `title` `Dentist`; `date` `2026-08-11`; `time` `14:30` | `2:30` resolves to the afternoon, per §5.2. |
| `Pick up groceries` | `task` | `title` `Pick up groceries` | No date. Lands as a `saved` task in Anytime. |
| `Gym at 6pm every weekday` | `task` | `title` `Gym`; `time` `18:00`; `date` `2026-08-05`; `recurrence { freq: 'weekdays' }` | Recurrence is parsed but always shown in the review form for confirmation. |
| `Chicken tacos for dinner Sunday` | `meal` | `title` `Chicken tacos`; `details.mealSlot` `dinner`; `date` `2026-08-09`; `time` `19:00` (from the slot default) | The slot-derived time is flagged at `0.6`. |
| `Zahav Saturday 7pm with Ben and Priya` | `outing` | `title` and `details.placeName` `Zahav`; `date` `2026-08-08`; `time` `19:00`; participants `psn_ben`, `psn_priya` | |
| `Call the apartment office tomorrow` | `task` | `title` `Call the apartment office`; `date` `2026-08-06` | No time. |
| `Submit insurance form by the 15th` | `task` | `title` `Submit insurance form`; `date` `2026-08-15` | `by` is treated as a due date, not a deadline concept — the product has no deadlines. |
| `Book flights for the New York trip` | `task` | `title` `Book flights`; `parentActivityId` if `New York Trip` matches an existing upcoming plan by title, confidence `0.5` | Parent matching is a flagged suggestion, never silent. |
| `Coffee with Alice next week` | `outing` | `title` `Coffee`; participant ambiguous (§5.3); `date` `2026-08-10` (Monday of next week), confidence `0.45` | Vague ranges resolve to the first day of the range and are always flagged. |

### 5.2 Resolution conventions

Fixed, deterministic rules the model output is post-processed against. They are implemented
in `packages/shared` and unit-tested independently of the model.

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

### 5.3 People resolution

Names in the input are matched against the user's contacts, never against a global
directory.

| Case | Behaviour |
| --- | --- |
| Exactly one contact matches, case-insensitively, on full display name or first name | Resolved to that `personId`, confidence `0.9`, shown as a normal participant chip |
| More than one contact matches (`Alice` → `Alice`, `Alice Chen`) | **Not resolved.** The name goes into `unresolvedPeople`. The review screen shows a chip reading `Alice ?` which, when tapped, opens the participant picker filtered to `Alice`. Nothing is added until the user picks. |
| No contact matches | Goes into `unresolvedPeople`. The chip reads `+ Alice` and tapping it offers `Add "Alice" as a new person`. Nothing is created until confirmed. |
| A name that is also a common word (`Will`, `Mark`, `May`, `Sunday`) | Resolved only when the input has an explicit `with` before it. `Mark the calendar` never resolves to a person named Mark. |
| More than 8 names in one input | Only the first 8 are attempted; the rest are ignored and a single note appears: `Some names weren't matched.` |

`unresolvedPeople` is a plain `string[]` in the response
([`../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier)).
The server never creates a `Person` during a parse.

### 5.4 Ambiguous cases and how they resolve

| Input | Ambiguity | Resolution |
| --- | --- | --- |
| `Dinner with Alice` | No date | No date set. Saved as an undated `meal`. The review screen does not prompt for one. |
| `Meeting at 5` | AM or PM | PM per §5.2, flagged at `0.6` with `Read as "5" — assumed 5:00 PM` |
| `Lunch 12` | Noon or midnight | Noon, confidence `0.85`, not flagged |
| `Concert 08/09` | 8 September vs 9 August | Uses the user's locale order (`en-US` → 9 August), flagged at `0.5`, explanation names the chosen reading |
| `Trip 14-16 Aug` | Range | `date` = `2026-08-14`, `endTime` unused. Multi-day plans are a single dated activity in v1; the range appears in the title or notes. Flagged. |
| `Severance S2E5 Friday` | Episode syntax | `season` `2`, `episode` `5`, both at `0.8`; title becomes `Severance` |
| `Gym every 3 days` | Recurrence interval | `{ freq: 'interval_days', interval: 3 }`, shown in the Repeat field for confirmation |
| `Call mum` | `mum` is a relationship, not a contact name, unless a contact is named that | Matched only against actual contact display names. Otherwise no participant. |
| Input with no verb and no date (`Zahav`) | Could be anything | `suggestedType` confidence below `0.5` → no type pre-selected, chips shown, title filled ([`activities.md`](activities.md#24-how-the-type-suggestion-is-presented-and-overridden)) |

> **Decision:** a multi-day range creates one activity on the first day, not one activity
> per day and not a new date-range field. Adding `schedule.endDate` to the model is a real
> change with consequences across the agenda, GSI1 and the `.ics` export, and it is not in
> v1 scope.

---

## 6. Failure and fallback

### 6.1 The failure matrix

Every failure resolves to the same place: the manual form, with the user's input preserved.
Capture never loses what the user typed, photographed or pasted.

| Failure | Detection | What the user sees | State preserved |
| --- | --- | --- | --- |
| **Not implemented** (Phase 1–6) | `501` | Nothing on the text path — the suggestion simply never appears. On the image and link paths: `Add the details yourself for now.` | Text stays in the field; image stays attached; URL stays in `sourceUrl` |
| **Parse produced nothing usable** | `200` with overall `confidence < 0.3` or no fields | `Couldn't work that out — here's a blank form.` | Full input becomes `title` (text) or stays attached (image/link) |
| **Parse failed server-side** | `500` | `Something went wrong reading that.` with a `Try again` action | Everything |
| **Model output failed schema validation** | Server-side | Treated as `500`. Logged with the raw output at `warn`. | Everything |
| **Offline** | No connectivity | No capture call is attempted. No error is shown for text input. Image and link show `You're offline — add the details yourself.` | Everything. The activity is created against the local queue and syncs later ([`interaction-contract.md`](interaction-contract.md#54-offline)) |
| **Rate limited** | `429` with `Retry-After` | `You've used up automatic capture for now. Try again in 40 minutes, or fill this in yourself.` | Everything |
| **Image unreadable** | `200` with every field `< 0.4` | The review screen opens with all fields under `Couldn't read` and a header `Couldn't read this image.` Two actions: `Try another photo`, `Fill in manually`. | Image stays attached |
| **Image too large / wrong type** | Client-side, before upload | `Pick a photo under 10 MB.` | — |
| **Link fetch failed / blocked** | Server-side | `Couldn't open that link.` The URL is still saved to `sourceUrl`. | Everything |
| **Link is a login-walled page** | Server-side, detected as a login page | `That page needs a login, so there was nothing to read.` | URL saved |
| **Timeout** | 12 s client-side deadline | Same as parse failed. The request is abandoned; a late response is discarded. | Everything |

### 6.2 The degraded path is the v1 path

Until Phase 7, every capture endpoint returns `501`. The product must be complete and
pleasant without any of it:

- Add → type a title → pick a type chip → fill the form → Save. Under 5 seconds
  ([`overview.md`](overview.md#7-success-criteria-for-v1) S1).
- Add → Photos → the image is attached to a new activity, and the user types the details.
- Add → Link → the URL is stored on `sourceUrl` and shown as a tappable row, and the user
  types the details.

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
  change. This is the same code path the pre-Phase-7 build uses, so it is exercised
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
| What leaves the account | The downsized image bytes, or the truncated text, or the fetched page text. Nothing else — no user id, no email, no contact list, no other activity. |
| Who it goes to | The Anthropic API, called from the Lambda in `us-east-1`. The API key lives in Secrets Manager and is never in the client. |
| Contact names | The user's contact list is **not** sent to the model. People resolution (§5.3) happens locally in the Lambda against the user's own `PERSON#` rows, using the names the model returned in `unresolvedPeople`. |
| Retention by the app | The image stays in S3 as an attachment on the activity, private, served only through CloudFront. Deleting the attachment deletes the object. |
| Retention of the parse | None. `ParsedCapture` is not persisted. It exists in the response body and in the client's memory until the user saves or cancels. |
| Logging | Request metadata (user id, request id, latency, token counts, confidence) is logged. **Image bytes and input text are not logged in prod.** `rawModelOutput` is dev-only and stripped by the response serialiser in prod. |
| Training | Content sent to the API is not used to train models. This is a statement about the API's terms, restated in the copy; if the terms change, the copy changes. |
| Opt-out | Settings → `Automatic capture` toggle, on by default. Off means the capture endpoints are never called from that device and the Add screen shows only the manual path. Nothing else in the app changes. |

### 8.3 Reviewer checks

| # | Check |
| --- | --- |
| C1 | No capture endpoint writes any item other than the rate-limit counter. |
| C2 | `rawModelOutput` is absent from every prod response. Asserted by a response-serialiser test with `NODE_ENV=production`. |
| C3 | Input text and image bytes never appear in a log line. Asserted by a log-redaction test over the pino serialisers. |
| C4 | The contact list is never included in a model request payload. Asserted by a snapshot of the outbound request body. |
| C5 | The privacy sheet is shown before the first image or link capture per install, and `Not now` prevents the call. |
| C6 | The `capture.enabled` kill switch produces exactly the `501` path, with no client crash and no error toast on the text path. |
