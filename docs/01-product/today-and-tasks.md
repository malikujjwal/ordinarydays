# Today and tasks

**Status:** canonical for the Today screen and task behaviour. Data shapes are owned by
[`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity)
and the expansion algorithm by
[`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm).
The endpoint is
[`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans).

---

## 1. What Today is

Today answers one question: *what do I need to know or do today?* It is the app's landing
screen and the first thing loaded after auth.

Today owns no data. It is a rendering of one `AgendaItem[]` response for one date. There is
no per-day entity, no user-controlled ordering, no "add to Today" action, and no state that
would be lost by throwing the screen away and re-querying. See
[`overview.md`](overview.md#42-today-owns-no-data).

**One request.** A cold open of Today issues exactly one call:

```
GET /v1/agenda?from=<today>&to=<today>&tz=<user tz>&include=anytime_unscheduled,overdue
```

Everything on the screen comes out of that response. Any feature that requires a second
request to render Today is rejected.

> **Decision:** `include=overdue` is a new, additive `include` token on
> `GET /v1/agenda`, required by the overdue rule in §7. It is additive and therefore ships
> without a version bump per
> [`../02-architecture/api-contract.md#5-versioning-and-deprecation`](../02-architecture/api-contract.md#5-versioning-and-deprecation),
> but it must be added to the contract and to the Zod schema in `packages/shared` before
> the client uses it. It also requires one additive optional field on `AgendaItem`:
> `overdueFromDate?: string` (`YYYY-MM-DD`), present only on rolled-forward items.

---

## 2. Sections

> **Section order amended — 2026-08-17 (founder, P2-44).** EARLIER TODAY now renders **second**,
> directly beneath the UP NEXT card and **above** SCHEDULE, with the NOW divider between it and
> SCHEDULE. The timed order is UP NEXT → EARLIER TODAY → *NOW* → SCHEDULE. The untimed
> groups then follow in the fixed order TODAY · NO TIME → OVERDUE → ANYTIME · NO DATE,
> followed by the read-only TOMORROW preview when it has rows.
>
> The founder's report: *"The earlier today section makes more sense on the top so that it feels
> like we have a timeline. The current section makes things a little confusing."* Reading down the
> screen now runs morning → present → what is still coming, which is one timeline rather than two
> lists pointing away from each other. It also resolves a conflict this document had with
> [`../04-conventions/design-system.md`](../04-conventions/design-system.md) §7.1, which has always
> placed the NOW divider "between EARLIER TODAY and what remains" — under the old order there was
> no such position, because nothing remained after it.
>
> Two consequences recorded where they belong: EARLIER TODAY's sort inverts to **ascending**
> (§2.4), and the section **collapses by default above four rows** (§2.4), because it now sits
> between the user and the part of the day they can still act on.

> **The Tomorrow preview — 2026-08-12 (founder ruling), built by P2-45.** Beneath today's work
> sections, Today carries a short, **read-only** look-ahead at tomorrow. It appears in no earlier
> version of this document because it is a new surface rather than catch-up, which is why it
> arrives with its own amendment rather than inside P2-44's.
>
> - It renders tomorrow's **dated** rows only, capped at three, as a plain time-and-title list:
>   `7:30 PM  Dinner at Zahav`, and `Anytime` in the time column for a dated-but-untimed row.
> - **Nothing in it is interactive** (narrowed 2026-08-17, founder: *"no need to open a task or
>   anything, its just to show the stuff for tomorrow"*). No checkbox, no swipe, no completion, no
>   resolution prompt, no snooze — and no tap target either, so rule 6 does not arise. It is an
>   overview, not a list you work from; tomorrow's day is reached through Plans.
> - **It is hidden entirely when tomorrow holds nothing** — no empty state and no heading. A
>   look-ahead that says "nothing tomorrow" is a nag about an empty day (§8.3).
> - **It changes no aggregate.** `2 of 6 done` and the progress bar count Today alone, and
>   UP NEXT stays today's next timed item.
> - Undated tasks never appear: they are already on Today under ANYTIME · NO DATE, and the server
>   pins them to the window's first day, so they cannot render twice.
>
> Today's request widens to **two days** to serve it — one request, one cache entry, one `ETag`.
> The `include` tokens stay day-scoped by construction, so nothing attaches to both days.

Today has one timed sequence followed by three explicit untimed groups, in the fixed order
above. A section or group with no items is not rendered at all except where §2.5 says
otherwise. If the local date changes while Today is
open, the client re-issues the agenda request for the new date; the one-minute ticker only
recomputes UP NEXT and EARLIER TODAY between fetches and never carries the screen across
midnight.

```
THURSDAY, AUGUST 6
Today                                        2 of 6 done
━━━━━━━━━━──────────────────────────────────────────────

UP NEXT · IN 2H 15M
  ◇  Dentist appointment
     2:30 PM · Jefferson Dental Center
     Attended   Snooze

EARLIER TODAY                                  2 done  ⌄

NOW ──────────────────────────────────────────  12:15 PM

SCHEDULE
  5:30 PM  □  Pick up groceries
  6:00 PM  □  Gym                              ↻
  7:30 PM  ◇  Chicken tacos            Meal
  8:00 PM  ◇  Severance                Watch · S2 E4

TODAY · NO TIME
  □  Submit insurance form

OVERDUE
  □  Call apartment office              Due Aug 4   2 days

ANYTIME · NO DATE
  □  Water the plants

TOMORROW                                             3
  9:00 AM  ◇  Coffee with Dan
  1:00 PM  ◇  Standup
```

### 2.1 UP NEXT

**Definition.** The single next thing that has a clock time today.

Precisely: of all items in `days[0].schedule`, UP NEXT is the first item, in the section's
sort order (§3.1), whose **effective start time** is greater than or equal to the current
local wall-clock minute, and whose status is not `completed`, `completed_occurrence`,
`skipped`, `skipped_occurrence`, or `cancelled`.

- **Effective start time** means the time after occurrence overrides are applied: a snoozed
  occurrence uses `snoozedUntil`, a rescheduled occurrence uses `overrideTime`, otherwise
  the series or activity time. This is the `time` field on `AgendaItem`.
- Untimed items (Anytime) are never UP NEXT. An item with no clock time cannot be "next".
- Overdue rolled-forward tasks (§7) are never UP NEXT.
- UP NEXT is a **duplicate render** of a row that also appears in SCHEDULE. It is not moved
  out of SCHEDULE. Completing it from either place updates both.
- It is computed **client-side from the current minute**, and re-evaluated on a one-minute
  ticker and on app foreground, so it advances without a refetch. The server also returns
  `days[0].upNext` computed at request time; the client uses the server value only as the
  initial paint and then recomputes.
- The UP NEXT row is visually larger than a SCHEDULE row and shows a relative time
  (`in 20 minutes`, `in 2 hours`, `now`). Below 60 seconds it reads `now`.
- Its planner card keeps one secondary band. Available `locationLabel`, `noteExcerpt`,
  type `subtitle`, and recurrence copy are joined in that order and de-duplicated; if none
  exists the band and its rules are absent. The full source URL is deliberately not part of
  the trimmed Agenda projection, so this display rule does not widen the wire model.

If every timed item today is in the past, UP NEXT is not rendered (see §2.5).

### 2.2 SCHEDULE

Every item for today that has a clock time and has **not** yet passed, ascending by
effective start time.

> **A completed row keeps its slot — amended 2026-08-17 (founder, P2-44).** Completing a timed
> item no longer moves it: it stays here, checked and struck, and joins EARLIER TODAY when the
> clock reaches its time like everything else. With EARLIER TODAY now rendering **above**
> SCHEDULE (§2), relocating on completion threw the row *upward* across the NOW divider — a task
> finished early jumped backwards past "now", which reads as the screen rewriting the day rather
> than recording it. An **untimed** item is the exception and has to be: it has no slot to stay
> in, so completing it leaves its untimed group immediately (§2.3). An item passes at the moment its **end time** is reached, or, if it
has no end time, at the moment its start time is reached — see §6.1.

Rows show: time on the left, affordance (checkbox for tasks, a non-interactive marker for
everything else — §4), title, and a type-derived subtitle.

The vertical rail connects rows only **within** EARLIER TODAY or SCHEDULE. It ends at the last
row before NOW and begins at the first row after NOW; no line bridges either section heading,
the whitespace around NOW, or the boundary between those two timed sections.

### 2.3 UNTIMED WORK

Three explicit, open groups render beneath the timed day, in this order:

1. `Today · no time`
2. `Overdue`
3. `Anytime · no date`
4. `Tomorrow`, when its read-only preview has dated rows (§2)

These groups are a scan list, not another timeline. They are separated by whitespace, not cards,
large backgrounds, shadows, decorative rules, or marker connectors. Every task uses the same flat
row, 56 pt minimum row measure, 44 × 44 pt interactive control, compact internal padding, and the
same checkbox/title/metadata/trailing alignment. A subtle `border` hairline separates adjacent rows
inside one populated group; it never separates groups. Titles wrap to at most two lines. Rows omit
the empty time rail and repeated `No date` / `No time` copy, and show only useful list, parent-plan,
or recurrence metadata in subdued text. Ordinary labels and metadata use neutral text tokens;
overdue due-date and trailing age information is the only coloured text in this block.

Each heading carries its own plain item count and deliberately does **not** report `n of m done`:
the Today header remains the only completion figure for the day. Empty groups are absent. The
overdue group keeps its existing bounded disclosure: the first three rows render initially and
the existing expander reveals or hides the remainder. The `Anytime · no date` group remains capped
at 20 rows with the existing `See all (47)` route.

1. **Dated-but-untimed items for today** — anything with `schedule.date === today` and no
   `schedule.time`. These come from `days[0].anytime`.
2. **Overdue tasks** rolled forward from previous days (§7), oldest original date first.
   Each shows a short `Due Aug 4` line beneath its title and, when useful, a compact trailing age
   such as `2 days`; both use `warning`.
3. **Undated tasks** — `objectKind: 'task'`, `type: 'task'`, `status: 'saved'`, and no
   `schedule`. Tasks do not carry participants. These come from the
   `include=anytime_unscheduled` merge, newest-created first.

Completed items never sit in the untimed groups. Completing an item in any of the three groups moves
it, on the spot, to EARLIER TODAY (§2.4).

ANYTIME · NO DATE is narrower than it reads. "No date" means two different things, and Today only
holds one of them:

| No date means | Example | Where it goes |
| --- | --- | --- |
| **Whenever — today is fine** | `Submit the insurance form` | ANYTIME · NO DATE |
| **Not decided yet** | `Dinner at Zahav with Alice, date TBD`; a solo `Poconos trip` | **Plans → Needs a date.** Never Today. |

The test is the pure rule in
[`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets):
an undated Activity goes to Needs a date when `objectKind: 'plan'` and to ANYTIME · NO DATE when
`objectKind: 'task'`. The explicit object choice — not type, people, title, or capture —
owns that distinction. The product statement of the rule is
[`plans-and-lists.md`](plans-and-lists.md) §1.2.

> **Decision — the two meanings are separated, and only the first reaches Today.** Putting
> them in one place was the model's largest product error: it sent an undecided Plan to
> Today’s ANYTIME · NO DATE group next to a solo errand, which made Today a mixture of things to do and
> things to think about. An undecided plan is not something you have to do today, and a
> screen that says it is becomes a list of things to feel bad about (§8.3).

> **Decision:** ANYTIME · NO DATE is capped at **20 rows** on Today, with a `See all (47)` footer that
> pushes the **Anytime** screen. That screen pages through
> `GET /v1/activities?filter=saved`; Today never expands the remaining rows in place.
> Without a cap, a user with a large Inbox has a Today screen that is mostly not about
> today. The cap is a client-side render limit; the response still carries what the page
> size returned.

> **Anytime route ruling — 2026-08-11.** The footer uses a pushed screen because hundreds
> of inline rows would destroy Today's bounded read. The product still has exactly three
> tabs: the three-tabs-only rule governs tab destinations, not screens pushed from them.
> P2-19 registers the route with the standard loading-state stub; P2-39 completes the
> paginated screen after the shared AgendaRow, swipe and undo foundations land in P2-24.

> **Presentation amendment — 2026-09-03 (founder).** The earlier single `ANYTIME` heading and
> reserved empty time rail made the three different kinds of untimed work difficult to scan and
> made them look like part of the clock. The three server/client buckets and all mutation rules
> are unchanged; only their presentation is split into the explicit headings above. The scheduled
> timeline is outside this amendment.

### 2.4 EARLIER TODAY

Two kinds of row share this section:

1. Items with a clock time today whose effective start (or end, per §6.1) has passed.
   This includes items already completed today.
2. Items completed today that have **no** clock time — untimed-today items and undated
   tasks. They render without a time column and take their completion moment
   (`completedAt`) as their sort instant.

The section sorts **ascending** by that instant — clock time for the first kind, completion time
for the second — so the earliest is at the top and the most recent sits closest to the NOW
divider beneath it (amended 2026-08-17; see the decision below).

> **Resolved rows recede by weight and ink, not by opacity — 2026-08-17 (founder).** A completed,
> skipped or passed row carried `opacity: 0.62`, which is the one thing
> [`interaction-contract.md`](interaction-contract.md) §6.4 forbids: de-emphasis "is achieved with
> weight and size, not by dropping contrast below the threshold", and blending toward the
> background took a `textSecondary` subtitle from 4.77:1 to about 3.3:1. The check and the strike
> are unchanged; the title drops from `bodyStrong`/`textPrimary` to `body`/`textMuted`, which
> reads quieter **and** clears AA. Three struck two-line titles in succession no longer out-shout
> the unfinished row beneath them.

- Completed items render with their outcome verb in the trailing slot (`Had it`,
  `Watched`, `Attended`, `Done`) and a struck-through or de-emphasised title. **An outcome the
  user declined renders the words they chose** — `Didn't happen`, `Didn't go` — not the type's
  positive verb (amended 2026-08-15, founder report): a declined outcome is stored as
  `status: 'skipped'` carrying that outcome, and reading the type alone reported `Attended` for
  an event the user had just said they did not go to. **This list is
  not the passed-plan sheet's**, whose positive button for a task is `Complete` (§8's table).
  A task's *action* is `Complete`; the *state* it ends in is `Done`. One mapping served both
  until 2026-08-13, so a finished task announced itself as `Complete` — an instruction where a
  status belongs. `outcomeVerb` renders state, `completionVerb` renders the action.
- Un-complete stays reachable from the row for every completed item here, timed or not:
  the checkbox un-ticks a task, and any row's detail screen offers un-complete after the
  6-second toast window closes.
- Passed-but-unresolved items render with the resolution prompt described in §6.
- The section is capped at 10 rows with a `Show all` expander.
- **It is collapsed by default, at any length** (founder, 2026-08-17). Its header carries
  `<n> done` and a chevron that opens it. The section now sits between the user and the part of
  the day they can still act on, and what is behind you is reference rather than something to
  work from — so it folds, and the count means nothing is hidden. The 10-row cap and its
  `Show all` apply inside, once open.

> **Decision — amended 2026-08-17: EARLIER TODAY sorts ascending (oldest first).** It sorted
> descending while it rendered **below** SCHEDULE, and the reason was sound for that position:
> "the two sections point in opposite directions from 'now', which is what makes the screen
> readable as a timeline centred on the present moment." The founder has moved the section
> **above** SCHEDULE (§2), and under that order the same goal inverts the sort — reading downward
> must run 8:00 AM → 11:00 AM → *NOW* → 5:30 PM, so the past climbs into the present rather than
> retreating from it. SCHEDULE still sorts ascending; the screen is now one continuous direction
> instead of two.

> **Decision — completed untimed and undated items join EARLIER TODAY (2026-08-07).** This
> section used to be clock-timed-only, which left a completed ANYTIME item with nowhere to
> go: it left ANYTIME (§2.3) and qualified for no other section, so the day's record was
> incomplete and §2.5's all-done state claimed rows this section did not hold. Completion
> order is the honest sequence for items that never had a time, and rendering them without
> a time column keeps the timeline readable. §2.5's `All done for today` line is now
> literally true: EARLIER TODAY carries every completed row.

> **Presentation amendment — show completion before relocation (2026-08-11; narrowed
> 2026-08-17).** This describes a row that **relocates**, which since 2026-08-17 means an untimed
> or undated one only — a timed row now stays in SCHEDULE (§2.2) and simply renders checked and
> struck, so there is nothing to hold or fade. On Today,
> checking a task first checks and strikes the row in its current position. It holds for the
> `fast` motion duration, fades out over `base`, and only then appears in EARLIER TODAY in its
> canonical position. The completion request and optimistic completed state still happen
> immediately; the at-most-300 ms delay belongs only to the section relocation. The row never
> travels down the screen. With Reduce Motion enabled, the hold and insert/remove animation
> are removed and the completed row relocates immediately. A rolled-forward overdue row uses
> the same checked-then-fade acknowledgement and enters EARLIER TODAY too: because it was
> counted in Today's denominator, completing it today must advance Today's numerator.

### 2.5 Empty states

Each section has one empty state. Empty-state copy is plain and does not congratulate the
user.

> **Empty-state action reconciliation — 2026-08-12.** The fully empty Today state follows
> the product-wide one-action contract: its sole action is `Add`, opening the same unselected
> **Task / Plan / Add list** chooser as global `+`. The older two-button wording is retired;
> Today does not add a second `Open Lists` action to this state.

| Situation | Rendered |
| --- | --- |
| Nothing at all today, and no undated tasks | Full-screen state: heading `Nothing planned today`, body `Add something you want to do, or check your Lists.`, and one `Add` action. `Add` opens the same unselected **Task / Plan / Add list** chooser as global `+`. No section headings are rendered. This state is rendered even when Plans → Needs a date is full: an undecided plan is not a reason to say something is planned today, and Today never counts or mentions that stage (§3.2). |
| Nothing at all today, but there are undated tasks | ANYTIME · NO DATE renders normally with them. Above it, a one-line note: `Nothing scheduled today.` No UP NEXT, SCHEDULE or EARLIER TODAY headings. |
| SCHEDULE empty, one or more untimed groups non-empty, EARLIER TODAY non-empty | SCHEDULE heading is rendered with the single row `Nothing left scheduled today.` UP NEXT is not rendered. |
| SCHEDULE non-empty, every untimed group empty | No untimed heading is rendered. The inline `+ Add a task` quick-add row (see [`activities.md`](activities.md#71-quick-add-behaviours)) still appears at the foot of the list. |
| EARLIER TODAY empty | Not rendered. There is no "nothing has happened yet" state. |
| UP NEXT has no candidate (all timed items are past) | Not rendered. No "you're done" message. |
| Everything today is completed | UP NEXT and SCHEDULE are not rendered; EARLIER TODAY carries the completed rows — timed, untimed and undated alike (§2.4); a single line above it reads `All done for today.` |
| Load failed | See [`interaction-contract.md`](interaction-contract.md#5-loading-empty-error-and-offline-states). |

---

## 3. Ordering and tie-breaking

### 3.1 Sort keys

| Section | Primary | Tie-break 1 | Tie-break 2 |
| --- | --- | --- | --- |
| SCHEDULE | Effective start time, ascending | `activityId` ascending | `occurrenceDate` ascending |
| EARLIER TODAY | Effective start time, **ascending** (completion time for rows with no clock time, §2.4) | `activityId` ascending | — |
| OVERDUE | `overdueFromDate` ascending | `activityId` ascending | — |
| TODAY · NO TIME | `activityId` ascending | — | — |
| ANYTIME · NO DATE | `createdAt` descending | `activityId` descending | — |

`activityId` is a ULID, so it sorts **stably and identically on every client** — which is
the property these rows need. Using it as the tie-break
means SCHEDULE ordering is exactly the natural order of the GSI1 query
(`gsi1sk = <localDateTime>#<activityId>`, see
[`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets)),
so the server does no extra sorting for the common case and the client's re-sort after a
local mutation produces the identical order.

> **Decision (wording amended 2026-08-17, Phase 2.6):** the tie-break is **stable id
> order**, not type priority and not alphabetical. Two things at 6:00 PM have no meaningful
> precedence, and a type-priority rule would be a hidden ranking of types, which contradicts
> "types guide, never restrict". This note used to say "creation order", which the id
> approximated while every id was server-minted; a client-minted id
> ([`../02-architecture/data-model.md`](../02-architecture/data-model.md#8-ids) §8) carries
> a device clock, so id order remains deterministic and stable but is no longer a creation
> chronology. Any surface that genuinely needs "the one I added first" must sort on
> `createdAt`, which stays server-set.
>
> One row of the table above uses `activityId` as a **primary** sort rather than a tie-break —
> TODAY · NO TIME, dated untimed items, which have no other ordering signal. It keeps that
> sort: stable and identical on every client is what the group needs, and it never claimed to
> be chronological. ANYTIME · NO DATE already leads with `createdAt` and is unaffected.

### 3.2 What is excluded from Today

| Excluded | Rule |
| --- | --- |
| `cancelled` activities | Never shown on Today, on any date. |
| `skipped` occurrences | Hidden by default. Today's overflow menu has `Show skipped`, a client-only toggle persisted per device, rendered as the same compact ruled checkbox row as the List page's filters. It renders skipped rows in EARLIER TODAY, de-emphasised **and tagged `Skipped` in `textMuted`** (amended 2026-08-15, founder report — de-emphasis alone made a skipped row indistinguishable from a merely past one), with an `Undo skip` action. |
| Prep tasks with a `parentActivityId` | **Included** if they have their own `schedule.date` of today. A prep task is a task; it belongs on Today when it is due. It renders with the parent plan's title as its subtitle. |
| Items belonging to a plan the user has declined | Excluded from Today and the agenda query. Declining rewrites the `ActivityIndex` entry as a declined read-only projection — it renders only as the durable Plans row with `Rejoin` ([`sharing-and-people.md`](sharing-and-people.md) §3.2), never on Today. |
| **Undated plans — anything in the Needs-a-date stage** | Excluded, on every day, with no toggle to include them. `GET /v1/agenda` never returns the `#P` bucket, and `include=anytime_unscheduled` merges the `#N` bucket only ([`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans)). They live in Plans → Needs a date ([`plans-and-lists.md`](plans-and-lists.md) §1.3). |
| Items with `rsvp: 'pending'` | **Included** in SCHEDULE, with a pending-RSVP badge and inline Going / Maybe / Decline actions. See [`sharing-and-people.md`](sharing-and-people.md#33-what-appears-on-the-invitees-today). |

---

## 4. Row affordances by type

The leading control on a row is determined by `AgendaItem.hasCheckbox`, which is true for
`objectKind: 'task'` when the caller may complete it. Tasks are solo; a prep Task can also
be completed by a participant of its parent Plan through that explicit parent relationship.

| `type` | Leading control | Tap on control | Tap on row |
| --- | --- | --- | --- |
| `task` | Checkbox, 44×44 pt hit target | Completes (or un-completes) immediately, optimistically, with undo | Opens detail |
| `meal` | Non-interactive diamond marker | — (marker is not a hit target; it is `accessibilityElementsHidden`) | Opens detail |
| `watch` | Non-interactive diamond marker | — | Opens detail |
| `event` | Non-interactive diamond marker | — | Opens detail |
| `custom` | Non-interactive diamond marker | — | Opens detail |

Non-task types are completed from three places and never from the row's leading control:

1. The detail screen's primary button (`Had it`, `Watched`, `Attended`, `Done`).
2. The swipe action (see [`interaction-contract.md`](interaction-contract.md#3-gesture-table)).
3. The passed-plan prompt in EARLIER TODAY (§6).

The reason is the concept's rule that a plan is not an unfinished task. A dentist
appointment with an unticked box implies an obligation to tick it; a dentist appointment
with a marker does not.

### 4.1 A plan you did not create carries no completion control

Completion is **global and owner-only**: an occurrence records that *the thing happened*,
not that *I attended*
([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)).
On a shared Plan somebody else owns, the row shows no checkbox, its swipe actions carry
no completion verb, and EARLIER TODAY shows no resolution prompt (§8.2). What a participant
sees is the plan's state — including `Attended` once the owner records it.

A participant who did not go sets their RSVP to declined, which the owner sees. One who wants
the plan off their day leaves it, which removes it from their Today and Plans altogether
([`sharing-and-people.md`](sharing-and-people.md#34-what-a-participant-can-and-cannot-change)
§3.4). Neither is a completion, and neither changes anything for anyone else. Prep tasks are
the one thing on a shared plan a participant may complete: a prep task is an item on a shared
checklist, so any participant of the parent may tick it, whoever created it
([`plans-and-lists.md`](plans-and-lists.md#3-prep-tasks) §3).

**Subtitles** are set server-side on `AgendaItem.subtitle`:

| Type | Subtitle format | Example |
| --- | --- | --- |
| `task` | Parent plan title, if any | `New York Trip` |
| `meal` | `Meal` + slot if set | `Meal · Dinner` |
| `watch` | `Watch` + `S<n> E<n>` if set, else `mediaKind` | `Watch · S2 E4` |
| `event` | `details.organiser` if set, else `location.label` | `Dr Patel` |
| `custom` | none | |

Trailing badges, in this order when present: recurrence glyph `↻`, snooze glyph, overdue
date chip, participant avatars (max 3 + `+n`), pending-RSVP badge.

---

## 5. Tasks

A task means *something I need to complete*. Tasks are the only type with a checkbox
(§4).

A generated future occurrence of a recurring task keeps its checkbox visible, but the
checkbox is disabled until that occurrence's date. A person cannot pre-complete future
generated occurrences; today's and past occurrences remain resolvable, and an existing
future completion remains reversible for compatibility. Opening a future occurrence's detail
does not bypass the rule: its primary completion action is absent until that date.

Task creation is explicit. Global `+` asks **Task / Plan / Add list**; choosing Task opens
this form with `objectKind: 'task'`, `type: 'task'`. Today's contextual `+ Add a task` answers that choice in its
label and opens the Task form directly. Words and capture cannot turn a selected Task into
a Plan or ListItem, and the final creation action is `Save task`. The client always sends
`type: 'task'`; it never relies on a hidden default.

### 5.1 Scheduling a task

| State | `schedule` | Where it appears |
| --- | --- | --- |
| No schedule | absent | ANYTIME · NO DATE, on every day, until dated or completed |
| Date only | `{ date }` | TODAY · NO TIME on that date |
| Date + time | `{ date, time }` | SCHEDULE on that date, moving to EARLIER TODAY once passed |

Clearing a date returns a Task to ANYTIME · NO DATE. Tasks never gain people; coordinated work is an
explicit **Plan → General** or another visible Plan kind. There is no "someday" flag:
undated *is* someday for a Task.

### 5.2 Reminders

Reminders belong to a person, not to the activity. The creation form exposes one; the detail
screen allows adding more, capped at **3 per person per activity**. A Task has only its
owner's reminders. Offsets, defaults and delivery are specified in
[`notifications.md`](notifications.md#3-reminder-timing); the per-person rule is
[`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1.

A task with a date but no time can still have a reminder; it fires at the user's configured
all-day reminder hour (default 09:00 local).

### 5.3 Snooze

Snooze moves *this occurrence* later. It never edits the underlying schedule of a recurring
series (§5.5).

| Context | Options offered | Effect |
| --- | --- | --- |
| Non-recurring task, today, timed | `15 minutes`, `1 hour`, `3 hours`, `This evening (6 PM)`, `Tomorrow`, `Pick a time` | `15 min`–`This evening` and `Pick a time` (same day) issue `POST /v1/activities/:id/snooze` with `until` as `HH:mm`. `Tomorrow` issues `POST /v1/activities/:id/schedule` with tomorrow's date and the same time, because moving a one-off task to another day *is* a reschedule. |
| Recurring occurrence | `15 minutes`, `1 hour`, `3 hours`, `This evening (6 PM)`, `Pick a time` — **no `Tomorrow`** | Always `POST /v1/activities/:id/snooze` with `{ occurrenceDate, until: 'HH:mm' }`, writing an `Occurrence` with `status: 'snoozed'`. |
| Undated or all-day task | Snooze is not offered. There is no time to move. | — |

Options are pruned to the future: an option that would land in the past — `This evening
(6 PM)` opened at 9 PM — is hidden client-side, so the sheet never offers a time the
server would reject.

**The relative options count from the later of now and the occurrence's own time** (amended
2026-08-15, founder report). "Snooze moves *this occurrence* later" and "prune anything in the
past" are the same rule only once an item is due; before that they disagree. Counted from the
clock alone, a 6:00 PM task snoozed at 2:10 PM offered `15 minutes` → 2:25 PM, moving it nearly
four hours **earlier** than it was already scheduled. A fixed option that does not clear the
base is dropped for the same reason, so `This evening (6 PM)` is not offered on a 6:00 PM task,
and `Pick a time` enforces the same boundary and names it. P2-25's "compute from the current
minute" described the pruning case and is superseded for the not-yet-due one.

Snooze is offered on **any** timed task today, whether or not its time has passed and whether
or not it repeats; the table above is the whole of the availability rule and there is no
upcoming-only restriction. It is offered on the activity detail screen as well as from the row
(amended 2026-08-15, founder report — the detail screen required an occurrence and so dropped
the table's entire non-recurring row). `Tomorrow` there does what it does everywhere: a
reschedule, not a snooze.

The sheet names the activity it is moving and states the reach of the move above the options
(amended 2026-08-14, P2-42): `Call the dentist · 3:00 PM`, then `Today only. Tomorrow stays
6:00 PM.` on a recurring occurrence and `Today only. Nothing else changes.` on a one-off. The
time in that line is the **series** time, so re-snoozing an already-snoozed row still says what
tomorrow keeps. The option table above is unchanged; the copy is
[`interaction-contract.md`](interaction-contract.md#55-reschedule-and-snooze-sheet-copy) §5.5.

> **Decision:** `Tomorrow` is deliberately absent for recurring occurrences. Snoozing
> tomorrow's Gym into a day that already has a Gym would produce two rows for one series,
> breaking the one-row-per-series rule (§5.4). To move a single occurrence to another day,
> use reschedule → `This occurrence only`, which writes an `Occurrence` with
> `status: 'rescheduled'` and an `overrideDate` (§6.3).

A snoozed item stays in SCHEDULE, re-sorted to its new effective time, with a snooze glyph
and its original time shown de-emphasised: `6:00 PM → 8:00 PM`. Snooze is repeatable.
`Undo snooze` is available in the row's swipe actions and restores the original time by
deleting the `Occurrence`'s snooze fields.

**A repeated snooze compounds** (amended 2026-08-15, founder report): the second `15 minutes` on
an item already snoozed to 6:15 PM moves it to 6:30 PM, because the base is the later of now and
the item's *effective* time and a snoozed item's effective time is the snoozed one. This
supersedes the earlier "snoozes from now", which was written when the base was always the clock
and which the 2026-08-15 base amendment above already replaced for the not-yet-due case; keeping
it would have meant two rules for one control depending on whether the last press had landed.

**Rescheduling ends the snooze** (amended 2026-08-15, founder report). A snooze defers this
occurrence from the time it currently sits at; a reschedule replaces that time, so the deferral
has nothing left to defer and the glyph and the `6:00 PM → 6:15 PM` affix would be describing a
schedule that no longer exists. `Remove time` counts, and leaves nothing for a snooze to be
relative to at all. The write that clears it is the schedule write itself, so every surface
agrees without deriving anything; an idempotent replay, which writes the same schedule back,
changes nothing and leaves the snooze alone.

**The rule does not vary with how the snooze is stored.** A series keeps it on an `Occurrence`
and a one-off on the Activity's own `snoozedUntil`
([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4.1, §4.5); every
surface reads the effective time, so both compound alike and both show the moved time wherever
the activity is rendered, the detail screen included.

### 5.4 Skip

Skip says "not this one, and I do not want to be asked again". It is available on any task
and on any recurring occurrence.

- Non-recurring task → `POST /v1/activities/:id/skip`, status becomes `skipped`, the row
  leaves Today.
- Recurring occurrence → `POST /v1/activities/:id/skip` with `occurrenceDate`, writing an
  `Occurrence` with `status: 'skipped'`. The series and every other occurrence are
  untouched.
- The activity detail screen offers `Skip today` under the same rule as this section states —
  any task, or any recurring occurrence (amended 2026-08-15, founder report). A **non-recurring
  plan** is neither, and is resolved through its passed-plan prompt instead.
- Skipping never notifies anyone and never appears in a shared plan's updates feed.
- Skipped items are hidden from Today unless `Show skipped` is on (§3.2), and are undoable
  for the standard undo window plus, permanently, via `Show skipped` → `Undo skip`.

### 5.5 Related plan

A task may be attached to a plan by setting `parentActivityId`, making it a **prep task**
of that plan.

- Set from the task's `Related plan` field, or created directly inside a plan's prep-tasks
  section.
- The task keeps its own schedule, reminders and recurrence. It is a first-class Activity,
  not a sub-item.
- On Today it renders with the parent plan's title as its subtitle and its own date.
- Completing a prep task updates the plan's prep progress (`3 of 5 done`), which is a
  drill-down-able number: tapping it opens the plan's prep list.
- Deleting the parent plan does **not** delete prep tasks; it clears their
  `parentActivityId` and they become ordinary tasks. This is stated here because it differs
  from the delete cascade for `PART#`/`EXP#` items in
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).

> **Decision:** prep tasks survive deletion of their parent plan. A user who cancels a trip
> may still need to return the rental car. Cascade-deleting a person's real to-dos because
> the container went away is the kind of data loss that ends trust in a planner.

### 5.6 Task detail

Task detail is the Activity detail screen, reduced. It follows the shared anatomy
conventions in [`plans-and-lists.md`](plans-and-lists.md#21-anatomy) §2.1 and shows, top to
bottom: title, the schedule row with its combined repeat/reminder summary, the completion
control, and the functional Reminder, Notes and
`Related plan` row — the parent link, when it is a prep task (§5.5). Its actions are the
standard complete, skip and snooze set (§4, §§5.3–5.4). It has no People, Expenses,
Updates, or Attachments sections: tasks are solo (§5.1), so the coordination sections do
not exist for them, and the screen renders no disabled placeholders for anything it lacks.
If the Task was converted from a Plan, its prior updates remain available through the API as
read-only conversion history; omitting the Updates section does not delete that user content,
and the Task accepts no new entries.
Each functional capability is a single disclosure row with a trailing chevron and accessible
expanded state; opening it shows either its current content or the real add controls.

---

## 6. Recurring tasks

Recurrence is a first-class behaviour, not a convenience. The rules below are product
requirements with mandatory test coverage (brief §12).

### 6.1 The options list

The Repeat field opens a sheet with one clean dropdown containing exactly these options.
The `Recurrence written` column
lists the rule fields of one **rule segment** (§6.2): the sheet always shows and edits the
series' **active** (last) segment, which — on a series that has never had an "all future"
edit, the overwhelmingly common case — is the only segment there is. Earlier segments are
history and have no UI of their own.

| Option shown | `Recurrence` written | Notes |
| --- | --- | --- |
| Does not repeat | New draft: no `recurrence` is written. Existing series: remove `recurrence` and retain the explicitly selected occurrence as the one-off Activity (§6.3). | Default on a new draft. On a series this is a type change, not an alias for End series. It is available only from an explicit occurrence target; series-only detail never guesses a surviving date. **Founder-confirmed 2026-08-14**, superseding the 2026-08-13 `Never` interpretation. |
| Daily | `{ freq: 'daily', interval: 1 }` | |
| Weekdays | `{ freq: 'weekdays' }` | Monday–Friday |
| Weekends | `{ freq: 'weekly', interval: 1, byWeekday: [0, 6] }` | Saturday and Sunday |
| Weekly | `{ freq: 'weekly', interval: 1, byWeekday: [<weekday of the anchor date>] }` | Label reads `Weekly on Thursday` |
| Biweekly | `{ freq: 'weekly', interval: 2, byWeekday: [<weekday of the anchor date>] }` | Label reads `Every 2 weeks on Thursday` |
| Monthly | `{ freq: 'monthly', byMonthDay: [<day of the anchor date>] }` | Explicit anchor. Label reads `Monthly on the 6th` |
| Every 3 Months | `{ freq: 'monthly', interval: 3, byMonthDay: [<day of the anchor date>] }` | Explicit anchor. Label reads `Every 3 months on the 6th` |
| Every 6 Months | `{ freq: 'monthly', interval: 6, byMonthDay: [<day of the anchor date>] }` | Explicit anchor. Label reads `Every 6 months on the 6th` |
| Yearly | `{ freq: 'yearly', byMonth: [<month of the anchor date>], byMonthDay: [<day of the anchor date>] }` | Explicit anchor. Label reads `Every year on 3 September` |
| Custom | `{ freq: 'interval_days', interval: X }` | Reveals a typed `Days` input, integer 2–365. This is not the Phase 9 RFC 5545 rule. |

Every repeating option additionally exposes an **Ends** dropdown: `No end` (default), `On a
date` (`recurrence.endDate`), `After N times` (`recurrence.count`, 1–999). `No end` clears
both termination fields and means the series continues indefinitely. Ends belongs to the
**series**, not to a segment: however many segments a series has accumulated, there is one
Ends setting and it closes the whole series.

**End series** is a separate occurrence-targeted action. It keeps `recurrence` and sets its
inclusive `endDate` to the explicit occurrence in view. It is not an option in the Repeat
dropdown and it is not `No end`'s opposite write disguised under the same label.

> **Three operations, one name each — 2026-08-14 (founder), recorded by P2-52.** The Repeat
> sheet previously used `Never` for two opposite ideas: in the Repeat dropdown it removed
> `recurrence`, and in the Ends dropdown it meant the series never terminates. Code and tests
> could therefore agree on a label while performing different writes. **Does not repeat**,
> **End series** and **No end** are now three operations with three names, and no
> implementation may route them through a shared `Never` branch. The reasoning, the rejected
> alternatives and the conversion-survivor rule are
> [`../02-architecture/decisions.md`](../02-architecture/decisions.md) **ADR-054**; the rule
> that scope is stated rather than inferred is **ADR-053**. Neither is restated here — where
> this section and an ADR appear to differ, the ADR owns the mechanics and this section owns
> what the user sees.

**Does not repeat** needs one guard on an existing series. Removing `recurrence` from a
series that has stored past completions leaves its `OCC#` rows stored but removes them from
rendering — expansion is what puts those dates on screen. Choosing Does not repeat on such a
series therefore confirms first, in the §1a.1 shape
([`interaction-contract.md`](interaction-contract.md#1a1-additive-changes-happen-immediately-destructive-changes-explain-what-will-be-lost)),
naming the real completion count — the same count and copy source as `Delete whole series`
([`activities.md`](activities.md#64-deleting) §6.4) — and pointing at `End series` as the
alternative that stops future occurrences while keeping history rendering. On a series
with no recorded completions, the conversion applies immediately.

The **anchor date** in the table above is the segment's `effectiveFrom`. For the first
segment it is always the activity's `schedule.date` at the moment recurrence is set; for an
appended segment it is the date the "all future" edit took effect (§6.2). An anchor is not
editable separately, and no later edit ever re-anchors a segment that has already been
written — editing a series appends a segment; it never moves an existing one.

`recurrence.mode` is `'fixed'` in v1 (§6.7).

> **Repeat-control amendment — 2026-08-12.** This dropdown replaces the earlier chip,
> stepper, and selected-weekday controls. Here `Custom` deliberately means a typed
> `interval_days` value; the RFC 5545 `freq: 'custom'` editor remains Phase 9 work. Hourly is
> deliberately deferred: the current recurrence engine and occurrence identity produce one
> wall-date occurrence per series per day, so multiple intraday occurrences require a broader
> recurrence and occurrence-storage redesign.

> **Decision:** Yearly ships in v1 rather than waiting for `freq: 'custom'`. Birthdays and
> anniversaries are the most obvious recurring events in a life planner, and putting them
> behind a hand-written RFC 5545 `rrule` would put the most common case behind the least
> accessible option.

> **Decision:** the sheet always writes explicit anchors — `byMonth` + `byMonthDay` for
> yearly, `byMonthDay` for monthly. A yearly series anchored only on its segment's
> `effectiveFrom` would silently
> move every future year if the user rescheduled the first occurrence, and a birthday must
> not drift because you shifted this year's dinner. The expansion function still falls back
> to the segment's `effectiveFrom` when the anchors are absent, so a hand-constructed
> series works, but the sheet never relies on that
> ([`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence)).

**Month-end clamping.** A monthly or every-N-months series on day 29, 30 or 31 emits the
last day of any selected month that is shorter. `byMonthDay: [31]` produces 28 February
(29 in a leap year), 30 April, 31 May. It never skips a selected month and never spills
into the next.

The same rule covers **29 February** on a yearly series. A yearly series anchored on
29 February emits 29 February in a leap year and **28 February** in every other year. It is
never skipped, never moved to 1 March, and the stored anchor (`byMonth: [2]`,
`byMonthDay: [29]`) is never rewritten — the
clamp happens at expansion time, so the series still emits 29 February again the next time
one comes round. `Every year on 29 February` is the label in both cases; the row on Today
carries the date it actually landed on.

### 6.2 One row per series

A recurring activity is **one** stored Activity. Future occurrences are never materialised
as rows — see
[`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence).

That one row also holds the series' full rule history. `recurrence` is an ordered list of
**rule segments**, each carrying the rule fields of §6.1 plus an `effectiveFrom` date that
doubles as its expansion anchor. A segment is in force from its `effectiveFrom` until the
day before the next segment's `effectiveFrom`; the last segment runs until the series' Ends
setting, or forever. Segments are rule history on the one row — never extra Activity rows,
and never materialised occurrences.

**An "all future occurrences" edit appends a segment; it never rewrites one.** Changing Gym
from Mon/Wed/Fri to Tue/Thu, or moving it from 6:00 PM to 7:00 AM, appends a new segment
whose `effectiveFrom` is the edited occurrence's date — or today, when the edit is made
from the series' detail screen outside any occurrence context. A time change is a segment
change for the same reason a rule change is: each segment carries the time that was in
force while it applied. Past segments are immutable. Expansion picks the segment in force
for each date, so a past occurrence — and its completion, skip or snooze — renders forever
under the rule and time that were in force on its date. `This occurrence only` keeps its
existing Occurrence-override semantics (§6.3), unchanged: an occurrence override still
never mutates the series, and appending a segment is an owner's edit to the series row, not
an occurrence action.

> **Same-day correction amendment — 2026-08-12.** There is one narrow exception to
> append-only history: when the active segment itself starts today and today's occurrence has
> no stored completion, skip, snooze, or reschedule override, changing Repeat replaces that
> active segment in place. This lets a user correct a rule immediately after creating it
> without attempting two segments with the same `effectiveFrom`. The write conditionally
> verifies that `OCC#<today>` is absent in the same transaction. Once today's occurrence has
> any stored action, history exists and the ordinary append-only rule applies; the user edits
> from the next occurrence instead. Every segment before the active one remains immutable.

A series is capped at **20 segments**. The edit that would create a 21st returns
`validation_failed`, and the sheet explains it and suggests ending the series (see
[`activities.md`](activities.md#64-deleting) §6.4) and starting a new one — a series edited
that many times is a new habit wearing an old row, and an unbounded segment list would make
every expansion pay for it.

> **Decision — segmented recurrence (2026-08-07).** "All future occurrences" used to patch
> the single stored rule in place, and expansion fetched `OCC#` overrides only for dates
> the *current* rule emits. Changing Gym from Mon/Wed/Fri to Tue/Thu therefore made months
> of past completions stop rendering anywhere, and a time edit rewrote how every past
> occurrence displayed. That fails the same test §7 sets for rolled-forward tasks: history
> is honest. Segments fix it without touching the one-row rule — the series is still one
> Activity, nothing is ever materialised, and an edit appends a few bytes of rule, not
> rows. The stored shape and the segment-aware expansion are owned by
> [`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence)
> and
> [`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm).

The rendering rule that follows: **Today shows at most one row per series.** If a series
would produce two occurrences on one date (only possible through a malformed custom
`rrule`), the expansion emits the earliest and drops the rest, and the response carries a
warning.

Screens that show several days at once — Plans → Upcoming, any multi-day agenda window —
show one row per series *per date*.

### 6.3 Occurrence semantics

An occurrence is identified by `(activityId, occurrenceDate)`. The absence of an
`Occurrence` row means "scheduled, not yet acted on". Rows exist only for occurrences the
user has touched.

| Action on an occurrence | Written | Series affected |
| --- | --- | --- |
| Complete | `Occurrence { status: 'completed', completedAt }` | No |
| Un-complete | `Occurrence` deleted, or `status` cleared | No |
| Skip | `Occurrence { status: 'skipped' }` | No |
| Snooze | `Occurrence { status: 'snoozed', snoozedUntil }` | No |
| Reschedule this occurrence | `Occurrence { status: 'rescheduled', overrideTime and/or overrideDate }` | No |
| Reschedule all future | A new rule segment appended to `recurrence`, `effectiveFrom` = the edited occurrence's date (§6.2) | **Yes, forward only**: past segments and existing `Occurrence` rows are untouched |
| Delete this occurrence | `Occurrence { status: 'skipped' }` | No |
| Does not repeat | In one domain transaction, copy the selected occurrence's effective date, time and end time to the Activity schedule, retain its timezone, and remove `recurrence` | **Yes, type conversion**: the selected occurrence becomes the one-off; other generated occurrences stop rendering; stored `OCC#` rows are untouched |
| End series | `recurrence.endDate` set inclusively to the explicit occurrence in view on the series row | **Yes, forward only**: no later occurrences are emitted; every past occurrence keeps rendering |
| No end | Clear `recurrence.endDate` and `recurrence.count` on the series row | **Yes, forward only**: expansion continues indefinitely under the stored segments |
| Delete whole series | Activity deleted, occurrences — and the history they hold — cascade, after the confirmation in [`activities.md`](activities.md#64-deleting) §6.4 names that history | n/a |

`This occurrence only` moves are not limited to the clock. An `overrideDate` moves a
single occurrence to another day: the occurrence is emitted on its override date — not its
original one — and renders there with a `moved from Tue, 4 Aug` affix. The series and
every other occurrence are untouched.

The three recurrence-changing rows above are three write paths, and each names the one it
uses ([`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities)
§2.3):

| Operation | Write path | Target |
| --- | --- | --- |
| Does not repeat | `POST /v1/activities/:id/recurrence/convert` | `{ occurrenceDate }`, **required** — there is no unscoped form |
| End series | `PATCH /v1/activities/:id` carrying a `recurrence` whose `endDate` is the occurrence in view | The date is stated by the caller, never resolved from cache |
| No end | `PATCH /v1/activities/:id` carrying a `recurrence` with neither `endDate` nor `count` | Series-level; no occurrence is involved |

`AgendaItem.occurrenceDate` is present if and only if the item came from a series
expansion. The client must send it back on every occurrence-scoped call
(`complete`, `skip`, `snooze`). Omitting it targets the series and is a bug.
Navigation from that row carries the same explicit target into detail. A series-only detail
screen cannot infer today, the next occurrence or the most recent occurrence from the agenda
cache; it offers series actions only until the user opens a real occurrence.

### 6.4 Completing one occurrence

Completing today's Gym completes today's Gym. Tomorrow's Gym still exists, at its normal
time, unchanged. Concretely:

- `POST /v1/activities/:id/complete` with `{ occurrenceDate: '2026-08-06' }` writes exactly
  one item, `ACT#<id>/OCC#2026-08-06`, per
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).
- The series' `ACT#<id>/META` is not written. Its `updatedAt` does not change. This is
  success criterion S6 in [`overview.md`](overview.md#7-success-criteria-for-v1) and is
  asserted in an integration test.
- The completed row moves from SCHEDULE to EARLIER TODAY on the same screen, without a
  refetch.
- No follow-up suggestion is offered on a recurring completion (see
  [`activities.md`](activities.md#53-follow-up-suggestions)). The next occurrence already
  exists.

### 6.5 Snooze does not shift the series

This is the concept's explicit example and a required test case:

```
Gym
Normally 6:00 PM
Today   → snooze until 8:00 PM
Tomorrow → still 6:00 PM
```

Mechanically: snooze writes `Occurrence { date: today, status: 'snoozed',
snoozedUntil: '20:00' }`. The expansion in
[`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm)
step 5 emits today at 20:00 and every other date at the time of the segment in force
(§6.2). Nothing about `Recurrence` is read or written by snooze.

The same is true of complete, skip and single-occurrence reschedule. A code path that
snoozes and then writes `ACT#/META` is wrong even if the visible result looks right.

### 6.6 Daylight saving time

Series are expanded in the activity's stored `schedule.timezone` using calendar arithmetic,
not by adding fixed millisecond offsets.

| Case | Behaviour |
| --- | --- |
| A daily 6:00 PM task across a DST transition | Stays 6:00 PM local on both sides. The UTC instant shifts by an hour; the wall-clock time does not. |
| An occurrence whose local time does not exist (spring forward, e.g. 02:30 on a day that jumps 02:00 → 03:00) | Emitted at the first valid local time after the gap (03:00). It is never dropped. |
| An occurrence whose local time occurs twice (fall back) | Emitted once, at the **first** (earlier UTC) instance. |
| The profile timezone changes — explicitly in Settings, or by auto-follow (below) | Existing activities keep their stored `schedule.timezone`. Today's boundaries and the "now" comparison use the *profile* timezone. A 6:00 PM New York task viewed from London shows as 11:00 PM on the London day. |
| `scheduledAtUtc` | Recomputed on every schedule write, and by the reminder scheduler when it reads the item. Never trusted as authoritative over `date` + `time` + `timezone`. |

**The device timezone is authoritative by default.** On app foreground, if the device
timezone differs from the profile timezone, the client updates the profile timezone — a
server write, so reminder scheduling and quiet hours follow — and shows a dismissible,
non-blocking banner: `Now showing times in London time.` The banner appears on every
change and is never a modal; there is nothing to confirm, only something to notice.

A Settings toggle, `Lock to home timezone` (default off), suppresses auto-follow. When
locked, a mismatch shows a passive indicator in place of the banner — never a prompt, and
never a loop of prompts. Timed activities are unaffected either way: they store their own
`schedule.timezone` and already convert per viewer (the row above).

> **Decision — the device timezone wins by default (2026-08-07).** This section used to
> cover only an explicit profile change, which left the common case — landing in London
> with the profile still on New York — undefined, and the least bad reading was a Today
> whose day boundary sat at home-midnight, 5 AM local. Calendars set the expectation that
> times follow the device, and a stale home-midnight day boundary is the worse surprise:
> reminders fire at the wrong wall-clock hour and "today" ends mid-evening. Auto-follow
> fixes that; the banner exists because a day boundary must never move invisibly. The
> change is therefore never silent and never modal, and `Lock to home timezone` keeps the
> choice with the user.

The reminder scheduler works from UTC instants; the agenda works from wall-clock. Both must
agree at the boundary, which is what the DST unit tests in `packages/shared` assert.

### 6.7 Fixed vs completion-relative modes

`Recurrence.mode` has two values. v1 ships `fixed` only.

| Mode | Meaning | Status |
| --- | --- | --- |
| `fixed` | Every Tuesday, whether or not last Tuesday was done. Occurrences are a pure function of the segment anchors and their rules (§6.2). | **v1.** |
| `after_completion` | Three days after the last time it was actually done. | Phase 9. |

When `after_completion` ships, the Repeat sheet grows a segmented control at the top:
`On a schedule` / `After I finish it`. Its semantics are fixed now so nothing has to be
re-litigated later:

- The next occurrence is `last completion date + interval`. With no completions ever, it is
  the active segment's `effectiveFrom`.
- It projects **at most one** future occurrence. A completion-relative series never appears
  more than once in a date range, however wide.
- Skipping does not advance it. Only completing does.
- Snoozing does not advance it.

Until Phase 9 the mode control is not rendered and the API rejects
`mode: 'after_completion'` with `validation_failed`.

---

## 7. Overdue tasks

The concept does not state a rule for a dated task that was never completed. This section
states one.

> **Decision — the overdue rule.** A **task** (`type === 'task'`) that is not part of a
> recurring series, has `status: 'scheduled'`, and has `schedule.date` strictly before
> today, is **rolled forward onto Today** in OVERDUE, retaining its
> original stored date. Nothing else rolls forward: not meals, not watch sessions, not
> events, not custom activities, and not recurring occurrences.

Details:

1. **Nothing is mutated.** The activity keeps `schedule.date` = its original date. The roll
   forward is a *query* rule inside the agenda handler, enabled by `include=overdue`. This
   keeps "Today owns no data" intact: the item is still on its own date in Plans and in any
   date-range view.
2. The row shows a date chip in the trailing slot, using the shortest unambiguous form:
   `Yesterday`, a weekday name for the last 6 days (`Tue`), otherwise `4 Aug`. Colour is
   the app's de-emphasis colour, not red. Overdue is information, not an alarm.
3. **Cut-off.** Only tasks dated within the last **30 days** roll forward. Older ones stay
   where they are and are reachable through `GET /v1/activities?filter=past`. Without a
   cut-off, one abandoned month poisons Today permanently.
4. **Cap and collapse.** If more than 5 tasks roll forward, the first 3 render and the rest
   collapse behind a `+7 more overdue` row that expands in place. No badge count is shown
   anywhere else in the app.
5. Completing a rolled-forward task completes the original activity with its original date.
   `completedAt` is now; `schedule.date` is unchanged. Its history is honest, while the Today
   projection moves it to EARLIER TODAY so the progress figure advances.
6. Tapping the date chip opens the reschedule sheet pre-set to today, which is the one-tap
   path for "yes, do it today". The app never does this automatically.
7. **Recurring occurrences never roll forward.** A missed Monday gym is gone. Reviving it
   would produce a growing pile of identical rows, which is exactly the failure mode
   recurring tasks exist to avoid.
8. Non-task types dated in the past are handled by §8, not by roll-forward.

---

## 8. Passed plans

A scheduled activity that has passed must not look like an unfinished task forever
(concept §18).

### 8.1 When something has "passed"

| Item | Passes at |
| --- | --- |
| Timed, with `endTime` | `endTime` |
| Timed, no `endTime` | `time` |
| All-day / untimed | The end of that local day |

An item that has passed moves from SCHEDULE to EARLIER TODAY. On the client this happens on
the one-minute ticker without a refetch; on the server it is the
`isPast` flag on `AgendaItem`.

### 8.2 Resolution prompts

An item in EARLIER TODAY that is still `scheduled` (not completed, skipped or cancelled)
shows one inline prompt in its trailing slot. The prompt is a **question**, not a warning,
and carries no badge, colour alarm, or count.

| Type | Prompt shown on the row | Options presented when tapped |
| --- | --- | --- |
| `task` | `Done?` | `Complete` · `Didn't happen` |
| `meal` | `How did it go?` | `Had it` · `Didn't happen` |
| `watch` | `How did it go?` | `Watched` · `Didn't happen` |
| `event` | `How did it go?` | `Attended` · `Didn't go` |
| `custom` | `Done?` | `Done` · `Didn't happen` |

The same prompt appears at the top of the item's detail screen. Selecting the positive
option calls `POST /v1/activities/:id/complete` with the matching `outcome`; selecting the
negative option calls `complete` with `outcome: 'didnt_happen'` / `'didnt_go'`, which sets
`status: 'skipped'`.

**The prompt is shown to the owner only** (§4.1). A participant's passed row moves to EARLIER
TODAY, de-emphasised, with no prompt and no chip — there is nothing for them to answer, and
`Didn't go` is an RSVP, not an outcome.

### 8.3 Never force cleanup

Hard rules a reviewer checks:

1. There is **no** unresolved-items count, badge, or nag anywhere in the app.
2. There is **no** notification asking the user to resolve a passed plan.
3. An unresolved passed item **never** reappears on a later day. It stays on its own date.
   (Overdue roll-forward in §7 applies to tasks only, and a task's prompt is `Done?`, which
   is a genuine to-do, not a cleanup chore.)
4. After the day ends, unresolved items simply become history. They render in Plans on
   their own date with no prompt and no styling that implies fault.
5. The maintenance job that drops **undated** terminal items out of GSI1 after 60 days (see
   [`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets))
   never touches dated items at all — Plans → Past is permanent history (decision
   2026-08-07) — and does not change any item's status. It only stops indexing what it
   covers.

> **Decision:** unresolved passed items are never auto-completed and never auto-skipped.
> The app does not decide on the user's behalf whether something happened.

---

## 9. Worked example day

**Context.** Thursday 6 August 2026. Profile timezone `America/New_York`. Current local
time **3:10 PM**. This matches the sample in
[`original-concept.md`](original-concept.md) §4, extended with the sections and rules
above.

### 9.1 Stored data

| # | Activity | Type | Schedule | Notes |
| --- | --- | --- | --- | --- |
| A | Overnight oats | `meal` | 6 Aug 08:00 | Already `completed`, `outcome: 'had_it'`, slot breakfast |
| B | Dentist appointment | `event` | 6 Aug 14:30 | `location.label` = `Dr Patel`, still `scheduled` |
| C | Pick up groceries | `task` | 6 Aug 17:30 | Reminder −15 min |
| D | Gym | `task` | series: one segment — weekdays, 18:00, `effectiveFrom` 2026-01-05 | No occurrence row for 6 Aug |
| E | Chicken tacos | `meal` | 6 Aug 19:30 | Slot dinner; 4 ingredients, 3 already on Groceries |
| F | Severance | `watch` | 6 Aug 20:00 | `mediaKind: 'show'`, S2 E4, service Apple TV+, Alice is a participant (`rsvp: 'going'`) |
| G | Submit insurance form | `task` | 6 Aug, no time | |
| H | Call apartment office | `task` | **4 Aug**, no time | Still `scheduled` — overdue |
| I | Book flights for New York | `task` | none | `status: 'saved'`, `parentActivityId` = New York Trip |

### 9.2 One request

```
GET /v1/agenda?from=2026-08-06&to=2026-08-06&tz=America/New_York
    &include=anytime_unscheduled,overdue
```

Server-side: query GSI1 `U#<u>#S` for `2026-08-06T00:00`–`2026-08-06T23:59` (A, B, C, E, F,
G); query `U#<u>#R` and expand (D → one occurrence at 18:00, no override row); query
`U#<u>#N` for the undated bucket (I); query the overdue window `2026-07-07`–`2026-08-05`
filtered to `type === 'task'` and `status === 'scheduled'` (H).

### 9.3 Rendered screen

```
THURSDAY, AUGUST 6
Today                                                  0 of 9 done
━━━━━━━━━━────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────────────┐
  │  UP NEXT · IN 2 HOURS                                        │
  │  □  Pick up groceries                                        │
  │     5:30 PM                                                  │
  │     Complete   Snooze                                        │
  └──────────────────────────────────────────────────────────────┘

EARLIER TODAY                                            1 done  ⌄

NOW ─────────────────────────────────────────────────────  3:10 PM

SCHEDULE
  5:30 PM   □  Pick up groceries
  6:00 PM   □  Gym                                              ↻
  7:30 PM   ◇  Chicken tacos                       Meal · Dinner
  8:00 PM   ◇  Severance                    Watch · S2 E4    (A)

OVERDUE                                                         1
            □  Call apartment office                 Due Tue

TODAY · NO TIME                                                 1
            □  Submit insurance form

ANYTIME · NO DATE                                               1
            □  Book flights for New York          New York Trip
  + Add a task
```

**EARLIER TODAY renders collapsed**, above SCHEDULE and above the NOW divider (§2, §2.4). Opened,
it holds its two rows **oldest first**:

```
EARLIER TODAY                                            1 done  ⌃
  8:00 AM   ◇  Overnight oats                            Had it
  2:30 PM   ◇  Dentist appointment       Dr Patel   How did it go?
```

`(A)` is Alice's avatar. `↻` is the recurrence glyph.

### 9.4 Why each row is where it is

| Row | Section | Rule |
| --- | --- | --- |
| Pick up groceries | UP NEXT + SCHEDULE | First timed item at or after 15:10 that is not resolved (§2.1). Rendered in both places (§2.1). |
| Gym | SCHEDULE | Series expansion emitted 18:00 for 6 Aug; no `Occurrence` row exists, so it is unresolved (§6.3). Checkbox because it is a `task` (§4). |
| Chicken tacos | SCHEDULE | Timed, future. Diamond marker, not a checkbox, because `meal` (§4). |
| Severance | SCHEDULE | Timed, future. Subtitle from `details` (§4). |
| Call apartment office | OVERDUE | Overdue task from 4 Aug, inside the 30-day window, rolled forward with overdue date metadata (§7). |
| Submit insurance form | TODAY · NO TIME | Dated today, no time (§2.3). |
| Book flights for New York | ANYTIME · NO DATE | Undated `saved` task, merged in by `include=anytime_unscheduled`. Subtitle is the parent plan (§5.5). |
| Overnight oats | EARLIER TODAY, top | Passed and already completed; shows its outcome verb (§2.4). Ascending order puts it above the 2:30 PM item (§2.4, amended 2026-08-17). |
| Dentist appointment | EARLIER TODAY, bottom | Passed at 14:30, no end time (§8.1). Still `scheduled`, so it carries the `event` prompt (§8.2). Nearest to NOW, so it sits last (§2.4). |

### 9.5 What happens next on this screen

| Time / action | Result |
| --- | --- |
| 17:15 | Reminder push for Pick up groceries fires (−15 min). |
| 17:30 | The one-minute ticker moves Pick up groceries to EARLIER TODAY; UP NEXT becomes Gym at 6:00 PM. |
| User taps the Gym checkbox | `POST /v1/activities/<D>/complete { occurrenceDate: '2026-08-06' }`. One `OCC#2026-08-06` item written. The series is untouched. Tomorrow (Friday) still shows Gym at 6:00 PM. |
| User swipes Chicken tacos → Snooze → 1 hour | Not offered. Snooze is a task affordance; for a `meal` the swipe offers Reschedule, which opens the reschedule sheet. |
| User taps `How did it go?` on Dentist appointment | Sheet with `Attended` / `Didn't go`. `Attended` writes `outcome: 'attended'`, `status: 'completed'`. The row loses its prompt and shows `Attended`. |
| User ignores the dentist prompt entirely | Nothing happens. Tomorrow the row is not on Today at all, carries no prompt in Plans, and is never counted anywhere (§8.3). |
