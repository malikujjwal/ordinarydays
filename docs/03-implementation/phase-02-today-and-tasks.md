# Phase 2 — Today and tasks

## Goal

At the end of this phase the app answers its own question: *what do I need to know or do
today?* A pure recurrence engine in `packages/shared` expands a series into dates without
touching I/O and without drifting across a daylight-saving boundary or a short month. One
`GET /v1/agenda` call returns everything Today renders — timed items, untimed items, undated
saved items, expanded recurring occurrences with their overrides applied, and tasks rolled
forward from the last 30 days — and the client partitions it into UP NEXT, SCHEDULE, ANYTIME
and EARLIER TODAY, advancing on a one-minute ticker without a refetch. Completing today's
Gym completes today's Gym and leaves tomorrow's alone, provably. Tasks can be completed,
un-completed, skipped, snoozed and rescheduled, optimistically, with a six-second undo, and
those mutations survive a subway ride. Local reminders fire on device. Passed plans stop
looking like unfinished work. One pure function decides which GSI1 bucket every activity's
index entry lives in, so an undated plan with people on it goes to Plans and never to Today's
Anytime list. This is the phase where the product becomes usable daily.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phase 1 complete and its acceptance criteria passing | In particular the repository layer, the `ActivityIndex` write path, and `packages/ui`. Phase 1's inline bucket logic is **replaced** by `deriveGsi1Bucket` in P2-05, not extended. |
| 1a | [`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets) read, including the bucket-derivation function and the `lastActivityAt` paragraph | Four buckets, not three. `#P` and `#N` mean opposite things and the reason is in that section. |
| 2 | [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) read in full | It is the specification for this phase, including the worked example day in §9 which doubles as a fixture. |
| 3 | [`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm) read | The six-step algorithm is normative. |
| 4 | Coverage gate at 100% on `packages/shared/src/recurrence/**` already configured | Set up in P0-24 precisely so it is live before the first line of engine code exists. |

## Deliverables

- [ ] `expandRecurrence(rec, from, to, tz)` — pure, no I/O, 100% statement and branch
      coverage, passing the full test matrix in P2-02.
- [ ] `describeRecurrence(rec)` producing the UI's label (`Every weekday`, `Monthly on the
      6th`, `Every year on 3 September`, `Every 3 days until 12 Dec`).
- [ ] `deriveGsi1Bucket(activity)` — the one pure function that decides `S` / `P` / `N` / `R`,
      with a test matrix over every input combination and every transition that must rewrite
      an index entry.
- [ ] `lastActivityAt` on the Activity and on the `ActivityIndex` entry, distinct from
      `updatedAt`, sorting the `#P` bucket and never touching `If-Match`.
- [ ] `GET /v1/agenda` with `?from`, `?to`, `?tz`, and the `include` tokens
      `anytime_unscheduled` and `overdue`; window capped at 62 days; `ETag`; `warnings[]`.
- [ ] `AgendaItem` projection with server-set `hasCheckbox`, `subtitle`, `isPast`,
      `occurrenceDate` and `overdueFromDate`.
- [ ] `complete`, `uncomplete`, `skip`, `snooze`, `schedule` endpoints, with occurrence
      scoping that provably never writes `ACT#/META`, and completion enforced as **global and
      owner-only** — a participant gets `403`.
- [ ] Per-user reminders: `GET`/`POST`/`DELETE /v1/activities/:id/reminders` operating on
      `REM#<userId>#` rows scoped to the caller by key construction, capped at 3 per user per
      activity.
- [ ] The Today screen with all four sections, their fixed order, their sort keys, their
      empty states, and the client-side UP NEXT ticker.
- [ ] Row affordances by type: a checkbox on `task` and nothing else; swipe actions per the
      gesture table; every swipe action also reachable as an `accessibilityAction`.
- [ ] Overdue roll-forward with the 30-day window, the date chip, the cap-and-collapse at
      5, and no mutation of the underlying activity.
- [ ] Passed-plan resolution prompts, and the absence of any badge, count or nag anywhere.
- [ ] Snooze, reschedule and repeat sheets, including the two-option sheet for a series.
- [ ] Optimistic updates with a six-second undo toast, and a persisted offline mutation
      queue on iOS.
- [ ] Local notifications scheduled on device for **the signed-in user's own** reminders on
      the current and next day.
- [ ] The Plans tab rendering a multi-day **window** from the same endpoint, with the `#P`
      bucket excluded — the three-stage Plans screen is Phase 3. A wider window, not an
      activity that spans days: there is no `schedule.endDate` in v1 (ADR-050).

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P2-01 | The recurrence engine `expandRecurrence` | shared | — | no | L |
| P2-02 | The recurrence test matrix | shared | P2-01 | no | L |
| P2-03 | `describeRecurrence` for the UI | shared | P2-01 | yes | M |
| P2-04 | `Recurrence` Zod schema and server-side validation | shared | P1-06 | yes | M |
| P2-05 | `deriveGsi1Bucket` and its test matrix | shared | P1-06 | yes | M |
| P2-06 | `lastActivityAt`, distinct from `updatedAt` | shared/api | P2-05, P1-05 | no | M |
| P2-07 | `OccurrenceRepository` | api | P1-05 | yes | M |
| P2-08 | Agenda service: query, expand, merge, project | api | P2-01, P2-07, P1-09 | no | L |
| P2-09 | Overdue roll-forward query rule | api | P2-08 | no | M |
| P2-10 | `AgendaItem` projection: subtitle, checkbox, isPast | api | P2-08 | no | M |
| P2-11 | `GET /v1/agenda` route, window cap, `ETag`, warnings | api | P2-08, P2-09, P2-10 | no | M |
| P2-12 | `POST /v1/activities/:id/schedule` and unschedule | api | P1-10, P2-05 | yes | M |
| P2-13 | `POST /v1/activities/:id/complete` and `/uncomplete` | api | P2-07, P1-10 | no | L |
| P2-14 | `POST /v1/activities/:id/skip` | api | P2-13 | yes | S |
| P2-15 | `POST /v1/activities/:id/snooze` | api | P2-13 | no | M |
| P2-16 | Per-user reminders: items, endpoints, and the write paths | api | P2-12 | yes | M |
| P2-17 | Series limit and window warnings | api | P2-08 | yes | S |
| P2-18 | Agenda client hook, query keys and cache policy | mobile | P2-11, P1-20 | no | M |
| P2-19 | Today screen shell and the four sections | mobile | P2-18, P1-22 | no | L |
| P2-20 | The UP NEXT card and the one-minute ticker | mobile | P2-19 | no | M |
| P2-21 | Agenda row components and affordances by type | mobile | P2-19 | no | L |
| P2-22 | Swipe actions and the gesture table | mobile | P2-21 | no | L |
| P2-23 | Optimistic mutation model functions | shared/mobile | P2-13, P2-15 | no | L |
| P2-24 | The undo toast system | mobile | P2-23 | no | M |
| P2-25 | The snooze sheet | mobile | P2-22, P2-15 | yes | M |
| P2-26 | The reschedule sheet, including the series two-option case | mobile | P2-22, P2-12 | yes | M |
| P2-27 | The repeat sheet | mobile | P2-03, P2-04 | yes | M |
| P2-28 | Passed-plan resolution prompts | mobile | P2-21, P2-13 | no | M |
| P2-29 | Overdue rows: date chip, cap and collapse | mobile | P2-21, P2-09 | no | M |
| P2-30 | Today's empty states | mobile | P2-19 | yes | S |
| P2-31 | Today's contextual `+ Add a task` action | mobile | P2-19, P1-24 | yes | S |
| P2-32 | The Plans tab: date-range agenda | mobile | P2-18 | yes | M |
| P2-33 | Persisted query cache and the offline mutation queue | mobile | P2-23 | no | L |
| P2-34 | Local notifications on device | mobile | P2-16 | no | M |
| P2-35 | `Show skipped` device-local toggle | mobile | P2-21 | yes | S |
| P2-36 | Worked-example-day integration fixture and test | ci | P2-11 | no | M |
| P2-37 | E2E: Today flows on web and iOS | ci | P2-28, P2-29 | no | M |

P2-17, P2-30, P2-31 and P2-35 are mechanical; follow the canonical sections named in the
table and skip the design discussion. P2-31's exact label is `+ Add a task`: it bypasses the
global chooser because the context fixes `{ objectKind: 'task', type: 'task' }`, opens the
Task form, and ends with `Save task`. It never accepts words first and never decides whether
the result is a Task or Plan from those words.

---

### P2-01 — The recurrence engine

**This is the highest-risk task in the whole plan.** It is pure, it is small, it is fully
specified, and it is wrong in a way nobody notices for three weeks if it is written
carelessly. Build it first, alone, before anything that consumes it.

**Files.**

```
packages/shared/src/recurrence/expand.ts       expandRecurrence — the only public entry
packages/shared/src/recurrence/rules/{daily,weekdays,weekly,monthly,yearly,intervalDays}.ts
packages/shared/src/recurrence/calendar.ts     wall-clock date arithmetic helpers
packages/shared/src/recurrence/index.ts
```

**Signature.**

```ts
export function expandRecurrence(
  rec: Recurrence,
  from: string,      // YYYY-MM-DD inclusive, in tz
  to: string,        // YYYY-MM-DD inclusive, in tz
  tz: string,        // IANA
): string[];         // YYYY-MM-DD, ascending, unique
```

**Segmented rules.** `rec` is the series' stored `recurrence`: an **ordered list of rule
segments**, each carrying the rule fields plus `effectiveFrom` (`YYYY-MM-DD`). A segment is
in force from its `effectiveFrom` to the day before the next segment's `effectiveFrom`; the
last segment runs to the series end. Expansion picks the segment in force for each date and
never blends two, which is what keeps `OCC#` history rendering under the rule that was in
force at the time. Each segment self-anchors on its own fields — `startDate` never
re-anchors when a segment is appended. The rule modules below operate on **one segment**;
`expandRecurrence` walks the list. The 20-segment cap is a schema rule (P2-04), not an
engine concern.

**Approach.**

1. **Wall-clock arithmetic only.** Every step operates on calendar dates in `tz` using
   `date-fns` and `date-fns-tz`. Never add fixed millisecond offsets; never round-trip
   through a UTC `Date` and back for date stepping. A day is not 86,400,000 ms twice a year.
2. One rule module per `freq`, each a pure generator from its segment's `effectiveFrom`
   forward. `weekdays` is
   its own rule, not `weekly` with five weekdays, because the product exposes it as its own
   option and the label differs.
3. **Month-end clamping** (`../01-product/today-and-tasks.md` §6.1): a monthly series on day
   29, 30 or 31 emits the **last day** of any shorter month. `byMonthDay: [31]` produces 28
   February (29 in a leap year), 30 April, 31 May. It never skips a month and never spills
   into the next.
4. **`yearly`** ships in this phase, not Phase 9. The client always writes explicit
   `byMonth` **and** `byMonthDay`, and those anchor the series; the engine falls back to the
   month and day of the segment's `effectiveFrom` only when both are absent, which happens
   for a hand-constructed series and never for one the Repeat sheet wrote. Leap day uses the *same*
   clamping code path as monthly — a series anchored on 29 February emits 29 February in a
   leap year and 28 February otherwise, never 1 March and never nothing. Reuse the monthly
   clamp; do not write a second one
   (`../02-architecture/data-model.md` §4.2).
5. **Termination.** `endDate` and `count` live on the series, not on a segment, and close
   the whole series. `endDate` is inclusive. `count` counts occurrences from the series'
   first occurrence (the first segment's `effectiveFrom`), including any before `from` — so
   a `count: 3` series starting 1 January produces nothing for a March window. Both may be
   present; the earlier bound wins.
6. **Bounds.** Occurrences strictly before the first segment's `effectiveFrom` are never
   emitted. The window is
   capped at 62 days by the caller; the engine itself must still terminate on a pathological
   rule, so cap internal iteration at 1,000 steps and throw a typed error rather than
   looping.
7. **`custom` / `rrule` is Phase 9.** `freq: 'custom'` throws `validation_failed`. Do not
   pull in an RFC 5545 library now.
8. **`mode: 'after_completion'` is Phase 9.** The engine accepts only `fixed`.
9. **Determinism.** No `Date.now()`, no `new Date()` with no argument, no locale, no
   `Intl.DateTimeFormat` default. Everything the function returns is a function of its four
   arguments.

**DST — the part that is subtly wrong if unstated.** `expandRecurrence` returns **dates**,
not instants, so DST does not affect it directly. DST affects the two consumers, and the
rules are:

| Case | Behaviour | Owner |
| --- | --- | --- |
| A daily 18:00 task across a transition | Emits the same date sequence; the wall-clock time stays 18:00 on both sides; the UTC instant shifts by an hour | engine + `scheduledAtUtc` derivation |
| A local time that does not exist (spring forward: 02:30 on a day jumping 02:00 → 03:00) | The date is still emitted. The *instant* derivation resolves to the first valid local time after the gap, 03:00. It is never dropped. | `toUtcInstant()` in `calendar.ts` |
| A local time occurring twice (fall back) | The date is emitted once. The instant derivation picks the **first** (earlier UTC) instance. | `toUtcInstant()` |

Put `toUtcInstant(date, time, tz)` in `calendar.ts` alongside the engine, because it is the
same body of knowledge and the same tests, and export it — the reminder scheduler and the
agenda both need it and must agree at the boundary.

**Edge cases beyond the above.**

- `byWeekday: []` on a weekly rule is `validation_failed`, not "every day".
- `interval` on `interval_days` is 2–365; `interval: 1` is `daily` and is normalised to it
  at the schema layer, not in the engine.
- A series whose first segment's `effectiveFrom` is after `to` returns `[]` without
  iterating.
- `from > to` returns `[]`.
- Leap day: a monthly series on the 29th emits 29 February in a leap year and 28 February
  otherwise. A yearly series anchored on 29 February behaves identically.
- A yearly series produces at most one date per calendar year, so a 62-day window yields one
  date or none. The engine takes `from`/`to` as given and does not enforce the 62-day cap —
  that is the route's job (P2-11) — which is why the yearly unit tests may span years.

**Tests.** P2-02 is the test matrix and is a separate task because it is the deliverable
that makes this one trustworthy.

---

### P2-02 — The recurrence test matrix

**Files.** `packages/shared/src/recurrence/expand.test.ts`,
`packages/shared/src/recurrence/calendar.test.ts`,
`packages/shared/src/recurrence/fixtures/*.json`.

**Coverage requirement: 100% statements and 100% branches**, enforced by the gate configured
in P0-24. Not "high coverage". A branch in this file that no test exercises is a branch
whose behaviour nobody has decided.

Every row below is a required test case. Each is table-driven with explicit expected date
arrays — no computed expectations, because a bug in the expectation helper and a bug in the
engine cancel out.

The rule literals below are single-segment shorthand: each names one segment's rule fields,
and `startDate` in a literal reads as that segment's `effectiveFrom` — the stored field name
under the segmented shape (P2-01, P2-04). Every case runs on a one-segment series unless it
says otherwise; the multi-segment cases are in the list after the table.

| # | Case | Setup | Expected |
| --- | --- | --- | --- |
| 1 | **Daily** | `{ freq: 'daily', interval: 1, startDate: '2026-08-01' }`, window 1–7 Aug | Seven consecutive dates. |
| 2 | **Daily, window starts mid-series** | Same, window 5–7 Aug | `['2026-08-05','2026-08-06','2026-08-07']`. Nothing before `from`. |
| 3 | **Weekdays** | `{ freq: 'weekdays', startDate: '2026-08-03' }` (Mon), window 1–14 Aug | Ten dates, no Saturday, no Sunday, including the Monday start. |
| 4 | **Weekdays starting on a weekend** | `startDate: '2026-08-01'` (Sat), window 1–7 Aug | First emission is Monday 3 Aug. The start date itself is not emitted. |
| 5 | **Weekly by day** | `{ freq: 'weekly', interval: 1, byWeekday: [4], startDate: '2026-08-06' }` (Thu) | Every Thursday in the window, starting 6 Aug. |
| 6 | **Weekly, multiple weekdays** | `byWeekday: [1,3,5]`, window covering three weeks | Mon/Wed/Fri of each week, ascending, no duplicates. |
| 7 | **Weekly with interval 2** | `{ freq: 'weekly', interval: 2, byWeekday: [1] }` | Alternate Mondays, anchored on the week containing `startDate`. |
| 8 | **Monthly by date** | `{ freq: 'monthly', byMonthDay: [6], startDate: '2026-08-06' }`, window Aug–Oct | 6 Aug, 6 Sep, 6 Oct. |
| 9 | **Month-end rollover, 31st** | `byMonthDay: [31]`, window Jan–Jun 2026 | 31 Jan, **28 Feb**, 31 Mar, **30 Apr**, 31 May, **30 Jun**. Never skipped, never spilled into the following month. |
| 10 | **Month-end rollover, 30th in February** | `byMonthDay: [30]`, Feb 2026 | 28 Feb. |
| 11 | **Month-end, leap year** | `byMonthDay: [31]`, Feb 2028 | 29 Feb. |
| 12 | **Month-end, 29th non-leap** | `byMonthDay: [29]`, Feb 2026 | 28 Feb. |
| 13 | **Every N days** | `{ freq: 'interval_days', interval: 3, startDate: '2026-08-01' }`, window 1–14 Aug | 1, 4, 7, 10, 13 Aug. Anchored on `startDate`, not on the window. |
| 14 | **Every N days, window offset from the anchor** | Same series, window 5–14 Aug | 7, 10, 13 Aug. The phase is preserved. |
| 15 | **DST spring forward, daily 18:00** | `America/New_York`, daily, window 7–9 Mar 2026 | Three dates; `toUtcInstant` gives 23:00Z, 23:00Z, **22:00Z** across the transition — wall clock constant, instant shifts. |
| 16 | **DST spring forward, non-existent local time** | Daily at 02:30, `America/New_York`, transition day | The date is emitted; `toUtcInstant` resolves to 03:00 local. Never dropped. |
| 17 | **DST fall back, ambiguous local time** | Daily at 01:30, `America/New_York`, transition day | The date is emitted **once**; `toUtcInstant` returns the **earlier** (first) instant. |
| 18 | **DST in a southern-hemisphere zone** | `Australia/Sydney`, daily 18:00 across the October transition | Wall clock constant; instant shifts the other way. Catches a hard-coded northern assumption. |
| 19 | **A zone with a 30-minute offset** | `Asia/Kolkata` (+05:30), daily | Correct instants; catches integer-hour assumptions. |
| 20 | **Series end date** | `{ freq: 'daily', startDate: '2026-08-01', endDate: '2026-08-05' }`, window 1–10 Aug | Five dates. `endDate` is inclusive. |
| 21 | **End date before the window** | Same series, window 6–10 Aug | `[]`. |
| 22 | **Count limit** | `{ freq: 'weekly', byWeekday: [1], count: 3, startDate: '2026-08-03' }`, wide window | Exactly three Mondays. |
| 23 | **Count exhausted before the window** | Same series, window starting 1 Sep | `[]`. Occurrences before `from` still consume the count. |
| 24 | **Count and end date together** | `count: 10`, `endDate` reached at occurrence 4 | Four dates. The earlier bound wins. |
| 25 | **Snoozed occurrence** | Series daily 18:00; `Occurrence { date: today, status: 'snoozed', snoozedUntil: '20:00' }` | The engine emits today; the **agenda merge** emits it at 20:00 and every other date at 18:00. `Recurrence` is neither read nor written by snooze. |
| 26 | **Completed occurrence** | `Occurrence { date: today, status: 'completed' }` | The date is still emitted; the merge marks it `completed_occurrence`; the series `ACT#/META` `updatedAt` is unchanged (success criterion S6). |
| 27 | **Skipped occurrence** | `Occurrence { date: today, status: 'skipped' }` | The date is emitted and marked `skipped_occurrence`; it is hidden from Today unless `Show skipped` is on; every other date is unaffected. |
| 28 | **Rescheduled occurrence** | `Occurrence { status: 'rescheduled', overrideTime: '21:00' }` | Emitted at 21:00 on that date only. With `overrideDate` also set, the merge emits it on `overrideDate` instead — once, never on both days (data-model §4.5). |
| 29 | **Timezone travel** | Activity stored with `schedule.timezone: 'America/New_York'`, 18:00; profile timezone changed to `Europe/London`; agenda requested with `tz=Europe/London` | The activity keeps its stored timezone. Today's boundaries and the "now" comparison use the **profile** timezone. A 6:00 PM New York task renders as 11:00 PM on the London day, and may land on the *next* London date. |
| 30 | **Timezone travel across a date boundary** | 22:00 `America/New_York` viewed from `Asia/Tokyo` | Appears on the following local date, not the same one, and is not duplicated on both. |
| 31 | **Empty window** | `from > to` | `[]`, no throw. |
| 32 | **Start after the window** | `startDate` a year later | `[]`, with no iteration (assert the internal step counter). |
| 33 | **62-day window, daily** | Maximum legal window | 62 dates, in ascending order, unique, no duplicates at month boundaries. |
| 34 | **Pathological rule guard** | A rule crafted to emit nothing for 1,000 steps | Throws a typed error rather than hanging. |
| 35 | **Determinism** | The same call twice, and with the process clock moved a day | Identical output. Asserts no hidden `Date.now()`. |
| 36 | **Purity** | Freeze the `Recurrence` object and call | No mutation, no throw. |
| 37 | **Yearly, explicit anchors — the only shape the client writes** | `{ freq: 'yearly', byMonth: [9], byMonthDay: [3], startDate: '2026-09-03' }`, window 1 Jan 2026 – 31 Dec 2029 | 3 Sep 2026, 2027, 2028, 2029. The anchors drive expansion; `startDate` is used only as a lower bound. |
| 38 | **Yearly, 29 February in a leap year** | `{ freq: 'yearly', startDate: '2028-02-29' }`, window Feb 2028 | 29 Feb 2028. |
| 39 | **Yearly, 29 February in a non-leap year** | Same series, window 1 Jan – 31 Dec 2029 | **28 Feb 2029**. Never 1 March, never omitted, and `startDate` is unchanged. Run the same series across 2028–2032 to assert it returns to 29 Feb in 2032. |
| 40 | **Yearly, hand-constructed with no anchors — the `startDate` fallback** | `{ freq: 'yearly', startDate: '2026-08-06' }`, no `byMonth` and no `byMonthDay`, window 2026–2028 | 6 Aug 2026, 2027, 2028. Month and day fall back to `startDate`. The Repeat sheet never writes this shape; the fallback exists so a hand-constructed series still expands. |
| 41 | **Yearly with an end date** | `{ freq: 'yearly', startDate: '2026-09-03', endDate: '2028-09-03' }`, window 2026–2030 | 3 Sep 2026, 2027, 2028. `endDate` is inclusive; 2029 and 2030 are absent. |
| 42 | **Yearly across a DST boundary at its anchor time** | `{ freq: 'yearly', startDate: '2026-11-01' }` at 01:30 `America/New_York`, window 2026–2027 | The date is emitted once each year; on the 2026 fall-back date `toUtcInstant` returns the **earlier** instant, and in 2027 (no transition on 1 Nov) the ordinary instant. The wall clock is 01:30 in both years. |
| 43 | **Rescheduling an occurrence does not move a yearly series** | `{ freq: 'yearly', byMonth: [9], byMonthDay: [3], startDate: '2026-09-03' }`; run it once as stored, then again with `startDate` rewritten to `'2026-09-10'` and the anchors untouched, plus `Occurrence { date: '2026-09-03', status: 'rescheduled', overrideTime: '19:00' }`; window 2027–2029 | 3 Sep in 2027, 2028 and 2029 in **both** runs. The override changes one date; the anchors, not `startDate`, decide every other year. The same rewrite on the unanchored shape of case 40 would move every future year, which is why the client always writes anchors. |

Cases 37–43 call `expandRecurrence` with multi-year windows on purpose. The 62-day cap is a
route-level rule (P2-11), not an engine-level one, and a yearly series cannot be observed
inside 62 days.

Beyond the table:

- **Segment cases**, required, same table-driven style. A two-segment series (weekdays
  18:00 `effectiveFrom` 2026-01-05, then Tue/Thu `effectiveFrom` 2026-08-10) expanded over a
  window straddling 10 August emits weekdays before the boundary and Tue/Thu from it, with
  no date emitted by both rules. A segment is in force through the day before the next
  segment's `effectiveFrom` — assert the boundary day itself belongs to the new segment. A
  window entirely inside an earlier segment's in-force period uses that segment's rule even
  though a later segment exists. Appending a segment does not change what an
  already-elapsed window expands to (run the one-segment series, append, re-run the past
  window, assert identical output). Each segment self-anchors: an `interval_days` second
  segment phases from its own `effectiveFrom`, not the first segment's.
- **Property-based tests** (`fast-check` or a hand-rolled generator) over random valid
  `Recurrence` objects and random 1–62-day windows, asserting three invariants: output is
  strictly ascending; output is a subset of the window; output has no duplicates. Run 1,000
  cases in CI.
- **A cross-check** for `daily` and `weekdays` against a naive day-by-day filter
  implementation written independently in the test file. If two independent implementations
  disagree, the test fails and one of them is wrong — that is the point.
- **Golden fixtures** in `fixtures/` for cases 9, 15, 17 and 29, so a refactor that changes
  behaviour fails loudly rather than quietly.

---

### P2-03 — `describeRecurrence` for the UI

**Files.** `packages/shared/src/recurrence/describe.ts`,
`packages/shared/src/recurrence/describe.test.ts`, exported from
`packages/shared/src/recurrence/index.ts`.

**What to build.** The one pure function that turns a stored `Recurrence` into the label
the product shows — the Repeat field's value on the creation and detail forms, the Repeat
sheet's summary row (P2-27), and the accessibility label behind the `↻` glyph on agenda
rows (P2-21). One implementation, in `shared`, so the sheet, the row and the detail screen
cannot drift.

```ts
export function describeRecurrence(rec: Recurrence, today: string): string;
//                                                  ^ YYYY-MM-DD — for the year check on
//                                                    the `until` suffix; see Approach 1.
```

**It describes the active (last) segment.** The sheet always shows and edits the active
segment, and earlier segments are history with no UI of their own
([`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#61-the-options-list)
§6.1), so the label is a function of the last segment's rule fields plus the series-level
Ends fields. A label that blended two segments would describe a rule that is never in
force.

**The labels**, matching the option list in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#61-the-options-list)
§6.1 and the examples in this phase's deliverables:

| Rule | Label |
| --- | --- |
| `daily` | `Daily` |
| `weekdays` | `Every weekday` |
| `weekly`, one weekday | `Weekly on Thursday` |
| `weekly`, several weekdays | `Weekly on Monday, Wednesday and Friday`, days in Mon-first calendar order (decision recorded here — raise in PR if wrong) |
| `weekly`, `interval` > 1 | `Every 2 weeks on Monday` (decision recorded here — raise in PR if wrong) |
| `monthly` | `Monthly on the 6th` — ordinal suffixes correct for 1st/2nd/3rd/21st/22nd/23rd/31st |
| `yearly` | `Every year on 3 September` — day then month, no ordinal suffix |
| `yearly`, clamped anchor | `Every year on 29 February`, always the stored anchor, never the clamped date (`../01-product/today-and-tasks.md` §6.1) |
| `interval_days` | `Every 3 days` |
| Ends on a date | Suffix ` until 12 Dec`, adding the year only when it is not the current year (decision recorded here — raise in PR if wrong) |
| Ends after N times | Suffix `, 3 times` (decision recorded here — raise in PR if wrong) |
| Both `endDate` and `count` | Show the `endDate` suffix only — computing which bound wins requires expansion, which this function must not do (decision recorded here — raise in PR if wrong) |

**Approach.**

1. Pure and deterministic on the same terms as the engine: no locale APIs, no
   `Intl.DateTimeFormat`, no clock. The "current year" check for the `until` suffix takes
   `today` as a second parameter (`describeRecurrence(rec, today)`), supplied by the
   caller, so the function stays a function of its arguments and testable with a frozen
   date. Weekday and month names come from fixed English tables; v1 ships one language.
2. `freq: 'custom'` and `mode: 'after_completion'` throw the same typed error the engine
   uses. The schema (P2-04) rejects them upstream; this function refusing them too means a
   hand-constructed invalid object cannot render a misleading label.
3. The `yearly` no-anchor fallback shape (P2-02 case 40) labels from the segment's
   `effectiveFrom` month and day, mirroring the expansion fallback.
4. No pluralisation library and no template engine. It is string concatenation over a
   closed set of shapes.

**Tests.** Table-driven: at least one case per row above, each with the exact expected
string; every ordinal suffix boundary (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31); the
`until` suffix with and without the year; a two-segment series labels the active segment
and ignores the first (assert against a fixture whose two segments would produce different
labels); purity and determinism as in P2-01; `custom` and `after_completion` throw.

---

### P2-04 — `Recurrence` Zod schema and validation

**Files.** `packages/shared/src/schemas/recurrence.ts`.

**Approach.** The stored shape is the **segmented** one from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series)
§6.2: `Recurrence` is `{ mode, endDate?, count?, segments: RecurrenceSegment[] }`, where
each `RecurrenceSegment` carries the rule fields of
[`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence)
minus `startDate`, plus a required `effectiveFrom` (`YYYY-MM-DD`, its expansion anchor) and
an optional `time`/`endTime` snapshot of the schedule time in force while it applies.
`segments` is ordered ascending by `effectiveFrom` with no duplicates, length 1–20; the
write that would create a 21st segment is `validation_failed`, and the message says so, so
the sheet can explain it (§6.2). `mode`, `endDate` and `count` belong to the series — one
Ends setting closes the whole series, however many segments it has. (`data-model.md` §4.2
carries the same segmented shape, including the lazy-migration reading of pre-segment
rows.)

Per-segment rule constraints, which the schema applies to **every** segment:

| Rule | Enforcement |
| --- | --- |
| `mode` | `'fixed'` only. `'after_completion'` → `validation_failed`, per `today-and-tasks.md` §6.7. |
| `freq: 'custom'` | Rejected until Phase 9. The `rrule` field exists in the type and is unusable. |
| `weekly` | `byWeekday` required and non-empty; values 0–6. |
| `monthly` | `byMonthDay` required, single element in v1, 1–31. The client always writes it. |
| `yearly` | `byMonth` and `byMonthDay` are both optional at the schema layer and must be supplied together or not at all; each a single element in v1, `byMonth` 1–12 and `byMonthDay` 1–31. The client always writes both; neither present is the hand-constructed case and means "anchor on the segment's `effectiveFrom`". |
| `interval_days` | `interval` required, 2–365. `interval: 1` normalised to `freq: 'daily'`. |
| `count` | 1–999. Series-level. |
| `endDate` | ≥ the first segment's `effectiveFrom`. Series-level. |
| `effectiveFrom` | For the **first** segment: always the activity's `schedule.date` at the moment recurrence is set; not separately editable; server overwrites any client value. For an **appended** segment: the edited occurrence's date, or today when the edit was made from the series' detail screen outside any occurrence context ([`today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series) §6.2); server-set on the same rule. Strictly greater than the previous segment's. |
| Append-only history | A `PATCH` carrying `recurrence` on an existing series must leave every previously stored segment byte-identical and may only append one new final segment (and/or change the series-level Ends fields). Anything else — a rewritten, reordered or deleted past segment — is `validation_failed`. Past segments are immutable. |
| Recurrence with no `schedule.date` | `validation_failed` — Repeat is only enabled when a date is set. |

**Tests.** One valid and at least two invalid cases per row; `mode: 'after_completion'`
rejected with a message naming the phase; `interval: 1` on `interval_days` normalised; a
20-segment series accepted and a 21st rejected with the explaining message; an append with
a rewritten past segment rejected; `effectiveFrom` not ascending rejected.

---

### P2-05 — `deriveGsi1Bucket` and its test matrix

**Files.** `packages/shared/src/activities/bucket.ts`,
`packages/shared/src/activities/bucket.test.ts`,
`packages/shared/src/activities/index.ts`.

**What to build.** The one pure function that decides which GSI1 bucket an activity's index
entry belongs in. It is transcribed exactly from
[`../02-architecture/data-model.md#bucket-derivation`](../02-architecture/data-model.md#bucket-derivation)
and is not paraphrased, re-ordered or re-expressed as a lookup table:

```ts
function deriveGsi1Bucket(a: Activity): 'S' | 'P' | 'N' | 'R';
```

**Order matters and is part of the specification.** Recurrence wins over a date; a date wins
over the explicit `objectKind` test. After those two checks, `objectKind: 'plan'` is `P` and
`objectKind: 'task'` is `N`. Type and participants never decide the bucket. Reordering the
conditions changes where real activities appear and is the failure this task exists to
prevent.

**Approach.**

1. One file, one exported function, no I/O, no clock, no configuration. It takes an
   `Activity` and returns a character. It does not build a key, does not know about
   `gsi1sk`, and does not write anything.
2. The repository layer calls it in exactly one place — the function that builds an
   `ActivityIndex` item — so no service, route or client ever re-derives a bucket. Phase 1
   built the index entry with the three-bucket rule inline; this task replaces that inline
   logic with a call and deletes the original. **Two implementations is the defect.**
3. `#P` is new in this phase. `#N` narrows to mean an explicitly chosen undated Task only, and the reason
   the two are separate buckets rather than one is in
   [`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets):
   `#N` means "today, whenever", `#P` means "someday, undecided". An undated Plan on Today's
   Anytime list next to an errand is the exact error the split prevents.
4. The `gsi1sk` for each bucket comes from the same table in the canonical document —
   `<localDateTime>` for `S`, `<lastActivityAt>` for `P` (P2-06), `<createdAt>` for `N`,
   `<seriesStartDate>` for `R` — and is built in the repository, not here. Under the
   segmented shape (P2-04), `<seriesStartDate>` is the **first** segment's `effectiveFrom`;
   appending a segment never rewrites it.

**The rewrite rule.** Every write path that can change an input must recompute the bucket and
rewrite the index entry in the **same transaction** as the activity write. The inputs are
exactly three: `recurrence`, `schedule.date`, `objectKind`. A write path that
touches one of those and does not rewrite the index entry leaves an activity in the wrong
tab, and the storage looks correct while the product does not.

**Tests.** Table-driven, one case per row, with the expected bucket written out literally.
100% branch coverage on this file, gated with the recurrence module.

| # | `recurrence` | `schedule.date` | `objectKind` | `type` (not an input) | Bucket |
| --- | --- | --- | --- | --- | --- |
| 1 | — | `2026-08-14` | `task` | `task` | `S` |
| 2 | — | `2026-08-14` | `plan` | `event` | `S` — a date beats everything below it |
| 3 | — | — | `task` | `task` | `N` |
| 4 | — | — | `plan` | `custom` | `P` |
| 5 | — | — | `plan` | `meal` | `P` |
| 6 | — | — | `plan` | `event` | `P` |
| 7 | — | — | `plan` | `watch` | `P` |
| 8 | — | — | `plan` | `event` | `P` |
| 9 | — | `2026-08-15` | `plan` | `meal` | `S` |
| 10 | `{ freq: 'daily' }` | — | `task` | `task` | `R` |
| 11 | `{ freq: 'daily' }` | `2026-08-14` | `task` | `task` | `R` — recurrence beats a date |
| 12 | `{ freq: 'weekly' }` | — | `plan` | `meal` | `R` — recurrence beats object kind |

Transitions. Each is a second call to the function with one input changed, asserting the
bucket moves and therefore that the index entry must be rewritten:

| # | Transition | Before → after |
| --- | --- | --- |
| 13 | A date is set on an undated Task | `N` → `S` |
| 14 | A date is set on an undated Plan | `P` → `S` |
| 15 | A date is cleared on a Task | `S` → `N` |
| 16 | A date is cleared on a Plan | `S` → `P` |
| 17 | `objectKind` explicitly changes Task → Plan while undated | `N` → `P` |
| 18 | `objectKind` explicitly changes Plan → Task while undated | `P` → `N` |
| 19 | Plan `type` changes `custom` → `event` while undated | `P` → `P`, no rewrite needed |
| 20 | Participants are added to an undated Plan | `P` → `P`, no rewrite needed |
| 21 | Participants are removed from an undated Plan | `P` → `P`, no rewrite needed |
| 22 | `type` changes while dated | `S` → `S`, no rewrite needed |
| 23 | A recurrence is added to a dated task | `S` → `R` |
| 24 | A recurrence is removed from a dated series | `R` → `S` |
| 25 | A recurrence is removed from an undated Plan | `R` → `P` |

Beyond the table: a purity test that freezes the `Activity` and asserts no mutation; a
determinism test that calls twice with the process clock moved and asserts identical output;
and an exhaustiveness test that enumerates `{ task, plan } × { dated, undated }` and all six
presentation types, asserting only `objectKind` distinguishes undated `#N` from `#P`.

Integration, against DynamoDB Local: scheduling an undated Plan moves its index
entry from `U#<u>#P` to `U#<u>#S` and leaves exactly one index entry per user; unscheduling
moves it back; changing its presentation type leaves it in `#P`.

---

### P2-06 — `lastActivityAt`, distinct from `updatedAt`

**Files.** `packages/shared/src/types/activity.ts`,
`packages/shared/src/schemas/activity.ts`,
`services/api/src/repositories/activityRepository.ts`.

**What to build.** A second timestamp on the Activity, mirrored onto the `ActivityIndex`
entry, meaning *this plan is being discussed*. It sorts the `#P` bucket descending so the
Needs-a-date stage leads with the plan people are actually talking about, per
[`../02-architecture/data-model.md#bucket-derivation`](../02-architecture/data-model.md#bucket-derivation).

| Field | Bumped by | Read by |
| --- | --- | --- |
| `updatedAt` | Edits to the Activity itself — title, notes, schedule, type, location, details | `If-Match` on `PATCH /v1/activities/:id`; nothing else |
| `lastActivityAt` | An RSVP change (Phase 6), a posted update (Phase 3), an added expense (Phase 7) | The `#P` bucket's `gsi1sk`; nothing else |

**Why they are two fields and not one.** `updatedAt` backs optimistic concurrency. If a
participant's RSVP bumped it, an owner with an open edit sheet would get a `409` from a
change that touched none of the fields they were editing, and the honest resolution — a
three-way merge over fields that did not conflict — would be doing real work to recover from
a collision the model invented. Two fields cost eight bytes and remove the whole problem.

**Approach.**

- Both fields are server-derived and are in neither `CreateActivityInput` nor the `PATCH`
  body, per the mass-assignment rule in
  [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.1
  rule 4. A request containing either is `400`.
- `lastActivityAt` is initialised to `createdAt` on creation, so a plan that has never been
  discussed still sorts.
- The bump is one repository helper, `touchLastActivity(activityId, at)`, which updates
  `ACT#/META` and every participating user's `IDX#` entry in the same transaction the
  originating write uses. Never a second round trip, and never a bare `UpdateItem` from a
  service.
- **An edit bumps `updatedAt` only.** Renaming a plan is not a discussion, and letting a
  rename reorder the Needs-a-date list would make the stage twitch on every keystroke-saved
  edit.
- The writers land in later phases. This task ships the field, the schema, the index sort key
  and the helper; Phase 3 wires the updates feed to it, Phase 6 the RSVP path, Phase 7 the
  expense path. Each of those tasks re-asserts the property through its own real path.

**Tests.**

- **The `If-Match` test, which is the point of the task.** Read an activity and capture its
  `updatedAt` as the `If-Match` value. Call `touchLastActivity` directly — standing in for
  the Phase 6 RSVP writer, which does not exist yet. Re-read: `lastActivityAt` has moved,
  `updatedAt` is byte-identical. Then issue the `PATCH` with the captured `If-Match` and
  assert it returns `200`, not `409`. Phase 6 repeats this test through an actual RSVP.
- `PATCH`ing the title moves `updatedAt` and leaves `lastActivityAt` unchanged.
- Two activities in the `#P` bucket, the older one touched: a descending query on
  `U#<u>#P` returns it first.
- `lastActivityAt` equals `createdAt` on a freshly created activity.
- A request body containing `lastActivityAt` or `updatedAt` is rejected with `400`.

---

### P2-07 — `OccurrenceRepository`

**Files.** `services/api/src/repositories/occurrenceRepository.ts`,
`packages/shared/src/types/occurrence.ts`,
`packages/shared/src/schemas/occurrence.ts`.

**What to build.** The repository that owns every read and write of
`ACT#<activityId>` / `OCC#<yyyy-mm-dd>` items
([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)
§4.5). No DynamoDB call to an `OCC#` key exists anywhere else — the no-DynamoDB-outside-
repositories rule, applied to the item type this phase lives on. Built on the P1-05 base:
key builders take `activityId` explicitly, items are validated against the shared schema on
read, `schemaVersion` upgrade-on-read applies.

The `Occurrence` shape is §4.5 verbatim: `date` is the series' **nominal** date — the date
expansion emitted — never the snoozed or rescheduled display time's date. It carries **no
participant identity and no user field**; a `userId` parameter on any method of this
repository is the per-participant-completion defect from the risk table arriving early.

**Methods.**

| Method | Backs | Notes |
| --- | --- | --- |
| `get(activityId, date)` | occurrence-scoped mutations' read-before-write | `GetItem`. Absence returns `null` — "scheduled, not yet acted on" is the absence of a row, and the repository never fabricates one. |
| `batchGetForPairs(pairs: { activityId, date }[])` | expansion step 4 (P2-08) | `BatchGetItem`, chunked at 100 keys, with `UnprocessedKeys` retried with backoff. The chunking lives **here**, not in the agenda service — step 4 must not be an N-query loop and the service must not know the limit. |
| `queryWindow(activityId, from, to)` | occurrence history for one series — the plan-detail screen and the P2-36 assertions | Access pattern 5: `Query pk = ACT#<a>`, `sk BETWEEN OCC#<from> AND OCC#<to>`, both inclusive. |
| `put(occurrence)` | complete, skip, snooze, reschedule-this-occurrence | Upsert of exactly one item. This method is structurally incapable of touching `ACT#/META` — it takes an `Occurrence`, builds one `OCC#` key, and writes one item. That is the storage-layer half of success criterion S6; the endpoint tests (P2-13, P2-14, P2-15) assert the visible half. |
| `delete(activityId, date)` | `uncomplete` on an occurrence, `Undo skip`, undo of a snooze | Deletes the row; absence restores "not yet acted on". |
| `countCompleted(activityId)` | the `Delete whole series` confirmation, which must name the real count of stored past completions ([`../01-product/activities.md`](../01-product/activities.md#64-deleting) §6.4) | `Query` on the partition with `begins_with OCC#`, `Select: COUNT`, filtered to `status = 'completed'`. A partition-scoped query, not a `Scan`, and computed on demand — the dialog is rare and a denormalised counter would be a second copy of the truth (decision recorded here — raise in PR if wrong). |

**Edge cases.**

- A second `put` for the same `(activityId, date)` replaces the row — snooze is repeatable
  (P2-15), and the row holds one current state, not a history.
- The activity-delete cascade (P1-14) already removes `OCC#` rows with the partition;
  nothing here duplicates that.
- No method takes a status filter except `countCompleted`; hiding skipped occurrences is a
  merge rule in P2-08 and a client toggle in P2-35, never a storage-level filter.

**Tests.** Integration against DynamoDB Local: put/get round-trip preserves every field;
`batchGetForPairs` with 250 pairs issues three `BatchGetItem` calls (client spy) and
returns results correctly paired, including misses; a seeded `UnprocessedKeys` response is
retried; `queryWindow` bounds are inclusive at both ends; `put` leaves `ACT#/META`
byte-identical (read before and after); `delete` then `get` returns `null`;
`countCompleted` counts completed rows only, ignoring skipped and snoozed.

---

### P2-08 — Agenda service

**Files.** `services/api/src/services/agendaService.ts`.

**Approach.** The six-step algorithm in
[`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm),
implemented literally:

1. `Query GSI1 U#<u>#S BETWEEN <from>T00:00 AND <to>T23:59` — one-off and already-dated
   items.
2. `Query GSI1 U#<u>#R` — every active series.
3. For each series, `expandRecurrence(...)` — pure, no I/O, called inside a loop with no
   awaits in it.
4. `BatchGetItem` the `OCC#<date>` overrides for every (series, date) pair from step 3,
   batched at 100 keys.
5. Merge overrides: `skipped` → emit as skipped (hidden by default); `completed` → emit as
   completed; `snoozed` → emit at `snoozedUntil`; `rescheduled` → emit at `overrideTime`,
   and on `overrideDate` instead of the original date when it is set (the cross-day
   this-occurrence move, data-model §4.5), never on both days;
   otherwise emit at the time of the **segment in force** for that date — its `time`
   snapshot, falling back to `schedule.time` when the segment carries none — so past
   completions and skips render forever under the rule and time in force on their date
   ([`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series)
   §6.2).
6. Merge 1 + 5, sort by effective local time, and return per-day buckets.

**The agenda never touches `U#<u>#P`.** Three buckets feed it — `#S` for dated items, `#R`
for series, and `#N` for the Anytime section when `include=anytime_unscheduled` is set. The
`#P` bucket holds undecided plans, which are not things to do today, and
[`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans)
states this as a property of the endpoint rather than a filter applied afterwards. Implement
it as an absent query, not as a `Filter` on a wider one: a bucket that is never read cannot
leak into a section by accident, and a filter can be dropped in a refactor without any test
noticing.

Server-side partitioning into `upNext` / `schedule` / `anytime` / `earlier` uses the sort
keys in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §3.1. `upNext` is
computed at request time and is the client's **initial paint only** — the client recomputes
on its ticker (P2-20).

**Edge cases.**

- Step 4 must not be an N-query loop. One `BatchGetItem` per 100 keys.
- Sorting ties break on `activityId` ascending, which is a ULID and therefore creation
  order. This is deliberately *not* type priority and not alphabetical — a type ranking
  would be a hidden hierarchy of types.
- `cancelled` activities never appear, on any date.
- Items belonging to a declined plan never enter the query because declining removes the
  `ActivityIndex` entry (Phase 6).
- Prep tasks with their own `schedule.date` are **included**, with the parent plan's title
  as the subtitle.
- A series that would emit two occurrences on one date (only reachable via a malformed
  custom rule, which is Phase 9) emits the earliest and drops the rest, adding a warning.

**Tests.** Unit with a mocked repository covering each merge branch. Integration against
DynamoDB Local using the worked example day from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §9 as the fixture
(P2-36), asserting the exact section membership and order of all nine rows.

Plus, seeded with one activity in every bucket: a repository spy asserts that **no query
against `U#<u>#P` occurs on any agenda path**, with and without both `include` tokens, and
the undated Plan in that bucket appears in no section of the response.

---

### P2-09 — Overdue roll-forward

**Files.** `services/api/src/services/agendaService.ts` (a separate exported function),
`services/api/src/repositories/activityRepository.ts` (the window query).

**Approach.** Implement the overdue rule from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §7 exactly, and
nothing more:

- Enabled only by `include=overdue`.
- Query GSI1 `U#<u>#S` for the window `[today − 30 days, today − 1 day]`, filtered to
  `type === 'task'`, `status === 'scheduled'`, and **not** part of a recurring series.
- Emit each as an ANYTIME group-1 item with `overdueFromDate` set to its original date.
- **Nothing is mutated.** The activity keeps its `schedule.date`. This is a query rule, so
  the item is still on its own date in Plans and in any date-range view, which is what keeps
  "Today owns no data" true.

`overdueFromDate?: string` is an additive optional field on `AgendaItem`, and
`include=overdue` is an additive token. Both ship without a version bump, and both must be
added to
[`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans)
and to the Zod schema in `packages/shared` **before** the client uses them.

**Edge cases.**

- Non-task types dated in the past never roll forward. Not meals, not watch sessions, not
  events, not custom activities.
- **Recurring occurrences never roll forward.** A missed Monday gym is gone. Reviving it
  produces a growing pile of identical rows, which is the exact failure mode recurring tasks
  exist to avoid.
- The 30-day cut-off is not negotiable: without it, one abandoned month poisons Today
  permanently. Older items remain reachable through `GET /v1/activities?filter=past`.
- Completing a rolled-forward task completes the **original** activity with its original
  date. `completedAt` is now; `schedule.date` is unchanged. Its history stays honest.

**Tests.** Integration: a task dated 4 Aug appears on 6 Aug with `overdueFromDate:
'2026-08-04'` and its stored date unchanged; a task dated 40 days ago does not appear; an
event dated yesterday does not appear; a recurring task's missed occurrence does not appear;
completing a rolled-forward task leaves `schedule.date` untouched and sets `completedAt`.

---

### P2-10 — `AgendaItem` projection

**Files.** `services/api/src/services/agendaProjection.ts`,
`packages/shared/src/schemas/agenda.ts`.

**Approach.** Build the `AgendaItem` shape from
[`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans),
server-side, so the client never derives presentation from `type` with a switch statement:

- `hasCheckbox = type === 'task'`, and nothing else, ever.
- `subtitle` per the table in
  [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §4: parent plan
  title for `task`; `Meal · <slot>`; `Watch · S<n> E<n>` or `mediaKind`; `organiser`
  else `location.label` for `event`; none for
  `custom`.
- `isPast` per §8.1: `endTime` if present, else `time`, else the end of the local day.
- `time` is the **effective** time after occurrence overrides — the snooze or reschedule
  value, not the series value.
- `occurrenceDate` is present **if and only if** the item came from a series expansion. The
  client must send it back on every occurrence-scoped call; omitting it targets the series
  and is a bug.

**Tests.** Table-driven: one case per type asserting `hasCheckbox` and `subtitle`; a snoozed
occurrence's `time` equals `snoozedUntil`; a rescheduled occurrence's equals `overrideTime`;
`occurrenceDate` present only for series items; `isPast` at exactly the boundary minute for
each of the three cases.

---

### P2-12 — `POST /v1/activities/:id/schedule` and unschedule

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/services/scheduleService.ts`,
`packages/shared/src/schemas/schedule.ts`.

**Approach.** The endpoint from
[`../02-architecture/api-contract.md#23-activities`](../02-architecture/api-contract.md#23-activities)
§2.3: body `{ date, time?, endTime?, timezone }`; unschedule is the same route with
`{ date: null }`. **Owner only** — a participant cannot reschedule
([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
§3), so a participant gets `403` through the same `assertActivityAccess` as P2-13 and a
stranger gets `404`.

- **Validation.** `time` requires `date`; `endTime` requires and must be after `time`
  (same-day) → `validation_failed` per
  [`../01-product/activities.md`](../01-product/activities.md#3-progressive-creation-forms--shared-rules)
  §3.4; `timezone` is IANA, falling back to `X-Client-Timezone` when the body omits it.
  `{ date: null }` removes `schedule` **entirely** — time, end time, timezone,
  derived instants — and returns the Activity to `saved` (§3.4's Date control).
- **Status is derived, never accepted**: `schedule?.date ? 'scheduled' : 'saved'`
  ([`../02-architecture/data-model.md#41-activity`](../02-architecture/data-model.md#41-activity)
  §4.1). `scheduledAtUtc` / `endAtUtc` are recomputed on every schedule write with
  `toUtcInstant` from `calendar.ts` (P2-01) — the reminder scheduler and the agenda must
  agree at the boundary, so there is exactly one derivation.
- **The bucket rewrite, in the same transaction.** `schedule.date` is a bucket input
  (P2-05), so the write is one `TransactWriteItems` over `ACT#/META` and every user's
  `IDX#` entry per
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items):
  scheduling moves `N → S` or `P → S`; unscheduling moves `S → N` for a Task and `S → P`
  for a Plan, by `objectKind` and nothing else (acceptance criterion 24).
- **The RSVP reset ships now, reachable in Phase 6.** A date set or changed resets every
  non-declined participant's `rsvp` to `pending` (declined participants are excluded on both
  the app-user and guest sides — decision 2026-08-07, see phase-06 P6-15), clears
  `respondedAt`, sets `rsvpForDate`; a time-only
  change keeps responses; clearing the date keeps them and clears `rsvpForDate`
  ([`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change)
  §7.1). The response carries `rsvpReset: true` when it happened. The `PART#` writes join
  the same transaction. Like P2-13's authz, this is built now against seeded rows while
  nothing can create them.
- `icsSequence` increments — date, time, end time and timezone are all in the exported set
  (§4.1).
- **A recurring series does not go through this route's schedule path.** Series edits are
  either an occurrence override or a segment append (P2-26), never a rewrite of
  `schedule.date` — the series' `#R` sort key is the first segment's `effectiveFrom` and
  `schedule.time` mirrors the active segment. Two rules:
  - With `occurrenceDate` in the body and `recurrence` present, the route writes
    `Occurrence { status: 'rescheduled', overrideDate?: date, overrideTime: time }` through
    P2-07 and touches
    nothing else — this is the write behind the reschedule sheet's `This occurrence only`
    (P2-26). `occurrenceDate` is an additive body field and is added to the API contract
    and the shared schema before the client uses it, on the same rule as P2-09's additions.
    The body's `date` **may differ** from `occurrenceDate`: a this-occurrence reschedule
    may move the occurrence cross-day. `Occurrence.overrideDate`
    ([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4.5) exists
    for exactly this — a differing `date` is stored as `overrideDate` (an equal one stores
    none), the override row stays keyed by its original `occurrenceDate`, and the expansion
    merge emits the occurrence on `overrideDate` when set. This is the resolution of the
    ambiguity `today-and-tasks.md` §5.3's note pointed at (decision resolved 2026-08-07);
    it is no longer an open flag.
  - Without `occurrenceDate`, a request against an activity with `recurrence` is
    `validation_failed`. The sheet never issues it, and accepting it would be a series
    write that bypasses segment history (decision recorded here — raise in PR if wrong).
- `fromSuggestionId` (`data-model.md` §4.3a) belongs to the phase that ships date
  suggestions; this handler ignores no field silently — the schema simply does not include
  it yet.
- Not a creating `POST`: no `Idempotency-Key` required. The operation is naturally
  idempotent — scheduling to the same date twice is one state.
- Callers in this phase: the reschedule sheet (P2-26), the snooze sheet's `Tomorrow`
  option (P2-25), the overdue chip and `Do today` swipe (P2-29, P2-22).

**Tests.** Integration: scheduling an undated Task moves its index entry `N → S` in one
transaction with exactly one entry per user afterwards; unscheduling returns a Task to `N`
and a Plan to `P`; `endTime` before `time` and `time` without `date` each `400`;
unschedule removes the whole `schedule` object and flips status to `saved`; a daily-18:00
date in `America/New_York` on a DST boundary derives the shifted instant (matches P2-02
case 15); with seeded `PART#` rows a date change resets `rsvp` and sets `rsvpForDate`, a
time-only change does not, and the response says `rsvpReset: true` only for the former; a
participant gets `403` and nothing is written (partition count before and after); a
stranger gets `404`; on a series, no `occurrenceDate` → `400`, with `occurrenceDate` → one
`OCC#` row, `META` byte-identical.

---

### P2-13 — `complete` and `uncomplete`

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/services/completionService.ts`.

**Approach.** `POST /v1/activities/:id/complete` with `{ occurrenceDate?, outcome? }`.

**Owner only.** Completion is **global**: an `Occurrence` records that *the thing happened*,
not that *somebody attended*, and it carries no participant identity by design
([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)
§4.5, ADR-048). A participant calling `complete`, `uncomplete`, `skip` or `snooze` on a plan
they can see gets **`403`** — not `404`, because they can already see it and hiding it would
be a lie. The check is `assertActivityAccess(userId, activityId, 'owner')` in `authz.ts`
(P1-10), not a branch in this service.

Enforce it now, in this phase, while there is one user and nothing to break. Phase 6 makes it
reachable and walks it in the authorisation matrix (P6-28); it does not introduce it.

**Prep tasks are the exception, and it costs one rule.** Completion authority follows the
object: completing a *plan* asserts a shared fact about an event, but completing a *prep
task* ticks an item on a shared checklist. **Any participant of the parent plan may
complete, uncomplete and edit a prep task, whoever created it**
([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
§3, [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.4,
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §5.5). If Alice books
the hotel for a trip you are planning together, she ticks `Book hotel` whether or not she
typed it.

The ordinary owner check does **not** grant this, so `authz.ts` carries one participant
branch: *a participant of the parent may act on a child*. When the activity has a
`parentActivityId`, `assertActivityAccess` also consults the **parent's** `PART#` rows.
It is applied once in the middleware, never per endpoint, and Phase 6 walks it with a real
participant (P6-28).

Two paths, and their difference is the most important invariant in this phase:

| Body | Writes | Does **not** write |
| --- | --- | --- |
| No `occurrenceDate` | `ACT#/META`: `status: 'completed'`, `completedAt`, `outcome` | — |
| With `occurrenceDate` | **Exactly one item**, `ACT#<id>/OCC#<date>`, with `status: 'completed'`, `completedAt` | `ACT#/META`. Its `updatedAt` does not change. |

That second row is success criterion S6 and is asserted by an integration test, not by
inspection.

`outcome` defaults per type from the verb table in
[`../01-product/activities.md`](../01-product/activities.md) §5.2. `didnt_happen` and
`didnt_go` set `status: 'skipped'`, not `completed` — they are the polite way to clear
something without claiming it happened.

`uncomplete` reverses `completed` and `skipped`, restores the prior status, and clears
`completedAt` and `outcome`. For an occurrence it deletes the `Occurrence` row.

**Edge cases.**

- There is no per-participant completion, and there is no key that could hold one. A
  participant who did not go sets their RSVP to `declined`; one who wants the plan off their
  day leaves it. Both already exist. The feature and its cost are deferred in
  [`../00-open-decisions.md`](../00-open-decisions.md) item 31.
- Completing an activity that is already completed is idempotent, not a `409`.
- The completed row moves from SCHEDULE to EARLIER TODAY on the same screen without a
  refetch — that is client work (P2-23), but the response shape must give the client
  everything it needs to do it without one.
- No follow-up suggestion is offered on a recurring completion. The next occurrence already
  exists.

**Tests.** Integration: completing an occurrence writes exactly one item (count the
partition before and after) and leaves `ACT#/META.updatedAt` byte-identical; tomorrow's
expansion still emits the series at its normal time; `uncomplete` on an occurrence deletes
the row; `outcome: 'didnt_go'` sets `status: 'skipped'`; completing twice is idempotent.

Plus authorisation, written against a seeded `PART#` row and a stubbed identity for that
participant while nothing yet creates one: **a participant's `POST .../complete` returns
`403` and writes nothing** — asserted by counting the partition before and after, so a
handler that returns `403` after writing fails. The same case for `uncomplete`, `skip` and
`snooze`, and the mirror case that a stranger gets `404` on all four.

Plus the parent-participant rule, on a seeded prep task whose `parentActivityId` points at
that shared plan and whose `ownerId` is the plan owner's: a participant who did **not**
create the prep task completes it with `200`, and `uncomplete` reverses it; a stranger to the
parent gets `404` on both. Both cases go through the same helper, so a fix that special-cases
the endpoint fails them.

---

### P2-14 — `skip`

**Files.** `services/api/src/services/completionService.ts`,
`services/api/src/routes/activities.ts`.

**Approach.** `POST /v1/activities/:id/skip` with `{ occurrenceDate? }`, per
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#54-skip) §5.4. Skip
says "not this one, and I do not want to be asked again". Same authorisation as P2-13,
through the same `assertActivityAccess` — owner only, participant `403` with nothing
written, stranger `404`; the parent-participant branch applies to prep tasks because it
lives in the middleware, not in this handler.

Two paths, on P2-13's exact pattern:

| Body | Writes | Does **not** write |
| --- | --- | --- |
| No `occurrenceDate` | `ACT#/META`: `status: 'skipped'`. The row leaves Today. | — |
| With `occurrenceDate` | Exactly one item, `ACT#<id>/OCC#<date>`, `{ status: 'skipped' }`, via P2-07 | `ACT#/META`. Its `updatedAt` does not change (S6). |

- **Skip is private.** It never notifies anyone and never appears in a shared plan's
  updates feed (§5.4) — unlike `cancelled`, which is the plan being off rather than the
  owner quietly clearing it.
- The series delete sheet's `This occurrence` option writes the same skipped occurrence
  (`../01-product/today-and-tasks.md` §6.3); there is one write path, not two.
- `uncomplete` (P2-13) reverses a skip: it restores the prior status on a non-recurring
  task and deletes the `OCC#` row for an occurrence — this is what backs `Undo skip` under
  the `Show skipped` toggle (P2-35).
- Skipping an already-skipped target is idempotent. Skipping a completed occurrence
  overwrites the single `OCC#` row to `skipped` and clears `completedAt` — one row holds
  one current state, and the UI never offers it (a completed row offers `Un-complete`)
  (decision recorded here — raise in PR if wrong).
- No type gate server-side: `complete` with `outcome: 'didnt_happen'` already writes
  `skipped` for plan types (P2-13), so refusing direct skip by type would be a fiction.
  Which rows *offer* Skip is the gesture table's business (P2-22).

**Tests.** Integration: skipping an occurrence writes exactly one item (partition count
before and after) and leaves `ACT#/META.updatedAt` byte-identical; the same series'
other dates expand unchanged; a non-recurring skip flips `META.status` and the item leaves
the agenda response; skip then `uncomplete` restores `scheduled` / deletes the row; the
skipped occurrence is emitted as `skipped_occurrence` and hidden by default in the agenda
merge (P2-08); a participant gets `403` with nothing written; a stranger gets `404`.

---

### P2-15 — `snooze`

**Files.** `services/api/src/services/completionService.ts`.

**Approach.** `POST /v1/activities/:id/snooze` with `{ occurrenceDate, until }`, where
`until` is `HH:mm` on the same day or an ISO instant. Writes `Occurrence { status:
'snoozed', snoozedUntil }` and **nothing else**. **Owner only**, on the same rule and through
the same check as P2-13: a snooze moves the thing for everybody, so it is not a participant's
to move.

> A code path that snoozes and then writes `ACT#/META` is wrong even if the visible result
> looks right. This is a required test case, from
> [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §6.5.

The concept's own example is the acceptance test:

```
Gym, normally 6:00 PM
Today   → snooze until 8:00 PM
Tomorrow → still 6:00 PM
```

**Edge cases.**

- Snooze is repeatable; a second snooze overwrites `snoozedUntil` on the same row.
- `until` earlier than the current time is `validation_failed`.
- Snooze is not offered on an undated or all-day task — there is no time to move.
- `Tomorrow` is deliberately absent for a recurring occurrence. Moving tomorrow's Gym into a
  day that already has one produces two rows for one series. For a non-recurring task,
  `Tomorrow` is a **reschedule**, not a snooze, and the client must call
  `/schedule`, not `/snooze`.

**Tests.** Integration: snoozing writes one `OCC#` item and leaves `ACT#/META.updatedAt`
unchanged; the next day's agenda shows the series time; a second snooze updates one row; an
`until` in the past `400`s; `Recurrence` is never read on the snooze path (assert with a
repository spy that no `#R` query occurs).

---

### P2-16 — Per-user reminders: items, endpoints, and the write paths

**Files.** `services/api/src/repositories/reminderRepository.ts`,
`services/api/src/services/reminderService.ts`,
`services/api/src/routes/activities.ts` (three routes),
`packages/shared/src/schemas/reminder.ts` (extend P1-06).

**What to build.** The management surface for the `REM#<userId>#<reminderId>` items P1-09
already writes at create time, and the validation that keeps them bounded.

**A reminder belongs to a person, not to a plan.** A shared plan has **one schedule and many
reminder sets**
([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)
§4.3, ADR-047). Ujjwal's "leave in 15 minutes" is about Ujjwal's journey; Alice, who lives
next door, must not receive it because he created the plan.

Three routes, all from
[`../02-architecture/api-contract.md#24a-reminders--per-user`](../02-architecture/api-contract.md#24a-reminders--per-user)
§2.4a:

| Route | Rule |
| --- | --- |
| `GET /v1/activities/:id/reminders` | The caller's own rows only. Never anyone else's, on any plan, ever. |
| `POST /v1/activities/:id/reminders` | `{ offsetMinutes }`. Any participant, **for themselves**. Max 3 per user per activity → `422`. |
| `DELETE /v1/activities/:id/reminders/:reminderId` | Only your own. Somebody else's id is `404`, never `403` — a `403` would confirm it exists. |

**The scoping is structural, not a check.** The `sk` prefix is built as
`REM#${c.get('userId')}#`, so there is no path parameter, body field or query string that
could name another user's row. A handler that took a `userId` from anywhere but the token
would be the bug; there is nowhere to take one from.

**Validation.** `offsetMinutes` is an integer in `[-10080, 0]` — up to a week before, never
after the start. `-0` means "at start time" and is stored as `0`. Duplicate offsets for the
same user on the same activity are rejected with `409`, not silently deduplicated: two
identical reminders is a mistake, and a silent drop looks like the write failed.

**Edge cases.**

- Nothing here fires anything. Local scheduling is P2-34; server-side push is Phase 5
  (P5-13, P5-14).
- An undated activity may carry reminders. They are stored and simply have nothing to
  schedule against until a date lands, at which point P5-14 picks them up. Rejecting them
  would mean the user had to remember to come back.
- Deleting an activity deletes its `REM#` rows for **every** user in the cascade (P1-14),
  which is already true because the cascade deletes the whole partition.
- The three routes are participant-accessible, unlike completion. This is the asymmetry worth
  understanding: managing your own reminder affects only you, whereas completing affects
  everyone (P2-13).

**Tests.** Integration with two invented user IDs, one owner and one seeded `PART#` row:
`GET` as user B on an activity where user A has two reminders returns an **empty array**, and
the response body contains neither A's offset nor A's reminder id; `POST` as B creates a row
under B's key and A's `GET` is unchanged; `DELETE` of A's reminder id by B returns `404` and
A's row survives; a fourth `POST` by one user returns `422` while a fourth by the *other*
user succeeds, proving the cap is per user and not per activity; `offsetMinutes: 30` is
rejected.

---

### P2-11 — `GET /v1/agenda`

**Approach.** Query parameters `from`, `to`, `tz`, `include` (comma-separated:
`anytime_unscheduled`, `overdue`). Window strictly capped at 62 days →
`400 validation_failed`. `ETag` on the response, computed from the response body hash, with
`If-None-Match` returning `304`. Response is client-cacheable for 60 s.

`warnings[]` carries `series_limit_exceeded` when the user has more than 200 active series
(a `200` with a warning, not an error) and the duplicate-occurrence warning from P2-08.

**Edge cases.** Today issues **exactly one** request:

```
GET /v1/agenda?from=<today>&to=<today>&tz=<tz>&include=anytime_unscheduled,overdue
```

Any feature requiring a second request to render Today is rejected. That is success
criterion S2 and it is asserted by a Playwright network-count assertion, not by review.

**Tests.** A 63-day window `400`s; a 62-day one succeeds. `If-None-Match` with the current
`ETag` returns `304` with no body. The Playwright assertion counts exactly one data request
on a cold Today open.

---

### P2-18 — Agenda client hook, query keys and cache policy

**Files.** `apps/mobile/src/features/agenda/hooks/useAgenda.ts`,
`apps/mobile/src/features/agenda/keys.ts`,
`packages/shared/src/api/` (extend the P1-20 client with `getAgenda`).

**Approach.** The data layer between `GET /v1/agenda` (P2-11) and every screen in this
phase. Feature hooks are the only place `useQuery` appears and own their query keys
([`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §2.4 layer table).

- **The client method** is typed from the shared agenda schema (P2-10's
  `packages/shared/src/schemas/agenda.ts`) and parses the response through it — the same
  schema object the Lambda validated with, never a second shape.
- **One key helper.** `agendaKey(from, to, tz, include)` in `keys.ts` is the only
  constructor of agenda query keys, used by this hook, by every `onMutate` in P2-23, and by
  invalidation in P2-24. The key includes **every** parameter that changes the response;
  omitting `include` would make Today (both tokens) and the Plans window (neither) collide
  in one cache entry, and the bug would look like phantom rows.
- **Today's call is the single request** from
  [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#1-what-today-is)
  §1: `from = to = today`, both `include` tokens, one fetch. The hook exposes the whole
  response; sectioning is `partition.ts` (P2-19). No per-section fetches, ever — that is
  success criterion S2.
- **`tz` is the profile timezone** (P2-02 case 29 —
  `../01-product/today-and-tasks.md` §6.6): read from the cached `me` query, falling back
  to the device timezone before the profile has ever loaded (decision recorded here —
  raise in PR if wrong). "Today" itself is derived in that timezone, not from
  `new Date().toDateString()`.
- **Cache policy** comes from the shared `queryClient` defaults
  ([`../02-architecture/tech-stack.md#34-offline-and-optimistic-updates`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates)):
  `staleTime` 60 s matching the API's 60 s cacheability, `networkMode: 'offlineFirst'`, a
  week of `gcTime` so a cold offline open renders last-known data. The hook adds no
  per-query overrides without a reason written here.
- **Refetch triggers**: app foreground and the local-midnight rollover — the hook re-derives
  `today` when the P2-20 ticker crosses midnight and switches to the new day's key,
  leaving yesterday's entry to garbage-collect. The one-minute ticker itself never
  refetches; UP NEXT and section movement are local recomputation (P2-19, P2-20).
- The Plans tab (P2-32) calls the same hook with a multi-day window and no
  `include=anytime_unscheduled`; there is one hook, parameterised, not two.
- `ETag`/`If-None-Match` is transport-level in the shared client, invisible here.

**Tests.** Unit: the key helper produces distinct keys for distinct `include` sets and
identical keys for identical inputs; a mounted hook for Today issues exactly one fetch
(mock transport call count); a response that fails schema parsing surfaces the query's
error state rather than partial data; crossing midnight (frozen clock advanced) re-keys to
the new date. The end-to-end single-request assertion is Playwright's, in P2-37.

---

### P2-19 — Today screen shell and the four sections

**Files.** `apps/mobile/app/(app)/(tabs)/index.tsx`,
`apps/mobile/src/features/agenda/{hooks/useAgenda.ts, components/*, model/partition.ts}`.

**Approach.** Four sections, fixed order, from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §2. A section with no
items is not rendered at all except where §2.5 says otherwise.

`model/partition.ts` is a pure function from `AgendaItem[]` + current minute to the four
section arrays, unit-tested independently of React. The client re-partitions locally on the
ticker and after every optimistic mutation; the server's partitioning is the initial paint.
The two must agree — that is what the shared sort keys buy.

ANYTIME has three groups under **one** heading with no sub-headings, in order: overdue
rolled-forward (oldest original date first), dated-but-untimed today, then undated saved
items newest-created first. Group 3 is capped at **20 rows** with a `See all (47)` footer
opening `GET /v1/activities?filter=saved`.

**Group 3 is the `#N` bucket and nothing else** — explicitly chosen, undated Task
activities. An undated Plan is in `#P` and belongs to Plans → Needs a date, regardless of
its presentation `type` or participants
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.2). The client
does not filter for this and must not try: the server never sends those rows, because the
agenda never queries that bucket (P2-08). A client-side type or participant check here would be a second
copy of `deriveGsi1Bucket` written in the wrong place.

EARLIER TODAY sorts **descending** while SCHEDULE sorts ascending, so the screen reads as a
timeline centred on now. It is capped at 10 rows with a `Show all` expander.

**Edge cases.** No user-controlled ordering. No "add to Today" action. No per-day entity. If
a proposed feature needs state that would be lost by throwing the screen away and
re-querying, it does not belong here.

**Tests.** `partition.ts` unit tests over the worked example day at 15:10, at 17:31, and at
23:59, asserting exact section membership each time. A render test asserting section order
and that an empty section is absent from the tree. A test that an undated
`{ objectKind: 'plan', type: 'event' }`, seeded alongside the fixture, renders in no section
on Today — asserted against the response, and separately by a grep test that `partition.ts`
contains no comparison against `type` or `participantCount`.

---

### P2-20 — The UP NEXT card and the ticker

**Approach.** UP NEXT is the first item in SCHEDULE order whose **effective start time** is
≥ the current local minute and whose status is not completed, skipped, cancelled, or their
occurrence variants. Untimed items are never UP NEXT; overdue rolled-forward tasks are never
UP NEXT.

It is a **duplicate render** of a row that also appears in SCHEDULE. It is not moved out.
Completing it from either place updates both.

Recomputed on a one-minute ticker and on app foreground, without a refetch. Relative time
copy: `in 20 minutes`, `in 2 hours`, `now` below 60 seconds.

**Edge cases.** The ticker must not run while the app is backgrounded — schedule it from an
`AppState` listener, not a bare `setInterval`, or iOS wakes the JS thread pointlessly. If
every timed item today is past, UP NEXT is not rendered, and there is no "you're done"
message.

**Tests.** Unit on the selector with a frozen clock at three minutes across a boundary. A
render test asserting the row appears in both UP NEXT and SCHEDULE and that completing from
one updates the other in a single render pass.

---

### P2-21 — Agenda row components and affordances by type

**Files.** `apps/mobile/src/features/agenda/components/{AgendaRow.tsx, RowLeading.tsx,
RowBadges.tsx}`, built from `packages/ui` primitives (P1-22).

**What to build.** The one row component the whole product renders agenda items with —
Today's four sections, the UP NEXT card's body (P2-20), and the Plans window (P2-32) all
use it, so there is one row component in the product.

**It renders the `AgendaItem` projection and re-derives nothing the server already
decided** (P2-10): the leading control comes from `hasCheckbox` and only from
`hasCheckbox`, the subtitle is rendered verbatim, `isPast`, `isSnoozed`, `isRecurring` and
`overdueFromDate` drive their badges. A `type === 'task'` check deciding the checkbox is
the second-implementation defect from the risk table, and the grep test below fails on it.
`type` is legitimately consulted for exactly two things the projection does not carry: the
completion **verb** labels (`Had it`, `Watched`, `Attended`, `Done` — the verb table in
[`../01-product/activities.md`](../01-product/activities.md#52-completion-verbs) §5.2) and
the per-type swipe action sets, which P2-22 owns.

**Affordances, from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#4-row-affordances-by-type)
§4:**

- `hasCheckbox: true` → a checkbox with a 44×44 pt hit target. Tapping it completes or
  un-completes, optimistically, with the undo toast (P2-23, P2-24), and **does not
  navigate**.
- `hasCheckbox: false` → a non-interactive diamond marker: not a hit target, and
  `accessibilityElementsHidden` so the screen reader never announces a control that does
  nothing (acceptance criterion 12).
- Tapping the row body opens detail and mutates nothing, on every row type — rule 6, and
  the only exception is the checkbox above.
- Tapping the time column opens the reschedule sheet (U4, P2-26). Tapping the overdue date
  chip opens it pre-set to today (P2-29).

**Row anatomy.** Time on the left (SCHEDULE/EARLIER only), leading control, title,
server-set subtitle, then trailing badges in the fixed order of §4: recurrence glyph `↻`
(accessibility label from `describeRecurrence`, P2-03), snooze glyph with the original time
de-emphasised (`6:00 PM → 8:00 PM`, §5.3), overdue date chip (P2-29), participant avatars
(max 3 + `+n`), pending-RSVP badge. The avatar and RSVP slots ship now and render empty
until Phase 6 — the projection fields already exist.

State rendering: a completed row shows its outcome verb in the trailing slot with a
struck-through or de-emphasised title (§2.4); a passed-but-unresolved row carries the
resolution prompt chip, whose behaviour is P2-28; a skipped occurrence renders only under
`Show skipped` (P2-35), de-emphasised.

**Accessibility.** A timed task row reads as three elements in the order checkbox, body,
time, with the labels from
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#62-voiceover--screen-reader-labels)
§6.2 (acceptance criterion 19). The row reflows at the largest Dynamic Type size with
nothing clipped. Swipe actions and their `accessibilityAction` mirrors are P2-22, which
wraps this component; nothing in this task attaches a gesture.

**Tests.** Component tests per
[`../04-conventions/testing.md`](../04-conventions/testing.md) §5, for every row type in
the gesture table: tap body navigates and does not mutate; checkbox mutates and does not
navigate; the marker has no role and fires nothing. The subtitle is rendered verbatim —
feed a fixture whose subtitle contradicts its `type` and assert it renders anyway, proving
no client-side re-derivation. Badge order matches §4 with all five present. A grep test
asserts the leading-control decision reads `hasCheckbox` and that no `type` comparison
feeds it, mirroring P2-19's grep in spirit. Snapshot of the snoozed time treatment.
Largest accessibility size reflow.

---

### P2-22 — Swipe actions and the gesture table

**Files.** `apps/mobile/src/features/agenda/components/SwipeableRow.tsx`.

**Approach.** Implement §3.1 of
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) exactly.
Right reveals the row's single positive action; left reveals up to three secondary actions.
Full-swipe commits only the **first** action on that side and **never** a destructive one.

Every swipe action is additionally exposed as an `accessibilityAction` on the row, so it is
reachable without swiping. Nothing important is behind a gesture alone.

Built on `react-native-gesture-handler` + `react-native-reanimated` so the gesture runs on
the UI thread — the `Animated` API drops frames during list scrolling, which is exactly when
swipe actions fire.

**Edge cases.** On web, swipes are replaced by a hover-revealed trailing action button and a
hover-revealed `⋯`, both keyboard-reachable (§7.1). Hover-revealed controls are never the
only path to an action. Reduce Motion: the row still tracks the finger (direct
manipulation) but does not spring.

**Tests.** Unit per row type asserting the exact action set from the table. An accessibility
test asserting every swipe action has a matching `accessibilityAction` with the same label.
Playwright on web asserting the hover affordances and their keyboard equivalents.

---

### P2-23 — Optimistic mutation model functions

**Files.** `apps/mobile/src/features/agenda/model/{applyCompletion,applySkip,applySnooze,
applyReschedule}.ts`.

**Approach.** Pure functions from a cached agenda response plus a mutation variable to the
next agenda response. They are what the `onMutate` handlers call, following the uniform
pattern in
[`../02-architecture/tech-stack.md#34-offline-and-optimistic-updates`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates).

They must produce **exactly** what the server will return, or the row visibly flips back a
second later. That is why they are pure and separately tested: the test asserts the
optimistic projection equals a real server response for the same mutation, using fixtures
captured from the integration tests.

Optimistic mutations in this phase: task completion, occurrence complete/skip/snooze, and
reschedule.

**Tests.** For each function: a golden test comparing its output to a recorded server
response for the same input. Property test: applying and then reversing a mutation returns
the original object deep-equal.

---

### P2-24 — The undo toast system

**Files.** `apps/mobile/src/features/undo/**`, `packages/ui/src/Toast.tsx`.

**Approach.** The model in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §4:
reversible actions happen immediately with a **6-second** undo toast and no confirmation;
irreversible ones get a confirmation dialog and no undo; bulk reversible ones get 10
seconds.

The critical rule: **the network call fires immediately, not at the end of the window.**
Undo is a compensating call, not a delayed commit. This keeps the app correct when it is
closed mid-window. One toast at a time; a new action replaces the visible toast and commits
the previous one.

Toasts announce with `accessibilityLiveRegion="polite"`, the `Undo` button is focusable and
is inserted into the tab order immediately after the focused element for the window's
duration.

**Edge cases.** If the original call failed, the row reverts and the toast becomes an error
toast with `Retry` instead of `Undo`. Undo works offline — it is a local compensation plus a
queued call.

**Tests.** Unit: a second action commits the first; dismissing commits; undo restores sort
position and scroll offset; a failed original produces a `Retry` toast. Playwright: complete
a task, press `Cmd+Z`, assert the row returns to its exact prior position.

---

### P2-25 — The snooze sheet

**Files.** `apps/mobile/src/features/agenda/components/SnoozeSheet.tsx`.

**Approach.** Implement the table in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#53-snooze) §5.3
exactly. The sheet's option set depends on what was swiped, and one of the options is
secretly a different endpoint:

| Context | Options | Dispatch |
| --- | --- | --- |
| Non-recurring task, today, timed | `15 minutes`, `1 hour`, `3 hours`, `This evening (6 PM)`, `Tomorrow`, `Pick a time` | All but `Tomorrow` → `POST /v1/activities/:id/snooze` with `until` as `HH:mm`. **`Tomorrow` → `POST /v1/activities/:id/schedule`** with tomorrow's date and the same time — moving a one-off task to another day *is* a reschedule (P2-12), and routing it through snooze would be the wrong write. |
| Recurring occurrence | The same **minus `Tomorrow`** | Always `POST .../snooze` with `{ occurrenceDate, until }`. The absent option is deliberate (§5.3's decision): tomorrow already has its own occurrence. |
| Undated or all-day task | The sheet is never opened — the swipe action is not offered (P2-22). There is no time to move. | — |

- Relative options compute from the current minute. An option that would land in the past
  — `This evening (6 PM)` opened at 7 PM — is not shown, because the server rejects an
  `until` earlier than now with `validation_failed` and offering it would manufacture the
  error (decision recorded here — raise in PR if wrong).
- `Pick a time` opens the standard time picker in 5-minute increments
  ([`../01-product/activities.md`](../01-product/activities.md#3-progressive-creation-forms--shared-rules)
  §3.4), same-day only; a picked past time shows the inline error, mirroring the server
  rule rather than duplicating it in a second shape.
- The result is optimistic through `applySnooze` (P2-23) with the 6-second undo toast
  (P2-24); undo deletes the snooze via the compensating call, restoring the original time
  (§5.3 `Undo snooze`). The row re-sorts to its new effective time with the snooze glyph
  and `6:00 PM → 8:00 PM` treatment (P2-21).
- Snooze is repeatable: opening the sheet on an already-snoozed item snoozes from now and
  overwrites `snoozedUntil` (P2-15).
- Entry points: partial left swipe → `Snooze`, full left swipe → this sheet (gesture
  table §3.1). Options are buttons whose accessibility labels name the resulting time
  (`Snooze until 8:00 PM`), not just the offset.
- Never rendered for a shared plan the user does not own — snooze is owner-only (P2-15)
  and the swipe that opens it is already absent
  ([`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#31-today-and-agenda-rows)
  §3.1).

**Tests.** Unit: the option set for each of the three contexts matches the table;
`Tomorrow` dispatches `/schedule` with tomorrow's date and the unchanged time, never
`/snooze` (spy on the client); the recurring dispatch always carries `occurrenceDate`; at
19:00 the evening option is absent; each fixed option computes the correct `until` from a
frozen clock. Component: options are announced with their resulting time. The storage-side
guarantees are P2-15's integration tests, not repeated here.

---

### P2-26 — The reschedule sheet

**Approach.** Opened by tapping a date or time **anywhere** it is rendered (U4). It never
edits in place on a row.

For a **recurring series** it presents a two-option sheet: `This occurrence only` /
`All future occurrences`. The first writes an `Occurrence` with `status: 'rescheduled'` and
`overrideTime` — plus `overrideDate` when the user moved it to a different day, which a
this-occurrence reschedule may do (P2-12, data-model §4.5). The second **appends a rule segment** to `recurrence` with
`effectiveFrom` = the edited occurrence's date — or today, when the sheet was opened from
the series' detail screen outside any occurrence context — carrying the new time as its
`time` snapshot; `schedule.time` mirrors the new active segment. Past segments and past
occurrences are untouched, and at the 20-segment cap the write returns `validation_failed`
and the sheet explains it and suggests ending the series
([`../01-product/activities.md`](../01-product/activities.md#62-editing-schedule) §6.2,
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series)
§6.2). There is no "all occurrences including past" option.

Clearing the date on an activity with participants warns that it comes off everyone's day and
returns to Plans → Needs a date, with the `Keeps:` line naming the plan, everyone on it, and
their replies — which are **not** reset. The copy is
[`../01-product/activities.md`](../01-product/activities.md#62-editing-schedule) §6.2 and
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a1-additive-changes-happen-immediately-destructive-changes-explain-what-will-be-lost)
§1a.1. (Phase 6 makes this reachable; build the branch now.)

**Tests.** Integration: `This occurrence only` writes one `OCC#` row and leaves the series
untouched; `All future occurrences` appends exactly one segment, leaves every earlier
segment byte-identical and leaves existing occurrence overrides intact; the 21st-segment
attempt surfaces the explanatory sheet, not a raw error.

---

### P2-27 — The repeat sheet

**Files.** `apps/mobile/src/features/activities/components/RepeatSheet.tsx` — it is a
creation-form control (`../01-product/activities.md` §3.4) as much as an agenda one, so it
does not live under `features/agenda`.

**Approach.** The options list in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#61-the-options-list)
§6.1, exactly: Never, Daily, Weekdays, Weekly, Monthly, Yearly, Every X days (stepper,
2–365), Selected weekdays (seven toggles, at least one on). `Custom` is not shown until
Phase 9, and there is no mode control — `mode` is `'fixed'` (§6.7). Every option exposes
**Ends**: `Never` / `On a date` (`recurrence.endDate`) / `After N times`
(`recurrence.count`, 1–999). Ends belongs to the series and closes the whole series,
however many segments it has.

- **The sheet writes one rule segment's fields**, validated by the same Zod schema the
  server uses (P2-04) — imported, never redefined. It always writes explicit anchors:
  `byWeekday` from the anchor date's weekday for Weekly, `byMonthDay` for Monthly,
  `byMonth` **and** `byMonthDay` for Yearly. The anchor date is the segment's
  `effectiveFrom` — `schedule.date` for a new series' first segment. The sheet never
  writes the anchorless fallback shape.
- **On an existing series the sheet shows and edits the active (last) segment only.**
  Earlier segments are history with no UI (§6.1). A rule change is an "all future" edit:
  the client sends the full new `recurrence` value on the ordinary `PATCH`, equal to the
  stored one plus one appended segment whose `effectiveFrom` is the edited occurrence's
  date — or today, from the series detail outside any occurrence context — and the server
  enforces the append-only property (P2-04) (decision recorded here — raise in PR if
  wrong: the alternative is a server-side append taking only the new rule).
- **The 21st segment**: the server returns `validation_failed`; the sheet explains it and
  suggests ending the series and starting a new one (§6.2), rather than surfacing a raw
  error string.
- **`Never` removes `recurrence`** (§6.1), which moves the bucket `R → S` (P2-05
  transition 24). On a series with stored past completions this also stops those
  `OCC#` rows rendering anywhere, so the sheet shows the §1a.1-shape confirmation naming
  their real count — the same count and copy source as `Delete whole series`
  ([`../01-product/activities.md`](../01-product/activities.md#64-deleting) §6.4) — and
  points at `End series` as the history-keeping alternative (decided 2026-08-07 —
  `today-and-tasks.md` §6.1 now states the same `Never` guard).
- Repeat is only enabled when a date is set (§3.4 of `activities.md`); the sheet is never
  reachable without one, and the server rejects the combination anyway (P2-04).
- `Every X days` with X = 1 is normalised to Daily at the schema layer (P2-04); the
  stepper simply starts at 2.
- The summary row and the collapsed field value both come from `describeRecurrence`
  (P2-03), so the sheet and the form can never disagree about what was chosen.

**Tests.** Unit: one case per option asserting the exact segment fields written, matching
§6.1's table (including the anchors); Selected weekdays with zero toggles disables the
commit; each Ends variant lands on the series level, not the segment. Component: opened on
a two-segment series, the sheet renders the active segment's values and nothing from the
first; the 21-segment `validation_failed` renders the explanatory state with an
`End series` path; `Never` on a series with seeded completions shows the confirmation with
the real count, and on a never-completed series applies immediately. Integration for the
append itself is P2-26's and P2-04's.

---

### P2-28 — Passed-plan resolution prompts

**Approach.** An item in EARLIER TODAY still in `scheduled` shows one inline prompt in its
trailing slot — a **question**, not a warning, with no badge, no colour alarm and no count.
Copy per type from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §8.2: `Done?` for
task and custom, `How did it go?` for the rest, with the two options each maps to.

The same prompt appears at the top of the item's detail screen.

**The three hard rules a reviewer checks, all testable:**

1. There is **no** unresolved-items count, badge or nag anywhere in the app.
2. There is **no** notification asking the user to resolve a passed plan.
3. An unresolved passed item **never** reappears on a later day.

Unresolved items are never auto-completed and never auto-skipped. The app does not decide on
the user's behalf whether something happened.

**Tests.** A test that greps the client for a badge component bound to any unresolved count
and fails on a hit. Integration: an unresolved item from yesterday does not appear in
today's agenda response. Playwright: ignore a prompt, advance the fixture clock a day,
assert the row is absent and carries no styling implying fault in Plans.

---

### P2-29 — Overdue rows: date chip, cap and collapse

**Files.** `apps/mobile/src/features/agenda/components/{OverdueChip.tsx,
OverdueCollapse.tsx}`, `apps/mobile/src/features/agenda/model/formatOverdueChip.ts`.

**Approach.** The client half of the overdue rule — P2-09 supplies the data and mutates
nothing; this task renders it per
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#7-overdue-tasks) §7.

- Rolled-forward rows are ANYTIME group 1, oldest `overdueFromDate` first — the ordering
  is `partition.ts`'s (P2-19); this task renders what it is given.
- **The date chip** shows the shortest unambiguous form of the original date (§7.2):
  `Yesterday`; a weekday name for the last 6 days (`Tue`); otherwise `4 Aug`. The 30-day
  window means a year is never needed. It uses the app's de-emphasis colour, never red —
  overdue is information, not an alarm, and there is no badge and no count anywhere else.
  `formatOverdueChip(overdueFromDate, today)` is a pure function, exported and tested on
  its own.
- **Cap and collapse** (§7.4): when more than 5 tasks roll forward, the first 3 render and
  the rest collapse behind a `+n more overdue` row — `n` = total − 3 — that expands **in
  place**, with no navigation and no new fetch (acceptance criterion 11: six overdue means
  three rows plus `+3 more overdue`).
- **Chip tap** opens the reschedule sheet pre-set to today (§7.6) — the one-tap "yes, do
  it today" path, which the app never takes automatically. The `Do today` swipe action
  (gesture table) commits `POST .../schedule` with today's date directly (P2-12, P2-22).
- Overdue rows are never UP NEXT (§2.1 — they have no clock time today).
- Completing a rolled-forward row completes the **original** activity: the optimistic
  model (P2-23) removes it from ANYTIME, and it does not join EARLIER TODAY — that section
  holds items *timed today* (§2.4), and this item's honest home is its own past date in
  Plans (decision recorded here — raise in PR if wrong).
- Accessibility: the chip's accessibility label is the full form — `Overdue from Tuesday
  4 August` — never the abbreviation; the collapse row announces the hidden count and its
  expanded/collapsed state.

**Tests.** Unit on `formatOverdueChip` with a frozen `today`: yesterday, each of the six
weekday-name days, the seventh day back (`30 Jul` form), and the 30-day boundary value.
Render: six overdue fixtures produce three rows plus `+3 more overdue`; expanding renders
all six in place with no navigation event and no refetch (mock transport call count
unchanged); chip tap opens the reschedule sheet pre-set to today; the chip carries the
de-emphasis token, asserted against the design-system token rather than a hex literal.
Completing a rolled-forward row removes it from ANYTIME without inserting it into EARLIER
TODAY. The no-mutation and 30-day-window guarantees are P2-09's integration tests.

---

### P2-32 — The Plans tab: date-range agenda

**Approach.** The same `GET /v1/agenda` the Today screen uses, with a wider window and
**without** `include=anytime_unscheduled`. Items are grouped under date headings and rendered
with the row components from P2-21, so there is one row component in the product.

This is the Plans tab's Phase 2 form and it is deliberately partial: it is the **Upcoming**
stage only. The three-stage screen — Needs a date, Upcoming, Past — arrives in Phase 3 with
`GET /v1/plans` (`phase-03-plans-and-lists.md` P3-20, P3-35), because Needs a date needs the
`#P` bucket's RSVP summary and its `lastActivityAt` ordering, neither of which the agenda
endpoint carries.

**Edge cases.** No badge and no count on the tab, in this phase or any later one. A recurring
series contributes one row per date in the window, which is what makes a multi-day window read
correctly. That is a **recurring series expanded across days**, not one activity occupying
several — `schedule` has no `endDate` (ADR-050), so a three-day trip appears on its start
date only, here and on Today.

**Tests.** A network assertion that the Plans request omits `include=anytime_unscheduled`; a
render test over a seven-day fixture asserting one row per series per date; a test that an
undated shared plan appears nowhere on this screen in Phase 2, since the endpoint that
surfaces it does not exist yet.

---

### P2-33 — Persisted query cache and the offline mutation queue

**Files.** `apps/mobile/src/lib/queryClient.ts`,
`apps/mobile/src/lib/persister.ts`,
`apps/mobile/src/lib/onlineManager.ts`.

**Approach.** The three mechanisms in
[`../02-architecture/tech-stack.md#34-offline-and-optimistic-updates`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates):
a persisted query cache via `@tanstack/query-async-storage-persister`; optimistic updates
(P2-23); and a persisted mutation cache resumed with `resumePausedMutations()` on reconnect,
driven by `@react-native-community/netinfo`.

Every creating `POST` carries an `Idempotency-Key` generated once at `onMutate` and reused
on every retry. That is why the server's idempotency records exist.

**Platform difference, deliberate:** the mutation queue is **iOS only**. On web the
persisted cache is enabled but the queue is disabled and the app warns on unload if the
in-memory queue is non-empty. A browser tab is usually closed, not backgrounded; queued
mutations that never flush are worse than an error toast.

**Scope guard.** No SQLite mirror, no CRDT, no local recurrence expansion. Offline means
"read what you had, queue what you did", not "work indefinitely disconnected". The agenda is
a server-computed projection; reimplementing expansion against a local store would duplicate
the hardest logic in the product in a second place that can disagree with the first.

**Edge cases.** Queue cap of 200 pending mutations, then new writes are refused with
`You're offline and there's a lot waiting to sync.` A queued write returning `409` surfaces
one banner naming the affected changes, not one toast per change.

**Tests.** Maestro: airplane mode on, complete three tasks, kill the app, relaunch, airplane
mode off, assert all three land exactly once (verified by item count, since the idempotency
key should make a duplicate impossible even if the queue double-fires).

---

### P2-34 — Local notifications on device

**Files.** `apps/mobile/src/features/reminders/localSchedule.ts`.

**Approach.** Push is Phase 5. This phase schedules **local** notifications with
`expo-notifications` for reminders on activities in the current and next day, so reminders
work end to end on device before any server-side scheduling exists.

Rescheduled on every agenda refresh: cancel all previously scheduled local notifications
owned by the app and re-schedule from the current agenda. That is simpler and more correct
than tracking deltas, and the volume is tiny.

**The device only ever sees its own user's reminders**, because that is all the API returns
(P2-16, P1-10 rule 6). There is therefore no filtering to do here and none to write — if this
module ever needs a `userId` comparison, something upstream has leaked and the fix is
upstream. On a shared plan the correct result is that two people's phones buzz at two
different times for one dinner, and neither device knows the other's offset.

**Edge cases.**

- The permission prompt is **not** requested here. Permission timing is
  [`../01-product/notifications.md`](../01-product/notifications.md) §6.1 and belongs to
  Phase 5 with the pre-prompt sheet. In Phase 2, if permission has not been granted, local
  scheduling silently no-ops and the reminder controls stay usable.
- Untimed items fire at the profile's all-day reminder hour, default 09:00 local.
- A reminder whose fire time is already past is dropped silently.
- Web is a no-op (`push.web.ts`).

**Tests.** Unit on the schedule-computation function (offset arithmetic, all-day hour, past
reminders dropped) with the `expo-notifications` API mocked. Manual verification on a
simulator with the clock advanced.

---

### P2-36 — Worked-example-day integration fixture and test

**Files.** `services/api/test/fixtures/workedExampleDay.ts`,
`services/api/test/integration/agenda.workedExample.test.ts`,
`packages/shared/src/fixtures/workedExampleDay.response.json` (the captured response).

**What to build.** The worked example day in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#9-worked-example-day)
§9 as an executable fixture, and the integration test that pins acceptance criterion 7.
This is the one test that exercises the whole pipeline — buckets, expansion, overrides,
overdue roll-forward, projection, partitioning — against a scene a human can check by eye
against the spec.

**Approach.**

- **Seed through the real write paths**, not raw `PutItem`: activities A–I from §9.1 are
  created via the repositories and services under test (builder functions per
  [`../04-conventions/testing.md`](../04-conventions/testing.md) §8.1 — no shared mutable
  fixture objects), so the index entries and buckets in play were produced by the code
  being tested, not hand-crafted to look right. Series D is one segment — weekdays, 18:00,
  `effectiveFrom` 2026-01-05 — with no occurrence row for 6 August.
- **Frozen clock**: Thursday 6 August 2026, 15:10 `America/New_York`, via the injected
  clock, never real time.
- **The single request from §9.2**, both `include` tokens. Assert:
  - the exact section membership and order of all nine rows per §9.3/§9.4 — `upNext` is
    Pick up groceries; `schedule` is C, D, E, F ascending; `anytime` is H (with
    `overdueFromDate: '2026-08-04'`), then G, then I (subtitle `New York Trip`);
    `earlier` is B then A, descending;
  - projection fields per row: `hasCheckbox` true only for C, D, G, H, I; the subtitles
    from §4's table; D carries `isRecurring: true` and `occurrenceDate: '2026-08-06'`;
    H's stored `schedule.date` is still `2026-08-04` after the response is produced;
  - an `ETag` is present, and repeating the request with `If-None-Match` returns `304`.
- **Then the §9.5 mutations**, in sequence on the same seeded state: completing D's
  occurrence writes exactly one `OCC#2026-08-06` item, leaves `META.updatedAt`
  byte-identical, and Friday's agenda still emits Gym at 18:00 (criterion 4); `Attended`
  on B writes `outcome: 'attended'`, `status: 'completed'`; the next day's request no
  longer contains B and carries no prompt-driving state for it (criterion 17's server
  half).
- **A segment coda**, because this fixture is the phase's one end-to-end segment check:
  append a second segment to D (Tue/Thu, 07:00, `effectiveFrom` 2026-08-10) through the
  real `PATCH` path, then assert a 3–14 August window emits weekdays at 18:00 through
  Friday the 7th and Tue/Thu at 07:00 from the 10th, and that the completed
  `OCC#2026-08-06` from the earlier step still renders at 18:00 — history under the rule
  in force at the time.
- **The captured response JSON is committed** and is the same fixture `partition.ts`
  (P2-19) and the optimistic-model golden tests (P2-23) consume. One fixture, three
  consumers — that is what makes server and client ordering provably agree (risk table,
  "Section sort order drifts").

**Tests.** This task **is** the test; its deliverable is the passing suite plus the
committed response fixture. It runs in `pnpm test:integration` against DynamoDB Local in
CI.

---

### P2-37 — E2E: Today flows on web and iOS

**Files.** Web: `e2e/specs/{complete-undo.spec.ts, reschedule.spec.ts,
a11y-keyboard.spec.ts}`. iOS: `apps/mobile/e2e/{add-and-complete.yaml,
snooze-occurrence.yaml, up-next-ticker.yaml}`.

**What to build.** The Today-owning subset of the fixed E2E catalogue in
[`../04-conventions/testing.md`](../04-conventions/testing.md#6-end-to-end) §6 — no flows
beyond the catalogue; E2E proves wiring, and the layers below already prove behaviour.

**Web, Playwright** (§6.1's rules: wait on a role or a network response, never
`waitForTimeout`; each spec creates its own user via a fixture and deletes it in teardown;
never the seed data):

- `complete-undo.spec.ts` — create a task through the UI, complete it from the checkbox,
  assert the network call fired **before** the toast appeared (network log — criterion
  14), then `Cmd+Z`, assert the compensating call and that the row returns to its exact
  prior position. This spec's cold open also carries the **network-count assertion**:
  exactly one data request renders Today (success criterion S2, criterion 6). It lives
  here rather than in a ninth spec because the catalogue is closed (decision recorded here
  — raise in PR if wrong).
- `reschedule.spec.ts` — tap the time column (U4), move the task to a new time through the
  sheet, assert the row re-sorts and the server state changed. Includes P2-28's flow:
  ignore a passed item's prompt, advance the fixture clock a day, assert the row is absent
  from Today and carries no fault styling in Plans.
- `a11y-keyboard.spec.ts` — a keyboard-only pass over Today per
  [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#7-web-equivalents)
  §7.2/§7.3: `T` to Today, arrows move row focus, `Space` toggles the focused task,
  `Return` opens detail, and every hover-revealed control from P2-22's web equivalents is
  reachable by keyboard.

**iOS, Maestro** (§6.2; flows assert on the accessibility labels from
`interaction-contract.md` §6.2, so a broken flow usually means a regressed label):

- `add-and-complete.yaml` — Today's contextual `+ Add a task`, type a title, `Save task`,
  complete it from the checkbox.
- `snooze-occurrence.yaml` — swipe a recurring occurrence, snooze it, then confirm the
  series is unchanged: the series detail still shows the original time and the next day
  still lists the occurrence at the series time.
- `up-next-ticker.yaml` — background the app, advance past the next item's time, return,
  and confirm UP NEXT advanced without a refetch (the foreground recompute, criterion 8's
  device-side cousin).

CI wiring per §6.2: Playwright gates the PR (retries: 1 in CI, and a pass-on-retry is
still flagged); Maestro runs in `mobile.yml` on `workflow_dispatch` and tags and gates the
TestFlight submission, not the merge.

**Tests.** This task is tests. Its own acceptance is that criteria 6, 13, 14 and 19's
end-to-end halves are asserted by these files and fail when deliberately broken (comment
out the undo handler locally; the suite must catch it).

## Acceptance criteria

1. `expandRecurrence` passes all 43 matrix cases in P2-02 plus 1,000 property-based cases,
   at **100% statement and branch coverage**, and CI fails if coverage drops below it.
2. A daily 18:00 task in `America/New_York` expanded across 7–9 March 2026 yields three
   dates whose derived UTC instants are 23:00Z, 23:00Z and 22:00Z — the wall clock is
   constant and the instant shifts.
3. A monthly series on `byMonthDay: [31]` expanded over January–June 2026 yields 31 Jan,
   28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun. A yearly series anchored on 29 February 2028
   expanded over 2028–2032 yields 29 Feb 2028, 28 Feb 2029, 28 Feb 2030, 28 Feb 2031 and
   29 Feb 2032, and its stored anchors and segment `effectiveFrom` are unchanged.
4. `POST /v1/activities/:id/complete { occurrenceDate }` writes exactly one item and leaves
   `ACT#<id>/META.updatedAt` byte-identical, verified by reading the item before and after.
   Tomorrow's agenda still shows the series at its normal time.
5. Snoozing today's occurrence to 20:00 shows it at 20:00 today and at the series time
   tomorrow, and no query against the `#R` bucket occurs on the snooze path.
6. A cold open of Today issues **exactly one** data request, asserted by a Playwright
   network-count assertion (success criterion S2).
7. Loading the worked example day from
   [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §9 as a fixture at
   local time 15:10 produces the exact screen in §9.3: the same nine rows, in the same
   sections, in the same order, with the same badges.
8. At 17:30 on that fixture, without a refetch, `Pick up groceries` moves to EARLIER TODAY
   and UP NEXT becomes `Gym` at 6:00 PM.
9. A task dated 4 August appears on 6 August in ANYTIME with a `Tue` chip, and its stored
   `schedule.date` is still `2026-08-04` after it is rendered and after it is completed.
10. A task dated 40 days ago does not roll forward. An event dated yesterday does not roll
    forward. A missed recurring occurrence does not roll forward.
11. Six or more overdue tasks render as three rows plus a `+n more overdue` expander, and no
    badge or count appears anywhere else in the app.
12. Only `task` rows have a checkbox. Tapping a `meal`, `watch`, `event` or
    `custom` row's leading marker does nothing and the marker is hidden from the screen
    reader.
13. Tapping the body of any row opens detail and mutates nothing, on every row type, on both
    platforms.
14. Completing a task shows a 6-second undo toast; the network call has already fired when
    the toast appears (asserted by a network log); undo issues the compensating call and
    restores the exact prior sort position.
15. With the device offline, completing three tasks, killing the app and relaunching online
    results in exactly three server-side completions and no duplicates.
16. A 63-day agenda window returns `400 validation_failed`; a 62-day one returns `200`.
17. An unresolved passed item shows its type's prompt today, and does not appear on Today
    tomorrow, carries no prompt in Plans, and is counted nowhere.
18. A local notification fires on the simulator at the configured offset for a timed task
    and at 09:00 for an untimed one.
19. VoiceOver reads a timed task row as three elements in the order checkbox, body, time,
    with the labels in
    [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2,
    and every swipe action is available as a rotor action.
20. The Plans tab renders a multi-day window from the same endpoint with one row per series
    per date, and does **not** send `include=anytime_unscheduled`. A non-recurring activity
    appears on exactly one date in that window, however many days it lasts in real life.
21. `deriveGsi1Bucket` passes all 25 matrix cases in P2-05 at 100% branch coverage, and is
    called from exactly one place in the codebase — asserted by a grep test that finds one
    caller and no second implementation of the rule.
22. An undated `{ objectKind: 'plan', type: 'event' }` has a `U#<u>#P` index entry, appears
    in **no** section of any agenda response with any combination of `include` tokens, and no
    query against `U#<u>#P` occurs on any agenda path. Changing its presentation type leaves
    it in `#P`.
23. An undated `{ objectKind: 'task', type: 'task' }` has a `U#<u>#N` index entry and appears
    in Today's ANYTIME section. Changing title text or presentation fields leaves it there;
    only an explicit `objectKind` change can move an undated Activity between `#N` and `#P`.
24. Giving the Plan in criterion 22 a date moves its index entry to `U#<u>#S`; clearing the
    date returns it to `U#<u>#P`, not to `#N`.
25. Bumping `lastActivityAt` leaves `updatedAt` byte-identical, and a `PATCH` carrying the
    `If-Match` captured before the bump returns `200`, not `409`. Editing the title moves
    `updatedAt` and leaves `lastActivityAt` unchanged.
26. A caller identified as a **participant** on a seeded shared plan receives `403` from
    `complete`, `uncomplete`, `skip` and `snooze`, and the `ACT#<id>` partition has the same
    item count and the same `META.updatedAt` after the attempt as before it. A stranger
    receives `404` from the same four. On a **prep task** of that plan, which they did not
    create, the same participant receives `200` from `complete` and `uncomplete`, and a
    stranger to the parent receives `404`.
27. `GET /v1/activities/:id/reminders` as user B, on an activity carrying two of user A's
    reminders, returns `[]`, and neither A's `offsetMinutes` nor A's reminder id appears
    anywhere in the serialised response. `POST`ing a fourth reminder as one user returns
    `422` while a fourth as the other user returns `201`.
28. Today's `+ Add a task` opens the Task form directly, the final action reads `Save task`,
    and the request contains `type: 'task'`. The same title entered through global
    `+` → `Plan` → `General` remains a `custom` Plan, proving the words do not route it.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| `freq: 'custom'` / RFC 5545 `rrule` | Phase 9 |
| `mode: 'after_completion'` recurrence | Phase 9 |
| Server-side reminder scheduling, EventBridge Scheduler, the reminder Lambda, push delivery | Phase 5 |
| The notification permission prompt and pre-prompt sheet | Phase 5 |
| Lists, the optional list ↔ activity bridge, prep-task UI inside a plan, watchlist progress | Phase 3 |
| Attachments and image upload | Phase 3 |
| `GET /v1/plans`, the three-stage Plans screen, the Needs-a-date row and its RSVP summary | Phase 3 (P3-20, P3-35) |
| Writers for `lastActivityAt`: the updates feed (Phase 3), RSVP (Phase 6), expenses (Phase 7). The field, the sort key and the helper ship here; the callers do not. | Phases 3, 6, 7 |
| Participants, RSVP badges on rows (the projection field exists; it renders empty) | Phase 6 |
| Expenses | Phase 7 |
| Capture beyond the existing `501` stubs | Phase 8 |
| The maintenance job that drops undated terminal items out of GSI1 after 60 days (past `#S` items are exempt — Plans → Past is permanent) | Phase 9 (P9-33) |
| Web push, service worker | Not in v1 |
| A local-first replica, SQLite mirror, or client-side recurrence expansion | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **The recurrence engine is subtly wrong** and nobody notices for weeks | A user reports "my gym disappeared in March" or "the 31st skipped February" | P2-01 is built first and alone; P2-02's 43-case matrix plus property tests plus an independent cross-check implementation; 100% branch coverage gated in CI; golden fixtures so a refactor fails loudly. |
| DST handled by adding milliseconds | Everything is right for ten months a year | Calendar arithmetic only, in `calendar.ts`; cases 15–19 include both hemispheres and a half-hour zone. A `+ 86400000` anywhere in `recurrence/` is a review rejection. |
| Snooze or complete writes `ACT#/META` | The visible result looks correct; the series' `updatedAt` churns and Phase 6's conflict detection starts firing spuriously | Success criterion S6, asserted by reading the item before and after; a repository spy asserting no `#R` query on the snooze path. |
| **The bucket rule is re-derived in a second place** — a client-side `type === 'task'` check, a service that builds an index entry by hand, or a filter in the agenda | An undated Plan appears on Today, or a Task vanishes from ANYTIME, and the two implementations disagree only for some inputs | One pure function (P2-05), one caller, a grep test asserting both. The agenda excludes `#P` by not querying it rather than by filtering it, so there is no filter to drop. |
| A write path changes `objectKind`, date or recurrence and forgets to rewrite the index entry | The activity is in the wrong tab and the stored row looks entirely correct | The three inputs are named in P2-05 and the rewrite happens in the same transaction as the write. Transitions 13–25 are tests, and the integration tests assert exactly one index entry after each. |
| **`lastActivityAt` is folded back into `updatedAt`** "because two timestamps is redundant" | An owner editing a plan gets a `409` because somebody RSVP'd, and the fix looks like it needs a merge engine | Acceptance criterion 25 fails immediately. The reason the fields are separate is in `data-model.md` §3.5 and is restated in P2-06. |
| A second request creeps into Today's cold open | Nobody notices until Today is slow on 4G | The Playwright network-count assertion is a gating acceptance criterion, not a review item. |
| The client's optimistic projection disagrees with the server | Rows visibly flip back a second after a tap | P2-23's golden tests compare the pure function's output to recorded server responses. |
| Overdue roll-forward mutates the activity | Plans shows the task on the wrong date; "Today owns no data" quietly stops being true | Roll-forward is a query rule with an explicit acceptance criterion asserting the stored date is unchanged after render **and** after completion. |
| The ticker runs while backgrounded | Battery complaints in TestFlight | Drive it from an `AppState` listener, not a bare interval. |
| Section sort order drifts between server and client | Rows reorder on refresh | Both use the sort keys in `today-and-tasks.md` §3.1, and `partition.ts` is tested against the same fixture the server integration test uses. |
| A badge or count for unresolved items is added "because it's useful" | The product becomes a nag | Acceptance criterion 11 plus a test that fails on a badge bound to an unresolved count. |
| The 62-day cap is enforced only on the client | A wide window times out the Lambda | Enforced server-side in the route validator and tested at 62 and 63. |
| **Per-participant completion is built by accident**, because "a participant should be able to tick their own row" reads as obviously right | An `OCC#<date>#<userId>` key, or an `attendedBy` array, appears in a Phase 2 pull request. In Phase 6 the agenda cannot say whose occurrence a row is | Completion of a **plan** is global and owner-only (ADR-048, amended by ADR-051). `Occurrence` has no user field and the endpoints are owner-gated in `authz.ts`, with criterion 26 asserting the `403` and asserting **nothing was written**. The prep-task branch is the parent-participant rule, not a per-participant occurrence. The real feature and its five-part cost are deferred in `../00-open-decisions.md` item 31. |
| **Reminders are scoped by a filter rather than by the key** | It works until one handler forgets, and the thing that leaks is a statement about somebody's day | The `sk` prefix is built from `c.get('userId')` (P2-16), so there is no id to get wrong. The only place a filter is needed is the plan-detail projection, which is one function with one test (P1-10 rule 6, criterion 24 of Phase 1). |
