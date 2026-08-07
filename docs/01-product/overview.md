# Product overview

**Status:** canonical for product intent. Derived from
[`original-concept.md`](original-concept.md). Where this document and the concept disagree
on *intent*, the concept wins and the conflict must be raised. Where they disagree on
*mechanics*, [`../02-architecture/data-model.md`](../02-architecture/data-model.md) and
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) win.

---

## 1. The promise

Ordinary Days is a personal life planner. It takes the things a person half-decides they
want to do — a show a friend recommended, a restaurant screenshot, a festival poster, the
form that needs submitting, dinner on Thursday — and carries each of them along a single
path from a vague intention to a thing that actually happened, including the coordination
with other people that most of them need. It is not a work tool and it does not organise
by project or priority. It organises by *when* and *with whom*, which is how ordinary life
is actually organised.

## 2. The lifecycle

Every feature in the product exists to serve one of six steps. If a proposed feature does
not sit on this line, it is out of scope.

| Step | What happens | Primary surfaces |
| --- | --- | --- |
| **Capture** | An intention enters the app with the least possible friction: typed text, a photo, a screenshot, a pasted link, or a chosen type. | Add button, [`ai-capture.md`](ai-capture.md) |
| **Organise** | It lands somewhere sensible with the right fields exposed: a List if there is no date, an Activity if there is. | [`activities.md`](activities.md), [`plans-and-lists.md`](plans-and-lists.md) |
| **Schedule** | It gets a date, and optionally a time. That is what makes it a Plan. | Activity detail, list-item scheduling |
| **Share** | People are added. App users get an in-app invitation; everyone else gets a link. | [`sharing-and-people.md`](sharing-and-people.md) |
| **Do** | It shows up on Today at the right moment with the right affordance. | [`today-and-tasks.md`](today-and-tasks.md) |
| **Follow up** | Completion offers the contextual next step: episode progress, expense review, the next occurrence, the next episode. Suggestions only. | [`plans-and-lists.md`](plans-and-lists.md), [`expenses.md`](expenses.md) |

The lifecycle is the same for a meal, a TV episode, a dentist appointment, a weekend trip,
and a reminder to call the apartment office. That uniformity is the product. Anything that
forks the lifecycle per type is a design failure.

## 3. The three-noun mental model

The user-facing vocabulary is exactly three words.

| Noun | User's question | What it actually is |
| --- | --- | --- |
| **Today** | What do I need to know or do today? | A query over Activities for one date. Owns no data. |
| **Plans** | What have I committed to, and when? | Activities that have a `schedule.date`. |
| **Lists** | What do I want to remember without committing to a date? | `List` + `ListItem`, a separate and deliberately simple entity. |

### Why it must stay three

1. **Three nouns fit in a tab bar and in a person's head.** A fourth noun (Meals, Watch,
   People, Expenses, Inbox) makes the product a bundle of mini-apps, which is precisely
   the failure mode the single-entity data model exists to prevent — see
   [`../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity`](../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity).
2. **The nouns are orthogonal, not overlapping.** Lists are the un-dated bucket, Plans the
   dated one, Today the slice of Plans that is relevant right now. Nothing is in two of
   them, so nothing needs to be kept in sync between them.
3. **Everything else is an attribute, not a place.** Meals, watching, expenses and people
   are properties of Activities, reached from the Activity, not destinations of their own.
   People is a *view*, reached from Profile or Search, never primary navigation
   (concept §22).

> **Decision:** the v1 navigation is exactly three tabs — Today, Plans, Lists — plus a
> persistent Add affordance and a Profile entry point in the header. People, Balances,
> Notification inbox and Settings all live under Profile. This is a navigation decision the
> concept implied but did not state.

## 4. Core principles

Each principle is written as a rule a reviewer or a test can check. A pull request that
violates one of these is rejected regardless of how good the feature is.

### 4.1 Types guide, never restrict

Activity `type` changes which fields the creation form shows and which verb the completion
button uses. It never blocks an action, never prevents scheduling, never hides an Activity
from Today, and can always be changed after creation.

