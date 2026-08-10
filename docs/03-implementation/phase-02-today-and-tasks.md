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

> **Plan amendment — 2026-08-10.** Before any Phase 2 task was scheduled, the phase gate
> was reconciled against the Phase 1 repository, including the Event/Outing kind merge.
> The task scopes, dependencies, file paths, acceptance criteria and estimates below are the
> amended plan of record. P2-02 remains the recurrence matrix; the post-merge presentation-
> type bucket matrix is P2-05, where the duplicated Event rows were found and corrected.

> **Second gate amendment — 2026-08-10.** A second read against the merged Phase 1 tree
> found hidden file ownership, dependency and retry assumptions before scheduling began.
> Cases 25–30 now belong to P2-08 rather than the engine-only P2-02; P2-01, P2-07, P2-12,
> P2-16, P2-22, P2-33 and P2-34 name the as-built files and dependency installs they must
> touch; P2-36 uses the repository's real integration-test command. These are ownership and
> sequencing corrections, not new product scope, so task sizes and phase totals are unchanged.

> **Third gate amendment — 2026-08-10.** The final pre-scheduling read against the merged
> Phase 1 tree corrected fixture ownership, transaction bounds, route/client ownership,
> authorisation projection, cache isolation, device-test setup and the remaining dependency
> rows. Earlier tasks self-seed; P2-36 is the capstone that replaces those local fixtures with
> the canonical worked-example fixture. Numeric order P2-01 through P2-37 remains
> dependency-valid after removing the earlier forward references to P2-36.

> **Fourth gate amendment — 2026-08-10.** A behaviour-only pass resolved the remaining
> implementation ambiguities before scheduling: one pure action-capability policy now serves
> both agenda projection and completion-route guards; completion mutations are idempotent and
> resumable across process death; ETag cache identity and Phase 4 sign-out ownership are
> explicit; Undo extends the Phase 1 toast singleton; and pre-auth E2E isolation keeps the
> fixed local identity. P2-13 now depends on the lower-numbered P2-10 policy owner, so numeric
> order P2-01 through P2-37 remains dependency-valid. Task sizes and phase totals are unchanged.

> **Fifth gate amendment — 2026-08-10.** The final behaviour trace closed the long-range
> read and replay paths before scheduling: recurrence edits carry explicit occurrence context;
> cross-day occurrence moves have collision-safe destination markers and a 60-day bound;
> timezone widening is ±2 days; notification refresh owns an eight-day request; every
> mutating POST is replay-protected; child pointers and ETags exclude stale/volatile data;
> and P2-38 hardens idempotency response storage atomically. The one deliberate execution-order
> exception is `P2-01…P2-11 → P2-38 → P2-12…P2-37`. Phase 2 is now 38 tasks / 97 AWU.

