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

This is the lifecycle of an **intention**. It is not the lifecycle of a list. A list can
feed it, can be produced by it, or can sit entirely outside it and still be doing its job
(§3.1).

| Step | What happens | Primary surfaces |
| --- | --- | --- |
| **Capture** | The user first names the object they are creating — **Task**, **Plan**, or **List item** — then enters its details by text, photo, screenshot, or link. | Add button, [`ai-capture.md`](ai-capture.md) |
| **Organise** | The chosen object opens with the right fields. A Plan additionally requires an explicit kind: **General**, **Meal**, **Watch**, **Event**. Words and automatic capture never make either choice. | [`activities.md`](activities.md), [`plans-and-lists.md`](plans-and-lists.md) |
| **Schedule** | It gets a date, and optionally a time. Until then a plan waits in Plans → Needs a date; only a dated plan can reach Today. | Activity detail, list-item scheduling |
| **Share** | People are added — to a plan, or to a list. App users get it in their app; someone invited to a plan without an account gets a link. | [`sharing-and-people.md`](sharing-and-people.md) |
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
| **Plans** | What am I intending, and when? | Activities that are intentions rather than possibilities — three stages: Needs a date, Upcoming, Past. |
| **Lists** | What do I want to keep together? | `List` + `ListItem`, a separate entity with its own reason to exist. Shareable, like a plan. |

### Why it must stay three

1. **Three nouns fit in a tab bar and in a person's head.** A fourth noun (Meals, Watch,
   People, Expenses, Inbox) makes the product a bundle of mini-apps, which is precisely
   the failure mode the single-entity data model exists to prevent — see
   [`../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity`](../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity).
2. **The nouns answer different questions, and each stands on its own.** Lists answer "what
   do I keep together?", Plans "what have I committed to?", Today "what now?". A thing can
   be in a list *and* be an activity, and when it is, the two rows are linked rather than
   copied ([`plans-and-lists.md`](plans-and-lists.md) §6.1) — one title, one source of
   truth, no sync problem.
3. **Everything else is an attribute, not a place.** Meals, watching, expenses and people
   are properties of Activities, reached from the Activity, not destinations of their own.
   People is a *view*, reached from Profile or Search, never primary navigation
   (concept §22).

> **Decision:** the v1 navigation is exactly three tabs — Today, Plans, Lists — plus a
> persistent Add affordance and a Profile entry point in the header. People, Balances,
> Notification inbox and Settings all live under Profile. This is a navigation decision the
> concept implied but did not state.

### 3.1 Four concepts, connected where it is useful

The three nouns are what the user sees. Underneath them are **four concepts**, and the
relationships between them are optional edges, not pipeline stages. There is no
`Lists → Plans → Today` pipeline. Anything that treats one as the definition of the others
is wrong.

The distinction between a task, a plan, a List, and a list item is chosen **before** details
are entered. It is not inferred from the title, a date, a person, a source image, or a model:

> **The entry point, or an explicit Task / Plan / Add list choice, determines what is
> created. A date changes scheduling state, not identity.**
>
> A **Task** is stored as an Activity with `objectKind: 'task'`, `type: 'task'`. A **Plan**
> is stored as an Activity with `objectKind: 'plan'`; its explicitly chosen kind maps to
> `custom`, `meal`, `watch`, `event`. **Add list** opens the unselected List-type catalogue.
> A **List item** is stored as a `ListItem` only after the contextual entry point inside its
> destination List fixes that identity.

This is the rule for the whole document set, stated here once and canonical in
[`../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity`](../02-architecture/data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity).
Every other product document points at it rather than restating it. No document may say that
a date creates a plan, that scheduling turns an Activity into one, or that clearing a date
un-plans it: an undated plan is a plan waiting for a day.

| Concept | What it is | What it needs from the others |
| --- | --- | --- |
| **Lists** | Things the user wants to keep together. Groceries, restaurants they love, books, a packing list. Shareable. | Nothing. A list that never produces an activity is complete and finished. |
| **Activities** | Tasks and Plans. The one schedulable entity. Created only after the user chose Task or Plan, or explicitly chose `Plan this item` on a list item. | Nothing. Most activities never touch a list. |
| **Plans** | An Activity created as a Plan, with an explicit kind: General, Meal, Watch, Event. A date is not required. | An Activity. That is all a plan is. |
| **Today** | What matters now. A query, never storage. | Activities for one date. |

