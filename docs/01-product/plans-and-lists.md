# Plans and lists

**Status:** canonical for the Plans tab, plan detail, lists, shared lists, and the optional
bridge between them. Lists are independent collections, not a staging area for plans — §5.1
is the load-bearing section. Entities are owned by
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem);
endpoints by
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).

---

## 1. What makes an Activity a Plan

A date, a phrase, and another person's name are not the distinction. A Plan is an Activity
the user explicitly created as a Plan, after choosing **General**, **Meal**, **Watch**,
**Event**. A date changes its scheduling state, not its identity. The rule is stated once in
[`overview.md`](overview.md#31-four-concepts-connected-where-it-is-useful) §3.1.

A Plan is still stored in the Activity entity, with `objectKind: 'plan'`; a Task uses
`objectKind: 'task'`. There is no separate Plan table or **automatic** promotion step.
Explicit intent is persisted rather than reconstructed from `type`, people, title, or date;
Task ↔ Plan changes use the explicit conversion flow in [`activities.md`](activities.md) §6.3. A plan can exist
before anybody has picked a day for it: `Dinner at Zahav with Alice, date TBD` is a plan,
not a saved scrap. A date decides only *which stage of Plans it sits in* and whether it can
reach Today.

| Property | Consequence |
| --- | --- |
| `schedule.date` present | `status` becomes `scheduled`. The Activity appears in Plans → Upcoming, in the agenda for that date, and on Today when that date is today. |
| `schedule.date` absent | A Plan is `saved` in Plans → Needs a date. A Task is `saved` in Today's ANYTIME (§1.2). |
| `schedule.time` present | It occupies a slot in Today's SCHEDULE rather than ANYTIME. |
| `participants.length > 0` | Valid on `objectKind: 'plan'` only. `visibility` becomes `shared` after the user uses the People picker or another explicit sharing action. Tasks do not gain participants; coordinated work is **Plan → General** or another visible Plan kind. Typed names and capture never add participants. |
| `type` | The explicit creation choice sets it: Task → `task`; Plan kinds General / Meal / Watch / Event → `custom` / `meal` / `watch` / `event`. It changes which fields and completion verb render, while `objectKind` preserves Task versus Plan. |

Plan intent therefore **does** appear in the data model as `objectKind: 'plan'`. Do not
build a separate Plan entity or infer Plan-ness from another field: Tasks and Plans remain
Activities, read through buckets of one index.

### 1.1 Creation routes

Every route below starts with an explicit Task or Plan choice and ends at one
`POST /v1/activities`. Text, images, links, and AI can fill compatible fields only after
that choice.

| Route | Entry point | Pre-fills |
| --- | --- | --- |
| Manual Plan | Global `+` → **Plan** → **General / Meal / Watch / Event** → form | Date only if launched from a dated context, after the choices |
| Manual Task | Global `+` → **Task** → form, or contextual `+ Add a task` | `objectKind: 'task'`, `type: 'task'`; compatible context such as date or parent plan |
| Natural language | Choose Task or Plan and, for Plan, its kind → type text | Compatible fields from the reviewed parse; never object kind, Plan kind, or people ([`ai-capture.md`](ai-capture.md)) |
| From a photo or screenshot | Choose Task or Plan and, for Plan, its kind → Camera / Photos | Compatible reviewed fields + the image as an attachment |
| From a pasted link | Choose Task or Plan and, for Plan, its kind → Link | Compatible reviewed fields + `sourceUrl` |
| **From a list item** | List item → `Plan this item` → explicit Plan kind and audience | Title plus Activity `listId` / `listItemId` provenance, established only by the list-scoped endpoint (§6). The list's name, creation preset, settings, and item words never select or pre-select kind. |
| From a person | Person view → `Plan something with Alice` | Alice as a participant |
| Duplicate | Plan overflow → Duplicate | `objectKind`, title, type, `details`, `location` and `notes` — and nothing else ([`activities.md`](activities.md#71-quick-add-behaviours) §7.1, which is authoritative). **Amended in P1-15:** this row read "everything except schedule, participants, expenses, attachments", which predates the 2026-08-07 decision adding reminders, prep children and lists to the drop list — so read alone it implied reminders survived. Stated as what *is* copied rather than what is not, since that list is short and closed and cannot go stale the same way. |
| From an invitation | Accepting an in-app invite | Nothing is created; an `ActivityIndex` entry is added for the invitee |

### 1.2 Where an explicitly chosen object with no date appears

An Activity with no date routes to exactly one of two places, by a pure rule owned by
[`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets)
(`deriveGsi1Bucket`). This rule decides a saved Activity's **display bucket after creation**.
It does not decide what object the user meant to create.

| Condition | Destination |
| --- | --- |
| `objectKind: 'plan'` | **Plans → Needs a date.** Never Today. |
| `objectKind: 'task'` | **Today → ANYTIME.** Never Plans. |

For a Task, no date means "whenever" — `Submit the insurance form` is an errand you do at
some point. For a Plan, no date means *not decided yet*, including General. A solo,
undated `Poconos trip` is a Plan that needs a date even though nobody else is on it, and it
does not belong on Today next to the insurance form.

Words never route captured intentions. Identical words produce the object selected before
they were entered:

| Explicit action | Text entered | Result |
| --- | --- | --- |
| `Restaurants to try` → **Add an item** | `Try Zahav` | One ListItem in `Restaurants to try`; no Activity. |
| Global `+` → **Plan** → **Event** | `Try Zahav` | One undated Event Plan in **Needs a date**; no ListItem. |
| `Movies to watch` → **Add an item** | `Watch Severance` | One ListItem in `Movies to watch`; no Activity. |
| Global `+` → **Plan** → **Watch** | `Watch Severance` | One undated Watch Plan in **Needs a date**; no ListItem. |
| Global `+` → **Task** | `Watch Severance` | One Task in **ANYTIME**. The verb does not override the Task choice. |
| **Plan** → **Watch**, then People picker → Alice | `Watch Severance Friday 8 PM` | One Friday Watch Plan shared with Alice. Typing `with Alice` alone would not add her. |

Nothing promotes one object into another. A user may explicitly use `Plan this item` to
link a ListItem to a new Plan (§6), but the words themselves never cause that bridge.

### 1.3 The Plans tab

Plans has three stages, in this fixed order, served by one `GET /v1/plans`
([`../02-architecture/api-contract.md#22a-plans`](../02-architecture/api-contract.md#22a-plans)).

> **Amendment (2026-08-25, founder) — the stages are a switcher, not a stack.** The three
> stages were previously stacked on one scroll, each rendering its heading and its empty line
> so that "the three stages together are the shape of the screen". That reasoning was sound
> and the layout was not: `needsDate` **does not paginate**, so eight undated plans push
> Upcoming below the fold and thirty put it somewhere nobody scrolls. Where "what is on
> Friday" lives then depends on how many loose ideas you happen to be holding — which is the
> backlog dynamic §1.3.2 exists to prevent, arriving through layout instead of through a
> badge. The stages now render as a `SegmentedControl` (`Needs a date · Upcoming · Past`),
> one stage visible at a time.
>
> **Nothing in §1.3.2 forbade a switcher; it forbids the numbers on it.** The control carries
> no counts, no badges and no dots — its three words are always on screen, which is what
> preserves the vocabulary the stacked layout was protecting. A selected stage with nothing
> in it still renders its own empty line (§1.3.3), and when **all three** are empty the
> switcher is replaced by the single `No plans` state rather than showing an empty control.

| Stage | Contains | Order | Source |
| --- | --- | --- | --- |
| **Needs a date** | Activities with `objectKind: 'plan'` and no date (§1.2) | `lastActivityAt` **descending** — most recently discussed first | `needsDate` |
| **Upcoming** | Activities with a date from today forward, grouped under date headings | Date ascending, then effective time, then `activityId` | `upcoming` |
| **Past** | Activities with a date before today, grouped under month headings | Date descending, paginated | `past` |

> **Decision — Needs a date sorts by most-recently-discussed, not by oldest.** An RSVP, a
> posted update or an added expense bumps `lastActivityAt`, so the plan people are actually
> talking about floats to the top. Sorting oldest-first would build a queue with the most
> ignored thing at the head, which is a backlog, and this stage is explicitly not one
> (§1.3.2). `updatedAt` is not used for this; it backs `If-Match` and would be bumped by an
> unrelated edit.

Upcoming and Past are not plans-only. The agenda bucket that serves them returns every
dated Activity, so dated **Tasks** appear under their date and month headings too — the tab
is "everything with a date, plus plans needing one", which
[`today-and-tasks.md`](today-and-tasks.md#7-overdue-tasks) §7 already assumes when it keeps
a rolled-forward task on its own date in Plans.

> **Decision (2026-08-07) — Past is permanent.** Past is the plan's memory lane, and it does
> not expire. A trip completed in March is still in Past in June, and in June of any later
> year; the month grouping and the pagination carry the whole history, however far back it
> goes. No archival window, sweep, or age limit ever removes anything from this stage — the
> storage side keeps the full past range reachable
> ([`../02-architecture/data-model.md`](../02-architecture/data-model.md)).

#### 1.3.1 Row anatomy

> **Presentation note (2026-08-08).** The Plans tab now renders these as **event cards**,
> per the founder's design reference — see
> [`../04-conventions/design-system.md`](../04-conventions/design-system.md) §7.3, which
> reverses the earlier rows-for-density decision. Everything below about *content* —
> which lines exist, in which stage, in which order, with which vocabulary — is unchanged
> and remains canonical; "row" here names the unit of content, and the card is its frame.

**Needs a date.** Two lines, no time column, no checkbox. A third line appears only when
somebody has suggested a date (§2.3).

```
NEEDS A DATE

  ◇  Dinner at Zahav                                Event
     Alice interested · Ben hasn't replied                    ›
     2 dates suggested

  ◇  Poconos trip                                   Event
     Just you                                                 ›

  ◇  Severance with Alice                            Watch
     Alice and 2 others interested · 1 hasn't replied         ›
```

| Element | Rule |
| --- | --- |
| Leading marker | The type's non-interactive diamond. **Never a checkbox**, on any type. |
| Title | The activity title, two lines before truncating. |
| Trailing label | The Plan-kind label, de-emphasised. No date chip — there is no date. |
| Second line | The RSVP summary, in plain language, always rendered. |
| Third line | **Amended by P3-36 (recorded 2026-09-01):** the date slot always reads `No date yet`, with the suggestion count appended as `— 1 suggestion` / `— n suggestions` when the count is ≥ 1 — the wording `design-system.md` §7.3 specifies and the founder's screen board draws. This row previously specified a count-only line rendered solely at count ≥ 1; the two canonical docs disagreed and the conflict is resolved toward §7.3 + the board, which encode the later decision. Unchanged: the count is content, never a badge or a count on the stage heading (§1.3.2), and it is `suggestionCount` on the `needsDate` item, alongside `rsvpSummary`, so the row costs no second request — [`../02-architecture/api-contract.md#22a-plans`](../02-architecture/api-contract.md#22a-plans). |
| Tap | Opens plan detail (U1). Nothing on the row mutates anything, including the third line. |

The RSVP summary is built from `rsvpSummary` on the response and follows these rules:

| Situation | Rendered |
| --- | --- |
| No participants | `Just you` |
| Participants are grouped by response, and the groups are joined by ` · ` in this fixed order | interested, maybe, pass, no reply |
| A group of one or two | Both names: `Alice interested`, `Alice and Ben interested` |
| A group of three or more | The first name and a count: `Alice and 2 others interested` |
| The no-reply group | Named the same way, with the verb changed: `Ben hasn't replied`, `2 haven't replied` |
| Nobody has responded at all | `Nobody has replied` — the one case that collapses to a single phrase |
| A group with nobody in it | Omitted. Empty groups never render as `0 maybe`. |

The words are the undated vocabulary — `interested`, `maybe`, `pass`, `hasn't replied` —
because the plan has no date. The stored values are unchanged; only the words differ. The
full mapping is in [`sharing-and-people.md`](sharing-and-people.md) §3.5.

Rendering a name requires a name, so `rsvpSummary` carries, per group, its count **and the
first one or two display names** in participant order. A counts-only summary would force the
row to fall back to `2 interested`, which reads as a poll result rather than as people, and
would make the row's whole reason for existing — knowing who is in — a second request away.

**Upcoming.** The same `AgendaItem` row Today renders
([`today-and-tasks.md`](today-and-tasks.md#4-row-affordances-by-type)), grouped under date
headings, with the time in the left column and the type's affordance rules unchanged. A
recurring series contributes one row per date in the window. A plan completed before its
date stays in Upcoming until the date passes and renders with its outcome verb in the
trailing slot, exactly as a Past row does.

> **Presentation amendment (2026-08-11, P2-32) — compress interior gaps and keep month
> context.** Upcoming renders a single quiet line for each consecutive run of empty calendar
> days **between** two dates that contain entries in the loaded window. One empty day reads
> `Aug 20 · nothing planned`; a longer run reads `Aug 20 – 24 · nothing planned`, using the
> same abbreviated month/day vocabulary as the surrounding date headings. The list renders
> no gap before its first dated entry and none after its last dated entry. Tapping a gap line
> opens the schedule date picker pre-set to the gap's first day and does nothing else: it
> does not create, schedule, or move an Activity. This is another application of
> **suggest, never auto-create**. Upcoming also renders month headers over its date groups;
> the current month header stays pinned while scrolling until the next month header replaces
> it. A persistent week strip and a direct-manipulation date scrubber remain out of scope and
> are parked in [`../00-open-decisions.md`](../00-open-decisions.md) deferred item #52.

**Past.** The same row, de-emphasised, with its outcome verb in the trailing slot when it
has one. **No resolution prompt and no styling that implies fault** — an unresolved past
plan renders plainly and is never counted anywhere
([`today-and-tasks.md`](today-and-tasks.md#83-never-force-cleanup)).

#### 1.3.2 Needs a date never nudges

Hard rules a reviewer checks:

1. No badge on the Plans tab, ever, for any stage.
2. No count in the `Needs a date` heading. The heading is the two words and nothing else.
3. No notification exists whose trigger is "this plan has had no date for N days".
4. Nothing is archived, hidden, de-emphasised or re-sorted for being old. Age is not a
   signal in this stage; `lastActivityAt` is.
5. No empty-state or heading copy describes the stage as something to clear, finish, or get
   through.

It is a place to look when you are deciding what to do, not a backlog. This is the same
rule that keeps Today from becoming a guilt list
([`today-and-tasks.md`](today-and-tasks.md#83-never-force-cleanup)), applied to the one
other surface that could plausibly grow a counter.

#### 1.3.3 Empty states

Per [`interaction-contract.md`](interaction-contract.md#52-empty) §5.2: one heading, one
line of guidance, at most one action.

| Stage | Heading | Guidance | Action |
| --- | --- | --- | --- |
| Needs a date | `Nothing without a date` | `Plans you've started but not scheduled show up here.` | — |
| Upcoming | `No upcoming plans` | `Anything with a date shows up here.` | `Add` |
| Past | `Nothing here` | `Plans that have happened show up here.` | — |
| All three empty | `No plans` | `Add something you want to do, on its own or with someone.` | `Add` |

Both `Add` actions open the same global **Task / Plan / Add list** chooser with nothing
selected. Being on the Plans tab never pre-selects Plan or skips the Plan-kind choice.

#### 1.3.4 The calendar navigator

> **Added 2026-08-25 (founder).** This resolves `../00-open-decisions.md` deferred item #52,
> which parked a week strip and a date scrubber because "selection, focus, accessibility, and
> synchronisation behavior has not been designed". The answer is none of the three candidates
> that item listed: a familiar month calendar, shared by two stages.

A chronological list answers *what is next* and cannot answer *what does my month look like*,
because distribution is not visible in a sequence you have to scroll. Upcoming and Past each
carry a calendar; **Needs a date does not**, having no dates to navigate.

**The invariant that removes the edge cases: the tab determines eligibility, not the
displayed month.** Every visible date belonging to the active stage is interactive, including
adjacent-month spillover. Selecting one changes the month on screen and **never** the stage.

| | Upcoming | Past |
| --- | --- | --- |
| Dataset | Today and future | Strictly before today |
| Collapsed | Rolling `Next 7 days`, today → +6 | Rolling `Previous 7 days`, −6 → today |
| Expanded | A normal month calendar, the same geometry in both |  |
| Month navigation | Current month and forward | Current month and backward |
| Encoding | Bar = plan load · dot = tasks present | Dot = known activity. **No dot = no claim** |
| Day tap | Jumps within the active stage. Never switches stage, never writes. | |
| Header tap | Month/year grid, clamped to the stage's direction | |

**Today belongs to Upcoming.** It is still actionable, so it sits with planning semantics —
and it therefore renders inert at the end of Past's `Previous 7 days` strip, present as a
boundary rather than a target.

**Three visual states, because there are three meanings.** A live date in the displayed month
gets the normal treatment; a live date spilling in from a neighbouring month is subordinate
but plainly readable and tappable; an out-of-stage date is inert. The middle state is the one
to get right — a date the user can see and legitimately act on must not look disabled — and
spillover carries its density with it, because rendering a visible, eligible day as an empty
cell would undermine the one thing the calendar is for.

**Absence of a past marker is not a claim of emptiness.** A dot means loaded-and-found; no dot
means nothing is known yet. That is the only honest reading when the data arrives by
pagination, and it is why Past never gets a load bar: a bar implies a measured quantity. It
also requires the client to track which ranges it has actually fetched — otherwise the dots
are whatever happens to be in memory, and the rule is decorative. No summary endpoint answers
"which months contain history"; that would be a second projection able to disagree with the
list.

**The clamp is visible, not merely enforced.** In Upcoming the back arrow and every earlier
month are dimmed; in Past the forward arrow is. Nothing silently does nothing.

**Two rules hold the whole thing together.**

1. **The calendar and the list derive from the same effective agenda state** — the projected
   one the list renders, including optimistic local writes, never a raw network payload. A
   reschedule that moves a row to Friday must move its density with it in the same frame.
2. **The calendar chooses the query window; it never becomes a second pagination or data
   model.** Upcoming requests its exact visible window. Past requests both visible bounds and
   follows the window's cursor until coverage is complete; only completed coverage can make
   an unmarked date mean loaded-and-empty. Older-list scrolling uses its separate ordinary
   Past cursor
   ([`../02-architecture/api-contract.md#22a-plans`](../02-architecture/api-contract.md#22a-plans)).

Dates here are viewer-local `WallDate`s throughout — cell, grouping, request bounds and the
today boundary share one definition, per
[`../04-conventions/coding-standards.md`](../04-conventions/coding-standards.md) §4.4. A
calendar that interpreted dates in UTC while the agenda used viewer-local wall dates would
disagree with the list at every midnight boundary.

Collapsed or expanded is remembered **locally** on each platform. It is view state, not
profile data.

### 1.4 Giving a needs-a-date plan a date

This is the one transition the stage exists for, and it is destructive: it discards
responses people already gave.

**Why.** Someone who said `Interested` to an undated plan agreed to the idea, not to a time
nobody had picked. Carrying that response onto a Saturday claims consent they never gave.
The reset rule and its exact transitions are canonical in
[`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change).

**The flow.**

1. The plan's when/where block reads `Not scheduled` with a `Schedule` action (§2.2). Tapping
   it, or the block itself, opens the reschedule sheet (U4).
2. The user picks a date and optionally a time and taps `Set date`.
3. **If the plan has participants who have responded**, a confirmation is shown before
   anything is written. It is an instance of the invariant in
   [`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.1 and
   takes that section's shape:

   ```
   Set Saturday 9 August as the date?

   This will reset:
     Alice's and Ben's replies — 2 people

   Keeps: the plan, its notes, its lists, and everyone on it.
   Everyone will be asked again.

                                 [ Cancel ]  [ Set the date ]
   ```

   The count is the number of participants who have actually responded, not the number of
   participants — a plan where nobody has replied shows **no confirmation at all**, because
   nothing would be lost (§1a.1 rule 3).
4. Confirming issues one `POST /v1/activities/:id/schedule`. The response carries
   `rsvpReset: true`, and the client says so rather than letting people discover it: a toast
   reading `Date set. Everyone has been asked again.`
5. The plan leaves Needs a date and appears in Upcoming, and on Today when the date is today.

**From a suggestion.** When somebody has suggested a date (§2.3), the owner's second route
is `Use this date` on the suggestion row. It opens the same sheet with the date and time
pre-filled, shows the same confirmation, and issues the same
`POST /v1/activities/:id/schedule` carrying `fromSuggestionId`. Nothing about the reset
changes: a suggestion marked as workable by four people is still not their consent to a
Saturday. Every suggestion on the plan is deleted once it is scheduled.

**What participants receive.** Each participant's own `rsvp` becomes `pending`, their row on
Today and in Plans regains its pending badge with inline `Going · Maybe · Decline`, and they
get one `plan_date_set` notification ([`notifications.md`](notifications.md#7-notification-catalogue)).
A system entry is written to the updates feed. The owner's own row is never reset.

**Changing a date that already exists** behaves identically: same confirmation, same reset,
same notification (`plan_date_changed`). **Changing only the time on the same date does
not** — responses are kept and participants get the existing `plan_changed` notification.
Clearing a date entirely also keeps responses; re-asking somebody to un-agree is noise.

---

## 2. Plan detail screen

One screen, one `GET /v1/activities/:id`, which is one DynamoDB `Query` over the
`ACT#<id>` partition (access pattern 4 in
[`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
Sections render in this fixed order and a section with nothing in it collapses to a single
"add" affordance rather than disappearing, so the plan's capabilities stay discoverable.

### 2.1 Anatomy

> **Amendment (2026-08-25, founder) — the screen grows as the plan does.** This section and
> [`../04-conventions/design-system.md`](../04-conventions/design-system.md) §7.5 disagreed:
> §2.1 specified ten expanded sections with the completion button last, while §7.5 — written
> later and **built by P2-41** — specified collapsed disclosure rows with the completion
> action directly under the schedule line. Neither answered the question that actually
> decides the screen, which is what it looks like *in between* empty and full. The rule below
> replaces the disagreement; the anatomy and section table that follow remain canonical for
> **what each section contains and who may act on it**, not for whether it renders expanded.
>
> **Rows split in two, by what they are.** A **setting** exists whether you have touched it or
> not — every activity has a notes field, a reminder state, a recurrence state. A **section**
> exists only because you put something in it.
>
> | What is in it | How it renders |
> | --- | --- |
> | A setting | Always, one compact row, value on the right. Notes, Reminder, Repeat. |
> | A section holding nothing | It does not render. It is discoverable as a named chip in one `Add to this plan` row at the foot. |
> | A section holding 1–3 rows | Expanded in full, with its own add affordance beneath. |
> | A section holding 4 or more | The first three rows, then `Show all n`. |
> | Notes over two lines | Clamped to two, the accessible name carrying the whole text. |
> | A capability not yet built | `Coming later`, subordinate, no chevron, no tap (§2.2). |
>
> **The completion action stays directly under the schedule line**, keeping §7.5: the screen's
> hero is the thing you came to do, and ten sections must not push it below the fold.
>
> Two failures this is calibrated against. A plan with two prep tasks must not hide them
> behind a disclosure that costs a tap to reveal less text than the row occupied — that is
> §7.5's flaw. A plan with twenty prep tasks and twelve updates must not render a wall — that
> is §2.1's. The thresholds are where those two meet.

```
┌─────────────────────────────────────────────────────────┐
│ ‹ Back                              Share    ⋯          │
│                                                         │
│  [ attachment image, if primaryAttachmentId ]           │
│                                                         │
│  New York Trip                                    (1)   │
│  Event · Shared with 3 people                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Fri 14 Aug                                       │  │  (2)
│  │  Manhattan                                        │  │
│  │  Remind me · 15 minutes before                    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  PEOPLE                                    Add people   │  (3)
│    Alice      Going                                     │
│    Ben        Maybe                                     │
│    Chloe      Invited · guest                           │
│                                                         │
│  PREP                                     3 of 5 done   │  (4)
│    ☐ Buy tickets                                8 Aug   │
│    ☐ Pack the car                              13 Aug   │
│    + Add prep task                                      │
│                                                         │
│  LISTS                                       Add list   │  (5)
│    Packing            8 items · 3 checked               │
│    Places to visit    6 items                           │
│                                                         │
│  EXPENSES                                 Add expense   │  (6)
│    Total $482.00 · You are owed $121.50                 │
│    Hotel            $340.00   paid by you               │
│    Train            $142.00   paid by Alice             │
│                                                         │
│  NOTES                                                  │  (7)
│    Check-in is after 3 PM.                              │
│                                                         │
│  ATTACHMENTS                                    Add     │  (8)
│    [ thumb ] [ thumb ]                                  │
│                                                         │
│  UPDATES                                                │  (9)
│    Alice is going                          2 days ago   │
│    Time changed to 8:00 PM                 3 days ago   │
│    + Write an update                                    │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                    Done                           │  │  (10)
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

| # | Section | Contents | Rules |
| --- | --- | --- | --- |
| 1 | **Header** | Title, Plan-kind label, share state, primary attachment as a hero image | Title is inline-editable by the owner. Tapping the hero opens the attachment viewer. `Share` opens the participant picker; `⋯` opens the overflow (edit, change Plan kind, duplicate, cancel, delete). |
| 2 | **When / where** | One date, the time range within that day, timezone if it differs from the profile, location label and address, and **your own** reminders | The date row and the address row are separate tap targets: the first opens the reschedule sheet ([`interaction-contract.md`](interaction-contract.md#3-gesture-table)), the second opens the platform maps app. Never inline-editable. There is one date, never a range (§2.4). The reminder row is described below. |
| 3 | **People** | Participants with RSVP state, guest badge, invite links | Owner-only add and remove. Each row opens that Person's view. See [`sharing-and-people.md`](sharing-and-people.md#2-adding-people-to-a-plan). |
| 4 | **Prep** | Child activities (`parentActivityId` = this plan) | §3. The default view lists **incomplete** prep tasks only. The `3 of 5 done` counter is tappable and expands the section to the full list, completed items included. |
| 5 | **Lists** | Lists whose `sourceActivityId` is this plan, plus any list explicitly attached | §4. `Add list` opens the same full, fixed-order catalogue as New List, with nothing selected; it creates nothing until the user explicitly picks a style and confirms. |
| 6 | **Expenses** | Expense lines and the plan-level owes summary | Only rendered when the plan has ≥ 2 participants **or** ≥ 1 expense. See [`expenses.md`](expenses.md). Every number drills down. |
| 7 | **Notes** | `activity.notes`, private to the owner's view | Distinct from `details.description` on an `event`, which *is* shown publicly. Notes never appear on the invite page. |
| 8 | **Attachments** | Images linked to the activity | Tap opens a viewer; long-press offers Set as cover / Delete. Owner-only add and delete. |
| 9 | **Updates** | The plan's activity feed, newest first | System entries (RSVP changes, time changes, expense additions) are written server-side with `kind: 'system'`. Participants may post entries; nobody may delete another's. See [`../02-architecture/api-contract.md#25-updates-the-plans-activity-feed`](../02-architecture/api-contract.md#25-updates-the-plans-activity-feed). |
| 10 | **Completion** | One primary button with the type's verb ([`activities.md`](activities.md#52-completion-verbs)) | **Owner only** — completion is global ([`activities.md`](activities.md#51-states) §5.1). For a passed plan the button is replaced by the resolution prompt ([`today-and-tasks.md`](today-and-tasks.md#82-resolution-prompts)). A recurring item opened from today's Plans occurrence completes that explicit occurrence and says so; a future occurrence cannot be pre-completed. |

**Your reminders, and only yours.** The reminder row inside the when/where block lists the
caller's own reminders on this plan, with `Add a reminder` beneath them. A shared plan has
one schedule and many reminder sets
([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)),
so the screen shows no count, no avatars and no trace of anybody else's — not even that they
have any. Joining a shared plan creates your own reminder from your own default offset
([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1); nobody
inherits the creator's, and the owner cannot set one for anyone else.

### 2.2 Section visibility

> **Pre-build discovery clarification — 2026-08-13.** The empty states below describe a
> capability after its owning phase has built real controls. Before then, Plan detail may show
> People, Prep, Lists and Attachments as non-interactive discovery rows ending in
> `Coming later`; a Meal may also show Ingredients this way until Phase 3 builds its
> interaction. Those rows have no chevron, disabled action, expansion or tap behaviour.
> Recipe, Expenses and Updates remain absent until their own product conditions and
> implementation are available.

> **Amended 2026-08-25 by §2.1.** The table below still governs *whether a capability is
> available at all*. What changed is the empty case: a section holding nothing no longer
> renders its own heading plus an add affordance — it collapses into the single
> `Add to this plan` chip row, and reappears as a section the moment it holds something. Rows
> reading "Never hidden. Empty state is the `X` affordance alone" should be read as "never
> *unavailable*; its empty state is a chip". Settings rows — Notes, Reminder, Repeat — are
> unaffected and always render.

| Section | Hidden when |
| --- | --- |
| Hero image | No `primaryAttachmentId`, or one that names no attachment the plan holds (P3-42: a deleted cover collapses the slot rather than rendering a broken image). Tapping the hero opens the viewer at the cover. |
| When / where | Never hidden. If unscheduled it renders `Not scheduled` with a `Schedule` action for the owner, `Suggest a date` for a participant (§2.3). |
| Reminder row (inside when / where) | Hidden when the plan has no date — there is nothing to count back from |
| Dates suggested (§2.3) | Hidden when the plan has a date. On an undated plan it is never hidden: its empty state is the suggest affordance alone |
| People | Never hidden. Empty state is the `Add people` affordance alone. |
| Prep | Never hidden. Empty state is `+ Add prep task` alone. |
| Lists | Never hidden. Empty state is `Add list` alone. |
| Expenses | Hidden when the plan has < 2 participants and 0 expenses |
| Notes | Empty state is a tappable `Add notes` placeholder |
| Attachments | Never hidden once the picker exists (P3-41, built 2026-09-01): while empty it is discovered through the `Photo` chip in the `Add to this plan` row, and once it holds content the section carries its own `+ Add photo`, like Prep and Lists. Picking a photo shows its row at once — thumbnail, `Uploading n%`, `Pending` while offline, `Retry` on failure — and the row reads `Added` when the confirm lands. Tapping a thumbnail opens the full-screen viewer at that photo, swiping between the plan's images (P3-42); long-pressing one offers the owner `Set as cover` (additive, standard undo) and `Delete` (confirms, no undo). The 2026-08-13 pre-build discovery row (`Attachments · Photos and files · Coming later`) remains only for a caller that has not wired the picker. |
| Updates | Hidden when `visibility === 'private'` and there are no entries. **Exception to the 2026-08-25 empty-case note (recorded by P3-40):** when this row makes the section visible with zero entries — a shared plan before anything has happened — it renders as the section itself carrying `+ Write an update`, not as a chip. The feed's entry point lives at the feed's foot wherever the feed may show, so there is no Update chip in the `Add to this plan` row at all; on a private plan with no entries the deliberate consequence is no entry point until a system entry exists. |
| Completion button | Hidden when `status` is `completed`, `skipped` or `cancelled` — replaced by the outcome and an `Undo` affordance — **and hidden for everyone but the owner**, who is the only person who can complete, skip or snooze a shared plan. A participant sees the outcome when there is one and nothing where the button would be. |

### 2.3 Date suggestions

An undated shared plan needs a way forward that does not require the owner to guess. Any
participant proposes a date; the owner decides. Shapes and endpoints are owned by
[`../02-architecture/data-model.md#43a-datesuggestion`](../02-architecture/data-model.md#43a-datesuggestion)
and
[`../02-architecture/api-contract.md#24b-date-suggestions`](../02-architecture/api-contract.md#24b-date-suggestions).

The section sits directly under the when/where block, so the answer to "when is this?" and
the attempt to answer it are in the same place.

```
  ┌───────────────────────────────────────────────────┐
  │  Not scheduled                                    │
  └───────────────────────────────────────────────────┘

  DATES SUGGESTED                          Suggest a date

    Sat 9 Aug · 7:00 PM                                     ▸
    Alice · before the show
    Works for you and Ben              [ ✓ Works for me ]

    Sun 10 Aug                                              ▸
    Ben
    Works for nobody yet               [   Works for me ]
```

| Element | Rule |
| --- | --- |
| Heading | `DATES SUGGESTED`. No count in the heading and no badge anywhere, for the same reason Needs a date never nudges (§1.3.2). |
| Order | Oldest first, so the list does not reshuffle as people mark availability. |
| Line 1 | The date, and the time when one was given. A suggestion with no time reads as a date alone. |
| Line 2 | Who suggested it — `You` on your own — and their note when there is one. |
| Line 3 | Who it works for, in words: `Works for you and Ben`, `Works for Alice and 2 others`, `Works for nobody yet`. Never a number on its own and never a face pile. |
| `Works for me` | A toggle, on your own suggestions as well as everybody else's. Tapping it adds or removes you from `worksFor` immediately, with the standard undo. Proposing a date does not mark it: suggesting says *this is possible*, marking says *I am free then*. |
| `Suggest a date` | Opens the date picker with an optional time and a one-line note. Any participant, including the owner. Guests cannot suggest. |
| `▸` (owner only) | `Use this date`, which schedules from that suggestion (§1.4). A participant does not see it — nothing on the row implies they can decide. |
| Withdrawing | The author may delete their own suggestion; the owner may delete any. Confirmed only when it is not yours ([`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.1). |
| Empty state | `No dates suggested yet` with the `Suggest a date` action. No guidance copy that treats it as something to clear. |
| Cap | 5 per plan. The sixth is refused inline with `You can suggest up to 5 dates.` |

> **Decision — `Works for me` is an availability signal, not a vote and not a like.** It
> reads as a statement about your calendar, so the words are `Works for me` and never
> `Agree`, `+1` or a heart, and the counts are never presented as a result. This is the only
> reaction-shaped control in the product ([`sharing-and-people.md`](sharing-and-people.md#7-anti-goals)
> §7 rules out the rest), and it earns its place by being the actual coordination signal.
> **Only the owner schedules**, whatever the counts say, so nothing here is a poll: five
> suggestions is a nudge toward a date, not a scheduling tool.

> **Decision — suggesting a date writes a system entry to the plan's updates feed and sends
> no push of its own.** There is no `suggestion_added` notification key. A dedicated push
> would make an undated plan the noisiest object in the product, which is precisely what
> §1.3.2 forbids; the feed entry means the owner sees it the moment they open the plan, and
> the `plan_activity` category already covers people wanting more than that
> ([`notifications.md`](notifications.md#7-notification-catalogue)).

### 2.4 One date, never a range

`schedule` holds a date, never an `endDate`
([`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1)).
A three-day trip is **one activity on its start date**, with prep tasks and lists hanging off
it. No screen, example or mock in v1 shows a range like `14–16 Aug`, and none may be added.

The consequence is stated rather than designed around: **the trip does not appear on Today
on days two and three.** It appears on 14 August, and on 15 and 16 August Today shows only
whatever else is dated then. The plan is reached from Plans → Upcoming, from its prep tasks,
and from its lists, all of which are on their own dates.

---

## 3. Prep tasks

Prep tasks are ordinary Activities of type `task` with `parentActivityId` set to the plan.
They are not a sub-entity and have no reduced capability. The converse is enforced too: only
a Task may be attached to a plan, so neither a create nor a kind-change patch can leave a Plan
sitting in another plan's PREP section (`validation_failed`, P3-18).

| Property | Behaviour |
| --- | --- |
| Creation | Inline `+ Add prep task` inside the plan, or from the Add screen's `Related plan` field |
| Own schedule | Yes. A prep task can be dated before the plan, on the plan's day, or undated. |
| Own reminders and recurrence | Yes. |
| Appears on Today | Yes, on its own date, with the plan's title as its subtitle ([`today-and-tasks.md`](today-and-tasks.md#5-tasks)). On a shared plan, on the **creator's** Today only — see the decision below. |
| Checkbox | Yes, everywhere — it is a `task` |
| Storage / retrieval | Access pattern 16 in [`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns) — queried from the parent's partition, not by a GSI filter |
| Counter | `activity.childCount` on the parent, maintained on write |
| Cap | 50 prep tasks per Plan. The 51st create is rejected, making the complete set and its done/open counts one bounded `SUB#` Query |
| On parent deletion | `parentActivityId` is cleared; the task survives ([`today-and-tasks.md`](today-and-tasks.md#55-related-plan)) |
| Shared plans | Prep tasks on a shared plan are visible to **any participant of the plan**, who may complete, uncomplete and edit them whoever created them. Their completion writes to the updates feed. A prep task is an item on a shared checklist, so ticking `Book hotel` says nothing about whether the trip happened; completing the **plan** stays with the owner ([`activities.md`](activities.md#51-states) §5.1). The rule is one line in the authorisation middleware — a participant of the parent may act on a child — in [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules) §3. |

Nesting is capped at **2 levels** (a plan, and its prep tasks). A `POST` that would create a
third level returns `validation_failed`, and so does a `PATCH` that would assemble one.

> **Corrected 2026-08-26 (P3-18 review).** This paragraph opened with "A prep task may itself
> have a prep task", which contradicted the very next sentence, the section's own opening line
> (`parentActivityId` set **to the plan**), the Cap row (**per Plan**), §P3-18 ("A Plan has at
> most 50 prep tasks") and the code, which has refused a parent that itself has a parent since
> Phase 1. It also described something no screen can show: the PREP section belongs to plan
> detail (§P3-38), and Task detail has no PREP section at all
> ([`today-and-tasks.md`](today-and-tasks.md#56-task-detail) §5.6). Read as: **a prep task's
> parent is always a Plan**, which is what everything else in this document already said. A
> `parentActivityId` naming a Task is `validation_failed` with `A prep task belongs to a plan.`

> **Decision:** the nesting cap is 2. Arbitrary nesting turns the product into an outliner,
> which is on the non-goals list in [`overview.md`](overview.md#6-non-goals).

> **Decision — amended 2026-08-23:** a Plan has at most 50 prep tasks; the 51st create is
> rejected. This supersedes the 2026-08-07 no-cap ruling. The bound keeps the PREP section's
> complete set and exact done/open counts within one bounded `SUB#` Query; the nesting cap of 2
> remains the independent structural limit.

**Completing the plan leaves open prep tasks untouched.** They keep their dates, stay on
their own Todays, and remain in the PREP section. When at least one incomplete prep task is
non-recurring, one dismissible follow-up is offered in the confirmation slot, per
[`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2:
`2 one-off prep tasks are still open — keep them?` with **Keep**, **Complete all**, and
**Delete**. The count and both bulk actions include only incomplete non-recurring children.
Recurring prep tasks remain untouched because completion requires an explicit occurrence
target; if they are the only open children, no prep follow-up is offered. Keeping, or
dismissing the follow-up, changes nothing; the other two write only when tapped, as their own
actions with their own undo.

> **Decision (2026-08-07) — prep tasks on a shared plan surface on the creator's Today
> only.** The plan is the shared surface. Any participant may still complete, uncomplete
> and edit a prep task from plan detail (the existing rule in the table above), but the
> task appears on Today only for the person who created it. Fanning prep tasks out would
> put unowned tasks on five people's Today; a calm Today shows only what you created or
> accepted.

**When a participant leaves a shared plan or is removed from it**, the prep tasks they
created are detached: `parentActivityId` is cleared — the same orphaning as parent deletion
above — so each task stays theirs, on their own Today, and leaves the plan's PREP section.
A system entry in the updates feed records it: `Sam left · 1 prep task went with him`. The
participant-side statement of the same rule is in
[`sharing-and-people.md`](sharing-and-people.md).

---

## 4. Lists created from a plan

A plan can produce a list. The plan never creates one by itself, and a list created this way
is an ordinary list from the moment it exists — it is not owned by the plan and does not end
when the plan does (§4.2). This is one of three ways a list comes into existence (§5.1), and
it is not the important one.

### 4.1 The explicit style choice

When a plan is created or opened, the LISTS section shows `Add list`. Tapping it opens the
same full, fixed-order preset catalogue as `New list` (§5.4), with nothing selected. Plan
kind, title, participants, dates, and AI never rank, recommend, or hide a preset. The user
explicitly chooses Blank, Checklist, Groceries, Watch Later, Books to Read, Places to Visit,
or Meal Ideas.

Selecting a preset creates a local List draft with `sourceActivityId` set to the Plan.
Item state presentation, optional feature configuration, icon and slot are previewed from
the selected preset in the usual way (§5.3). The title is pre-filled as
`<Preset title> · <Plan title>` — `Checklist · New York Trip` — and is editable. Only
`Create list` writes the List and copies those values.

> **Decision:** a list created from a plan seeds `slot: null` whatever its template says.
> `Groceries · Sunday dinner` is a per-occasion list, and promoting it to the household
> default destination at creation would silently change where every future "add ingredients"
> goes. The user can set the slot afterwards in list settings (§5.8).

Hard rule: **no list is created without that confirmation.** Creating a trip plan does not
silently produce three lists. See
[`overview.md`](overview.md#44-suggest-never-auto-create).

#### Sharing the list the plan just made

When the plan is shared, the same sheet that creates the list carries one unticked row:

```
  ☐  Share with Alice and Ben
     They can add and check items.
```

Rules:

- **Unticked by default, on every template.** The list is created private unless the user
  ticks it. This is §1a.2 applied to a second object: creating one thing never shares
  another.
- Ticking it adds every **app-user** participant of the plan as a `member` in the same
  confirmation. Guests are not added and the row says so when the plan has any:
  `Alice can be added. Chloe doesn't have the app.` List membership is app users only
  (§5.11).
- The row is not rendered at all for a private plan.
- Declining is silent and final for this creation. The list can be shared later from its own
  share sheet (§5.11.1), and the plan never asks again.

> **Decision — suggested, never automatic, and never pre-ticked.** For a packing checklist this is not a
> nicety: each person packs their own bag, and a shared `Packing · New York Trip` where three
> people tick one `Charger` row is actively wrong. Groceries and `Places to visit` for the
> same trip usually should be shared. The app cannot tell which is which from the template,
> so it asks once, cheaply, and defaults to the answer that loses nothing.

### 4.2 The link

`List.sourceActivityId` is the only link. Consequences:

- The plan's LISTS section shows every list with `sourceActivityId === plan.activityId`,
  plus their item counts.
- The list's own header shows `From New York Trip`, tappable back to the plan.
- Deleting the plan does **not** delete its lists. The lists keep their items and lose the
  back-link (`sourceActivityId` is cleared). A list of things you own is not owned by the
  trip.
- Archiving the plan (completing it) does not archive its lists. The user archives lists
  explicitly (§5.6).

---

## 5. Lists

### 5.1 What a list is for

A list is an **independent collection of things the user wants to keep together**. It is a
destination, not a staging area. A list that never produces an activity is a complete,
finished thing: `Favourite restaurants` is not an unfinished `Restaurants to try`, and a
packing list reused for four years is not waiting to graduate into anything.

Three lifecycles, given equal weight. None of them is the real one and the product must not
imply that any of them is.

| # | Lifecycle | Worked in |
| --- | --- | --- |
| i | Create → add items → keep using it forever. No scheduling, no nudging, no completion, no end. | §9.4 — `Favourite restaurants` |
| ii | Create → add items → explicitly `Plan this item` → choose a Plan kind → Today when dated. | §9.1 — a `watch` list → Friday |
| iii | A plan generates a supporting list (§4), which then outlives the plan. | §9.3 — `New York Trip` → `Packing` |

Consequences a reviewer can check:

- A checkbox-mode card may show the small `doneCount / itemCount` progress bar approved for the
  Lists index. No other list-level completion percentage, and no “items still unscheduled”
  nudge, exists anywhere in the product: the bar reports checkbox state, never commitment.
- No copy describes a list as somewhere things sit *until* something else happens (§5.9).
- `Plan this item` is one affordance on an item among several. It is never the primary action of
  the list screen, and never a list's empty-state call to action.
- Nothing archives, hides or de-emphasises a list because it has produced no activities.

### 5.2 One model: intrinsic state plus typed features

There is one `List` and one `ListItem`. A creation type is a preset copied once, not a
runtime category. Every item owns its title, optional note, intrinsic `open | active | done`
state and optional typed values. The List owns only how state is presented and which typed
features are enabled.

| Configuration | Meaning |
| --- | --- |
| `itemStateMode: none` | State remains stored but has no row control. |
| `itemStateMode: checkbox` | `done` is checked; checking writes `done`, unchecking writes `open`. `active` remains intrinsic and appears unchecked. |
| `itemStateMode: stages` | The three configured labels expose `open`, `active` and `done`; only populated groups render when grouping is on. Drag stays inside a state and never changes it. |
| Progress | Either uninterpreted text (`Page 143`) or structured episode data (`S2 E4`). The two variants are typed and never parsed from one another. |
| Place | Typed label/address/coordinates and the Maps action. |
| Sub-items | One bounded ranked child collection with configured vocabulary. Children have id, title, optional secondary text and rank—never state, notes, dates, Plans, features or children. |

The effective feature set is the intersection of enabled List configuration and populated
item values. Turning a feature off hides its values from rows, editors and adapters without
rewriting them; turning it back on restores the exact stored bytes. Labels carry no semantics.
Only explicit `integration: 'mealIngredients'` activates the Meal adapter.

### 5.3 The template catalogue

A **template** is one creation record: chooser label, summary, editable default title, icon,
state presentation, typed-feature configuration, slot and empty copy. Its resolved values are
copied onto the new List and never re-resolved. `templateKey` is immutable provenance only;
legacy keys remain readable provenance but are not offered for new creation.

The fixed creation catalogue is deliberately small and ordered:

| Order | Type | State | Features | Slot |
| --- | --- | --- | --- | --- |
| 1 | Blank | none | none | — |
| 2 | Checklist | checkbox | none | — |
| 3 | Groceries | checkbox | none | `groceries` |
| 4 | Watch Later | grouped `Want to watch / Watching / Watched` | episode Progress | `watch` |
| 5 | Books to Read | grouped `Want to read / Reading / Read` | text Progress | — |
| 6 | Places to Visit | checkbox | Place | — |
| 7 | Meal Ideas | none | Sub-items named `Ingredients / Ingredient / Quantity`, with `mealIngredients` | `meals` |

No preset selects a Plan kind. The public icon catalogue remains available, but these seven
presets use only the icons they need.

> **Decision — icons are the one part of a template that is not pure config.** A new
> template must reuse an icon already in `packages/ui/src/icons/` unless the founder
> approves a new one. Otherwise "adding a template is a config entry" quietly becomes
> "adding a template is a design task".

### 5.4 Creating a list: style first

`New list` begins with an explicit catalogue. The app does not inspect a name, suggest a
template, auto-select Blank, or infer configuration from words.

```
┌──────────────────────────────────────────────┐
│  Choose a list type                          │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Blank list · No category or details  › │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────┐  ┌──────────────────┐ │
│  │ Checklist        │  │ Groceries        │ │
│  │ Checkboxes       │  │ Shopping list    │ │
│  └──────────────────┘  └──────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────┐ │
│  │ Watch Later      │  │ Books to Read    │ │
│  │ Stages + progress│  │ Stages + progress│ │
│  └──────────────────┘  └──────────────────┘ │
│  ┌──────────────────┐  ┌──────────────────┐ │
│  │ Places to Visit  │  │ Meal Ideas       │ │
│  │ Places           │  │ Sub-items        │ │
│  └──────────────────┘  └──────────────────┘ │
└──────────────────────────────────────────────┘
```

The catalogue uses the exact seven-choice order in §5.3: Blank as one full-width leading card,
then the other six in a 2-up grid read left-to-right and top-to-bottom. Blank is the explicit
escape hatch for somebody who wants no category or item details. Nothing is selected,
recommended, pinned, history-ranked, filtered by Plan kind or hidden behind another control.
Destination selection may route by a slot, but never changes which creation types exist or
enables a feature.

Tapping a row opens the title step:

```
┌──────────────────────────────────────────────┐
│  Back                             Create list │
│                                              │
│  Watch Later                                │
│  Track what to watch and episode progress   │
│                                              │
│  List name                                  │
│  ┌────────────────────────────────────────┐ │
│  │ Watch Later                            │ │
│  └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

Rules:

1. The selected type is visible by name and its exact catalogue `summary`. `Back` returns
   to the full chooser with no write and no pre-selection retained as a default.
2. The title starts with the selected template's `defaultTitle` and is fully editable.
   It is data, not a classifier: editing `Watch Later` to `Watch repairs` does not
   change the explicitly selected preset.
3. `Create list` is enabled when the trimmed title is non-empty. It writes one
   `POST /v1/lists` carrying the selected `templateKey` and visible title.
4. There is no `/suggest-template` call, debounce, term catalogue, string matching, model
   call, confidence, or offline fallback. The catalogue ships with the client and works
   identically offline.
5. Assistive technology announces each choice as `<style>. <description>`, then announces
   `List name, pre-filled with <title>` on the title step. Focus never skips the explicit
   style selection.

Global `+` → **Add list** enters the same unselected catalogue above. Successful creation
closes the global Add flow; it does not open or return to a global List-item composer. List
items are created only through the contextual action inside their destination List.

> **What the frames fix, and what the sheet primitive does** — settled 2026-08-27 (founder),
> on the divergence raised in P3-26's PR.
>
> The two frames above are canonical for **the flow, the controls and their copy**: two steps
> in that order, a catalogue with nothing selected, a title step showing the style's name and
> its exact `summary`, an editable `List name`, a way back that retains nothing, and a commit
> reading `Create list`. Those are product decisions and the six rules restate them.
>
> **Where the dismissal and commit controls sit is the shared `Sheet` primitive's**, per
> [`../04-conventions/design-system.md`](../04-conventions/design-system.md) §6.1: a screen
> supplies controls, the sheet decides their geometry. So `Back` and `Create list` sit in the
> sheet's fixed footer, which keeps the commit reachable when the keyboard opens on the title
> step, and the single `✕` the primitive already renders is the way out of step one — it is
> the accessible route, and it is the one control that Escape, hardware Back, the scrim and
> the drag all converge on. The frame's `Cancel` is that control drawn in an earlier idiom,
> not a second one to add beside it.
>
> This is the general rule for every frame in this document, not an exception for this sheet:
> a drawing says which controls exist and what they say; the design system says where they go.

### 5.5 Changing a list later

Reached from the list header `⋯` → `List settings`. Every change here is an instance of the
product-wide additive/destructive rule
([`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.1) and
of the change rules in
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).
The sheet is the List-specific instance of the reusable settings grammar in
[`../04-conventions/design-system.md`](../04-conventions/design-system.md) §6.3. That grammar
may be reused by other features; this section does not define an app-wide Settings page.

| Setting | Label the user sees | Rule |
| --- | --- | --- | --- |
| `itemStateMode` | `None / Checkboxes / Stages` | Immediate. It changes presentation only and never rewrites intrinsic item state. `Group by stage` appears only for Stages. |
| `featureConfig.progress.enabled` | `Progress` | Immediate. Off hides editors, summaries and adapters while retaining every text/episode value byte-identically. |
| `featureConfig.place.enabled` | `Places` | Immediate. Off retains stored Place values. |
| `featureConfig.subItems.enabled` | `Sub-items` | Immediate. First enable opens the focused naming sheet; the main sheet later shows configured vocabulary and `Edit`. Off retains children and ranks. |
| `slot` | `Default destination` | Immediate. Moves no items, enables no feature and changes no existing content (§5.8). |

The main hierarchy is exactly `ITEM STATE`, the three-way segmented control, the conditional
group switch, then `ITEM DETAILS` with Progress, Places and Sub-items switches. Destination
settings are subordinate below. There is no destructive List-setting dialog. Every effective
settings write—including rename—applies immediately with a six-second Undo backed by the
server's retained operation token.

Two more rules:

- **Renaming a list changes nothing else.** State mode, features and slot remain byte-for-byte
  as they were; the app does not infer intent from a title.
- `templateKey` is immutable after creation. It records provenance and analytics only.
  The list renders its own stored icon, empty copy, state mode and feature configuration;
  no read path resolves the template again.

### 5.6 Operations on a list

| Operation | Rule |
| --- | --- |
| **Add item** | Persistent `+ Add an item` at the foot opens a rapid-entry row inline in the List's scrolling measure. The header and current content remain visible, and the row can scroll above the software keyboard as the List grows. The current List fixes the destination; no chooser or `New list` appears. One underlined field is accessibly named `Add item to <list name>`, followed by `Add` and `Done adding`; Note and typed features stay in Item details. Return performs the same single `POST /v1/lists/:id/items`, then clears and re-focuses the title field on success; failure retains it. |
| **Check / uncheck** | Only in checkbox mode. Tapping writes intrinsic `done` or `open` optimistically; tapping the row body opens item detail. |
| **Checked item placement** | Checked items stay in place and render struck-through and de-emphasised. They do **not** jump to the bottom. Re-sorting under the user's finger is disorienting and makes accidental double-taps destructive. |
| **Reorder** | Every item shows a neutral trailing grip on touch layouts; long-pressing the row or grip starts the same drag. Pointer layouts reveal the grip on hover/focus. A grouped staged List has one drag surface per populated state; drag never changes state. Writes one item PATCH with `afterItemId`. |
| **Clear checked** | In checkbox mode, deletes intrinsic `done` items immediately with no confirmation and offers the 10-second bulk Undo. |
| **Uncheck all** | In checkbox mode, changes only `done → open`, records exactly those ids and offers bulk Undo. |
| **Share** | Header `Share`, on every list. Opens the member sheet (§5.11.1). Owner only for adding and removing; a member sees the sheet read-only apart from `Leave list`. |
| **Archive** | Header overflow → `Archive list`. Sends `PATCH /v1/lists/:id { archived: true }` and offers settings Undo. Archived lists leave the Lists index, keep their items, and are reachable through `Lists → ⋯ → Show archived`. Owner only on a shared list — archiving is a change to the object, not to your view of it. Restoring is one tap. |
| **Delete** | Header overflow → `Delete list`, confirmed. **Owner only.** Deletes items and their per-viewer `LNK#` projections. Every Plan created through `Plan this item` survives; the confirmation says how many of the owner's linked Plans survive, plus the number of other members who lose the list (§1a.1). |
| **Rename** | Inline on the header title. Available to members as well as the owner — it changes nothing but the title (§5.5). |
| **Item detail** | Tapping opens one item shell: title, note, exposed state and enabled typed-feature editors from the registry, plus `Plan this item` and `Delete`. Text fields save after a short debounce while focus remains in the field; blur or the sheet's single Close flushes immediately. A trimmed-empty title is rejected and never overwrites the stored title. |
| **Empty list** | One compact semantic List icon, `Start with one item`, the List's stored `emptyStateCopy`, and one primary `Add item` action (§5.9). No large illustration or second empty add row. |
| **Item cap** | 500 items per list. Beyond that, `POST` returns `validation_failed` with `List is full.` |

(Moving an item between lists is not in v1 — copy the text into the other list and delete
the original.)

On the Lists index, each card uses one soft full-card collection tone from the design-system
palette. Tone is stable presentation derived from `listId`, not stored user data, a template
lookup, a category or status. A hash collision may repeat a tone, but sorting never recolours a
List. All card facts, actions and accessibility labels remain identical regardless of colour.

Variable-height index cards keep their intrinsic height and a fixed per-column gap. The client
sorts active and archived groups newest-created first using the stable time-sortable `listId`;
it does not expose user reordering or height-balance Lists. Each sorted sequence fills one
contiguous column and then the other. Every Lists-index state shares the same safe-area-aware
floating-navigation clearance, including archived Restore actions and the empty, error and
loading states.

On mobile, long-pressing a Lists-index card opens a compact action sheet that duplicates the
same Archive / Delete or Leave operations available through swipe and accessibility actions.
The sheet changes no operation semantics: Archive remains immediate with Undo, Delete/Leave
retain their confirmations, and the index remains non-reorderable. Active and archived groups
are separated by the standard strong divider and spacing, so the archived heading never
touches the final active card.

The List header has fixed Back, Share and More action slots around one flexible leading-aligned
title/edit slot. A long title may use two lines without moving those actions; a short title does
not centre itself in the remaining asymmetrical space. Both the index and detail `⋯` sheets use
full-width compact action rows with aligned icons and inline summaries. Only List settings has a
chevron; Delete is a separated danger-ink row rather than a filled action.

The Lists index pages access pointers that may resolve to active or archived Lists. Filtering
is not pagination completion: if a page contributes no visible active rows but has a cursor,
the client keeps loading until it can fill the viewport or exhausts the cursor. `No lists yet`
is shown only after that exhaustion. `Show archived` reuses already materialized pages and
continues the same bounded drain when more archived rows are needed.

> **Decision:** bulk checkbox operations are presentation-mode operations, never template or
> slot operations. Reuse across trips and shops is a property of choosing checkboxes.

### 5.7 What an item has

Field shapes are owned by
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem).
This is what the user sees.

**Every item** has a title, optional note, intrinsic state and optional provenance
— `sourceActivityId` plus the frozen `sourceLabel` rendered after the title (§7.5). A
Plan-state line is a caller-specific projection from `LNK#<viewer>#<item>`, not a field on
the shared ListItem (§6.2).

One common row and item sheet ask a typed registry for enabled feature summaries, renderers and
editors. Empty configured features add no row metadata and no blank controls. Populated summaries
stay to one concise line: `S2 E4`, `Page 143`, `8 ingredients` or the Place label. Generic
Sub-items use configured words inside the item; labels do not activate integrations.

The item sheet keeps Title and the top-aligned optional Note first, then groups only the exposed
state and enabled typed features. A Sub-item group is headed by its configured section label,
current count and compact `Add <singular>` action. Existing children collapse to grip, title,
populated secondary value and More; tapping the copy edits it in place, while More opens compact
Move up, Move down and Remove rows. The sheet ends with one divider-separated compact `Delete
item` danger row and remains scrollable when maximum content or enlarged text exceeds its
detent.

### 5.8 Default destinations

A **slot** is a semantic destination — `groceries`, `watch` or `meals`. It answers "which
list did the user mean?" for flows that add items somewhere without opening a list first.
It is independent of state presentation and optional features: two checkbox lists can serve
entirely different flows.

The user meets slots in two places.

**In the flow.** The destination is always shown, always changeable, and always specific:

```
Add ingredients to:
┌──────────────────────────────────────────────┐
│  Groceries — Trader Joe's                 ▾  │
└──────────────────────────────────────────────┘
   ☑ Chicken
   ☑ Tortillas (8)
   ☑ Tomatoes
   ☐ Sour cream

                            [ Add 3 to Groceries ]
```

When the app asks and when it does not, following the four-step rule in
[`../02-architecture/data-model.md#default-slots`](../02-architecture/data-model.md#default-slots):

| Situation | What the user sees |
| --- | --- |
| Exactly one list holds the slot | The destination row shows it. No question is asked. The dropdown still works. |
| Several, and a default is set | The destination row shows the default. Changing it in the dropdown applies **to this operation only** and does not change the default. |
| Several, no default set | A one-time sheet: `Which list should ingredients go to?` with the eligible lists and `Remember this choice`, checked by default (unchecking makes the choice one-off — P3-43). The answer is stored in `user.defaultLists`. |
| None | The destination row reads `Choose or create a list` and opens the seven-type catalogue with nothing selected. After `Create list`, the original flow returns with that List visibly named; adding still requires its own named confirmation. |

**In settings.** Profile → Settings → **Default lists** shows three rows — Groceries,
Watchlist, Meals — each naming the list currently in the slot, or `Ask each time`. The same
setting is reachable from the list itself as `Use as my default for` (§5.5).

Two rules that hold everywhere:

- **Opening a list never changes where future items go.** Most-recently-used is explicitly
  rejected: it makes the destination depend on browsing history, which the user cannot see
  and cannot reason about.
- A List with no matching slot is never an implicit destination. Slots route; they never
  enable a feature or integration.
- The zero-list case never supplies a `templateKey`, title, or style on the user's behalf.
  The slot explains why a destination is needed; it does not choose what new list to create.

### 5.9 Empty states and copy

Every empty List renders from values stored on that List, not by looking its `templateKey`
up again. The one compact List icon is a semantic marker; there is no large illustration,
congratulation, or exclamation mark
([`interaction-contract.md`](interaction-contract.md#52-empty) §5.2).

| Surface | Copy |
| --- | --- |
| Lists index, no lists | `No lists yet` / `Keep things you want to remember, track, or organise together.` / `New list` |
| Any empty List | Compact List icon / fixed heading `Start with one item` / the List's stored `emptyStateCopy` from the exact §5.3 record chosen at creation / `Add item` |

Copy rules, checkable in review:

- **No empty state, heading, tooltip or onboarding line may imply that an existing List or
  item is waiting to become something else.** `Save ideas until you're ready to plan them`
  is banned, along with progression copy built on *until*, *someday*, *ready to*, or
  *turn into*. `Yet` is banned when attached to an existing List (`Nothing here yet`), but
  the Lists-index heading `No lists yet` states literal absence and is allowed.
- Guidance copy says what to add, never what will happen to it afterwards.
- The Lists tab is never described as an inbox, a backlog, a staging area, a holding pen, or
  a place for things "without a date".

### 5.10 Completing an activity never checks its list item

Completion is an event on the Activity. The list owns its own state. Any cross-object change
is a **suggestion the user confirms** — this is the product-wide rule in
[`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2, and
§6.3 is its full table for lists.

Two worked cases.

**Zahav.** The List exposes Place and checkboxes, so `done` means *visited*. The user chooses `Plan this item` →
**Event** → **Just me**, schedules Zahav for Saturday, and
completes it with `Attended`. The caller-specific Plan state line becomes
`Done Saturday`. Intrinsic item state is unchanged. One follow-up appears in the confirmation slot:

```
Zahav · Restaurants to try       Mark Zahav visited in Restaurants to try?   ✕
```

Tapping it sets intrinsic state to `done`. Dismissing it leaves the item exactly as it was. Both are
correct outcomes: the user may have gone and still want it on the list.

**Dune.** `Books to read` exposes staged reading state. The user explicitly uses `Plan this item` →
**General** → **Just me**, schedules `Read Dune` for Saturday, reads for two hours, and
completes that Plan. The book is not
finished. The item remains `active` and no completion write happens automatically, because finishing
a reading session says nothing about finishing the book. The item keeps its `Done Saturday`
state line and stays where it is.

The difference between the two is whether completing the activity is *evidence* about the
item. Visiting a restaurant is; one reading session is not. When it is evidence, suggest.
When it is not, say nothing.

> **Decision — the implementable form of "evidence".** The
> `Mark {item title} visited in {list name}?` follow-up is
> offered only when the linked Activity has the explicitly chosen kind `event`, the current
> List exposes state and Place is enabled. A manually linked Event or disabled Place is not
> evidence. Every other Plan kind stays silent. Slot, template, labels and text are never inputs.

Structured episode Progress is the precedent, not the exception. Completing a Watch session
may *offer* to advance episode Progress and, separately, set intrinsic state to `done` when
state is exposed. It may then offer to schedule the next episode. Neither
writes without a tap (§8.4).

### 5.11 Shared lists

Lists are shareable through **the same People layer as plans**. One sharing system, two
shareable objects: a plan and a list. There is no second contact model, no second invite
flow, and no list-specific notion of a friend. Entities and constraints are owned by
[`../02-architecture/data-model.md#shared-lists`](../02-architecture/data-model.md#shared-lists);
the participant-side experience is
[`sharing-and-people.md`](sharing-and-people.md) §4a.

Two roles, and only two.

| Role | Can | Cannot |
| --- | --- | --- |
| **Owner** | Everything: item CRUD/reorder/state; rename; change state mode, feature configuration and slot; add/remove members; archive; delete | — |
| **Member** | Full item CRUD/reorder/state, `Plan this item`, rename and leave | Change configuration or default slot; delete/archive; add/remove other people |

> **Decision — a member can rename but cannot reshape.** Renaming changes nothing but the
> title (§5.5), so it is safe to give away. Configuration changes affect how every member sees
> items, so they stay with the
> owner. This is the same line the plan authorisation table draws between posting an update
> and rescheduling.

Two constraints the UI must state rather than discover:

- **App users only.** There is no guest editing of a list. Every item mutation has to be
  attributable to an identity, and a public link that anyone can type into is not one. A
  person without an account can be *invited* (§5.11.3) but cannot edit until they sign up.
- **20 people total per list, including the owner and pending invitations**, lower than the
  50 for a plan. A new private list can therefore add at most 19 other people. This is a
  household surface, not a broadcast one. A selection that would make the total 21 is refused
  inline with `A list can have up to 20 people.`

#### 5.11.1 The share sheet

Reached from the list header's `Share` action — the same affordance, in the same place, as
on a plan (U5). It opens the **same participant picker** as a plan
([`sharing-and-people.md`](sharing-and-people.md#22-the-participant-picker)), with the same
FREQUENT and RECENT buckets, the same search, the same `+ Add "<name>" as a new person` row
and the same OS contact picker row.

```
┌─────────────────────────────────────────────┐
│  Groceries                           Done   │
│                                             │
│  IN THIS LIST                               │
│    Ujjwal                          Owner    │
│    Alice                          Member    │
│    Ben        Invited · we emailed them  ✕  │
│                                             │
│  + Add people                               │
│                                             │
│  Anyone here can add, edit and check items. │
│  Only you can change what this list is or   │
│  delete it.                                 │
└─────────────────────────────────────────────┘
```

| Element | Rule |
| --- | --- |
| Member rows | Display name, then the role or invite state in the trailing slot. The owner is always first, derived from the list owner rather than a separate membership; the rest are ordered by `addedAt`. |
| Role label | `Owner` or `Member`. It is a label, not a control — v1 has no role change. To move ownership, the owner adds the person and deletes the list, or keeps it. |
| Pending invite | `Invited · we emailed them` only for someone with no account. An app user is active immediately; there is no opened/not-opened state. Rendered de-emphasised, with the `✕` to withdraw. |
| `✕` | Owner only, on anyone but themselves. Removes the member (§5.11.4). Confirmed, per §1a.1. |
| The two closing lines | Always rendered, verbatim, for members as well as the owner, so what a member can do is never something they have to find out by failing. |
| Member's view of the sheet | Shows the owner and active members only, minus `+ Add people`; their own row reads `Leave list`. Pending invitees and their addresses are owner-only lifecycle data. |

> **Decision — no roles beyond owner and member, and no per-item permissions.** A read-only
> viewer sounds harmless and is not: it doubles every empty state, every affordance table and
> every authorisation test for a case a household list does not have. Someone who should not
> edit the list should not be on it.

#### 5.11.2 Inviting someone who has the app

They get an `added_to_list` notification and an inbox entry, and the list appears in their
Lists index immediately, with its items. There is no accept step: a list is not an
invitation to be somewhere at a time, so there is nothing to decline. Someone who does not
want it leaves it (§5.11.4). Confirmation creates or reuses an owner-scoped Person on both
sides and writes an active list-relationship link in both partitions; the action is explicit
and no name, title or category is used to infer whom to share with.

#### 5.11.3 Inviting someone who does not have the app

The person is added with an email, and the app sends one email
([`notifications.md`](notifications.md#7-notification-catalogue), `list_invitation_email`).
Until they sign up:

| Surface | What it shows |
| --- | --- |
| The share sheet, to the owner | `Ben — Invited · we emailed them`, with `Resend` and `✕` |
| The list, to everyone in it | No active-member row or avatar. The pending membership still counts toward the 20-person cap and stored `memberCount`, but only the owner sees it in the share sheet. |
| The email, to Ben | Who invited him, the list's title, and one button that opens the App Store. **No item content.** A grocery list is not public, and a link that renders it would be a public list page — which does not exist. |

The owner also has an invited list-relationship link for this Person. It is lifecycle data,
not list access and not an `In n lists with you` count. When Ben signs up with that verified
email, the existing guest-linking machinery
([`sharing-and-people.md`](sharing-and-people.md#5-guest--registered-user-linking)) flips his
member row to `active`, creates or reuses the reciprocal Person and active relationship link
on both sides, and puts the list in his Lists index the first time he opens the app. Nobody
is notified and nothing is asked of him.

> **Decision — the invitation email carries no list content and no web view.** The public
> invite page exists for plans because a guest must be able to answer "am I coming?" without
> installing anything. A list has no such question. Building a public list page would mean a
> second unauthenticated surface, a second projection allow-list and a second thing to leak
> ([`sharing-and-people.md`](sharing-and-people.md#43-fields-the-public-projection-must-never-expose)).

#### 5.11.4 Leaving and being removed

| Action | Who | Effect |
| --- | --- | --- |
| `Leave list` | Any member, on themselves | The list disappears from their Lists index and both sides' list-relationship links are removed. Confirmed, naming what stays behind. |
| `✕` on a member | Owner only | Same effect, for that person; a pending invite also loses its owner-side invited link. Confirmed. |
| Delete the list | Owner only | The list, its items and every list-relationship link are gone for everyone. The confirmation names the item count **and** the number of other people who lose it (§1a.1). |

**What happens to the items you wrote.** They stay. A list is a shared object, not a stack of
per-person contributions, and pulling `Milk` off the shopping list because the person who
typed it left is a data loss nobody asked for. The leave confirmation says so:

```
Leave "Groceries"?

This removes the list from your Lists.

Keeps: all 14 items on it. Alice keeps the list.

                                    [ Cancel ]  [ Leave ]
```

Consequences, all deliberate:

- Any Plan you explicitly created from an item on that list is **yours** and is untouched. It
  keeps its `listItemId` back-pointer; you simply can no longer open the list from it, and
  the row that would navigate there is not rendered.
- Rejoining is a fresh invite from the owner. There is no rejoin link and no history of your
  membership.
- Leaving or list deletion removes the shared-list relationship, but never deletes either
  person's owner-scoped contact record or changes a Plan relationship.
- The owner cannot leave. They delete the list, or they keep it.

#### 5.11.5 Two people using a list at once

These are the concurrency rules from
[`../02-architecture/data-model.md#shared-lists`](../02-architecture/data-model.md#shared-lists),
stated as what a user sees, because each of them is a place the obvious implementation is
wrong.

| What happens | What the user sees | What the client must do |
| --- | --- | --- |
| Two people tick `Milk` at the same moment, one of them offline in a shop | It is checked. Once. No flicker, no un-tick when the queue drains. | Send `state: 'done'`, never a toggle instruction. Setting intrinsic state is idempotent and survives the offline queue with no merge logic. |
| Two people add an item at the same position | Both items are there, in the same order on both phones, and the order does not change on refresh. | Sort by `(rank, itemId)`. Identical ranks are expected, not exceptional; the tie-break is what makes the order stable. |
| Two people both add `Bread` | Two rows saying `Bread`. | **Never auto-merge, never dedupe, never warn.** Silently swallowing someone's entry is worse than a duplicate they can see and delete in one swipe. |
| Someone renames the list while you have the rename field open | Your save fails once with `This list changed while you were editing.` | List-**level** edits carry `If-Match`. Item writes do not. |

> **Decision — item writes carry no `If-Match` and last write wins per field.** Optimistic
> concurrency on a checkbox in a grocery list produces constant spurious `409`s in exactly
> the situation the feature exists for: two people in one shop with bad signal. The
> protection is worth having on the title and list settings, and nowhere
> else.

The ingredients-to-list flow (§7.3), `Clear checked` and `Uncheck all` (§5.6) all work
unchanged on a shared list, and all of them are visible to every member immediately. `Clear
checked` deletes items other people added; its menu label and Undo toast name the count, as
they already do. It still has no confirmation dialog.

---

## 6. The optional bridge between a list and an activity

Optional in both directions. A list item that never becomes a Plan is not incomplete, and an
activity that came from no list is not missing anything. This section specifies what happens
when the two are connected, not what is supposed to happen.

The user-facing action is `Plan this item`, never a generic `Schedule`. Its flow is fixed:

1. The item detail or row action opens the Plan-kind chooser with **General**, **Meal**,
   **Watch**, **Event** in that order. None is selected, highlighted,
   recommended, or moved first. The list's title, creation preset, settings, and item text do not
   choose a kind. General is available only as an explicit tap.

No template records a default bridge kind. `Event` exists here only after the user's explicit
tap; compatible pre-fills read only the stored feature configuration and populated item
feature values, never the creation preset or a destination slot.
2. On **every list, private or shared**, a required audience step follows the kind choice,
   asking exactly **Just me** or **Choose people**, with neither pre-selected. `Just me`
   makes the new Plan private and linked to the item. `Choose people` opens an empty People
   picker; list members may appear in the picker but none is selected automatically. The
   list's membership is never copied to the Plan.
3. After the audience step, the matching Plan form opens with the item's title and
   compatible typed fields copied. This copying can fill fields only; it cannot revise the
   chosen kind or the chosen audience. Date and time remain optional. This is the order the
   worked example in §9.1 shows: kind, then audience, then the form.
4. The final action is `Save plan`. Until it is activated, no Activity, participant, or
   link is written. The endpoint may create the Activity and caller-specific `LNK#`
   projection atomically, but it cannot add anyone not explicitly selected in step 2 or
   mutate the shared ListItem.

This audience step is about who participates in the new Plan, not who may still see or edit
the source ListItem. Choosing Just me does not unshare or copy the item.

### 6.1 The viewer-local link rule

Using `Plan this item` creates one Plan Activity and a **viewer-local pointer** to the
source item, per
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem):

```
LNK#<viewer>#<itemId>  ──►  Activity
ListItem               remains byte-identical
```

One endpoint does this atomically:
`POST /v1/lists/:id/items/:itemId/schedule`.

A shared ListItem never gains a global Activity-link field, and an Activity never claims
the item for every member. Different members may make different Plans from the same shared
item. Each sees a state line only when their own `LNK#<viewer>#<itemId>` projection resolves
to a readable scheduled Activity, unless they were explicitly added to the same Plan and are
also allowed to see the source list.

The item title and compatible fields are copied into the draft once, before `Save plan`.
After creation the ListItem and Plan are independent objects: editing either title or note
does not edit the other. The pointer supplies navigation and projected state, not shared
identity. This is what keeps one member's private Plan from rewriting a shared list for
everyone.

### 6.2 What the item looks like after scheduling

The item stays in its list, in place, byte-identical. When the current viewer's `LNK#`
pointer hydrates to a readable Activity with `schedule.date`, a state line is joined into
their response. An unscheduled pointer remains stored but renders no line. The item is not
moved, checked, or hidden.

The response carries that Plan's state as a trimmed projection beside the pointer — its kind,
its status and its schedule, and nothing else about it. Pointer and state arrive together or
not at all
([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §3). The Plan's
own title never travels: the row shows the item's title, and the two are independent after
the one-time seed (§6.1).

```
Restaurants to try
  Zahav
  Planned Saturday · 7 PM                    →
```

```
Watchlist
  Severance
  Watching · S2 E4
  Next session Friday · 8 PM                 →
```

Rules:

- The state line shows the current viewer's linked Activity date and time in the same relative format used
  elsewhere: weekday name within 7 days, otherwise `d MMM`.
- Link presence is not enough: an unscheduled Activity renders no line until it is rescheduled.
- A retained cancelled Plan renders `Cancelled`. Cancellation is useful Plan context and does
  not dissolve the relationship merely because it has no future date to show.
- Tapping the state line opens the **Activity**, not the item detail. Tapping the title
  opens the item detail. Both targets are ≥ 44 pt.
- For another list member with no pointer, the same item has no Plan state line. There is no
  global "someone planned this" badge and no participant leakage.
- A planned item is visually distinguished by the state line alone. No colour change, no
  strike-through, no move.
- An item on a checkbox-mode list is still checkable after scheduling. Checking it does not
  complete the Activity, and completing the Activity does not check it (§5.10, §6.3).

### 6.3 What happens on completion, un-completion and deletion

| Event on the Activity | Effect on the viewer projection and ListItem |
| --- | --- |
| Completed (any outcome) | The projected state line becomes `Done Saturday`. The ListItem is byte-identical: not checked, deleted, moved, hidden, or otherwise altered. Where completion is evidence about the item, one dismissible suggestion is offered and writes only if tapped (§5.10, §8.4). |
| Un-completed | The state line reverts. A follow-up the user **accepted** — a `done` state or updated episode progress — is their own edit and is not reverted with it. |
| Skipped / `didnt_happen` | The state line is removed and pointer(s) to that Plan are cleared. The ListItem is untouched. |
| Rescheduled | The state line updates. |
| Unscheduled (`date: null`) | The state line is removed. The `LNK#` pointer is **kept** — the Plan still exists in Needs a date. |
| Cancelled | Keep the pointer and render `Cancelled`. The Activity remains a Plan and the cancellation is useful context. |
| Plan converted to Task | Delete the viewer pointer and clear `Activity.listId` / `listItemId` in the same transaction as the conversion. The relationship was Plan-specific; the ListItem and Task both survive independently. |
| Plan deleted | Pointers to it are deleted. **The ListItem survives byte-identical.** |
| ListItem deleted | Its per-viewer pointers are deleted. **Every Plan survives.** |

Neither side cascade-deletes the other. This is stated in the data model and repeated here
because it is the most commonly mis-implemented rule in the product.

> **Decision:** completing an activity leaves its source item in the list rather than
> removing it, with every state presentation and every creation preset. These lists are memories as much as
> queues, and "we went there in March" is worth keeping. Users who want it gone delete it,
> check it, or archive the list.

> **Decision:** un-completing does not reverse a follow-up the user confirmed. Undo reverses
> the action the user took; it does not reach across into a second, separately confirmed
> decision. Marking Zahav visited has its own undo toast at the moment it happens.

### 6.4 The reverse direction

Plan → list is covered in §4. The two directions use different mechanisms and must not be
confused:

| Direction | Mechanism | Cardinality |
| --- | --- | --- |
| List item → Plan | `LNK#<viewer>#<itemId>` → Activity | One current pointer per viewer and item; different viewers may link different Plans |
| Plan → List | `List.sourceActivityId` | One plan → many lists |
| Meal → grocery items | `ListItem.sourceActivityId` + `sourceLabel` | One meal → many items, **not** a link (§6.5) |

### 6.5 Provenance vs linkage

A grocery item created from a meal is **not** the same relationship as `Plan this item`.
It carries `sourceActivityId` and a human `sourceLabel`, but no viewer-local `LNK#`
projection. It is a record of where the item came from, not a navigation pointer.

Consequences: checking off `Chicken` does not affect the meal; completing the meal does not
delete `Chicken`; deleting the meal leaves `Chicken` on the list with its label intact
(the back-link becomes non-navigable and the label stays as written).

---

## 7. Meals

Meals are an activity guide, not a product. No calories, no macros, no recipe steps, no
scaling — see
[`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1).

### 7.1 Save

A meal with no date is a `saved` Plan, or an item on a list whose Sub-items feature is
configured as Ingredients, depending on
the explicit creation action:

- **Global `+` → Plan → Meal → no date** creates an Activity with `status: 'saved'`. Because its type is
  not `task`, it routes to **Plans → Needs a date** (§1.2) and to
  `GET /v1/activities?filter=needs_date`. It does **not** appear on Today: an undecided meal
  is not something to do today. (**Corrected in P1-16**: this said `filter=saved`, which
  `today-and-tasks.md` §2.3 uses for the ANYTIME `See all` — a different bucket. `saved` is
  undated *tasks*; `needs_date` is undated *plans*. See
  [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.2.)
- **Meals list → `+ Add an item`** creates a `ListItem`. Nothing is scheduled and no Activity
  exists yet.

Both are legitimate. Neither is a better automatic interpretation of the words `Chicken
tacos`: the selected action determines the object, and capture cannot change it.

### 7.2 Schedule

A meal is already a plan the moment it exists; setting a date and time (and optionally a
slot) moves it from Needs a date to Upcoming (§1). Slot ↔ time inference is
specified in [`activities.md`](activities.md#42-meal). A meal can have participants,
expenses, prep tasks and attachments like any other activity.

### 7.3 Ingredients to groceries

The flow, exactly:

1. The meal's detail screen (or its creation form) has an **Ingredients** section: rows of
   `name` + optional `quantity`, each with a checkbox. Checkboxes default to **unchecked** so
   the eventual list write contains only ingredients the user explicitly selected.
2. Below it: `Add 4 selected to Groceries`, with the destination shown by name and
   changeable in a dropdown. The destination is resolved through the **`groceries` slot**,
   by the four-step rule in §5.8 — one eligible list, use it silently; several with a
   default, use the default and let the dropdown override it for this operation only;
   several with no default, ask once and remember; none, show `Choose or create a list`.
   Choosing `New list` opens the fixed catalogue with nothing selected. The user explicitly
   chooses a style and taps `Create list`, then returns here with the new destination named.
   Which list was opened most recently is never consulted.
3. Tapping the separate `Add <n> to <list name>` action issues one
   `POST /v1/activities/:id/ingredients/add-to-list` with the explicit `listId` and selected
   stable source `ingredientId`s. The server resolves those ids against the current meal,
   then derives titles and provenance from the matched rows; the
   ordinary List bulk route cannot accept them. Creating the destination
   never also adds the ingredients.
4. Each created `ListItem` gets:
   - `title` = ingredient `name`, with `quantity` appended in parentheses if present
     (`Tortillas (8)`),
   - `sourceActivityId` = the meal's `activityId`,
   - `sourceLabel` = the provenance label (§7.5).
5. Each source ingredient, identified by its stable `ingredientId`, gets `addedToListId` set, so the button
   can render `Added` for those rows and offer only the remaining ones next time.
6. Duplicate handling: if an item with the same case-insensitive, trimmed title already
   exists **unchecked** on the target list, no second row is created; the existing row's
   `sourceLabel` is extended (`Sunday dinner · Thursday lunch`). If the existing row is
   **checked**, a new row is created — the previous one was already bought. Ingredients in
   the same confirmed action are grouped by that normalized title, so the group uses one
   existing unchecked row or creates exactly one new row. A client-supplied destination id
   is permanently owned by the exact meal/ingredient outcome that first committed it; it
   cannot later name another ingredient or an ordinary item. Replaying that bound ingredient
   still returns its original row after check/rename, but the old row absorbs a newly selected
   same-title ingredient only if it is still unchecked and still has that title.

Nothing in this flow happens automatically. Creating a meal with ingredients writes zero
grocery items until step 3.

### 7.4 Completion

Completing a meal uses the verb `Had it` (`outcome: 'had_it'`) — see
[`activities.md`](activities.md#52-completion-verbs). Follow-ups offered, each dismissible:

- If ingredients exist that were never added to Groceries and the meal is likely to recur,
  nothing is offered. The app does not ask about the past.
- If the meal has participants and no expenses: `Add an expense?`
- If the meal came from a Meal Ideas list item: the item's linked Plan state line becomes
  `Done Sunday`. The item is not checked, moved or removed (§5.10).

### 7.5 The provenance label

`ListItem.sourceLabel` is a short human string rendered after the item title, separated by
an em dash:

```
Groceries
  Chicken          — Sunday dinner
  Tortillas (8)    — Sunday dinner
  Tomatoes         — Sunday dinner
  Milk
```

> **Decision — label format.** `sourceLabel` is computed at creation time and stored, never
> recomputed:
>
> 1. If the source meal is scheduled within the next 7 days **and** has a `mealSlot`:
>    `"<Weekday> <slot>"` — `Sunday dinner`.
> 2. If it is scheduled within 7 days with no slot: `"<Weekday>"` — `Sunday`.
> 3. If it is scheduled beyond 7 days: `"<d MMM> <slot>"` — `23 Aug dinner`.
> 4. If it is unscheduled: the meal's title — `Chicken tacos`.
> 5. If a label produced by rules 1–3 already exists on the target list from a *different*
>    meal, the meal title is appended: `Sunday dinner · Chicken tacos`.
>
> Storing rather than recomputing means the label stays truthful after the meal is
> rescheduled or deleted. A manually added item has no label and renders no dash. Internally,
> the row retains ordered `{ activityId, label }` segments and renders `sourceLabel` by joining
> them. Ownership is never inferred by splitting display text: a rule-5 label legitimately
> contains ` · `. A canonical segment may contain the complete 200-character meal title;
> rendered provenance has a dedicated 4,000-character bound and is never truncated. An
> extension that would exceed it rejects the whole action before any write.

The label is not a link in v1; it is text. Tapping the item opens item detail, which shows
`From Chicken tacos` as a navigable row when `sourceActivityId` still resolves.

---

## 8. Watch

The differentiator is *what I want to watch → when I'll watch it → who I'll watch it with*.
Not a catalogue, not ratings, not discovery. See
[`overview.md`](overview.md#6-non-goals).

### 8.1 Watchlist entries

A Watch Later entry is an ordinary `ListItem`. The preset configures stage presentation and
the episode-shaped Progress feature:

| Field | Values | Meaning |
| --- | --- | --- |
| `state` | `open` \| `active` \| `done` | Intrinsic state rendered with the configured labels Want to watch, Watching and Watched |
| `features.progress.kind` | `episode` | Selects the episode editor and compact summary renderer |
| `features.progress.mediaKind` | `movie` \| `show` | Optional user-entered context; controls whether season/episode fields render |
| `features.progress.season` | integer | Current progress, shows only |
| `features.progress.episode` | integer | Current progress, shows only |

Entries are created by the list's contextual `+ Add an item` composer. Global `+` offers
**Add list**, not List-item creation. A **Plan → Watch** creates only a Watch Plan,
including when it has no date. Its separate `Also add a list item to <list name>` control is
off by default and, if turned on, the final button names both writes. All fields are free
text or numbers; the app never looks anything up.

Progress is displayed as `S2 E4`. A movie or an item with empty progress shows no progress
line. State transitions are explicit list-item edits:

- `open` → `active`: offered with the first confirmed progress follow-up (§8.4), and can also
  be chosen manually.
- `active` → `done`: manual, or a confirmed follow-up after a movie. The app never decides a
  show is finished, because it does not know how many episodes there are.
- Any → any: manual from item detail. The labels are presentation; the stored values stay the
  same on every List.

> **Decision — confirmed, never automatic.** `open → active` is a confirmed follow-up like
> every other cross-object
> change, under
> [`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2. One
> rule with no exceptions is worth more than one saved tap.

### 8.2 Scheduling a watch session

From the watchlist item: `Plan this item` → the required **General / Meal / Watch / Event**
chooser (§6). For this flow the user explicitly chooses **Watch**; the list does not
infer or pre-select it. Confirming eventually calls
`POST /v1/lists/:id/items/:itemId/schedule` with the chosen type `watch`.

The created Activity is pre-filled with:

- `title` and `details.mediaTitle` = the item title,
- `details.mediaKind`, `details.season`, `details.episode` copied from the item's populated
  episode Progress value, **incremented by one episode** for an `active` show (S2 E4 → the session is
  for S2 E5),
- `details.service` = the last service used by this user.

The user can change every compatible pre-fill in the Plan form before confirming. Every
`Plan this item` flow requires the **Just me / Choose people** step in §6, including on a
private list; **Choose people** opens an empty picker. Participants are never copied from
list membership, the previous Plan, or capture.

> **Decision:** the pre-fill increments the episode. Scheduling the episode you have
> already seen is never what is meant. The value is editable, and for an `open` item with no
> progress the session defaults to S1 E1.

### 8.3 On Today

The session renders as a `watch` row with subtitle `Watch · S2 E5`, the service in the
detail screen, and participant avatars. No checkbox (§4 of
[`today-and-tasks.md`](today-and-tasks.md#4-row-affordances-by-type)).

### 8.4 Marking watched and progress increment

Completing the session (`Watched`, `outcome: 'watched'`) does exactly this:

1. Writes `status: 'completed'`, `completedAt`, `outcome: 'watched'` on the Activity. This
   is the only write.
2. If the current viewer's `LNK#<viewer>#<itemId>` pointer resolves, shows one follow-up in
   the confirmation slot:

   ```
   Movies and shows · currently S2 E4    Update to S2 E5?    ✕
   ```

   Tapping it sets the item's `features.progress` to the session's episode values and, if the
   item was `open`, sets `state: 'active'`. One write, with its own undo
   toast. Dismissing it leaves the item untouched — which is the right outcome when the
   session covered a rewatch, or when the user watched something else instead.
3. **Only once progress has been updated**, a second and separate follow-up appears:

   ```
   Movies and shows · now at S2 E5       Create a Plan for S2 E6?   ✕
   ```

4. Tapping `Create a Plan for S2 E6?` states the object choice, then opens the
   **Plan-kind chooser with nothing selected**. After the user explicitly chooses Watch,
   the form may suggest S2 E6, the same service, and the same time next week as compatible
   field values. People remains empty; sharing is chosen again through the People picker.
   It creates and shares nothing until the user reviews the fields and activates
   `Save plan`.

Steps 2 and 4 are two applications of one rule
([`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2), and
step 4 is also the concept's explicit constraint: the app "may then suggest scheduling the
next episode, but should not automatically create it". A code path that writes the item in
step 2, or an Activity in step 3, is a bug, not a shortcut.

For a `movie`, step 2 offers `Mark {list name} item as Watched?` instead, which sets the
named item to `state: 'done'`, and there is no step 3.

> **Decision — an item that has never said which it is.** `mediaKind` is optional (§8.1), so
> an item can have no media kind at all. Those items
> get **step 2's progress question**, offering the season and episode the user typed on the
> session — which is not the app deciding what kind of thing the item is, only copying this
> session's own values onto the item it came from. When the session names neither a season nor
> an episode there is nothing to copy and **nothing is offered**: `Update to ?` is not a
> question, and `done` is not an answer the app may reach for on something that might be a
> show, whose ending it cannot know (§8.1). A `movie` item still gets the watched transition,
> because that is what its own `mediaKind` says.
>
> Offering step 2 when the session repeats the item's current progress is also deliberate: that
> is a rewatch, and dismissing is the right answer to it. The app does not decide the question
> is not worth asking.
>
> The server carries all of this as data on the completion response and writes none of it
> ([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.3,
> `POST /v1/activities/:id/complete`). Confirming is the ordinary item `PATCH`.

**Watch progress belongs to the ListItem.** Members of a shared list therefore see the same
state and episode progress. The Activity link and completion follow-up are still viewer-local:
the shared item changes only when that viewer accepts the offered edit.

---

## 9. Worked end-to-end examples

These are lifecycle (ii) in §9.1 and §9.2, lifecycle (iii) in §9.3, and lifecycle (i) in
§9.4. All four are equally ordinary.

### 9.1 Watchlist → Today

**Goal:** Severance is on a Watch Later list; the user watches S2 E5 with Alice on Friday.

| Step | User action | Writes |
| --- | --- | --- |
| 0 | Lists → `New list` → explicitly chooses **Watch Later** → changes the visible name to `Movies and shows` → `Create list` | `POST /v1/lists { title: 'Movies and shows', templateKey: 'watch-later' }` copies stage labels, episode Progress configuration and the `watch` slot from the preset. No words selected the preset. |
| 1 | The list → `+ Add an item` → `Severance` → `Add`; then Item details → Progress → Show | `ListItem { itemId: itm_1, title: 'Severance', state: 'open', features: { progress: { kind: 'episode', mediaKind: 'show' } } }` after the explicit detail edit. |
| 2 | Item detail → sets progress S2 E4 (already watched up to there) and Watching | `PATCH /v1/lists/:id/items/itm_1` → `state: 'active'`, `features.progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 }` |
| 2a | List header → `Share` → explicitly adds Alice | Alice becomes a member of the list. This does not put her on any Plan. |
| 3 | Item detail → `Plan this item` → explicitly chooses **Watch** → required audience step → **Choose people** → Alice | The Watch form opens with `Severance`, **S2 E5**, and service Apple TV+ as compatible pre-fills. User sets Friday at 8:00 PM. Neither the Watch kind nor Alice was pre-selected. |
| 4 | `Save plan` | `POST /v1/lists/:id/items/itm_1/schedule` → one `TransactWriteItems`: `ACT#act_9/META` (`objectKind: 'plan'`, type `watch`, `schedule { date: '2026-08-07', time: '20:00' }`), `USER#<owner>/IDX#act_9`, and caller-specific `LNK#<owner>#itm_1 → act_9`. Because Alice was explicitly selected and can see the shared list, `LNK#<alice>#itm_1 → act_9` is also written with `ACT#act_9/PART#psn_alice`, `USER#<alice>/IDX#act_9`, and both `PLINK#` rows. `LIST#/ITEM#itm_1` is byte-identical before and after. |
| 5 | The list now reads | `Severance` / `Watching · S2 E4` / `Next session Friday · 8 PM` — one row, not two (§6.2). |
| 6 | Friday, Today | `8:00 PM ◇ Severance   Watch · S2 E5   (A)` in SCHEDULE. Alice sees the same row on her Today. |
| 7 | 10 PM, EARLIER TODAY → `How did it go?` → `Watched` | `POST /v1/activities/act_9/complete { outcome: 'watched' }`. **One write, on the Activity only.** `itm_1` is untouched. |
| 8 | Follow-up 1 | `Movies and shows · currently S2 E4 — Update to S2 E5?` Tapped → `PATCH .../items/itm_1` replaces the episode Progress value with S2 E5. |
| 9 | Follow-up 2 | `Movies and shows · now at S2 E5 — Create a Plan for S2 E6?` Dismissed. **Nothing is created.** |

### 9.2 Meal → Groceries

**Goal:** Chicken tacos for Sunday dinner; the ingredients need buying.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Global `+` → **Plan** → **Meal** → `Chicken tacos`, Sunday, slot Dinner (time auto-fills 19:00) | Nothing yet — the form is local, and Meal was explicit |
| 2 | Ingredients: `Chicken`, `Tortillas` qty `8`, `Tomatoes`, `Sour cream` (unchecks Sour cream — already has it) | Local |
| 3 | `Add selected ingredients to:` — the destination row already reads `Groceries`, the user's only list holding the `groceries` slot, so nothing was asked (§5.8) | Local |
| 4 | `Save plan and add 3 items to Groceries` | `POST /v1/activities` → `act_12` with `objectKind: 'plan'`, `type: 'meal'`, and `details.ingredients` = all four rows, each carrying its stable client-minted `ingredientId`. Then `POST /v1/activities/act_12/ingredients/add-to-list` with `listId: 'lst_g'` and the three checked source `ingredientId`s. |
| 5 | Groceries list now reads | `Chicken — Sunday dinner` · `Tortillas (8) — Sunday dinner` · `Tomatoes — Sunday dinner` · `Milk` (added manually last week, no label) |
| 6 | Meal detail | Chicken / Tortillas / Tomatoes render `Added`; Sour cream renders with `Add to Groceries`. |
| 7 | Saturday: user shops, checks all three | `PATCH` on each item, `state: 'done'`. **The meal is untouched** — provenance is not linkage (§6.5). |
| 8 | Sunday 19:00, Today | `7:30 PM ◇ Chicken tacos   Meal · Dinner`. (Time as entered; the 19:00 default was overridden.) |
| 9 | After dinner → `Had it` | `POST /v1/activities/act_12/complete { outcome: 'had_it' }`. Nothing on any list changes. |
| 10 | Monday: Groceries → `Clear checked (3)` | No dialog. Three items deleted immediately, with a `3 items cleared` toast carrying `Undo` for 6 seconds. Milk remains. |

### 9.3 Trip plan → Packing list

**Goal:** a New York trip with prep, packing, and places.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Global `+` → **Plan** → **Event** → `New York Trip`, **14 Aug**, location `Manhattan`; People picker → Alice + Ben; `Save plan` | `POST /v1/activities` → `act_20`, `objectKind: 'plan'`, `type: 'event'`, `visibility: 'shared'`, two `PART#` rows, two invitee `IDX#` rows. The trip runs to the 16th; the activity carries its start date only (§2.4), so it is on Today on the 14th and not on the 15th or 16th. |
| 2 | Plan detail → PREP → `+ Add prep task` ×2: `Book hotel` (2 Aug), `Buy tickets` (8 Aug) | Two `POST /v1/activities` with `objectKind: 'task'`, `type: 'task'`, `parentActivityId: act_20`. `act_20.childCount` = 2. |
| 3 | Plan detail → LISTS → `Add list` | The full fixed-order style catalogue opens with nothing selected (§4.1). |
| 4 | Picks **Checklist**, changes the title to `Packing · New York Trip` | `POST /v1/lists { title: 'Packing · New York Trip', templateKey: 'checklist', sourceActivityId: 'act_20' }` copies checkbox presentation and forces `slot: null` for a plan-created list (§4.1). |
| 5 | Adds `Charger`, `Jacket`, `Passport` | Three `POST /v1/lists/lst_p/items` |
| 6 | Back on the plan, LISTS reads | `Packing · New York Trip — 3 items` |
| 7 | Picks `Places to Visit` too, adds `Central Park`, `Museum` | A second list with the same `sourceActivityId`. Its Place feature is enabled, so each item can carry an address. |
| 8 | 2 Aug, Today | `☐ Book hotel   New York Trip` in ANYTIME — a prep task on its own date with the plan as subtitle (§3) |
| 9 | 13 Aug: packs, checks all three | `state: 'done'` ×3 |
| 9a | 15 and 16 Aug, Today | The trip is **not** on either day; it was on Today on the 14th (§2.4). The plan is one tap away in Plans → Upcoming, and anything dated on those days is an ordinary prep task or a separate activity. |
| 10 | 16 Aug: opens the plan from Plans and taps `Done` | `act_20` completed, by the owner — a participant has no completion control (§2.1). **Both lists survive, unarchived, with their items, and nothing on them is checked or changed.** Alice and Ben see the completion in the updates feed. |
| 11 | Next trip | The user opens `Packing · New York Trip` → overflow → `Uncheck all`, renames it `Packing`, and reuses it. Renaming changes nothing else (§5.5). Nothing was lost. |

### 9.4 A list that never produces an activity

**Goal:** the user keeps the restaurants they love, so they can answer "where should we go?"
in ten seconds. Nothing here ever becomes a Plan, and that is a complete,
successful use of the product.

| Step | User action | Writes |
| --- | --- | --- |
| 1 | Lists → `New list` | The full style catalogue opens in its fixed order, with nothing selected. No title field or suggestion runs yet. |
| 2 | Explicitly chooses **Places to Visit** → changes the visible name to `Places we love` | Local draft only; editing the title does not change the chosen preset. |
| 3 | `Create list` | `POST /v1/lists { title: 'Places we love', templateKey: 'places-to-visit' }` copies checkbox presentation and the Place feature, with `slot: null`. |
| 4 | Adds `Zahav`, `Suraya`, `Kalaya`, each with an address and a note (`the lamb`) | Four `POST /v1/lists/lst_f/items` with `location` |
| 5 | Six months of use | The list is opened 40 times, an item is tapped for its address, the maps app opens. **Zero activities exist.** |
| 6 | What the app does about it | Nothing. No progress indicator, no "you haven't planned any of these", no archive prompt, no suggestion to schedule. The list is finished the day it is created. |
| 7 | The user removes and later restores checkboxes | `⋯` → `List settings` → **Item state** → None, then Checkboxes. Each change is immediate, has no confirmation, and preserves every item's intrinsic state (§5.5). |
| 8 | Later still, one item does become a Plan | Item → `Plan this item` → the user explicitly chooses **Event** → `Just me` → `Save plan`. The list is unchanged by this; it was never waiting for it. |