> **File inventories are minima, not exhaustive.** The checklists in
> [`../04-conventions/repo-structure.md`](../04-conventions/repo-structure.md) — including the
> route checklist, export-map tests, dependency declarations and lockfile — bind every task
> implicitly. An implementing agent extends the task's file scope as needed to satisfy them
> and lists those extensions in the PR description. A gate finding of the form “task X omits
> file Y required by convention Z” is resolved by this standing rule; explicitly named
> product, data, dependency and cross-task ownership below remains binding.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phase 1 complete and its acceptance criteria passing | In particular the repository layer, the `ActivityIndex` write path, and `packages/ui`. Phase 1's inline bucket logic is **replaced** by `deriveGsi1Bucket` in P2-05, not extended. |
| 1a | [`../02-architecture/data-model.md#35-gsi1-buckets`](../02-architecture/data-model.md#35-gsi1-buckets) read, including the bucket-derivation function and the `lastActivityAt` paragraph | Four buckets, not three. `#P` and `#N` mean opposite things and the reason is in that section. |
| 2 | [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) read in full | It is the specification for this phase, including the worked example day in §9 which doubles as a fixture. |
| 3 | [`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm) read | The amended hydration-and-expansion algorithm is normative. |
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
      `anytime_unscheduled`, `overdue` and `reminders`; window capped at 62 days; `ETag`;
      `warnings[]`. Today receives its own reminder rows in this same request.
- [ ] `AgendaItem` projection with server-set `hasCheckbox`, `subtitle`, `isPast`,
      `occurrenceDate` and `overdueFromDate`.
- [ ] `complete`, `uncomplete`, `skip`, `snooze`, `unsnooze` and `schedule` endpoints, with
      occurrence scoping that provably never writes `ACT#/META`; non-occurrence status writes
      update `META` and every `ActivityIndex` row atomically; plan completion is global and
      owner-only, while ADR-051 permits the prep-task owner, parent-plan owner or a parent-plan
      participant to complete a prep task.
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
- [ ] Local notifications scheduled on device for **the signed-in user's own** reminders from
      one independent eight-day agenda refresh, covering the seven-day maximum offset.
- [ ] The Plans tab rendering a multi-day **window** from the same endpoint, with the `#P`
      bucket excluded — the three-stage Plans screen is Phase 3. A wider window, not an
      activity that spans days: there is no `schedule.endDate` in v1 (ADR-050).

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P2-01 | The recurrence engine `expandRecurrence` | shared | — | no | L |
| P2-02 | The recurrence test matrix | shared | P2-01 | no | L |
| P2-03 | `describeRecurrence` for the UI | shared | P2-01 | yes | M |
| P2-04 | `Recurrence` Zod schema and server-side validation | shared/api | P1-06, P1-10 | yes | L |
| P2-05 | `deriveGsi1Bucket` and its test matrix | shared | P1-06 | yes | M |
| P2-06 | `lastActivityAt`, distinct from `updatedAt` | shared/api | P2-05, P1-05 | no | M |
| P2-07 | `OccurrenceRepository` | api | P1-05 | yes | M |
| P2-08 | Agenda service: query, hydrate, expand, merge, project | api | P2-01, P2-07, P1-09 | no | L |
| P2-09 | Overdue roll-forward query rule | api | P2-08 | no | M |
| P2-10 | `AgendaItem` projection: subtitle, checkbox, isPast | api | P2-08 | no | M |
| P2-11 | `GET /v1/agenda` route, window cap, `ETag`, warnings | api | P2-08, P2-09, P2-10 | no | M |
| **P2-38** | **Idempotency replay hardening (deliberate pre-P2-12 execution slot)** | api | P1-04, P1-05, P1-09 | no | M |
| P2-12 | Sole schedule write path and detail-UI migration | shared/api/mobile | P2-01, P2-05, P2-07, P2-38, P1-10 | yes | L |
| P2-13 | `POST /v1/activities/:id/complete` and `/uncomplete` | api | P2-05, P2-07, P2-10, P2-38, P1-10 | no | L |
| P2-14 | `POST /v1/activities/:id/skip` | api | P2-13 | yes | S |
| P2-15 | One-off and occurrence `snooze` / `unsnooze` | api | P2-13 | no | L |
| P2-16 | Per-user reminders: items, endpoints, and the write paths | api | P2-08, P2-12 | yes | M |
| P2-17 | Series limit and window warnings | api | P2-08 | yes | S |
| P2-18 | Agenda client hook, ETag transport cache and query policy | shared/mobile | P2-11, P1-20 | no | L |
| P2-19 | Today screen shell and the four sections | mobile | P2-18, P1-22 | no | L |
| P2-20 | The UP NEXT card and the one-minute ticker | mobile | P2-19 | no | M |
| P2-21 | Agenda row components and affordances by type | mobile | P2-19 | no | L |
| P2-22 | Swipe actions and the gesture table | mobile | P2-21 | no | L |
| P2-23 | Optimistic mutation model functions | shared/mobile | P2-12, P2-13, P2-14, P2-15 | no | L |
| P2-24 | The undo toast system | mobile | P2-23 | no | M |
| P2-25 | The snooze sheet | mobile | P2-12, P2-15, P2-22, P2-24 | yes | M |
| P2-26 | Extend the reschedule sheet, including the series two-option case | mobile | P2-04, P2-12, P2-22 | yes | M |
| P2-27 | The repeat sheet | mobile | P2-03, P2-04 | yes | M |
| P2-28 | Passed-plan resolution prompts | mobile | P2-21, P2-13 | no | M |
| P2-29 | Overdue rows: date chip, cap and collapse | mobile | P2-09, P2-12, P2-21, P2-26 | no | M |
| P2-30 | Today's empty states | mobile | P2-19 | yes | S |
| P2-31 | Today's contextual `+ Add a task` action | mobile | P2-19, P1-24 | yes | S |
| P2-32 | The Plans tab: date-range agenda | mobile | P2-18 | yes | M |
| P2-33 | Persisted query cache and the offline mutation queue | shared/api/mobile | P2-16, P2-23 | no | L |
| P2-34 | Local notifications on device | mobile | P2-11, P2-16, P2-18 | no | M |
| P2-35 | `Show skipped` device-local toggle | mobile | P2-21 | yes | S |
| P2-36 | Worked-example-day integration fixture and test | ci | P2-04, P2-08, P2-11, P2-13, P2-19, P2-23 | no | M |
| P2-37 | E2E: Today flows on web and iOS | ci | P2-20, P2-24, P2-25, P2-26, P2-28, P2-29, P2-31, P2-33 | no | M |

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
packages/shared/src/recurrence/{placeholder.ts,placeholder.test.ts}  delete
packages/shared/package.json                   add ./recurrence export + date dependencies
packages/shared/src/index.test.ts              prove the new export resolves
pnpm-lock.yaml                                 lock date-fns and date-fns-tz for shared
```

`date-fns` and `date-fns-tz` become direct `packages/shared` dependencies in this task,
at the exact versions sanctioned in `tech-stack.md` §2.2/§2.3. The API already has them;
hoisting is not dependency declaration. Add the conditional `./recurrence` export
(`types` → `dist`, `react-native` → `src`, `default` → `dist`) in the same change, and delete
both P0-24 placeholder files that explicitly hand ownership to P2-01.

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
`packages/shared/src/recurrence/fixtures/*.json`,
`packages/shared/package.json`, `pnpm-lock.yaml`.

Declare `fast-check` as a direct `packages/shared` dev dependency in this task, at the
version sanctioned in `tech-stack.md` §2.5. A transitive lockfile entry does not satisfy the
dependency rule.

**Coverage requirement: 100% statements and 100% branches**, enforced by the gate configured
in P0-24. Not "high coverage". A branch in this file that no test exercises is a branch
whose behaviour nobody has decided.

Every row below is a required **engine or calendar** test case. The engine-pure matrix is
exhaustive for the behavior owned by P2-01: cases **1–24 and 31–43**, retaining the original
numbers for traceability. Cases 25–30 exercise occurrence merging, persistence and agenda
timezone projection rather than recurrence expansion; they are required P2-08 acceptance
tests and are listed there. Each case here is table-driven with explicit expected date
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
- **Property-based tests** with `fast-check` over random valid
  `Recurrence` objects and random 1–62-day windows, asserting three invariants: output is
  strictly ascending; output is a subset of the window; output has no duplicates. Run 1,000
  cases in CI.
- **A cross-check** for `daily` and `weekdays` against a naive day-by-day filter
  implementation written independently in the test file. If two independent implementations
  disagree, the test fails and one of them is wrong — that is the point.
- **Golden fixtures** in `fixtures/` for cases 9, 15 and 17, so a refactor that changes
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

**Files.** `packages/shared/src/schemas/recurrence.ts`,
`packages/shared/src/schemas/recurrence.test.ts`,
`packages/shared/src/schemas/activity.ts`,
`packages/shared/src/schemas/activity.test.ts`,
`services/api/src/services/activityService.ts`,
`services/api/src/services/activityService.test.ts`.

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

The shared Zod shape is necessary but not sufficient. `activityService` enforces the
stored-state rules on **both** `POST /v1/activities` and the `PATCH` recurrence path after
loading the current Activity. The PATCH body may carry `editedFromDate?: WallDate` alongside
`recurrence`. When present, the service proves that the current stored active rule emits that
date and uses it as the appended segment's `effectiveFrom`; when absent, it uses today in the
Activity's timezone. `editedFromDate` without a recurrence append is `validation_failed`.
The service ignores every client-supplied segment `effectiveFrom`, compares the edit to stored
history, and rejects any rewrite, reorder or deletion of an existing segment. Routes do not
duplicate this logic.

Per-segment rule constraints, which the shared shape and service apply to **every** segment:

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
| `effectiveFrom` | For the **first** segment: always the activity's `schedule.date` at the moment recurrence is set; not separately editable; server overwrites any client value. For an **appended** segment: server derives it from validated PATCH `editedFromDate`, or today in the Activity's timezone when that field is absent ([`today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series) §6.2). It must be strictly greater than the previous segment's. Client-supplied values inside segments are ignored. |
| Append-only history | A `PATCH` carrying `recurrence` on an existing series must leave every previously stored segment byte-identical and may only append one new final segment (and/or change the series-level Ends fields). Anything else — a rewritten, reordered or deleted past segment — is `validation_failed`. Past segments are immutable. |
| Recurrence with no `schedule.date` | `validation_failed` — Repeat is only enabled when a date is set. |

**Tests.** One valid and at least two invalid schema cases per row; `mode:
'after_completion'` rejected with a message naming the phase; `interval: 1` on
`interval_days` normalised; a 20-segment series accepted and a 21st rejected with the
explaining message; an append with a rewritten past segment rejected; `effectiveFrom` not
ascending rejected. Service tests cover create and PATCH separately, prove supplied
`effectiveFrom` values are overwritten by the server, and prove PATCH cannot alter any
stored segment while it may append exactly one final segment and/or edit series-level Ends.
Named service tests prove a valid emitted `editedFromDate` becomes the appended anchor, a date
the current active rule does not emit is `validation_failed`, absence uses Activity-local
today, and a segment's conflicting client `effectiveFrom` never wins.

---

### P2-05 — `deriveGsi1Bucket` and its test matrix

**Files.** `packages/shared/src/activity/bucket.ts`,
`packages/shared/src/activity/bucket.test.ts`,
`packages/shared/src/activity/index.ts`, plus the Phase 1 repository caller and the shared
coverage configuration. Convention-required barrels, export tests and integration tests are
implicit under the preamble rule.

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
   already ships the full four-bucket rule inline, including `#P`, with unit and integration
   coverage. This task transcribes that proven baseline into the shared function, extends it
   for the amended rules and matrix, replaces the repository caller, and deletes the inline
   original. **Two implementations is the defect.**
3. `#P` is not new in this phase. Phase 1 already separates it from `#N`; this task preserves
   that distinction while making the shared derivation canonical. The reason the two are
   separate buckets rather than one is in
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
This task owns the path-scoped 100% statement and branch coverage gate for `bucket.ts` in
`packages/shared/vitest.config.ts`; an asserted percentage without that CI threshold is not
the deliverable.

| # | `recurrence` | `schedule.date` | `objectKind` | `type` (not an input) | Bucket |
| --- | --- | --- | --- | --- | --- |
| 1 | — | `2026-08-14` | `task` | `task` | `S` |
| 2 | — | `2026-08-14` | `plan` | `event` | `S` — a date beats everything below it |
| 3 | — | — | `task` | `task` | `N` |
| 4 | — | — | `plan` | `custom` | `P` |
| 5 | — | — | `plan` | `meal` | `P` |
| 6 | — | — | `plan` | `event` | `P` |
| 7 | — | — | `plan` | `watch` | `P` |
| 8 | — | `2026-08-15` | `plan` | `meal` | `S` |
| 9 | `{ freq: 'daily' }` | — | `task` | `task` | `R` |
| 10 | `{ freq: 'daily' }` | `2026-08-14` | `task` | `task` | `R` — recurrence beats a date |
| 11 | `{ freq: 'weekly' }` | — | `plan` | `meal` | `R` — recurrence beats object kind |

Transitions. Each is a second call to the function with one input changed, asserting the
bucket moves and therefore that the index entry must be rewritten:

| # | Transition | Before → after |
| --- | --- | --- |
| 12 | A date is set on an undated Task | `N` → `S` |
| 13 | A date is set on an undated Plan | `P` → `S` |
| 14 | A date is cleared on a Task | `S` → `N` |
| 15 | A date is cleared on a Plan | `S` → `P` |
| 16 | `objectKind` explicitly changes Task → Plan while undated | `N` → `P` |
| 17 | `objectKind` explicitly changes Plan → Task while undated | `P` → `N` |
| 18 | Plan `type` changes `custom` → `event` while undated | `P` → `P`, no rewrite needed |
| 19 | Participants are added to an undated Plan | `P` → `P`, no rewrite needed |
| 20 | Participants are removed from an undated Plan | `P` → `P`, no rewrite needed |
| 21 | `type` changes while dated | `S` → `S`, no rewrite needed |
| 22 | A recurrence is added to a dated task | `S` → `R` |
| 23 | A recurrence is removed from a dated series | `R` → `S` |
| 24 | A recurrence is removed from an undated Plan | `R` → `P` |

Beyond the table: a purity test that freezes the `Activity` and asserts no mutation; a
determinism test that calls twice with the process clock moved and asserts identical output;
and an exhaustiveness test over every **valid** `{ objectKind, type }` pairing, dated and
undated, across the five post-merge presentation types (`task`, `meal`, `watch`, `event`,
`custom`). It asserts only `objectKind` distinguishes undated `#N` from `#P`; there are no
duplicated Event/Outing rows because Outing is no longer a type.

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
- The bump is one repository transaction builder,
  `touchLastActivity(activityId, at, indexedUserIds, transactionBuilder)`. The caller supplies
  the owner/participant user-id set and the transaction builder under construction, matching Phase 1's
  `PatchOptions.indexedUserIds` fan-out pattern. The service layer already holds the
  participant set for the originating update, RSVP or expense write and provides it; the
  helper performs no discovery read, sends no transaction of its own, and appends the META
  plus every `IDX#` write to the caller's transaction. Never a second round trip, and never
  a bare `UpdateItem` from a service.
- **An edit bumps `updatedAt` only.** Renaming a plan is not a discussion, and letting a
  rename reorder the Needs-a-date list would make the stage twitch on every keystroke-saved
  edit.
- The writers land in later phases. This task ships the field, the schema, the index sort key
  and the helper; Phase 3 wires the updates feed to it, Phase 6 the RSVP path, Phase 7 the
  expense path. Each of those tasks re-asserts the property through its own real path.

**Tests.**

- **The `If-Match` test, which is the point of the task.** Read an activity and capture its
  `updatedAt` as the `If-Match` value. Build and commit a transaction with
  `touchLastActivity`, supplying the seeded owner/participant ids — standing in for the
  Phase 6 RSVP writer, which does not exist yet. Re-read: `lastActivityAt` has moved,
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
`services/api/src/repositories/activityRepository.ts`,
`services/api/src/repositories/base.ts`,
`services/api/src/repositories/{base,activityRepository,occurrenceRepository}.test.ts`,
`packages/shared/src/types/occurrence.ts`,
`packages/shared/src/schemas/occurrence.ts`.

**What to build.** The repository that owns every read and write of
`ACT#<activityId>` / `OCC#<yyyy-mm-dd>` items
([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)
§4.5). No DynamoDB call to an `OCC#` key exists anywhere else — the no-DynamoDB-outside-
repositories rule, applied to the item type this phase lives on. Built on the P1-05 base:
key builders take `activityId` explicitly, items are validated against the shared schema on
read, `schemaVersion` upgrade-on-read applies.

Phase 1 already placed `listOccurrences` in `activityRepository.ts`. This task **moves that
function into `OccurrenceRepository`, updates every caller, and deletes the original
export and tests from `activityRepository`**. The rule that no `OCC#` access exists outside
`OccurrenceRepository` is an end-state invariant after this move, not a claim about the
Phase 1 starting tree.

P1-05's base has no batch-get or filtered/count query primitive yet. P2-07 adds both as
named deliverables in `base.ts`: `BatchGetItem` chunks at 100 keys, retries
`UnprocessedKeys` with bounded backoff, and upgrades every returned item on read; the query
primitive supports the repository-owned filter plus `Select: COUNT` needed below without
exposing raw DynamoDB expressions to services. Unit tests pin chunking, retry exhaustion,
upgrade-on-read, filter/count command shapes and empty input. P2-08 consumes the same
batch-get primitive for scheduled and series META hydration rather than inventing another.

The `Occurrence` shape is §4.5 verbatim: `date` is the series' **nominal** date — the date
expansion emitted — never the snoozed or rescheduled display time's date. It carries **no
participant identity and no user field**; a `userId` parameter on any method of this
repository is the per-participant-completion defect from the risk table arriving early.

**Methods.**

| Method | Backs | Notes |
| --- | --- | --- |
| `get(activityId, date)` | occurrence-scoped mutations' read-before-write | `GetItem`. Absence returns `null` — "scheduled, not yet acted on" is the absence of a row, and the repository never fabricates one. |
| `batchGetForPairs(pairs: { activityId, date }[])` | agenda override hydration (P2-08) | `BatchGetItem`, chunked at 100 keys, with `UnprocessedKeys` retried with backoff. The chunking lives **here**, not in the agenda service — override hydration must not be an N-query loop and the service must not know the limit. |
| `queryWindow(activityId, from, to)` | occurrence history for one series and the plan-detail screen | Access pattern 5: `Query pk = ACT#<a>`, `sk BETWEEN OCC#<from> AND OCC#<to>`, both inclusive. |
| `put(occurrence)` | complete, skip, snooze, reschedule-this-occurrence | Upsert of exactly one **domain** item. This method is structurally incapable of touching `ACT#/META` — it takes an `Occurrence` and builds one `OCC#` item. P2-38 extends the mutating repository seam to contribute that item to a caller transaction beside the separate `IDEM#` response item; that does not weaken the one-Activity-row invariant. This is the storage-layer half of success criterion S6; the endpoint tests (P2-13, P2-14, P2-15) assert the visible half. |
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
retried; `queryWindow` bounds are inclusive at both ends; a grep assertion finds
`listOccurrences` only in this repository and no remaining `OCC#` access in
`activityRepository`; `put` leaves `ACT#/META`
byte-identical (read before and after); `delete` then `get` returns `null`;
`countCompleted` counts completed rows only, ignoring skipped and snoozed.

---

### P2-08 — Agenda service

**Files.** `services/api/src/services/agendaService.ts`,
`services/api/src/repositories/activityRepository.ts`,
`services/api/src/repositories/occurrenceRepository.ts`,
`services/api/src/repositories/reminderRepository.ts` (read seam),
`services/api/src/repositories/reminderRepository.test.ts`,
`packages/shared/src/types/activity.ts`,
`packages/shared/src/schemas/activity.ts`,
`packages/shared/src/table/definition.ts`,
`packages/shared/src/table/definition.test.ts`.

**Explicitly untouched:** `services/api/src/repositories/migrate.ts`. Mixed-generation
timezone handling is a hydrated read fallback, not a schema migration.

**Approach.** The amended hydration-and-expansion algorithm in
[`../02-architecture/data-model.md#6-recurrence-expansion-algorithm`](../02-architecture/data-model.md#6-recurrence-expansion-algorithm),
implemented literally:

1. Widen the scheduled query two calendar days on each side:
   `Query GSI1 U#<u>#S BETWEEN <from-2d>T00:00 AND <to+2d>T23:59`. The full IANA span is
   26 hours (UTC−12 through UTC+14), so one day is not sufficient.
2. `BatchGetItem` `ACT#<activityId>/META` for every scheduled candidate, so one-off
   `snoozedUntil` comes from its canonical META field. For a timed row, use the index
   projection's `timezone` when present and fall back to the hydrated
   `META.schedule.timezone` for a Phase 1 row that predates the projection. Convert that
   stored zone to an instant with shared `toUtcInstant`, then into request `tz`; **only after
   conversion**, retain rows whose viewer-local date is inside `[from, to]`.
3. `Query GSI1 U#<u>#R` — at most the first 200 active-series index rows, with the existing
   warning if more exist.
4. **Series hydration:** before any expansion, `BatchGetItem` `ACT#<activityId>/META` for
   every `#R` row selected in step 3, chunked at 100 with unprocessed-key retry. Missing or
   unauthorised META rows are dropped with a warning. Expansion must never treat the thin
   index projection as a `Recurrence`.
5. For each hydrated series, `expandRecurrence(...)` over `[from-2d, to+2d]` in the
   series' stored timezone — pure, no I/O, called inside a loop with no awaits — then
   convert emitted instants into request `tz` and filter by the exact viewer-local
   `[from, to]` window.
6. In one exact-key batch pass, request `OCC#<date>` overrides for every emitted nominal pair
   and collision-safe `MOVE#<destinationDate>` markers for every series/date in the widened
   calendar window. A marker contains sorted, unique `movedFrom` nominal dates. Collect those
   source keys and hydrate their `OCC#<movedFrom>` rows in a **second** bounded batch pass.
   DynamoDB cannot follow a pointer discovered in the response to the first `BatchGetItem`;
   both passes are chunked at 100 with `UnprocessedKeys` retry, and the 60-day write bound
   caps the source set.
7. Merge overrides: `skipped` → emit as skipped (hidden by default); `completed` → emit as
   completed; same-day `snoozed` → emit at `snoozedUntil`; a cross-day `snoozed` or
   `rescheduled` source emits nothing on its nominal date. Its destination marker emits the
   hydrated source exactly once at `snoozedUntil` or `overrideDate`/`overrideTime`, with the
   “moved from” affix. A normal occurrence already due at the destination remains independent;
   otherwise emit at the time of the **segment in force** for that date — its `time`
   snapshot, falling back to `schedule.time` when the segment carries none — so past
   completions and skips render forever under the rule and time in force on their date
   ([`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#62-one-row-per-series)
   §6.2).
   For a one-off row, apply `ACT#/META.snoozedUntil` as its effective time; occurrence
   overrides remain series-only.
8. Merge the scheduled and expanded results and de-duplicate by `(activityId,
   occurrenceDate?)` after viewer-timezone conversion.
9. **Action-context hydration:** before projection, materialise one already-hydrated
   `ActionCapabilityContext` per distinct Activity: the canonical Activity, the caller's
   relationship to it, and—when `parentActivityId` is present—the parent `ownerId` and whether
   the caller participates in that parent plan. Resolve and de-duplicate this repository work at the assembly boundary;
   repeated occurrences of one series reuse the same context. No projection call performs a
   `GetItem`, participant query or `assertActivityAccess` call. P2-10 consumes these contexts
   with the pure `deriveActionCapabilities` function.
10. When `include=reminders`, use the read-only `ReminderRepository` seam introduced here to
   query `REM#<callerUserId>#` for each distinct Activity emitted in the bounded result,
   attach those rows to its AgendaItems, and never read another user's prefix. This is
   bounded fan-out behind one HTTP agenda request; P2-16 extends the
   same repository with management writes.
11. Sort by effective viewer-local time and return per-day buckets.

P2-08 also amends the `ActivityIndex` writer/schema to project `schedule.timezone`.
Every index row written from P2-08 onward carries it. Existing Phase 1 rows form a supported
mixed generation: absence means “read the stored zone from the META row this algorithm
already hydrated”, never “use the viewer zone”. The next ordinary write rebuilds the whole
index projection and stamps the field opportunistically. **Do not add a migration-registry
entry, scan or one-off backfill:** `services/api/src/repositories/migrate.ts` is deliberately
untouched because an old thin index row does not contain enough information to derive its
Activity's zone.

`GSI1` is not deployed anywhere yet: the local-first plan does not create a dev or production
table through Phase 3. Adding `timezone` to the shared `INCLUDE` projection is therefore a
table-definition edit plus recreation of the disposable DynamoDB Local table, not a live
index migration. The shared definition remains the source consumed by local-table creation
and the later CDK stack.

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

- Scheduled META hydration, series META hydration, destination-marker discovery and both
  occurrence override passes must
  not be N-query loops. Each uses `BatchGetItem`, one request per 100 keys, with retry for
  unprocessed keys.
- Capability derivation itself performs zero reads. Access-context hydration is de-duplicated
  by Activity and parent-plan id before the projection loop; one recurring series with seven
  emitted occurrences does not resolve its relationship seven times.
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
- Widening the `#S` query never widens the response. Rows are filtered only after conversion
  to request `tz`; transferred matrix case 30 (22:00 New York viewed from Tokyo) is an acceptance
  test here, proving the item appears on the following Tokyo date exactly once.
- The named extreme-zone test **`2026-01-01 23:30 UTC−12 becomes 2026-01-03 UTC+14`** proves
  both the ±2-day scheduled query and series-expansion window. Replacing either with ±1 makes
  the test fail.

**Tests.** Unit with a mocked repository covering each merge branch. Integration against
DynamoDB Local self-seeds the rows needed for this task, including a compact version of the
worked-example day from
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §9, and asserts the
exact section membership and order. P2-08 has no dependency on a later shared fixture.

Plus, seeded with one activity in every bucket: a repository spy asserts that **no query
against `U#<u>#P` occurs on any agenda path**, with and without all `include` tokens, and
the undated Plan in that bucket appears in no section of the response.

Also seed a `#R` index row whose projection contains no recurrence: assert its
`ACT#/META` is included in the hydration `BatchGetItem` before `expandRecurrence` is called.
Seed the New York → Tokyo boundary from transferred case 30 and assert the widened query finds
it, post-conversion filtering places it only on the following Tokyo date, and the exact
unwidened response window is preserved.

**Transferred acceptance cases 25–30.** These retain their original matrix numbers for
traceability, but they are P2-08 tests because each crosses the engine/agenda boundary:

| # | Case | Required P2-08 assertion |
| --- | --- | --- |
| 25 | **Snoozed occurrence** | A daily 18:00 series with a snoozed override emits today at 20:00 and every other date at 18:00; recurrence is neither rewritten nor re-anchored. |
| 26 | **Completed occurrence** | The emitted row is `completed_occurrence`; series `ACT#/META.updatedAt` remains byte-identical. |
| 27 | **Skipped occurrence** | The emitted row is `skipped_occurrence`, hidden by default and present under `Show skipped`; every other occurrence is unchanged. |
| 28 | **Rescheduled occurrence** | `overrideTime` moves only that occurrence; `overrideDate` writes nominal `OCC#` + destination `MOVE#` atomically and emits it on the replacement date exactly once, never on both dates. A normal occurrence and two moved-in occurrences may coexist on that date without key collision. |
| 29 | **Timezone travel** | An 18:00 `America/New_York` row viewed in `Europe/London` keeps its stored zone while request boundaries and “now” use the profile zone. Run once with projected `timezone` and once with that field absent, proving the hydrated-META fallback is identical. |
| 30 | **Timezone travel across a date boundary** | A 22:00 New York row viewed from Tokyo is found by the widened query and appears on the following Tokyo date exactly once. Run the legacy-row variant without projected `timezone` too, plus the named UTC−12 → UTC+14 two-date jump that requires ±2 days. |

---

### P2-09 — Overdue roll-forward

**Files.** `services/api/src/services/agendaService.ts` (a separate exported function),
`services/api/src/repositories/activityRepository.ts` (the window query),
`packages/shared/src/types/agenda.ts`,
`packages/shared/src/schemas/agenda.ts` (add `overdueFromDate`).

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
`services/api/src/services/actionCapabilities.ts`,
`services/api/src/services/actionCapabilities.test.ts`,
`packages/shared/src/schemas/agenda.ts`,
`packages/shared/src/types/agenda.ts`,
and the reserved `packages/shared/src/{schemas,types}/index.ts` barrels.

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
- `capabilities: { complete, skip, snooze }` comes from exactly one service-layer policy:
  `deriveActionCapabilities(ctx)`, a **pure** function over an already-hydrated context. Its
  input is the Activity, the authenticated caller's relationship to that Activity, and, for
  a prep task, whether that caller participates in the parent plan. It imports no repository,
  performs no I/O and never calls `assertActivityAccess`.

```ts
interface ActionCapabilityContext {
  activity: Activity;
  callerId: string;
  callerRole: 'owner' | 'participant' | 'none';
  parentOwnerId?: string;
  participatesInParent: boolean;
}

function deriveActionCapabilities(
  ctx: ActionCapabilityContext,
): { complete: boolean; skip: boolean; snooze: boolean };
```

The policy is literal: when `activity.parentActivityId` is present, the Activity owner, the
parent Plan's owner (`callerId === parentOwnerId`) or a participant of the parent Plan may
complete it; for every other Activity, only its owner may complete it. The explicit parent-
owner branch preserves Phase 1's inherited-owner access even when a different participant
created the prep task. `skip` and `snooze` have the same verdict as `complete`. P2-10 calls the function
once per projected item using P2-08's hydrated context; repeated occurrences reuse their
Activity context, so capability projection adds **zero reads per AgendaItem**. P2-13 is the
second consumer and the only endpoint-side consumer. The client receives the three booleans
but never receives `ownerId` and never re-derives authority.

**Tests.** Table-driven: one case per type asserting `hasCheckbox` and `subtitle`; the pure
policy's Activity-owner, parent-owner, plan-participant, parent-plan-participant prep-task,
direct-child-participant without parent participation and stranger cases assert the exact
three booleans. A repository
spy proves projecting any number of AgendaItems performs zero reads; a snoozed
occurrence's `time` equals `snoozedUntil`; a rescheduled occurrence's equals `overrideTime`;
`occurrenceDate` present only for series items; `isPast` at exactly the boundary minute for
each of the three cases.

---

### P2-38 — Idempotency replay hardening *(execute before P2-12)*

**Files.** `services/api/src/middleware/idempotency.ts`,
`services/api/src/repositories/idempotencyRepository.ts`,
`services/api/src/repositories/tx.ts`, the existing Phase 1 mutating-POST handlers/services
and repositories, and their unit/integration tests.

**Approach.** Replace Phase 1's reserve → domain write → complete sequence with the atomic
contract in API contract §1. For every mutating POST, the service precomputes the successful
HTTP status/body and passes a conditional `IDEM#<userId>#<key>` put as an extra item to the
repository transaction that performs the domain write. Transaction builders reserve one of
DynamoDB's 100 item slots for that record. A domain repository that cannot accept this extra
item is not ready to back a mutating POST.

The record stores `{ status, body, ttl }`. Replay returns **that stored status and body**;
there is no hard-coded `200`. Remove the durable in-flight record/state. Two concurrent first
attempts may both reach the transaction, but the conditional idempotency put permits only one
commit; the cancelled contender performs a strongly consistent read with bounded retry for
the winning commit, then returns that record. If no winner committed, it may retry its own
whole transaction. A validation/domain failure commits neither domain data nor a success record.

Migrate every mutating POST already present after Phase 1 (including create, duplicate and
device registration) to the transaction-attached item. P2-12 and later endpoint tasks consume
the same repository option rather than rebuilding idempotency locally. Extend mutating
repository methods, including `OccurrenceRepository.put/delete`, to accept the shared
transaction builder/extra items before those endpoint tasks use them. The route registry's
classification becomes `mutates` for every mutating POST, not the narrower Phase 1 `creates`
meaning; read-only POST stubs remain explicitly non-mutating.

**Crash-shaped tests.** Integration tests inject a failure immediately after DynamoDB reports
the transaction committed but before the HTTP response reaches the caller, then replay the
same key and assert the original status/body with exactly one domain write. A `201` replay
stays `201`. Concurrent same-key requests produce one transaction commit and two identical
responses. An injected transaction cancellation stores neither item. Grep/registry tests
prove no mutating POST bypasses the middleware and no replay branch hard-codes `200`.

---

### P2-12 — The sole schedule write path and detail-UI migration

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/services/scheduleService.ts`,
`services/api/src/repositories/activityRepository.ts`,
`services/api/src/repositories/tx.ts`,
`services/api/src/repositories/{activityRepository,tx}.test.ts`,
`packages/shared/src/schemas/{activity,schedule}.ts`,
`packages/shared/src/client/endpoints/activities.ts`,
`packages/shared/src/recurrence/calendar.ts`,
`apps/mobile/src/features/activity/hooks/useActivity.ts`,
`apps/mobile/src/features/activity/components/{ActivityDetailScreen,RescheduleSheet}.tsx`,
and their existing tests.

**Approach.** `POST /v1/activities/:id/schedule` is the **single schedule write path**.
Its body is `{ date, time?, endTime?, timezone, occurrenceDate? }`; unschedule uses
`{ date: null }`. In the same task, remove `schedule` from the shared
`patchActivityInput` schema, update its tests so PATCH rejects schedule/unschedule fields,
add the typed client method, and migrate the already-built detail screen and its
`RescheduleSheet` callbacks from `detail.patch({ schedule: ... })` to the schedule client
method. The client method requires an `Idempotency-Key` allocated at enqueue and carried in
the persisted mutation variables. No temporary dual path is accepted.

The route is owner-only for ordinary activities: a participant gets `403` and a stranger
gets `404` under the authorisation policy in API contract §3.

- **Validation.** `time` requires `date`; `endTime` requires and must be after `time`
  (same-day) → `validation_failed`; `timezone` is IANA, falling back to
  `X-Client-Timezone` when omitted. `{ date: null }` removes `schedule` **entirely** —
  time, end time, timezone and derived instants.
- **Status is derived, never accepted.** After the mutation, terminal statuses remain the
  endpoint-owned terminal value; otherwise the service derives
  `schedule?.date ? 'scheduled' : 'saved'`. The request schema accepts no `status`.
- **One time conversion.** Delete any route- or API-local wall-time conversion and call
  shared `toUtcInstant` from `packages/shared/src/recurrence/calendar.ts` for
  `scheduledAtUtc` and `endAtUtc`. The helper's spring-gap rule is the product rule: the
  first valid wall time after the gap, not “add one hour”. The named test
  **`spring gap forwards 2026-03-08 02:30 America/New_York to 03:00`** locks it.
- **The bucket rewrite is atomic.** Because `schedule.date` is a P2-05 input, one
  `TransactWriteItems` writes `ACT#/META`, every owner/participant `ActivityIndex` row and,
  for a prep task whose derived status changes, its parent `SUB#` pointer row.
  Scheduling moves `N → S` or `P → S`; unscheduling moves `S → N` for a Task and `S → P`
  for a Plan.
- **Unscheduling deletes reminders as a separate idempotent, resumable step.** After the
  atomic META + index rewrite clears the date, the service deletes every `REM#` row in the
  Activity partition in bounded batches, records/resumes incomplete cleanup, and treats
  already-absent rows as success. It is not folded into the transaction: at the participant
  and per-user reminder caps that transaction cannot fit. Best-effort fire-and-forget cleanup
  is still not acceptable.
- **The RSVP reset ships now, reachable in Phase 6.** A date set or changed resets every
  non-declined participant to `pending`, clears `respondedAt`, and sets `rsvpForDate`; a
  time-only change keeps responses; clearing the date keeps them and clears `rsvpForDate`
  ([`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change)
  §7.1). That section is authoritative for transaction shape: through 45 participants the
  reset may join the write; above 45 it uses the documented two-phase
  `rsvpResetPending` path and bounded participant batches. The response carries
  `rsvpReset: true` only when a reset occurred.
- **`icsSequence` follows the API contract.** Compare the before/after exported fields and
  increment once when `schedule.date`, `schedule.time`, `schedule.endTime` or
  `schedule.timezone` changes, including set and clear. Repeating an identical request does
  not increment it. Never accept a client-supplied sequence.
- **Recurring series.** With `occurrenceDate`, validate that it is emitted by the stored rule.
  A same-day change writes one `Occurrence { status: 'rescheduled', overrideTime? }`. A body
  date differing from `occurrenceDate` must be no more than 60 calendar days away and writes
  the nominal `Occurrence { status: 'rescheduled', overrideDate, overrideTime? }` **plus** the
  collision-safe destination `MOVE#<overrideDate>` marker in one transaction; replacing or
  undoing a prior destination removes its marker reference in that transaction. Undo uses
  the same schedule endpoint with the occurrence's in-force segment date/time; when those
  values equal the unmodified occurrence, the service deletes the source override and marker
  reference instead of retaining a redundant `rescheduled` row. Both paths
  leave `META` byte-identical. Without `occurrenceDate`, a request against a series is
  `validation_failed`; all-future edits append a recurrence segment through PATCH under
  P2-04/P2-26 and never rewrite schedule history.
- `fromSuggestionId` belongs to the later date-suggestion phase and is not in this schema.
  Schedule is a mutating POST and requires the P2-38 `Idempotency-Key`; replay returns its
  stored original `2xx` without repeating the transaction or reminder cleanup.
- Callers in this phase are the existing detail UI, the reschedule sheet (P2-26), Snooze's
  `Tomorrow` option (P2-25), the overdue chip and `Do today` swipe (P2-29, P2-22).

**Tests.** Shared-schema and route tests prove PATCH rejects `schedule` while POST schedule
accepts it; the existing detail-screen test asserts its date change and clear now call
`POST .../schedule` and issue no PATCH. Integration proves schedule/unschedule rewrites
META and all index rows in one transaction with exactly one index row per user; proves the
parent `SUB#` status is rewritten in the same transaction for a prep task; proves the
§7.1 RSVP path at 45 and 46 participants; interrupts and resumes reminder cleanup without
leaving any dated reminder row; derives status and `icsSequence` exactly as above; resets
RSVP only for a date change; returns
participant `403` and stranger `404` without writes; and keeps META byte-identical for an
occurrence move. Calendar tests include case 15 plus the named 2026-03-08 02:30 spring-gap
test and assert both the 03:00 local result and its UTC instant. Cross-day tests assert the
source + marker transaction, collision with a normal destination occurrence, marker cleanup
on undo/replacement, acceptance at exactly 60 days and `validation_failed` at 61. A crash-
shaped replay reuses the enqueue-time key and observes one committed schedule mutation.

---

### P2-13 — `complete` and `uncomplete`

**Files.** `services/api/src/routes/activities.ts`,
`services/api/src/services/completionService.ts`,
`services/api/src/services/activityService.ts`,
`services/api/src/repositories/activityRepository.ts`,
`packages/shared/src/client/endpoints/activities.ts` (complete/uncomplete methods).

**Approach.** `POST /v1/activities/:id/complete` with `{ occurrenceDate?, outcome? }`.
P2-13 owns both typed client methods, including the compensating `/uncomplete` call used by
Undo; each accepts and sends an `Idempotency-Key`, and later mobile tasks consume them rather
than constructing request paths.

**Plan completion is owner-only.** Completion is **global**: an `Occurrence` records that *the thing happened*,
not that *somebody attended*, and it carries no participant identity by design
([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)
§4.5, ADR-048). A participant calling `complete`, `uncomplete`, `skip` or `snooze` on a plan
they can see gets **`403`** — not `404`, because they can already see it and hiding it would
be a lie.

Enforce it now, in this phase, while there is one user and nothing to break. Phase 6 makes it
reachable and walks it in the authorisation matrix (P6-28); it does not introduce it.

**ADR-051 — completion authority follows the object.** Prep tasks are the exception, and it costs one rule. Completion authority follows the
object: completing a *plan* asserts a shared fact about an event, but completing a *prep
task* ticks an item on a shared checklist. **Any participant of the parent plan may
complete, uncomplete and edit a prep task, whoever created it; the parent owner retains the
same inherited authority even when a participant created the child**
([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
§3, [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.4,
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md) §5.5). If Alice books
the hotel for a trip you are planning together, she ticks `Book hotel` whether or not she
typed it.

**One policy, two consumers.** P2-13 consumes
`deriveActionCapabilities(ctx)` from P2-10; it does not choose between
`assertActivityAccess(..., 'owner')` and `assertActivityAccess(..., 'write')`. Those fixed
levels cannot express “owner-only plan, parent-participant prep task” as one action rule.
Completion-route authorisation is therefore a two-stage service decision:

1. Resolve the Activity, the caller's relationship to it and, for a child, the caller's
   parent `ownerId` and participation in that parent through the repository. The parent owner
   is an authorised inherited owner even when somebody else created the child. A caller with
   no direct or inherited parent relationship receives `404` before any action verdict is exposed.
2. Pass that already-hydrated context to the pure function and assert the requested
   `complete`, `skip` or `snooze` boolean. A related caller whose boolean is false receives
   `403`; no repository read occurs inside the pure function.

P2-14 and P2-15 use this same guard for skip and snooze. The ordinary Phase 1
`assertActivityAccess` API remains the owner/read/write guard for routes whose policy really
is one of those levels; these action routes retire the single-level call rather than adding a
service-side second implementation. Phase 6 later walks the same rule with a real participant
(P6-28).

**Replay identity.** `complete`, `uncomplete` and `skip` require an `Idempotency-Key`. The
client allocates one key for each logical mutation when it is **enqueued**, outside
`mutationFn`, and persists it in the mutation variables. A transport retry, an offline resume
and a process-death replay reuse that exact key; replay returns the original stored `2xx`
response and does not execute the write again. The route registry must put all three routes
through the idempotency middleware even when the selected path updates rather than creates a
row; P2-14 owns the skip client method and route wiring under this rule.

Two paths, and their difference is the most important invariant in this phase:

| Body | Writes | Does **not** write |
| --- | --- | --- |
| No `occurrenceDate` | One transaction writes `ACT#/META` (`status: 'completed'`, `completedAt`, `outcome`), **every owner/participant `ActivityIndex` row's denormalised `status`** and, for a prep task, the parent `SUB#` pointer's status | No split or best-effort denormalised update |
| With `occurrenceDate` | **Exactly one Activity-domain item**, `ACT#<id>/OCC#<date>`, with `status: 'completed'`, `completedAt`; P2-38 also attaches the separate `IDEM#` response item | `ACT#/META`. Its `updatedAt` does not change. |

That second row's one-Activity-domain-item invariant is success criterion S6 and is asserted
by an integration test, not by inspection. Every mutating POST transaction additionally
contains P2-38's idempotency response record.

The first row follows the Phase 1 PATCH transaction pattern in
`services/api/src/repositories/activityRepository.ts`: compute all projected index rows
from the post-mutation Activity, then write META and the complete fan-out in one
`TransactWriteItems`, including the parent's `SUB#` pointer for a prep task. A response must
never expose completed META while an index or child pointer still says scheduled. `uncomplete`
uses the same transaction and derives the restored nonterminal
status from schedule presence; it does not accept a prior status from the client.

P2-13 also repairs the as-built Phase 1 PATCH omission: a title patch on a prep task currently
updates the child Activity/index rows but leaves the denormalised parent `SUB#` title stale.
Extend that existing PATCH transaction so every child-title change rewrites the pointer. This
is a baseline bug fix in this task, not a second child-detail read path.

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
- A second request with the same `Idempotency-Key` is a replay and returns the original `2xx`
  body; a later intentional completion allocates a new key even if the target is already in
  the requested state.
- The completed row moves from SCHEDULE to EARLIER TODAY on the same screen without a
  refetch — that is client work (P2-23), but the response shape must give the client
  everything it needs to do it without one.
- No follow-up suggestion is offered on a recurring completion. The next occurrence already
  exists.

**Tests.** Integration: completing and uncompleting a non-occurrence atomically update META
and every seeded owner/participant index status, using a transaction spy shaped like the
Phase 1 PATCH test; a forced transaction cancellation leaves all rows unchanged. Completing
an occurrence writes exactly one item in the `ACT#` partition (count the
partition before and after) and leaves `ACT#/META.updatedAt` byte-identical; tomorrow's
expansion still emits the series at its normal time; `uncomplete` on an occurrence deletes
the row; `outcome: 'didnt_go'` sets `status: 'skipped'`; completing twice is idempotent.

Plus authorisation, written against a seeded `PART#` row and a stubbed identity for that
participant while nothing yet creates one: **a participant's `POST .../complete` returns
`403` and writes nothing** — asserted by counting the partition before and after, so a
handler that returns `403` after writing fails. The same case for `uncomplete`, `skip` and
`snooze`, and the mirror case that a stranger gets `404` on all four.

Plus the parent-participant rule, on a seeded prep task whose `parentActivityId` points at
that shared plan: a participant who did **not** create the prep task completes it with `200`,
and `uncomplete` reverses it; the parent owner also receives `200` when another participant
owns the child; a stranger to the parent gets `404` on both. Both cases go through the same
helper, so a fix that special-cases the endpoint fails them. Completion/uncompletion assert
the parent `SUB#` status changed in the same transaction. A Phase 1-style title PATCH asserts
the child META and parent pointer titles change together and forced cancellation changes
neither.

Client and route tests allocate the key before invoking the mutation function, replay the
same complete and uncomplete requests with that key, receive the byte-equivalent original
`2xx` response and observe exactly one repository write. A resumed-mutation test in P2-33
proves the persisted variable carries the same key after process death.

---

### P2-14 — `skip`

**Files.** `services/api/src/services/completionService.ts`,
`services/api/src/routes/activities.ts`,
`packages/shared/src/client/endpoints/activities.ts` (skip method).

**Approach.** `POST /v1/activities/:id/skip` with `{ occurrenceDate? }`, per
[`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#54-skip) §5.4. Skip
says "not this one, and I do not want to be asked again". Authorisation comes from the pure
ADR-051-aware policy and two-stage service guard established in P2-10/P2-13: plan actions
remain owner-only, while the parent-plan participant rule applies to prep tasks. An unauthorised
participant gets `403` with nothing written and a stranger gets `404`.
P2-14 owns the typed skip client method; it requires an `Idempotency-Key` allocated when the
logical mutation is enqueued and carried in persisted variables. Gesture and optimistic tasks
call it rather than constructing the route locally. The route is registered with the same
idempotency middleware as complete/uncomplete; replay returns the original `2xx` and performs
no second write.

Two paths, on P2-13's exact pattern:

| Body | Writes | Does **not** write |
| --- | --- | --- |
| No `occurrenceDate` | One transaction writes `ACT#/META.status = 'skipped'`, **every owner/participant `ActivityIndex.status = 'skipped'`** and, for a prep task, the parent `SUB#` pointer status. The row leaves Today. | No split or best-effort denormalised update |
| With `occurrenceDate` | Exactly one Activity-domain item, `ACT#<id>/OCC#<date>`, `{ status: 'skipped' }`, via P2-07; P2-38 also attaches the separate `IDEM#` response item | `ACT#/META`. Its `updatedAt` does not change (S6). |

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
- The non-occurrence path uses the Phase 1 PATCH transaction pattern cited in P2-13:
  derive the complete post-write index projection and commit META plus every fan-out row in
  one `TransactWriteItems`, including the parent `SUB#` pointer for a prep task. Transaction
  cancellation leaves every row unchanged.

**Tests.** Integration: skipping an occurrence writes exactly one item in the `ACT#` partition (partition count
before and after) and leaves `ACT#/META.updatedAt` byte-identical; the same series'
other dates expand unchanged; a non-recurring skip flips `META.status` and every seeded
`ActivityIndex.status` in one transaction and the item leaves
the agenda response; skip then `uncomplete` restores `scheduled` / deletes the row; the
prep-task variant rewrites and restores the parent `SUB#` status in those same transactions;
skipped occurrence is emitted as `skipped_occurrence` and hidden by default in the agenda
merge (P2-08); forced transaction cancellation changes no META or index row; a participant
gets `403` with nothing written; a stranger gets `404`; replaying the same
`Idempotency-Key` returns the original `2xx` with exactly one repository write.

---

### P2-15 — One-off and occurrence `snooze` / `unsnooze`

**Files.** `services/api/src/services/completionService.ts`,
`services/api/src/routes/activities.ts`,
`packages/shared/src/schemas/occurrence.ts`,
`packages/shared/src/client/endpoints/activities.ts`.

**Approach.** `POST /v1/activities/:id/snooze` accepts
`{ occurrenceDate?, until }`, where `until` is `HH:mm` on the same day or an ISO instant.
Both snooze and unsnooze require an `Idempotency-Key` allocated when the mutation is enqueued
and stored in its variables. The storage target is determined only by `occurrenceDate`:

| Target | Snooze write | Undo / unsnooze write |
| --- | --- | --- |
| Non-recurring one-off (no `occurrenceDate`) | Update `ACT#/META.snoozedUntil`; status remains derived from schedule | `POST /v1/activities/:id/unsnooze {}` deletes the META snooze field |
| Recurring occurrence, same day | Write `Occurrence { status: 'snoozed', snoozedUntil }` and leave META byte-identical | `POST /v1/activities/:id/unsnooze { occurrenceDate }` deletes that snoozed `Occurrence` row |
| Recurring occurrence, cross-day ISO instant | In one transaction write the nominal snoozed `Occurrence` and add its date to destination `MOVE#<date>.movedFrom` | In one transaction delete the snoozed source and remove only its marker reference; delete an empty marker row |

This is the compensating operation required by interaction-contract §4.1: undo **deletes
the snooze fields**, it does not reschedule to a guessed prior time. Occurrence overrides
are series-only; a one-off must never manufacture an `OCC#` row. Both routes use the pure
capability policy and two-stage service guard from P2-10/P2-13; a snooze moves the item for
every viewer.

The concept's own example is the acceptance test:

```
Gym, normally 6:00 PM
Today   → snooze until 8:00 PM
Tomorrow → still 6:00 PM
```

**Edge cases.**

- Snooze is repeatable; a second snooze overwrites `snoozedUntil` on the same storage target.
  Moving it to a different date also removes the old marker reference in the same transaction.
- `unsnooze` is idempotent. It may delete an occurrence only when that row is a snooze;
  it never erases a completion, skip or reschedule override.
- `until` earlier than the current time is `validation_failed`.
- The effective date of an ISO `until`, computed in the Activity timezone, must be within 60
  calendar days of `occurrenceDate`; exactly 60 is accepted and 61 is `validation_failed`.
- Snooze is not offered on an undated or all-day task — there is no time to move.
- `Tomorrow` is deliberately absent for a recurring occurrence. Moving tomorrow's Gym into a
  day that already has one produces two rows for one series. For a non-recurring task,
  `Tomorrow` is a **reschedule**, not a snooze, and the client must call
  `/schedule`, not `/snooze`.

**Tests.** Integration covers both rows of the table. A one-off snooze writes META, creates
no `OCC#` item, renders at the effective time, and unsnooze deletes the field. A recurring
snooze writes one `OCC#` item and leaves `ACT#/META.updatedAt` byte-identical; the next day's
agenda shows the series time; unsnooze deletes only that occurrence; a second snooze updates
one target; a cross-day snooze writes source + collision-safe marker atomically, renders once
beside any normal destination occurrence, and unsnooze removes both without disturbing other
`movedFrom` entries; 60/61-day boundary tests and an `until` in the past `400` test pass. A
repository spy proves no `#R` query occurs on either mutation path. Replay tests reuse the
enqueue-time key and observe one committed write.

---

### P2-16 — Per-user reminders: items, endpoints, and the write paths

**Files.** `services/api/src/repositories/reminderRepository.ts`,
`services/api/src/services/reminderService.ts`,
`services/api/src/services/{scheduleService,scheduleService.test}.ts`,
`services/api/src/routes/activities.ts` (three routes),
`packages/shared/src/schemas/reminder.ts` (extend P1-06),
`packages/shared/src/client/endpoints/activities.ts` (reminder methods).

**What to build.** Extend the read-only `ReminderRepository` seam introduced by P2-08 with
the management surface for the `REM#<userId>#<reminderId>` items P1-09 already writes at
create time, and the validation that keeps them bounded. Do not create a second repository
or a second agenda-specific reminder reader.

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

**Creation idempotency.** `POST .../reminders` creates a server-id row and therefore requires
`Idempotency-Key` under API contract §1. Its typed client method accepts and sends the key,
generated once at the public action boundary. Replaying that key returns the original 2xx
response from the idempotency store. The duplicate-offset `409` is a separate business rule
for a distinct logical request with a different key; it is not the replay response.

**Edge cases.**

- Nothing here fires anything. Local scheduling is P2-34; server-side push is Phase 5
  (P5-13, P5-14).
- **Reminders require a date.** Creation and reminder-management writes reject a reminder
  when the activity has no `schedule.date`, and unscheduling deletes its reminder rows
  through P2-12's separate idempotent, resumable cleanup. This is the rule in
  `notifications.md` §2/§3; the Phase 1 compose store already behaves correctly and is not
  changed by this task.
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
rejected. Creating or adding a reminder to an undated activity is rejected, and
unscheduling a dated activity eventually deletes all of its reminder rows after an injected
mid-cleanup interruption and resume. Replaying the same reminder-creation idempotency key
returns the original 2xx body and id; a new key at the same offset returns the business-rule
`409`.

---

### P2-11 — `GET /v1/agenda`

**Approach.** Query parameters `from`, `to`, `tz`, `include` (comma-separated:
`anytime_unscheduled`, `overdue`, `reminders`). `include=reminders` attaches only the
authenticated caller's `REM#<userId>#` rows to activities emitted in the window; it never
returns another user's reminder. Window strictly capped at 62 days →
`400 validation_failed`. `ETag` hashes a canonical serialisation of the response's **`data`
payload only**; volatile envelope metadata such as `meta.requestId` never participates.
`If-None-Match` returns `304`. Response is client-cacheable for 60 s.

`warnings[]` carries `series_limit_exceeded` when the user has more than 200 active series
(a `200` with a warning, not an error) and the duplicate-occurrence warning from P2-08.

**Edge cases.** Today issues **exactly one** request:

```
GET /v1/agenda?from=<today>&to=<tomorrow>&tz=<tz>&include=anytime_unscheduled,overdue,reminders
```

Today renders `days[0]`; the second day remains part of the same response. P2-34's independent
background refresh is cadence-driven and is not started by rendering Today. Any feature
requiring a second request to render Today is rejected. That is success criterion S2 and it
is asserted by a Playwright network-count assertion, not by review.

**Tests.** A 63-day window `400`s; a 62-day one succeeds. `If-None-Match` with the current
`ETag` returns `304` with no body. The named test **`ETag ignores requestId`** builds two
byte-equivalent `data` payloads under different envelope request ids, asserts equal ETags and
asserts the second conditional request returns `304`. With two users' reminders on the same activity,
`include=reminders` returns only the caller's rows for the window. The Playwright assertion
counts exactly one Today-owned data request on a cold open; a background notification refresh
is neither triggered nor awaited by that render.

---

### P2-18 — Agenda client hook, ETag transport cache and query policy

**Files.** `apps/mobile/src/features/agenda/hooks/useAgenda.ts`,
`apps/mobile/src/features/agenda/keys.ts`,
`packages/shared/src/client/http.ts`,
`packages/shared/src/client/http.test.ts`,
`packages/shared/src/client/endpoints/agenda.ts` (add `getAgenda`).

**Approach.** The data layer between `GET /v1/agenda` (P2-11) and every screen in this
phase. Feature hooks are the only place `useQuery` appears and own their query keys
([`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §2.4 layer table).

- **The client method** is typed from the shared agenda schema (P2-10's
  `packages/shared/src/schemas/agenda.ts`) and parses the response through it — the same
  schema object the Lambda validated with, never a second shape.
- **One key helper.** `agendaKey(from, to, tz, include)` in `keys.ts` is the only
  constructor of agenda query keys, used by this hook, by every `onMutate` in P2-23, and by
  invalidation in P2-24. The key includes **every** parameter that changes the response;
  omitting `include` would make Today (all three tokens) and the Plans window (neither) collide
  in one cache entry, and the bug would look like phantom rows.
- **Today's call is the single request** from
  [`../01-product/today-and-tasks.md`](../01-product/today-and-tasks.md#1-what-today-is)
  §1: `from = today`, `to = tomorrow`, all three `include` tokens, one fetch. Today renders
  the first day; P2-34 does not consume this hook and owns a separate cadence-driven request.
  The hook exposes the whole response;
  sectioning is `partition.ts` (P2-19). No per-section fetches, ever — that is
  success criterion S2.
- **`tz` is the profile timezone** (transferred matrix case 29, now owned by P2-08 —
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
- **`ETag`/`If-None-Match` is transport-level and invisible to hooks.** The shared client
  keeps an in-memory `{ etag, body }` pair per authenticated-user GET request identity. Extend
  the existing `AuthTokenProvider` seam with
  `getIdentity(): Promise<string | undefined>` alongside `getToken()`. The Phase 2 local
  provider presents `usr_local_dev`, and P4-22's real provider presents the authenticated app
  `userId`. That identity is part of the key alongside the request path/parameters; a token
  string itself is never a cache key. When identity is absent, the transport neither stores
  nor reuses an authenticated response body.
  On a later GET it sends `If-None-Match`; `304` is a successful response resolved from the
  paired cached body, not an `ApiError`, schema failure or query error. A 304 without a
  paired body retries once without the conditional header. `HttpClient` exposes
  `clearCache()`, which empties every ETag/body pair without replacing the client instance.

  Phase 2 ships the identity-scoped mechanism and `clearCache()` but has no sign-out lifecycle
  to wire yet. P4-27 owns calling `apiClient.clearCache()` in the real sign-out sequence beside
  the Query/persisted-cache clear; P4-22 owns supplying the real identity through the same
  provider seam. Instance lifetime is not an auth boundary, and Phase 2 must not imply that it
  is one.

**Tests.** Unit: the key helper produces distinct keys for distinct `include` sets and
identical keys for identical inputs; a mounted hook for Today issues exactly one fetch
(mock transport call count); a response that fails schema parsing surfaces the query's
error state rather than partial data; crossing midnight (frozen clock advanced) re-keys to
the new date. Transport tests prove `200` stores the ETag/body pair, the next `304` returns
that body as success, no body parsing is attempted for 304, and hooks observe no distinction
between cached-304 and fresh-200 results. Two user ids requesting the same path never share
a pair; switching the provider's presented identity cannot retrieve the previous identity's
body. A direct `clearCache()` test empties every pair. Real sign-out wiring is P4-27's test,
not a Phase 2 acceptance path. The
end-to-end single-request assertion is Playwright's, in P2-37.

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
23:59, self-seeded in this task and asserting exact section membership each time. A render test asserting section order
and that an empty section is absent from the tree. A test that an undated
`{ objectKind: 'plan', type: 'event' }`, seeded alongside the local test data, renders in no section
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

**Files.** `apps/mobile/src/features/agenda/components/SwipeableRow.tsx`,
`apps/mobile/package.json`, `pnpm-lock.yaml`.

Declare `react-native-reanimated` as a direct mobile dependency in this task, at the
Expo-compatible version sanctioned in `tech-stack.md` §2.2. `react-native-gesture-handler`
is already direct; a transitive or lockfile-only Reanimated entry does not satisfy the
runtime dependency.

**Approach.** Implement §3.1 of
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) exactly.
Right reveals the row's single positive action; left reveals up to three secondary actions.
Full-swipe commits only the **first** action on that side and **never** a destructive one.

Every swipe action is additionally exposed as an `accessibilityAction` on the row, so it is
reachable without swiping. Nothing important is behind a gesture alone.

The gesture table supplies the type-appropriate candidates; the rendered set is their
intersection with `AgendaItem.capabilities`. `complete`, `skip` and `snooze` are shown only
when the corresponding server-derived boolean is true. The client never compares owner ids,
participant counts or parent links to reconstruct authorisation.

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
optimistic projection equals a locally recorded server response for the same mutation.

Optimistic mutations in this phase: task completion, occurrence complete/skip/snooze, and
reschedule.

**Tests.** For each function: a golden test comparing its output to a recorded server
response self-seeded in this task for the same input. Property test: applying and then
reversing a mutation returns the original object deep-equal.

---

### P2-24 — The undo toast system

**Files.** `apps/mobile/src/features/undo/**`, the existing
`apps/mobile/src/stores/toast.ts`, the existing
`apps/mobile/src/features/shell/components/ToastHost.tsx`, and the existing
`packages/ui/src/primitives/Feedback.tsx` Toast primitive and tests.

**Approach.** The model in
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §4:
reversible actions happen immediately with a **6-second** undo toast and no confirmation;
irreversible ones get a confirmation dialog and no undo; bulk reversible ones get 10
seconds.

The critical rule: **the network call fires immediately, not at the end of the window.**
Undo is a compensating call, not a delayed commit. This keeps the app correct when it is
closed mid-window. One toast at a time; a new action replaces the visible toast and commits
the previous one.

**Extend the Phase 1 singleton; do not create a second toast state machine.** Undo is a new
toast variant carried by the existing `useToast` one-visible-toast slot and rendered by the
already-mounted `ToastHost`. Its action is `Undo`; its lifecycle adds the commit callback the
current confirmation-only shape does not need. Showing a new toast commits the active undo
before replacing it, timeout/dismiss commits it once, and pressing Undo runs the compensating
action without also committing. Ordinary Phase 1 confirmation/error toasts continue through
the same store and host, so an Undo and a save confirmation cannot overlap or bypass each
other's replacement rule.

Toasts announce with `accessibilityLiveRegion="polite"`, the `Undo` button is focusable and
is inserted into the tab order immediately after the focused element for the window's
duration.

**Edge cases.** If the original call failed, the row reverts and the toast becomes an error
toast with `Retry` instead of `Undo`. Undo works offline — it is a local compensation plus a
queued call.

**Tests.** Extend the existing store/host tests: a second ordinary or Undo toast commits the
active Undo exactly once before replacement; timeout and dismiss commit exactly once; pressing
Undo compensates and never commits; legacy confirmation/error toasts still use the same slot.
Undo restores sort position and scroll offset; a failed original produces a `Retry` toast. Playwright: complete
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
| Non-recurring task, today, timed | `15 minutes`, `1 hour`, `3 hours`, `This evening (6 PM)`, `Tomorrow`, `Pick a time` | All but `Tomorrow` → `POST /v1/activities/:id/snooze` with `{ until }` and **no** `occurrenceDate`, so P2-15 writes META snooze fields. **`Tomorrow` → `POST /v1/activities/:id/schedule`** with tomorrow's date and the same time — moving a one-off task to another day *is* a reschedule (P2-12). |
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
  (P2-24); undo calls `POST /v1/activities/:id/unsnooze`, with `occurrenceDate` only for a
  series occurrence. P2-15 then deletes the META field for a one-off or the snoozed
  Occurrence row for a series, restoring the original time (§5.3 `Undo snooze`). The row re-sorts to its new effective time with the snooze glyph
  and `6:00 PM → 8:00 PM` treatment (P2-21).
- Snooze is repeatable: opening the sheet on an already-snoozed item snoozes from now and
  overwrites `snoozedUntil` (P2-15).
- Entry points: partial left swipe → `Snooze`, full left swipe → this sheet (gesture
  table §3.1). Options are buttons whose accessibility labels name the resulting time
  (`Snooze until 8:00 PM`), not just the offset.
- Never rendered when `AgendaItem.capabilities.snooze` is false. The server-derived
  capability covers a shared plan the user does not own while preserving the ADR-051 prep-
  task rule; the client never re-derives ownership, and the swipe that opens it is absent
  ([`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#31-today-and-agenda-rows)
  §3.1).

**Tests.** Unit: the option set for each of the three contexts matches the table;
`Tomorrow` dispatches `/schedule` with tomorrow's date and the unchanged time, never
`/snooze` (spy on the client); a one-off snooze omits `occurrenceDate`, a recurring dispatch
always carries it, and undo calls `/unsnooze` with the matching scope; at
19:00 the evening option is absent; each fixed option computes the correct `until` from a
frozen clock. Component: options are announced with their resulting time. The storage-side
guarantees are P2-15's integration tests, not repeated here.

---

### P2-26 — The reschedule sheet

**Files.** Extend the existing
`apps/mobile/src/features/activity/components/RescheduleSheet.tsx` and its existing tests;
do not recreate or fork the sheet under `features/agenda`.

**Approach.** Extend the Phase 1 component opened by tapping a date or time **anywhere** it
is rendered (U4). It never
edits in place on a row.

For a **recurring series** it presents a two-option sheet: `This occurrence only` /
`All future occurrences`. The first writes an `Occurrence` with `status: 'rescheduled'` and
`overrideTime` — plus `overrideDate` when the user moved it to a different day, which a
this-occurrence reschedule may do (P2-12, data-model §4.5). A cross-day move is capped at 60
calendar days and uses P2-12's atomic nominal override + destination marker write. The second
submits the append-only recurrence PATCH with top-level `editedFromDate` equal to the edited
occurrence's date — or omits it when the sheet was opened from series detail outside any
occurrence context. The server validates/derives the appended segment's `effectiveFrom` and
ignores the segment's client value. The new segment carries the new time as its `time`
snapshot; `schedule.time` mirrors the new active segment. Past segments and past
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

**Tests.** Integration: same-day `This occurrence only` writes one `OCC#` row; a cross-day
choice writes the source + destination marker transaction and leaves the series untouched;
`All future occurrences` sends `editedFromDate` outside `recurrence`, appends exactly one
server-anchored segment, leaves every earlier
segment byte-identical and leaves existing occurrence overrides intact; the 21st-segment
attempt surfaces the explanatory sheet, not a raw error.

---

### P2-27 — The repeat sheet

**Files.** `apps/mobile/src/features/activity/components/RepeatSheet.tsx` — it is a
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
  stored one plus one appended segment, and sends top-level `editedFromDate` when invoked
  from an occurrence. From series detail it omits that field. The server supplies the new
  segment's `effectiveFrom` and enforces the append-only property (P2-04) (decision recorded here — raise in PR if
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
`apps/mobile/src/lib/mutationKeys.ts`,
`apps/mobile/src/lib/persister.ts`,
`apps/mobile/src/lib/onlineManager.ts`,
`apps/mobile/app/_layout.tsx` (root hydration gate),
`apps/mobile/src/features/compose/hooks/useCreateActivity.ts`,
`apps/mobile/src/features/activity/hooks/{useActivity,useActivityActions}.ts`,
`packages/shared/src/client/endpoints/activities.ts`,
`services/api/src/services/activityService.ts`,
`services/api/src/repositories/activityRepository.ts`,
`apps/mobile/package.json`, `pnpm-lock.yaml`,
and their existing tests.

Declare `@tanstack/query-async-storage-persister`,
`@react-native-async-storage/async-storage` and `@react-native-community/netinfo` as direct
mobile dependencies here, at the versions recorded in `tech-stack.md` §2.2.

**Approach.** The three mechanisms in
[`../02-architecture/tech-stack.md#34-offline-and-optimistic-updates`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates):
a persisted query cache via `@tanstack/query-async-storage-persister`; optimistic updates
(P2-23); and a persisted mutation cache resumed with `resumePausedMutations()` on reconnect,
driven by `@react-native-community/netinfo`.

The root provider is hydration-gated: restoration of the persisted client completes before
feature queries mount, default mutation functions are registered before paused mutations can
resume, and the app renders the existing neutral loading shell during that bounded restore.
A best-effort module-scope restore racing mounted hooks does not satisfy cold-start offline
behaviour.

Register stable mutation keys and default mutation functions on the shared `QueryClient` for
**create, duplicate, delete, patch, schedule, complete, uncomplete, skip, snooze, unsnooze
and reminder-create** before hydration calls
`resumePausedMutations()`. A persisted mutation without a matching default is not resumable;
component-local `mutationFn` closures are insufficient after process death.

`mutationKeys.ts` owns the literal keys — `['activity', 'create']`,
`['activity', 'duplicate']`, `['activity', 'delete']`, `['activity', 'patch']`,
`['activity', 'schedule']`, `['activity', 'complete']`, `['activity', 'uncomplete']`,
`['activity', 'skip']`, `['activity', 'snooze']`, `['activity', 'unsnooze']` and
`['activity', 'reminder-create']` — and hooks
import them rather than constructing lookalikes. Those keys are persistence identifiers;
changing them is a stored-cache migration, not a refactor. The endpoint defaults call the
typed endpoint methods owned by P2-12 through P2-16; they do not reconstruct endpoint paths.

**Retry ownership: the transport is the only retry layer.** P2-33 changes the shared
`QueryClient` defaults to `retry: false` for both queries and mutations; the transport's
bounded retry policy remains untouched. Record in `queryClient.ts`'s doc comment that a
TanStack retry count of three wrapped around the transport's four attempts produces up to
16 HTTP attempts, which is why the layers must not both retry.

Remove the existing **mutation-level** `networkMode: 'always'` and `retry: false` overrides
from `useCreateActivity`, `useActivity`'s PATCH mutation and `useActivityActions`; those
mutations inherit the queue's `networkMode: 'offlineFirst'` and global `retry: false`.
Keep `useActivity`'s GET-query `networkMode: 'always'` / `retry: false` override and its
comment: it is what makes the explicit `Try again` action issue a request rather than remain
paused. Every mutating POST in the registry (create, duplicate, schedule, complete,
uncomplete, skip, snooze, unsnooze and reminder-create) carries an
`Idempotency-Key` generated **before** `mutationFn` runs — in the mutation variables/public
action boundary — and the default function reuses that stored key on every retry and replay.
Never generate a key inside `mutationFn`: resumed and retried calls must identify the same
logical write. Patch and delete also have stable keys/default functions even though they do
not use idempotency headers. For completion, “before `mutationFn`” means the checkbox action
allocates the key as it enqueues the optimistic mutation; a resumed default receives it from
the persisted variables rather than minting another.

**PATCH reconciliation after process death.** A resumed PATCH may receive `409` because the
first attempt committed and its `If-Match` is now stale. The default refetches the Activity
and compares the server's canonical values against the persisted intended partial patch. If
every intended field already has the intended value (including server-normalised recurrence
and its `editedFromDate` anchor), resolve success and refresh the cache; if any intended field
diverges, surface the conflict. Never turn every 409 into success.

**DELETE replay and server ordering.** Amend the existing Phase 1 cascade so child rows and
external pointers are removed first and `ACT#/META` is deleted last. An interrupted retry can
therefore still resolve the Activity and authorise the remaining cleanup. Once META is gone,
the Activity-delete default treats `404` as success because the requested terminal state is
already true. This is endpoint-specific reconciliation, not a transport-wide conversion of
all 404s into success.

**Platform difference, deliberate:** the mutation queue is **iOS only**. On web the
persisted cache is enabled but the queue is disabled and the app warns on unload if the
in-memory queue is non-empty. A browser tab is usually closed, not backgrounded; queued
mutations that never flush are worse than an error toast.

**Scope guard.** No SQLite mirror, no CRDT, no local recurrence expansion. Offline means
"read what you had, queue what you did", not "work indefinitely disconnected". The agenda is
a server-computed projection; reimplementing expansion against a local store would duplicate
the hardest logic in the product in a second place that can disagree with the first.

**Edge cases.** Queue cap of 200 pending mutations, then new writes are refused with
`You're offline and there's a lot waiting to sync.` Genuinely divergent queued PATCHes
returning `409` after reconciliation surface one banner naming the affected changes, not one
toast per change.

**Tests.** The named `offline-queue-relaunch.yaml` Maestro acceptance flow is owned by
P2-37's catalogue: airplane mode on, complete three tasks, kill the app, relaunch, airplane
mode off, assert all three land exactly once (verified by item count, since the idempotency
key should make a duplicate impossible even if the queue double-fires). P2-33 supplies its
testable hooks and fixtures. Unit/integration tests dehydrate and rehydrate one create,
duplicate, delete, patch, schedule, complete, uncomplete, skip, snooze, unsnooze and
reminder-create mutation, then prove
each resolves through its registered default function. Create/duplicate tests spy on a
transport retry and a resumed replay and assert the exact same `Idempotency-Key` is reused;
every other mutating POST makes the same assertion, and replays return the stored original
`2xx` with one server-side write. PATCH tests cover both already-applied success and genuine
divergence; DELETE tests interrupt after child cleanup, resume while META still authorises,
then treat the final replayed 404 as success. Grep tests inspect **mutation option
objects only** and assert they no longer set
`networkMode: 'always'` or `retry: false`. A separate assertion pins the `useActivity`
GET-query override so a broad grep-and-delete cannot remove it.

---

### P2-34 — Local notifications on device

**Files.** `apps/mobile/src/features/reminders/localSchedule.ts`,
`apps/mobile/src/lib/push.ts`, `apps/mobile/src/lib/push.web.ts`,
`apps/mobile/package.json`, `pnpm-lock.yaml`, and their tests.

Declare the Expo-SDK-compatible `expo-notifications` version as a direct mobile dependency
in this task, as recorded in `tech-stack.md` §2.2. `push.ts` is the iOS adapter used by local
scheduling; `push.web.ts` is an explicit no-op because `notifications.md` makes v1
notifications iOS-only. Keeping that fork at the sanctioned push seam prevents the agenda
or reminder feature from growing platform branches.

**Approach.** Push is Phase 5. This phase schedules **local** notifications with
`expo-notifications` from an eight-calendar-day agenda window, so an Activity seven days away
can still fire its maximum-offset reminder today and reminders work end to end on device
before any server-side scheduling exists.

The notification scheduler owns its cadence and request. On its background/startup refresh it
issues exactly one
`GET /v1/agenda?from=<today>&to=<today+7d>&tz=<tz>&include=reminders`, cancels previously
scheduled local notifications owned by the app and re-schedules from that response. It does
not consume `useAgenda`, piggyback on a Today render or issue per-Activity reminder-detail
requests. The eight inclusive dates cover the seven-day maximum negative offset.

Today still requests `include=anytime_unscheduled,overdue,reminders` once and renders from that
one response. The scheduler's cadence is independent: mounting or refreshing Today neither
starts nor awaits its background request, preserving P2-11/P2-18/P2-37's screen-owned
one-request rule.

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
reminders dropped) with the `expo-notifications` API mocked. A scheduler test asserts one
eight-day `include=reminders` agenda request per cadence tick, no Activity-reminder request,
and scheduling of a seven-days-away Activity whose reminder fires today. A Today component
test proves its cold render remains one request and does not trigger the scheduler. The named simulator
setup step **`Grant notification permission fixture`** runs before criterion 18: use
`xcrun simctl privacy booted grant notifications <bundle-id>` where that simulator runtime
supports it, otherwise an E2E-only Expo test hook grants the equivalent permission. The hook
is compiled/enabled only for the test profile and is not a product permission prompt. Manual
verification then advances the simulator clock and observes both timed and all-day delivery.

---

### P2-36 — Worked-example-day integration fixture and test

**Files.** `services/api/test/fixtures/workedExampleDay.ts`,
`services/api/test/integration/agenda.workedExample.test.ts`,
`packages/shared/src/fixtures/workedExampleDay.response.json` (the captured response),
`packages/shared/src/test-fixtures/index.ts`,
`packages/shared/package.json` (the `./test-fixtures` export),
`packages/shared/src/index.test.ts`,
and the P2-08 agenda-service, P2-19 partition and P2-23 optimistic-model tests migrated from
their self-seeded data.

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
- **The single Today request from §9.2**, `from=2026-08-06`, `to=2026-08-07`, all three
  `include` tokens. Seed one caller-owned dated
  reminder and assert it arrives in that response. Assert:
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
- **This task performs the migration.** P2-08, P2-19 and P2-23 entered the phase with
  self-seeded tests and no forward dependency. Once the canonical response is captured,
  P2-36 replaces those local fixtures with imports from the test-only
  `@od/shared/test-fixtures` subpath and deletes the superseded test data in the same change.
  The subpath has the normal conditional export-map entry and resolution test, so mobile
  never reaches across the workspace into `packages/shared/src` and depcruise remains green.

**Tests.** This task **is** the test; its deliverable is the passing suite plus the
committed response fixture. It runs in `pnpm test:int` against DynamoDB Local in
CI.

---

### P2-37 — E2E: Today flows on web and iOS

**Files.** Web: `e2e/specs/{complete-undo.spec.ts, reschedule.spec.ts,
a11y-keyboard.spec.ts}`. iOS: `apps/mobile/e2e/{add-and-complete.yaml,
snooze-occurrence.yaml, up-next-ticker.yaml, offline-queue-relaunch.yaml}`. Wiring:
`.github/workflows/ci.yml`, `.github/workflows/mobile.yml`.

**What to build.** The Today-owning subset of the fixed E2E catalogue in
[`../04-conventions/testing.md`](../04-conventions/testing.md#6-end-to-end) §6 — no flows
beyond the catalogue; E2E proves wiring, and the layers below already prove behaviour.

**Web, Playwright** (§6.1's rules: wait on a role or a network response, never
`waitForTimeout`; never assert on seed data). The Phase 4 per-user-fixture rule does not exist
yet: through Phase 3 every local request deliberately resolves as `usr_local_dev`. Each Phase 2
spec therefore creates rows with a unique per-spec prefix, asserts only on those rows and
deletes those rows in teardown. It never adds or sends `X-Dev-User`, another user-selecting
header or a dev-bypass auth mode; the fixed local identity is a security boundary, not a test
limitation to route around:

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
- `offline-queue-relaunch.yaml` — the fourth catalogue flow and criterion 15's owner:
  enable airplane mode, complete three tasks, kill and relaunch the app, restore networking,
  and assert exactly three server-side completions with no duplicates. It consumes P2-33's
  persisted-cache test hooks and verifies process-death replay end to end.

CI wiring per §6.2: Playwright runs in `ci.yml` on **every pull request** (retries: 1 in CI,
and a pass-on-retry is still flagged); Maestro runs in `mobile.yml` on
`workflow_dispatch` and **release tags** and gates the TestFlight submission, not the merge.

**Tests.** This task is tests. Its own acceptance is that criteria 6, 13, 14, 15 and 19's
end-to-end halves are asserted by these files and fail when deliberately broken (comment
out the undo handler locally; the suite must catch it).

## Acceptance criteria

1. `expandRecurrence` passes P2-02's 37 engine/calendar cases (numbered 1–24 and 31–43)
   plus 1,000 property-based cases, at **100% statement and branch coverage**, and CI fails
   if coverage drops below it. P2-08 passes the six transferred boundary cases 25–30.
2. A daily 18:00 task in `America/New_York` expanded across 7–9 March 2026 yields three
   dates whose derived UTC instants are 23:00Z, 23:00Z and 22:00Z — the wall clock is
   constant and the instant shifts. The named `spring gap forwards 2026-03-08 02:30
   America/New_York to 03:00` test passes through shared `toUtcInstant`.
3. A monthly series on `byMonthDay: [31]` expanded over January–June 2026 yields 31 Jan,
   28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun. A yearly series anchored on 29 February 2028
   expanded over 2028–2032 yields 29 Feb 2028, 28 Feb 2029, 28 Feb 2030, 28 Feb 2031 and
   29 Feb 2032, and its stored anchors and segment `effectiveFrom` are unchanged.
4. `POST /v1/activities/:id/complete { occurrenceDate }` writes exactly one item in the
   `ACT#<id>` partition (plus P2-38's separate idempotency record) and leaves
   `ACT#<id>/META.updatedAt` byte-identical, verified by reading the item before and after.
   Tomorrow's agenda still shows the series at its normal time.
5. Snoozing today's occurrence to 20:00 shows it at 20:00 today and at the series time
    tomorrow, and no query against the `#R` bucket occurs on the snooze path. Snoozing a
    one-off writes META snooze fields and no `OCC#` row; `unsnooze` deletes the matching
    fields/row for each scope without deleting another occurrence status. A cross-day move
    writes nominal `OCC#` + destination `MOVE#` atomically and renders exactly once; 60 days
    from nominal is accepted, 61 is `validation_failed`, and undo removes both references.
6. A cold open of Today issues **exactly one** data request, with
    `from=today`, `to=tomorrow` and
    `include=anytime_unscheduled,overdue,reminders`; Today renders the first day and that
    response includes only the caller's reminder rows for both days. This is asserted by a
    Playwright network-count assertion (success criterion S2). It does not trigger or await
    P2-34's independently-cadenced background refresh.
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
15. P2-37's `offline-queue-relaunch.yaml` flow completes three tasks with the device offline,
    kills the app and relaunches online, and observes exactly three server-side completions
    with no duplicates. Each resumed completion runs through the stable `complete` mutation
    default and reuses the `Idempotency-Key` stored when that mutation was enqueued.
16. A 63-day agenda window returns `400 validation_failed`; a 62-day one returns `200`.
17. An unresolved passed item shows its type's prompt today, and does not appear on Today
    tomorrow, carries no prompt in Plans, and is counted nowhere.
18. After P2-34's named **`Grant notification permission fixture`** simulator setup step, a
    single eight-day `include=reminders` agenda refresh schedules a local notification at the
    configured offset for a timed task seven days away and at 09:00 for an untimed one. The
    shipped Phase 2 app itself never prompts.
19. VoiceOver reads a timed task row as three elements in the order checkbox, body, time,
    with the labels in
    [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.2,
    and every swipe action is available as a rotor action.
20. The Plans tab renders a multi-day window from the same endpoint with one row per series
    per date, and does **not** send `include=anytime_unscheduled`. A non-recurring activity
    appears on exactly one date in that window, however many days it lasts in real life.
21. `deriveGsi1Bucket` passes all 24 post-merge matrix cases in P2-05 at 100% branch coverage, and is
    called from exactly one place in the codebase — asserted by a grep test that finds one
    caller and no second implementation of the rule.
22. An undated `{ objectKind: 'plan', type: 'event' }` has a `U#<u>#P` index entry, appears
    in **no** section of any agenda response with any combination of `include` tokens, and no
    query against `U#<u>#P` occurs on any agenda path. Changing its presentation type leaves
    it in `#P`.
23. An undated `{ objectKind: 'task', type: 'task' }` has a `U#<u>#N` index entry and appears
    in Today's ANYTIME section. Changing title text or presentation fields leaves it there;
    only an explicit `objectKind` change can move an undated Activity between `#N` and `#P`.
24. Giving the Plan in criterion 22 a date through `POST .../schedule` moves its index entry
    to `U#<u>#S`; clearing the date through the same route returns it to `U#<u>#P`, not to
    `#N`. The shared PATCH schema rejects `schedule`, and the existing detail UI sends no
    schedule PATCH.
25. Bumping `lastActivityAt` leaves `updatedAt` byte-identical, and a `PATCH` carrying the
    `If-Match` captured before the bump returns `200`, not `409`. Editing the title moves
    `updatedAt` and leaves `lastActivityAt` unchanged.
26. A caller identified as a **participant** on a seeded shared plan receives `403` from
    `complete`, `uncomplete`, `skip` and `snooze`, and the `ACT#<id>` partition has the same
    item count and the same `META.updatedAt` after the attempt as before it. A stranger
    receives `404` from the same four. On a **prep task** of that plan, which they did not
    create, the same participant receives `200` from `complete` and `uncomplete`, and a
    parent owner receives `200` even when a participant owns the child; a stranger to the
    parent receives `404`. The route guard and every projected
    `capabilities` object receive their verdict from the same pure
    `deriveActionCapabilities` function; projection performs zero authorization reads per
    AgendaItem.
27. `GET /v1/activities/:id/reminders` as user B, on an activity carrying two of user A's
    reminders, returns `[]`, and neither A's `offsetMinutes` nor A's reminder id appears
    anywhere in the serialised response. `POST`ing a fourth reminder as one user returns
    `422` while a fourth as the other user returns `201`.
28. Today's `+ Add a task` opens the Task form directly, the final action reads `Save task`,
    and the request contains `type: 'task'`. The same title entered through global
    `+` → `Plan` → `General` remains a `custom` Plan, proving the words do not route it.
29. A `#R` index row is never expanded until `ACT#<id>/META` has been included in the
    bounded hydration `BatchGetItem`. A 22:00 New York activity requested for the matching
    Tokyo day is found by the ±2-day scheduled query, appears on the following Tokyo date
    exactly once, and is filtered out of the adjacent response day. The named
    **`2026-01-01 23:30 UTC−12 becomes 2026-01-03 UTC+14`** case also passes for one-off and
    recurring rows and fails under ±1 widening.
30. Non-occurrence complete, uncomplete and skip mutations write META plus every
    owner/participant `ActivityIndex.status` and any parent `SUB#` status in one transaction;
    forced cancellation leaves every row unchanged. A prep-task title PATCH also rewrites its
    `SUB#` title, fixing the Phase 1 omission. Occurrence-scoped variants still leave META
    byte-identical. All three routes require an `Idempotency-Key`; replay returns the original
    `2xx` and performs no second write.
31. The shared HTTP client stores an ETag/body pair and resolves a later `304` as the cached
    success value, transparently to `useAgenda`; identities requesting the same URL cannot
    read one another's cached body, and `clearCache()` empties every pair. Two agenda envelopes
    with identical canonical `data` but different `meta.requestId` values have the same ETag.
    Persisted create, duplicate, delete, patch, schedule, complete, uncomplete, skip, snooze,
    unsnooze and reminder-create mutations resume through stable default functions, and every
    mutating POST reuses the exact original idempotency key. PATCH distinguishes already-
    applied state from true divergence; replayed DELETE treats post-cascade `404` as success.
32. P2-38's crash-shaped integration test loses the first HTTP response after the domain +
    idempotency transaction commits. Replay returns the stored original status and body
    (`201` remains `201`) with exactly one domain write and no durable in-flight state.

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
| **The recurrence engine is subtly wrong** and nobody notices for weeks | A user reports "my gym disappeared in March" or "the 31st skipped February" | P2-01 is built first and alone; P2-02's 37 engine/calendar cases (1–24, 31–43) plus property tests and an independent cross-check implementation; P2-08 owns boundary cases 25–30 plus the named UTC−12 → UTC+14 ±2-day test; 100% branch coverage is gated in CI; golden fixtures make a refactor fail loudly. |
| DST handled by adding milliseconds | Everything is right for ten months a year | Calendar arithmetic only, in `calendar.ts`; cases 15–19 include both hemispheres and a half-hour zone. A `+ 86400000` anywhere in `recurrence/` is a review rejection. |
| An occurrence-scoped snooze or complete writes `ACT#/META` | The visible result looks correct; the series' `updatedAt` churns and Phase 6's conflict detection starts firing spuriously | Success criterion S6, asserted by reading the item before and after; one-off snooze is the explicit META exception, while a repository spy asserts no `#R` query on either snooze path. |
| **The bucket rule is re-derived in a second place** — a client-side `type === 'task'` check, a service that builds an index entry by hand, or a filter in the agenda | An undated Plan appears on Today, or a Task vanishes from ANYTIME, and the two implementations disagree only for some inputs | One pure function (P2-05), one caller, a grep test asserting both. The agenda excludes `#P` by not querying it rather than by filtering it, so there is no filter to drop. |
| A write path changes `objectKind`, date or recurrence and forgets to rewrite the index entry | The activity is in the wrong tab and the stored row looks entirely correct | The three inputs are named in P2-05 and the rewrite happens in the same transaction as the write. Transitions 12–24 are tests, and the integration tests assert exactly one index entry after each. |
| **`lastActivityAt` is folded back into `updatedAt`** "because two timestamps is redundant" | An owner editing a plan gets a `409` because somebody RSVP'd, and the fix looks like it needs a merge engine | Acceptance criterion 25 fails immediately. The reason the fields are separate is in `data-model.md` §3.5 and is restated in P2-06. |
| A second request creeps into Today's cold open | Nobody notices until Today is slow on 4G | The Playwright network-count assertion is a gating acceptance criterion, not a review item. |
| The client's optimistic projection disagrees with the server | Rows visibly flip back a second after a tap | P2-23's golden tests compare the pure function's output to recorded server responses. |
| Overdue roll-forward mutates the activity | Plans shows the task on the wrong date; "Today owns no data" quietly stops being true | Roll-forward is a query rule with an explicit acceptance criterion asserting the stored date is unchanged after render **and** after completion. |
| The ticker runs while backgrounded | Battery complaints in TestFlight | Drive it from an `AppState` listener, not a bare interval. |
| Section sort order drifts between server and client | Rows reorder on refresh | Both use the sort keys in `today-and-tasks.md` §3.1, and `partition.ts` is tested against the same fixture the server integration test uses. |
| A badge or count for unresolved items is added "because it's useful" | The product becomes a nag | Acceptance criterion 11 plus a test that fails on a badge bound to an unresolved count. |
| The 62-day cap is enforced only on the client | A wide window times out the Lambda | Enforced server-side in the route validator and tested at 62 and 63. |
| **Per-participant completion is built by accident**, because "a participant should be able to tick their own row" reads as obviously right | An `OCC#<date>#<userId>` key, or an `attendedBy` array, appears in a Phase 2 pull request. In Phase 6 the agenda cannot say whose occurrence a row is | Completion of a **plan** is global and owner-only (ADR-048, amended by ADR-051). `Occurrence` has no user field and both route guards and agenda capabilities consume `deriveActionCapabilities`, with criterion 26 asserting the `403` and asserting **nothing was written**. The prep-task branch admits the child owner, parent owner or parent participant; it is not a per-participant occurrence. The real feature and its five-part cost are deferred in `../00-open-decisions.md` item 31. |
| **Reminders are scoped by a filter rather than by the key** | It works until one handler forgets, and the thing that leaks is a statement about somebody's day | The `sk` prefix is built from `c.get('userId')` (P2-16), so there is no id to get wrong. The only place a filter is needed is the plan-detail projection, which is one function with one test (P1-10 rule 6, criterion 24 of Phase 1). |