```
           Global +                         Labelled contextual action
              │                         Add task / prep task / list item
              ▼                                      │
     required unselected choice                      │
       Task / Plan / Add list                        │
              │                                      │
        explicit target                              │
       ┌──────┼──────────┐                           │
       ▼      ▼          ▼                           ▼
     Task    Plan     List catalogue             List item
 objectKind: task objectKind: plan              current List fixed
       │      │          │                           │
       └──┬───┘          └─────────────┬─────────────┘
          ▼                            ▼
     Activities                      Lists
                             │                        │
                             │◀ ─ ─ (a) ─ ─ ─ ─ ─ ─ ┤
                             ├─ ─ ─ (b) ─ ─ ─ ─ ─ ─▶│
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
             Needs a date          Upcoming
                                      │ that date is today
                                      ▼
                                    Today

            (c) share ── one People layer, reaching Lists and Plans alike

   (a) Plan this item     (b) generate a list   ─ ─ optional, in both directions
```

An Activity created with a date goes straight to Upcoming; the Needs-a-date stage is a place
to sit, not a gate to pass through.

Three optional edges, and that is all of them:

- **Plan this item.** A viewer creates one Plan Activity plus a viewer-local `LNK#` pointer;
  the shared ListItem stays byte-identical. Compatible values copy into the draft once and
  then diverge safely ([`plans-and-lists.md`](plans-and-lists.md) §6.1).
- **Generate a list.** A plan can produce a supporting list, on confirmation only, and the
  list outlives the plan ([`plans-and-lists.md`](plans-and-lists.md) §4).
- **Share.** Plans and Lists are both shareable, through **one** People layer — one contact
  model, one picker, one `Share` affordance. What differs is the meaning: a plan asks "are
  you coming?" and stores an RSVP; a list asks nothing and membership is binary
  ([`sharing-and-people.md`](sharing-and-people.md) §1). A shared plan **suggests** sharing
  the lists it generates and never does so automatically.

An undated plan and an undated list item are not the same thing waiting at different stages.
The words `Try Zahav` can title either one: choosing **Plan → Event** creates an undated
plan; choosing **List item → Restaurants to try** creates a list item. Adding Alice later is
an explicit sharing action; her name in typed text never makes the choice. Neither object
promotes into the other ([`plans-and-lists.md`](plans-and-lists.md) §1.2).

## 4. Core principles

Each principle is written as a rule a reviewer or a test can check. A pull request that
violates one of these is rejected regardless of how good the feature is.

### 4.0 Intent is explicit before assistance

The global `+` opens exactly three choices: **Task**, **Plan**, and **List item**. A
contextual action fixes that same choice in its label — `+ Add a task`, `+ Add an item`, or
`+ Add prep task`. Plan then requires an explicit **General**, **Meal**, **Watch**,
**Event** choice. Nothing is pre-selected, including General.

General `New list` likewise requires an explicit style choice from the full catalogue before
its editable title appears. A typed destination the user already chose may show only eligible
styles—for Watch, the three Watch styles—but still begins unselected. List names never
select, suggest, rank, or change a template.

Only after those choices may automatic capture suggest compatible field values. It never
suggests or changes object kind, Plan kind, people, sharing, list destination,
reminder/notification state, or whether to save. Reminder remains a separate visible control
or the user's explicitly saved default. Final buttons name the write: `Save task`, `Save
plan`, or `Add to <list name>`.

- **Testable:** the same text entered after each global choice writes the selected object;
  capture responses contain no actionable object-kind, Plan-kind, participant, sharing,
  destination, or reminder suggestion; with schedule fields held equal, adding `remind me`
  wording leaves the Reminder control byte-identical (only the user's saved-default rule may
  populate it); and every creation request follows a user action whose accessible label names
  its object and destination.

### 4.1 Types guide, never restrict

Within `objectKind: 'plan'`, Activity `type` changes which fields the form shows and which
completion verb it uses. It never blocks a Plan action, prevents scheduling, or hides a Plan
from Today, and the user may explicitly change it among General, Meal, Watch, Event, and
Event. `objectKind` does carry a real boundary: Tasks have checkboxes and never gain their
own participants or expenses; coordinated work is an explicit Plan, usually General. A prep
Task may inherit access from its parent Plan, but that parent relationship is explicit and
does not turn the Task into a directly shared object.

- **Testable:** every Task and Plan kind can be scheduled and appears in `GET /v1/agenda`
  for its date; a Plan-kind-only change leaves `objectKind` unchanged; Task ↔ Plan changes
  occur only through the explicit conversion flow; Task creation rejects participants and
  expenses; and no AI or field edit changes either choice.

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
never writes one without an explicit user confirmation in the same interaction. The rule
extends to **changing** something the user did not touch: completing an activity never
alters its source list item, and no operation on one object silently writes another. The
full statement, with the list of every place it applies, is
[`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.2, and
it is stated once there rather than re-derived per feature.