- **Testable:** for every `ActivityType`, `POST /v1/activities/:id/schedule` succeeds;
  `PATCH /v1/activities/:id` with a new `type` succeeds; the Activity appears in
  `GET /v1/agenda` for its date. No handler branches on `type` to decide *whether* an
  operation is allowed.

### 4.2 Today owns no data

Today is a projection. It has no table, no rows, no user-editable ordering, and no state
that survives a rebuild of the view from Activities.

- **Testable:** deleting every cached response and re-querying `GET /v1/agenda` for a date
  reproduces the screen exactly. No write endpoint exists whose only effect is on Today.
  No entity in [`../02-architecture/data-model.md#3-key-schema`](../02-architecture/data-model.md#3-key-schema)
  is named for a day.

### 4.3 Tap a row opens detail, never mutates

A tap on the body of any row in any list navigates to that thing's detail screen. Mutation
requires a deliberate, separately hit-tested control: the checkbox, a swipe action, an
overflow item, or a button on the detail screen.

- **Testable:** the only mutating gestures in
  [`interaction-contract.md`](interaction-contract.md) originate from a control with its
  own accessibility element. Row `onPress` handlers call navigation only.

### 4.4 Suggest, never auto-create

The app may propose creating an Activity, a List, a list item, or a next occurrence. It
never writes one without an explicit user confirmation in the same interaction.

- **Testable:** no server endpoint creates an Activity as a side effect of another
  operation. `POST /v1/capture/*` returns a draft and never persists — see
  [`../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-7-stubbed-earlier).
  Marking a watch session complete does not create the next session. Completing a meal does
  not add groceries. Creating a trip plan does not create a packing list.

### 4.5 No unexplained numbers

Any aggregate the UI renders — a balance, a count, a total, a progress figure — must be
tappable, and the tap must reach the individual records that produced it.

- **Testable:** every numeric aggregate in the UI has a corresponding endpoint that returns
  its constituent rows. `GET /v1/people/:id/balance?include=expenses` is the canonical
  example; see [`expenses.md`](expenses.md) §5.

### 4.6 No category management

`ActivityType` is a closed enum of six values. There is no UI to create, rename, delete,
reorder, colour, or nest a type. `custom` is the escape hatch and is deliberately generic.
The same holds for `ListKind`: eight kinds, closed, of which `general` is one.

- **Testable:** no endpoint accepts a user-defined type or kind string. No settings screen
  contains a type editor. Search the client for a "manage categories" route: there is none.

## 5. Target user and jobs to be done

**Target user.** An adult organising a non-work life that involves other people. They have
a calendar for appointments and a notes app full of half-captured intentions, and nothing
connects the two. They are not managing a team and will not tolerate a tool that asks them
to configure it before it is useful. v1 assumes a single timezone per user, a single
currency per user, and English.

The three jobs:

| # | Job | Success looks like |
| --- | --- | --- |
| 1 | **"I keep losing the things I said I'd do."** Capture an intention in seconds, from anywhere, without deciding where it goes. | The item exists, is findable, and resurfaces at the right time without the user maintaining anything. |
| 2 | **"I want to actually do the things I saved."** Turn a saved intention into a dated commitment, and see the small number of things that matter today. | Today answers "what now?" in one screen and one glance, with no triage. |
| 3 | **"Doing things with people is the hard part."** Invite people without requiring them to install anything, keep everyone on one source of truth, and settle up afterwards. | A guest RSVPs from a link in under 30 seconds; nobody has to reconstruct who paid for what. |

## 6. Non-goals

These are refusals, not backlog items. Each is listed because the product's shape makes it
tempting.

| Not this | Because |
| --- | --- |
| **Jira / Asana / a task manager** | No projects, priorities, tags, labels, statuses beyond the five in `ActivityStatus`, assignees, estimates, boards, or sprints. Life is not a backlog. |
| **Notion / a wiki** | No nested pages, databases, templates, formulas, or custom fields. The schema is fixed on purpose. |
| **A nutrition tracker** | Meals carry a title, a slot, people and ingredients. No calories, macros, weights, portions, or recipe steps and scaling. |
| **Trakt / TV Time** | No catalogue, no metadata provider, no ratings, no reviews, no discovery feed. Watch entries are free text. The differentiator is *what → when → with whom*, not tracking depth. |
| **A social network** | No followers, feeds, likes, comments-on-strangers, public profiles, friend requests, or relationship scores. People are derived from shared plans only. |
| **A payments app** | No bank links, no card processing, no Venmo/PayPal integration, no budgets, no financial analytics, no multi-currency conversion. The app records that something is settled; it does not move money. |
| **A calendar client** | The app exports `.ics` and calendar links. It does not two-way sync, does not read the user's existing calendar, and does not attempt to be their primary calendar in v1. |

See also
[`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1),
which is the enforcing list at the storage layer.

## 7. Success criteria for v1

Observable, measurable, and checked before v1 is called done. Latency figures are p95 on a
warm Lambda over a 4G connection with an iPhone 13 or newer.

| # | Criterion | How it is measured |
| --- | --- | --- |
| S1 | **Capture to saved in under 5 seconds.** From tapping Add on Today to a saved Activity, for a typed title with no other fields. | Maestro flow timed end to end, median of 10 runs on device. |
| S2 | **Today loads in one API call.** A cold open of Today issues exactly one `GET /v1/agenda?...&include=anytime_unscheduled` and no other data request. | Playwright network assertion on web; a request-count assertion in the API client's test harness. |
| S3 | **Today renders in under 1.0 s from cache and under 2.0 s cold.** | Instrumented client timing from mount to first painted row. |
| S4 | **A guest can RSVP with no account in under 30 seconds and three taps** from opening the invite link. | Playwright flow against `/public/v1/invites/:token`, timed. |
| S5 | **Zero unexplained aggregates.** Every number rendered in the UI has a drill-down path. | Manual review checklist plus a lint rule: a `<Balance>`/`<Aggregate>` component must be passed an `onPress`. |
| S6 | **Completing one occurrence of a recurring task never mutates the series.** | Unit tests in `packages/shared` plus an integration test asserting `ACT#/META` `updatedAt` is unchanged after `POST /v1/activities/:id/complete` with `occurrenceDate`. |
| S7 | **Money reconciles exactly.** For any expense with any split mode, the sum of `splits[].amountCents` equals `amountCents`. | Property-based test over random amounts and participant counts, near-100 % coverage required by the brief. |
| S8 | **The public invite projection leaks nothing.** The response for `/public/v1/invites/:token` contains no expense, no note, no participant email, and no other activity. | Snapshot test with an explicit allow-list of keys; the test fails on any added key. |
| S9 | **Nothing is scheduled without confirmation.** No code path from a capture response to a persisted Activity exists without a user action. | Integration test: a capture response alone produces zero writes. |
| S10 | **A new user reaches a populated Today within 3 minutes of first launch** with no configuration screens beyond timezone confirmation. | Onboarding walkthrough, timed, on a clean install. |

> **Decision:** S3, S4 and S10 set numeric targets the concept did not specify. They are
> chosen to be achievable on the locked stack rather than aspirational; revise them with
> evidence, not opinion.

## 8. Related documents

| Document | Covers |
| --- | --- |
| [`activities.md`](activities.md) | The Activity concept, the Add experience, per-type creation forms, lifecycle and completion verbs. |
| [`today-and-tasks.md`](today-and-tasks.md) | The Today screen, tasks, recurrence, passed plans, overdue handling. |
| [`plans-and-lists.md`](plans-and-lists.md) | Plan detail anatomy, the eight list kinds, the Lists ↔ Plans bridge, meals and watching. |
| [`sharing-and-people.md`](sharing-and-people.md) | Participants, invitations, guests, the public invite page, the People layer. |
| [`expenses.md`](expenses.md) | Expenses on shared plans, splits, balances, settlement. |
| [`ai-capture.md`](ai-capture.md) | Natural-language capture, image-to-event, link parsing. Phase 7. |
| [`notifications.md`](notifications.md) | Categories, defaults, timing, quiet hours, the inbox, copy. |
| [`interaction-contract.md`](interaction-contract.md) | Gestures, states, undo, accessibility, web equivalents. |
