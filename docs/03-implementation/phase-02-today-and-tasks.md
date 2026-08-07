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
looking like unfinished work. This is the phase where the product becomes usable daily.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phase 1 complete and its acceptance criteria passing | In particular the repository layer, the GSI1 bucket rules, and `packages/ui`. |
| 2 | [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) read in full | It is the specification for this phase, including the worked example day in §9 which doubles as a fixture. |
| 3 | [`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm) read | The six-step algorithm is normative. |
| 4 | Coverage gate at 100% on `packages/shared/src/recurrence/**` already configured | Set up in P0-26 precisely so it is live before the first line of engine code exists. |

## Deliverables

- [ ] `expandRecurrence(rec, from, to, tz)` — pure, no I/O, 100% statement and branch
      coverage, passing the full test matrix in P2-02.
- [ ] `describeRecurrence(rec)` producing the UI's label (`Every weekday`, `Monthly on the
      6th`, `Every 3 days until 12 Dec`).
- [ ] `GET /v1/agenda` with `?from`, `?to`, `?tz`, and the `include` tokens
      `anytime_unscheduled` and `overdue`; window capped at 62 days; `ETag`; `warnings[]`.
- [ ] `AgendaItem` projection with server-set `hasCheckbox`, `subtitle`, `isPast`,
      `occurrenceDate` and `overdueFromDate`.
- [ ] `complete`, `uncomplete`, `skip`, `snooze`, `schedule` endpoints, with occurrence
      scoping that provably never writes `ACT#/META`.
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
- [ ] Local notifications scheduled on device for reminders on the current and next day.
- [ ] The Plans tab rendering a date range from the same endpoint.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P2-01 | The recurrence engine `expandRecurrence` | shared | — | no | L |
| P2-02 | The recurrence test matrix | shared | P2-01 | no | L |
| P2-03 | `describeRecurrence` for the UI | shared | P2-01 | yes | M |
| P2-04 | `Recurrence` Zod schema and server-side validation | shared | P1-09 | yes | M |
| P2-05 | `OccurrenceRepository` | api | P1-08 | yes | M |
| P2-06 | Agenda service: query, expand, merge, project | api | P2-01, P2-05, P1-12 | no | L |
| P2-07 | Overdue roll-forward query rule | api | P2-06 | no | M |
| P2-08 | `AgendaItem` projection: subtitle, checkbox, isPast | api | P2-06 | no | M |
| P2-09 | `GET /v1/agenda` route, window cap, `ETag`, warnings | api | P2-06, P2-07, P2-08 | no | M |
| P2-10 | `POST /v1/activities/:id/schedule` and unschedule | api | P1-13 | yes | M |
| P2-11 | `POST /v1/activities/:id/complete` and `/uncomplete` | api | P2-05, P1-13 | no | L |
| P2-12 | `POST /v1/activities/:id/skip` | api | P2-11 | yes | S |
| P2-13 | `POST /v1/activities/:id/snooze` | api | P2-11 | no | M |
| P2-14 | Reminder validation and storage on write paths | api | P2-10 | yes | S |
| P2-15 | Series limit and window warnings | api | P2-06 | yes | S |
| P2-16 | Agenda client hook, query keys and cache policy | mobile | P2-09, P1-23 | no | M |
| P2-17 | Today screen shell and the four sections | mobile | P2-16, P1-29 | no | L |
| P2-18 | The UP NEXT card and the one-minute ticker | mobile | P2-17 | no | M |
| P2-19 | Agenda row components and affordances by type | mobile | P2-17 | no | L |
| P2-20 | Swipe actions and the gesture table | mobile | P2-19 | no | L |
| P2-21 | Optimistic mutation model functions | shared/mobile | P2-11, P2-13 | no | L |
| P2-22 | The undo toast system | mobile | P2-21 | no | M |
| P2-23 | The snooze sheet | mobile | P2-20, P2-13 | yes | M |
| P2-24 | The reschedule sheet, including the series two-option case | mobile | P2-20, P2-10 | yes | M |
| P2-25 | The repeat sheet | mobile | P2-03, P2-04 | yes | M |
| P2-26 | Passed-plan resolution prompts | mobile | P2-19, P2-11 | no | M |
| P2-27 | Overdue rows: date chip, cap and collapse | mobile | P2-19, P2-07 | no | M |
| P2-28 | Today's empty states | mobile | P2-17 | yes | S |
| P2-29 | The Anytime quick-add row | mobile | P2-17, P1-31 | yes | S |
| P2-30 | The Plans tab: date-range agenda | mobile | P2-16 | yes | M |
| P2-31 | Persisted query cache and the offline mutation queue | mobile | P2-21 | no | L |
| P2-32 | Local notifications on device | mobile | P2-14 | no | M |
| P2-33 | `Show skipped` device-local toggle | mobile | P2-19 | yes | S |
| P2-34 | Worked-example-day integration fixture and test | ci | P2-09 | no | M |
| P2-35 | E2E: Today flows on web and iOS | ci | P2-26, P2-27 | no | M |

P2-15, P2-28, P2-29 and P2-33 are mechanical; follow the canonical sections named in the
table and skip the design discussion.

---

### P2-01 — The recurrence engine

**This is the highest-risk task in the whole plan.** It is pure, it is small, it is fully
specified, and it is wrong in a way nobody notices for three weeks if it is written
carelessly. Build it first, alone, before anything that consumes it.

**Files.**

```
packages/shared/src/recurrence/expand.ts       expandRecurrence — the only public entry
packages/shared/src/recurrence/rules/{daily,weekdays,weekly,monthly,intervalDays}.ts
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

**Approach.**

1. **Wall-clock arithmetic only.** Every step operates on calendar dates in `tz` using
   `date-fns` and `date-fns-tz`. Never add fixed millisecond offsets; never round-trip
   through a UTC `Date` and back for date stepping. A day is not 86,400,000 ms twice a year.
2. One rule module per `freq`, each a pure generator from `startDate` forward. `weekdays` is
   its own rule, not `weekly` with five weekdays, because the product exposes it as its own
   option and the label differs.
3. **Month-end clamping** (`../01-product/today-and-tasks.md` §6.1): a monthly series on day
   29, 30 or 31 emits the **last day** of any shorter month. `byMonthDay: [31]` produces 28
   February (29 in a leap year), 30 April, 31 May. It never skips a month and never spills
   into the next.
4. **Termination.** `endDate` is inclusive. `count` counts occurrences from `startDate`,
   including any before `from` — so a `count: 3` series starting 1 January produces nothing
   for a March window. Both may be present; the earlier bound wins.
5. **Bounds.** Occurrences strictly before `startDate` are never emitted. The window is
   capped at 62 days by the caller; the engine itself must still terminate on a pathological
   rule, so cap internal iteration at 1,000 steps and throw a typed error rather than
   looping.
6. **`custom` / `rrule` is Phase 8.** `freq: 'custom'` throws `validation_failed`. Do not
   pull in an RFC 5545 library now.
7. **`mode: 'after_completion'` is Phase 8.** The engine accepts only `fixed`.
8. **Determinism.** No `Date.now()`, no `new Date()` with no argument, no locale, no
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
- A series whose `startDate` is after `to` returns `[]` without iterating.
- `from > to` returns `[]`.
- Leap day: a monthly series on the 29th emits 29 February in a leap year and 28 February
  otherwise.

**Tests.** P2-02 is the test matrix and is a separate task because it is the deliverable
that makes this one trustworthy.

---

### P2-02 — The recurrence test matrix

**Files.** `packages/shared/src/recurrence/expand.test.ts`,
`packages/shared/src/recurrence/calendar.test.ts`,
`packages/shared/src/recurrence/fixtures/*.json`.

**Coverage requirement: 100% statements and 100% branches**, enforced by the gate configured
in P0-26. Not "high coverage". A branch in this file that no test exercises is a branch
whose behaviour nobody has decided.

Every row below is a required test case. Each is table-driven with explicit expected date
arrays — no computed expectations, because a bug in the expectation helper and a bug in the
engine cancel out.

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
| 28 | **Rescheduled occurrence** | `Occurrence { status: 'rescheduled', overrideTime: '21:00' }` | Emitted at 21:00 on that date only. |
| 29 | **Timezone travel** | Activity stored with `schedule.timezone: 'America/New_York'`, 18:00; profile timezone changed to `Europe/London`; agenda requested with `tz=Europe/London` | The activity keeps its stored timezone. Today's boundaries and the "now" comparison use the **profile** timezone. A 6:00 PM New York task renders as 11:00 PM on the London day, and may land on the *next* London date. |
| 30 | **Timezone travel across a date boundary** | 22:00 `America/New_York` viewed from `Asia/Tokyo` | Appears on the following local date, not the same one, and is not duplicated on both. |
| 31 | **Empty window** | `from > to` | `[]`, no throw. |
| 32 | **Start after the window** | `startDate` a year later | `[]`, with no iteration (assert the internal step counter). |
| 33 | **62-day window, daily** | Maximum legal window | 62 dates, in ascending order, unique, no duplicates at month boundaries. |
| 34 | **Pathological rule guard** | A rule crafted to emit nothing for 1,000 steps | Throws a typed error rather than hanging. |
| 35 | **Determinism** | The same call twice, and with the process clock moved a day | Identical output. Asserts no hidden `Date.now()`. |
| 36 | **Purity** | Freeze the `Recurrence` object and call | No mutation, no throw. |

Beyond the table:

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

### P2-04 — `Recurrence` Zod schema and validation

**Files.** `packages/shared/src/schemas/recurrence.ts`.

**Approach.** The `Recurrence` interface from
[`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence),
with the constraints the product actually imposes:

| Rule | Enforcement |
| --- | --- |
| `mode` | `'fixed'` only. `'after_completion'` → `validation_failed`, per `today-and-tasks.md` §6.7. |
| `freq: 'custom'` | Rejected until Phase 8. The `rrule` field exists in the type and is unusable. |
| `weekly` | `byWeekday` required and non-empty; values 0–6. |
| `monthly` | `byMonthDay` required, single element in v1, 1–31. |
| `interval_days` | `interval` required, 2–365. `interval: 1` normalised to `freq: 'daily'`. |
| `count` | 1–999. |
| `endDate` | ≥ `startDate`. |
| `startDate` | Always the activity's `schedule.date` at the moment recurrence is set; not separately editable. Server overwrites any client value. |
| Recurrence with no `schedule.date` | `validation_failed` — Repeat is only enabled when a date is set. |

**Tests.** One valid and at least two invalid cases per row; `mode: 'after_completion'`
rejected with a message naming the phase; `interval: 1` on `interval_days` normalised.

---

### P2-06 — Agenda service

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
   completed; `snoozed` → emit at `snoozedUntil`; `rescheduled` → emit at `overrideTime`;
   otherwise emit at the series time.
6. Merge 1 + 5, sort by effective local time, and return per-day buckets.

Server-side partitioning into `upNext` / `schedule` / `anytime` / `earlier` uses the sort
keys in
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §3.1. `upNext` is
computed at request time and is the client's **initial paint only** — the client recomputes
on its ticker (P2-18).

**Edge cases.**

- Step 4 must not be an N-query loop. One `BatchGetItem` per 100 keys.
- Sorting ties break on `activityId` ascending, which is a ULID and therefore creation
  order. This is deliberately *not* type priority and not alphabetical — a type ranking
  would be a hidden hierarchy of types.
- `cancelled` activities never appear, on any date.
- Items belonging to a declined plan never enter the query because declining removes the
  `ActivityIndex` entry (Phase 5).
- Prep tasks with their own `schedule.date` are **included**, with the parent plan's title
  as the subtitle.
- A series that would emit two occurrences on one date (only reachable via a malformed
  custom rule, which is Phase 8) emits the earliest and drops the rest, adding a warning.

**Tests.** Unit with a mocked repository covering each merge branch. Integration against
DynamoDB Local using the worked example day from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §9 as the fixture
(P2-34), asserting the exact section membership and order of all nine rows.

---

### P2-07 — Overdue roll-forward

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
  events, not outings, not custom activities.
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

### P2-08 — `AgendaItem` projection

**Files.** `services/api/src/services/agendaProjection.ts`,
`packages/shared/src/schemas/agenda.ts`.

**Approach.** Build the `AgendaItem` shape from
[`../02-architecture/api-contract.md#22-agenda--powers-today-and-plans`](../02-architecture/api-contract.md#22-agenda--powers-today-and-plans),
server-side, so the client never derives presentation from `type` with a switch statement:

- `hasCheckbox = type === 'task'`, and nothing else, ever.
- `subtitle` per the table in
  [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §4: parent plan
  title for `task`; `Meal · <slot>`; `Watch · S<n> E<n>` or `mediaKind`; `location.label`
  else `organiser` for `event`; `location.label` else `placeName` for `outing`; none for
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

### P2-11 — `complete` and `uncomplete`

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/services/completionService.ts`.

**Approach.** `POST /v1/activities/:id/complete` with `{ occurrenceDate?, outcome? }`.

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

- A participant may mark **their own** occurrence complete but may not complete the series
  or the activity for everyone (Phase 5 makes this reachable; enforce it now in `authz.ts`).
- Completing an activity that is already completed is idempotent, not a `409`.
- The completed row moves from SCHEDULE to EARLIER TODAY on the same screen without a
  refetch — that is client work (P2-21), but the response shape must give the client
  everything it needs to do it without one.
- No follow-up suggestion is offered on a recurring completion. The next occurrence already
  exists.

**Tests.** Integration: completing an occurrence writes exactly one item (count the
partition before and after) and leaves `ACT#/META.updatedAt` byte-identical; tomorrow's
expansion still emits the series at its normal time; `uncomplete` on an occurrence deletes
the row; `outcome: 'didnt_go'` sets `status: 'skipped'`; completing twice is idempotent.

---

### P2-13 — `snooze`

**Files.** `services/api/src/services/completionService.ts`.

**Approach.** `POST /v1/activities/:id/snooze` with `{ occurrenceDate, until }`, where
`until` is `HH:mm` on the same day or an ISO instant. Writes `Occurrence { status:
'snoozed', snoozedUntil }` and **nothing else**.

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

### P2-09 — `GET /v1/agenda`

**Approach.** Query parameters `from`, `to`, `tz`, `include` (comma-separated:
`anytime_unscheduled`, `overdue`). Window strictly capped at 62 days →
`400 validation_failed`. `ETag` on the response, computed from the response body hash, with
`If-None-Match` returning `304`. Response is client-cacheable for 60 s.

`warnings[]` carries `series_limit_exceeded` when the user has more than 200 active series
(a `200` with a warning, not an error) and the duplicate-occurrence warning from P2-06.

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

### P2-17 — Today screen shell and the four sections

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

EARLIER TODAY sorts **descending** while SCHEDULE sorts ascending, so the screen reads as a
timeline centred on now. It is capped at 10 rows with a `Show all` expander.

**Edge cases.** No user-controlled ordering. No "add to Today" action. No per-day entity. If
a proposed feature needs state that would be lost by throwing the screen away and
re-querying, it does not belong here.

**Tests.** `partition.ts` unit tests over the worked example day at 15:10, at 17:31, and at
23:59, asserting exact section membership each time. A render test asserting section order
and that an empty section is absent from the tree.

---

### P2-18 — The UP NEXT card and the ticker

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

### P2-20 — Swipe actions and the gesture table

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

### P2-21 — Optimistic mutation model functions

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

### P2-22 — The undo toast system

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

### P2-24 — The reschedule sheet

**Approach.** Opened by tapping a date or time **anywhere** it is rendered (U4). It never
edits in place on a row.

For a **recurring series** it presents a two-option sheet: `This occurrence only` /
`All future occurrences`. The first writes an `Occurrence` with `status: 'rescheduled'` and
`overrideTime`; the second patches `recurrence` and `schedule`. There is no "all occurrences
including past" option.

Clearing the date on an activity with participants warns
`Removing the date un-plans this for everyone. Continue?` (Phase 5 makes this reachable;
build the branch now).

**Tests.** Integration: `This occurrence only` writes one `OCC#` row and leaves the series
untouched; `All future occurrences` patches the series and leaves existing occurrence
overrides intact.

---

### P2-26 — Passed-plan resolution prompts

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

### P2-31 — Persisted query cache and the offline mutation queue

**Files.** `apps/mobile/src/lib/queryClient.ts`,
`apps/mobile/src/lib/persister.ts`,
`apps/mobile/src/lib/onlineManager.ts`.

**Approach.** The three mechanisms in
[`../02-architecture/tech-stack.md#34-offline-and-optimistic-updates`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates):
a persisted query cache via `@tanstack/query-async-storage-persister`; optimistic updates
(P2-21); and a persisted mutation cache resumed with `resumePausedMutations()` on reconnect,
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

### P2-32 — Local notifications on device

**Files.** `apps/mobile/src/features/reminders/localSchedule.ts`.

**Approach.** Push is Phase 4. This phase schedules **local** notifications with
`expo-notifications` for reminders on activities in the current and next day, so reminders
work end to end on device before any server-side scheduling exists.

Rescheduled on every agenda refresh: cancel all previously scheduled local notifications
owned by the app and re-schedule from the current agenda. That is simpler and more correct
than tracking deltas, and the volume is tiny.

**Edge cases.**

- The permission prompt is **not** requested here. Permission timing is
  [`../01-product/notifications.md`](../01-product/notifications.md) §6.1 and belongs to
  Phase 4 with the pre-prompt sheet. In Phase 2, if permission has not been granted, local
  scheduling silently no-ops and the reminder controls stay usable.
- Untimed items fire at the profile's all-day reminder hour, default 09:00 local.
- A reminder whose fire time is already past is dropped silently.
- Web is a no-op (`push.web.ts`).

**Tests.** Unit on the schedule-computation function (offset arithmetic, all-day hour, past
reminders dropped) with the `expo-notifications` API mocked. Manual verification on a
simulator with the clock advanced.

## Acceptance criteria

1. `expandRecurrence` passes all 36 matrix cases in P2-02 plus 1,000 property-based cases,
   at **100% statement and branch coverage**, and CI fails if coverage drops below it.
2. A daily 18:00 task in `America/New_York` expanded across 7–9 March 2026 yields three
   dates whose derived UTC instants are 23:00Z, 23:00Z and 22:00Z — the wall clock is
   constant and the instant shifts.
3. A monthly series on `byMonthDay: [31]` expanded over January–June 2026 yields 31 Jan,
   28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun.
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
12. Only `task` rows have a checkbox. Tapping a `meal`, `watch`, `event`, `outing` or
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
20. The Plans tab renders a multi-day range from the same endpoint with one row per series
    per date, and does **not** send `include=anytime_unscheduled`.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| `freq: 'custom'` / RFC 5545 `rrule` | Phase 8 |
| `mode: 'after_completion'` recurrence | Phase 8 |
| Server-side reminder scheduling, EventBridge Scheduler, the reminder Lambda, push delivery | Phase 4 |
| The notification permission prompt and pre-prompt sheet | Phase 4 |
| Lists, the Lists → Plans bridge, prep-task UI inside a plan, watchlist progress | Phase 3 |
| Attachments and image upload | Phase 3 |
| Participants, RSVP badges on rows (the projection field exists; it renders empty) | Phase 5 |
| Expenses | Phase 6 |
| Capture beyond the existing `501` stubs | Phase 7 |
| The maintenance job that drops completed and past items out of GSI1 after 60 days | Phase 8 (P8-33) |
| Web push, service worker | Not in v1 |
| A local-first replica, SQLite mirror, or client-side recurrence expansion | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **The recurrence engine is subtly wrong** and nobody notices for weeks | A user reports "my gym disappeared in March" or "the 31st skipped February" | P2-01 is built first and alone; P2-02's 36-case matrix plus property tests plus an independent cross-check implementation; 100% branch coverage gated in CI; golden fixtures so a refactor fails loudly. |
| DST handled by adding milliseconds | Everything is right for ten months a year | Calendar arithmetic only, in `calendar.ts`; cases 15–19 include both hemispheres and a half-hour zone. A `+ 86400000` anywhere in `recurrence/` is a review rejection. |
| Snooze or complete writes `ACT#/META` | The visible result looks correct; the series' `updatedAt` churns and Phase 5's conflict detection starts firing spuriously | Success criterion S6, asserted by reading the item before and after; a repository spy asserting no `#R` query on the snooze path. |
| A second request creeps into Today's cold open | Nobody notices until Today is slow on 4G | The Playwright network-count assertion is a gating acceptance criterion, not a review item. |
| The client's optimistic projection disagrees with the server | Rows visibly flip back a second after a tap | P2-21's golden tests compare the pure function's output to recorded server responses. |
| Overdue roll-forward mutates the activity | Plans shows the task on the wrong date; "Today owns no data" quietly stops being true | Roll-forward is a query rule with an explicit acceptance criterion asserting the stored date is unchanged after render **and** after completion. |
| The ticker runs while backgrounded | Battery complaints in TestFlight | Drive it from an `AppState` listener, not a bare interval. |
| Section sort order drifts between server and client | Rows reorder on refresh | Both use the sort keys in `today-and-tasks.md` §3.1, and `partition.ts` is tested against the same fixture the server integration test uses. |
| A badge or count for unresolved items is added "because it's useful" | The product becomes a nag | Acceptance criterion 11 plus a test that fails on a badge bound to an unresolved count. |
| The 62-day cap is enforced only on the client | A wide window times out the Lambda | Enforced server-side in the route validator and tested at 62 and 63. |
</content>