- **Testable:** no server endpoint creates or mutates a second entity as a side effect of
  another operation. `POST /v1/capture/*` returns a draft and never persists — see
  [`../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier`](../02-architecture/api-contract.md#211-capture--phase-8-stubbed-earlier).
  Marking a watch session complete does not create the next session and does not move the
  watchlist item's progress. Completing a meal does not add groceries. Completing an event
  does not check the list item it came from. Creating a trip plan does not create a packing
  list, and creating a list from a shared plan does not share it with that plan's people.

### 4.5 No unexplained numbers

Any aggregate the UI renders — a balance, a count, a total, a progress figure — must be
tappable, and the tap must reach the individual records that produced it.

- **Testable:** every numeric aggregate in the UI has a corresponding endpoint that returns
  its constituent rows. `GET /v1/people/:id/balance?include=expenses` is the canonical
  example; see [`expenses.md`](expenses.md) §5.

### 4.6 No category management

`ActivityType` is a closed enum of six values. There is no UI to create, rename, delete,
reorder, colour, or nest a type. `custom` is the escape hatch and is deliberately generic.

List **behaviour** is the same shape: a closed enum of three — `collection`, `watch`,
`meals` — and there is no UI to add a fourth. List **templates** are unbounded, but they are
shipped configuration, not a category system: the user picks one at creation and can change
the resulting list's capabilities afterwards, but cannot define, name, or manage a template.
See [`plans-and-lists.md`](plans-and-lists.md) §5.2 and §5.3.

- **Testable:** no endpoint accepts a user-defined type or behaviour string, and
  `POST /v1/lists` accepts `templateKey` only from the shipped catalogue. No settings screen
  contains a type editor or a template editor. Search the client for a "manage categories"
  route: there is none.

### 4.7 Lists are destinations, not staging areas

A list is a complete thing in itself. A list that never produces an activity has not failed
at anything, and the product never implies otherwise.

- **Testable:** no list-level progress indicator, completion percentage, unscheduled-item
  count, or "ready to plan these?" prompt exists in the client. No copy anywhere describes a
  list as holding things *until* something else happens, and no scheduled job archives,
  hides or nudges a list for being inactive. `Schedule` is never a list's empty-state
  action. See [`plans-and-lists.md`](plans-and-lists.md) §5.1 and §5.9.

## 5. Target user and jobs to be done

**Target user.** An adult organising a non-work life that involves other people. They have
a calendar for appointments and a notes app full of half-captured intentions, and nothing
connects the two. They are not managing a team and will not tolerate a tool that asks them
to configure it before it is useful. v1 assumes a single timezone per user, a single
currency per user, and English.

The three jobs:

| # | Job | Success looks like |
| --- | --- | --- |
| 1 | **"I keep losing the things I said I'd do."** Capture an intention in seconds, from anywhere, after one plain-language choice: Task, Plan, or List item. | The chosen object exists, is findable, and resurfaces at the right time without hidden routing or naming rules. |
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
| **A social network** | No followers, feeds, likes, comments-on-strangers, public profiles, friend requests, or relationship scores. People arise from explicitly shared Plans or Lists, plus contacts the user adds manually; there is no social graph. |
| **A payments app** | No bank links, no card processing, no Venmo/PayPal integration, no budgets, no financial analytics, no multi-currency conversion. The app records which selected expense-person obligations the user marked settled; it does not move money. |
| **A calendar client** | The app exports `.ics` and calendar links. It does not two-way sync, does not read the user's existing calendar, and does not attempt to be their primary calendar in v1. |

See also
[`../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1`](../02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1),
which is the enforcing list at the storage layer.

## 7. Success criteria for v1

Observable, measurable, and checked before v1 is called done. Latency figures are p95 on a
warm Lambda over a 4G connection with an iPhone 13 or newer.

| # | Criterion | How it is measured |
| --- | --- | --- |
| S1 | **Capture to saved in under 5 seconds.** From tapping Today's `+ Add a task`, or global `+` then `Task`, to a saved Task for a typed title with no other fields. | Maestro flow timed end to end, median of 10 runs on device. The request includes `objectKind: 'task'`, `type: 'task'`; the client never relies on a server default. |
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
| [`plans-and-lists.md`](plans-and-lists.md) | The Plans tab's three stages, plan detail anatomy, what lists are for, the three list behaviours and the template catalogue, default destinations, shared lists, the optional list ↔ activity bridge, meals and watching. |
| [`sharing-and-people.md`](sharing-and-people.md) | Participants, invitations, guests, the public invite page, list members, the People layer. |
| [`expenses.md`](expenses.md) | Expenses on shared plans, splits, balances, settlement. |
| [`ai-capture.md`](ai-capture.md) | Natural-language capture, image-to-event, link parsing. Phase 8. |
| [`notifications.md`](notifications.md) | Categories, defaults, timing, quiet hours, the inbox, copy. |
| [`interaction-contract.md`](interaction-contract.md) | Gestures, states, undo, accessibility, web equivalents. |
