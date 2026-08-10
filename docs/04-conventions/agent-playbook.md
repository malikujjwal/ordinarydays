# Agent playbook

**Status:** the operating manual for a coding agent working on this repository. Read this
before your first task and re-read §2, §6 and §8 whenever you are unsure.

This document ranks **below** the product specs and the architecture docs (§2). It tells you
how to work; they tell you what is true. If this playbook and a canonical doc disagree, the
canonical doc wins and you raise the conflict.

---

## 1. Start-of-task protocol

### 1.1 Find your task ID

Every unit of work has an ID of the form `P<phase>-<task>` — `P2-07`, `P5-11` — defined in
`docs/03-implementation/phase-<n>.md`. **Only the ten phase files named in
`docs/00-index.md` define task IDs**; if any other file matching `phase-*.md` exists in the
repo, it is superseded and must not be scheduled from. You are given one. If you were not
given one, stop and ask; do not invent one, and do not start work "to be helpful".

Your task ID determines your branch (`git-workflow.md` §1.1), your commit footer, your PR
title, and the scope you are allowed to touch.

### 1.2 Read the right docs

Do not read all 11,000 lines of `docs/`. Read the rows that match your task, in order. Every
path is relative to `docs/`.

| Working on… | Read, in this order |
| --- | --- |
| **Anything at all** | `01-product/overview.md` §2–§4 (the lifecycle, the three nouns, the five principles) · this playbook §2, §6 |
| **A screen or any UI** | `01-product/interaction-contract.md` (all of it) · `04-conventions/design-system.md` · the product doc for that surface (below) · `02-architecture/tech-stack.md` §3 |
| **Today, tasks, agenda rendering** | `01-product/today-and-tasks.md` · `02-architecture/api-contract.md` §2.2 · `02-architecture/data-model.md` §6 |
| **The Add screen, activity creation, type behaviour** | `01-product/activities.md` · `02-architecture/api-contract.md` §2.3 · `02-architecture/data-model.md` §4.1, §4.4 |
| **Plans, prep tasks, Lists, the Lists↔Plans bridge** | `01-product/plans-and-lists.md` · `02-architecture/data-model.md` §4.6 · `02-architecture/api-contract.md` §2.7 |
| **Recurrence** | `02-architecture/data-model.md` §4.2, §4.5, §6 · `01-product/today-and-tasks.md` · `04-conventions/testing.md` §2.2 |
| **People, sharing, invites, RSVP** | `01-product/sharing-and-people.md` · `02-architecture/api-contract.md` §2.4, §2.10 · `02-architecture/data-model.md` §4.7, §4.9 · `02-architecture/security-privacy.md` §1 rows 3, 13 |
| **Date suggestions on an undated plan** | `02-architecture/data-model.md` §4.3a · `02-architecture/api-contract.md` §2.4b, §3 · `02-architecture/decisions.md` ADR-049 |
| **Shared lists: members, roles, invites** | `01-product/plans-and-lists.md` §5.11 (behaviour) · `02-architecture/data-model.md` §3.3, §4.6 (storage) · `02-architecture/api-contract.md` §2.7, §3 |
| **Expenses, balances, settlement** | `01-product/expenses.md` · `02-architecture/data-model.md` §4.8 · `02-architecture/api-contract.md` §2.9 · `04-conventions/coding-standards.md` §3 |
| **An API endpoint** | `02-architecture/api-contract.md` (all) · `02-architecture/data-model.md` §5, §7 · `02-architecture/tech-stack.md` §4 · §7 below |
| **A repository or a key design** | `02-architecture/data-model.md` §3, §5, §7, §9 · `04-conventions/testing.md` §3 |
| **Auth, tokens, sessions** | `02-architecture/auth.md` · `02-architecture/security-privacy.md` §1 rows 1, 10 |
| **Notifications, reminders** | `01-product/notifications.md` · `02-architecture/data-model.md` §3.1, §4.3 (reminders are **per user**) · `02-architecture/api-contract.md` §2.4a · `02-architecture/aws-services.md` · `02-architecture/infrastructure.md` §1.1 · `02-architecture/security-privacy.md` §1 row 15 |
| **AI capture** | `01-product/activities.md` §2 · `01-product/plans-and-lists.md` §2 · `01-product/ai-capture.md` · `02-architecture/api-contract.md` §2.11 · `02-architecture/security-privacy.md` §1 row 7. The caller-selected target is mandatory; capture never selects or changes it and never sets a reminder from source words. |
| **CDK, AWS resources, deploys** | `02-architecture/infrastructure.md` · `02-architecture/aws-services.md` · `02-architecture/cost-model.md` |
| **CI, workflows, releases** | `02-architecture/infrastructure.md` §7 · `04-conventions/git-workflow.md` |
| **A `packages/ui` primitive** | `04-conventions/design-system.md` · `01-product/interaction-contract.md` §2, §6 |
| **Tests of any kind** | `04-conventions/testing.md` |
| **Anything that stores or logs user data** | `02-architecture/security-privacy.md` §3, §4 · `04-conventions/coding-standards.md` §7.3 |

`04-conventions/repo-structure.md` §7 answers "where does this file go" for anything. Consult
it rather than guessing.

### 1.3 Confirm scope before writing code

Write down — in the PR description draft, or in your first message back — these four things,
and only start once they are consistent with the phase doc:

1. **What you are building**, in one sentence, in product language.
2. **The files you expect to touch**, from `repo-structure.md` §7.
3. **What you are explicitly not building** — copy the phase doc's "do not do this yet" scope
   guards verbatim.
4. **Any canonical doc that needs a row added** (a new access pattern, a new endpoint, a new
   error code, a new constant).

If any of the four is unclear, that is a §8 trigger. Asking costs ten minutes; building the
wrong thing costs a day and pollutes `main`.

---

## 2. The rule hierarchy

> **Decision:** four ranks, intent above behaviour above mechanics above craft. The
> alternative — "the most recently written document wins" — is how a codebase drifts away
> from the product it was supposed to be, one convenient reinterpretation at a time. Ranking
> the founder's concept first means that a doc written later by an agent cannot quietly
> redefine what the product is.

When two documents disagree, this is the order. Higher wins.

| Rank | Source | Owns |
| --- | --- | --- |
| 1 | `docs/01-product/original-concept.md` | **Intent.** What the product is for and why. |
| 2 | `docs/01-product/*` (overview, activities, today-and-tasks, plans-and-lists, sharing-and-people, expenses, notifications, ai-capture, interaction-contract) | **Product behaviour.** What the user sees and can do. |
| 3 | `docs/02-architecture/*` (data-model, api-contract, tech-stack, infrastructure, auth, security-privacy, aws-services, cost-model, decisions) | **Mechanics.** How it is built and stored. |
| 4 | `docs/04-conventions/*`, including this playbook | **Craft.** How the code is written. |

Two clarifications that follow from `overview.md`'s own header:

- Where a product doc and the concept disagree on **intent**, the concept wins.
- Where a product doc and an architecture doc disagree on **mechanics**, the architecture doc
  wins.

> **You do not silently resolve a conflict.** Not by picking the doc you find more
> convincing, not by implementing both, not by choosing the one that is easier to build.
> Stop, and raise it: state the two passages, the file and section of each, what each implies
> for your task, and what you would do if forced to choose. Then wait.

A silently resolved conflict is the most expensive failure mode available to an agent,
because the resolution is invisible in the diff, is never revisited, and becomes the de
facto rule that the next agent inherits.

The same applies to a gap: if no doc answers your question, that is not permission to decide.
It is a §8 trigger.

---

## 3. Before you write code

- [ ] I have a task ID, and I am on a branch named for it (`git-workflow.md` §1.1).
- [ ] I have read every doc row in §1.2 that applies.
- [ ] I have written the four scope statements in §1.3.
- [ ] I know which layer each change belongs in (`repo-structure.md` §3).
- [ ] I have checked `data-model.md` §5: my reads are an existing access pattern, or I am
      adding a row for a new one.
- [ ] I have checked `api-contract.md` §2: my endpoint exists there, or I am adding it there
      first.
- [ ] I have searched for an existing helper before writing a new one. Recurrence, money,
      ranks, wall-clock conversion, ID generation, and cursor encoding all already exist.
- [ ] I am not adding a dependency. If I am, I have the justification block ready
      (`security-privacy.md` §7).
- [ ] I have checked the phase doc's scope guards and I am not building any of them.
- [ ] `git pull --rebase origin main` — I am starting from current `main`.

---

## 4. Before you open a PR

- [ ] `pnpm verify` passes: Biome, typecheck, unit tests with coverage thresholds,
      `dependency-cruiser`.
- [ ] `pnpm --filter @od/api test:int` passes, if I touched a repository or a key.
- [ ] `pnpm run gen:openapi` run, and the diff is committed, if I touched a schema or an
      endpoint.
- [ ] None of the 25 rejection smells in `coding-standards.md` §11 is present.
- [ ] Tests exist at the right layer, with the required cases (`testing.md` §4.4 for
      endpoints, §2.2 for recurrence and money).
- [ ] Canonical docs updated: `data-model.md` §5 row, `api-contract.md` §2 row,
      `constants.ts`, `errors.ts`, `security-privacy.md` §3 — whichever apply.
- [ ] Every user-facing string matches `interaction-contract.md` §5 where that document
      specifies the copy.
- [ ] Every new interactive element has `accessibilityRole`, `accessibilityLabel`, and its
      state, and every swipe action is also an `accessibilityAction`.
- [ ] No colour, spacing, radius, or font size outside the tokens (`design-system.md` §9).
- [ ] No secret, `.env`, build artefact, or generated file other than the three permitted
      ones (`git-workflow.md` §7).
- [ ] The PR description template is filled in, including "Why this approach" if a choice was
      made.
- [ ] The PR title is a valid Conventional Commit header (`git-workflow.md` §2.1).
- [ ] The diff is under 400 lines, or the first sentence of the description says why not.
- [ ] Everything I touched is inside my task ID's scope. Nothing else.

---

## 5. Definition of done

A task is done when it satisfies
[`../03-implementation/definition-of-done.md`](../03-implementation/definition-of-done.md).
The checklist in §4 is the mechanical part of it; the definition-of-done document is
authoritative and includes the acceptance criteria specific to your phase task.

"It works on my machine" is not on that list. Neither is "the tests I wrote pass".

---

## 6. Common mistakes in this codebase

Twelve mistakes, each of which has been designed against explicitly. Each is an automatic PR
rejection. Read the whole section once; you will make one of these otherwise.

### 6.1 Creating a Plan, Meal, or Task entity

There is **one** schedulable entity: `Activity`. The rule, canonical in `data-model.md` §1 and
ADR-045:

> **A Plan is an Activity with commitment or coordination. A date changes its scheduling
> state, not its identity.**

So an undated plan is a plan, not a draft of one (`plans-and-lists.md` §1), and scheduling is
`POST /v1/activities/:id/schedule` rewriting one index entry — not a conversion, a promotion,
or a second entity. The five stored types are a required field, not five tables
(`data-model.md` §1, `activities.md` §1). On create, that field comes only from the explicit
**Task** choice or the explicit Plan-kind choice; a title, parser, model or server default
must never supply it.

```ts
// Wrong
interface Meal { mealId: string; recipeUrl?: string; scheduledFor: string }
const meal = await mealRepository.create({ … });

// Wrong — same mistake wearing a different hat
class PlanService { async createPlan(input: CreatePlanInput) { … } }

// Right
const activity = await activityService.create({
  type: 'meal',
  title: 'Chicken tacos',
  schedule: { date: '2026-08-08', time: '19:30', timezone: 'America/New_York' },
  details: { kind: 'meal', mealSlot: 'dinner', recipeUrl },
});
```

The tell that you have made this mistake: you are writing a second `create` path, a second
`complete` path, or a second row component for a type.

### 6.2 Materialising future recurring occurrences

One Activity row holds the whole series. Future occurrences are computed at read time and do
not exist in the table. Only *modified* occurrences get an `OCC#` row
(`data-model.md` §4.2, §4.5, §6).

```ts
// Wrong — writes 365 rows, makes editing the series an unbounded rewrite,
// and breaks the moment the user changes the recurrence.
for (const date of expandRecurrence(rec, from, addYears(from, 1), tz)) {
  await activityRepository.put({ ...series, activityId: newActivityId(), schedule: { date } });
}

// Right — expand at read time, merge overrides.
const dates     = expandRecurrence(series.recurrence, from, to, tz);   // pure, no I/O
const overrides = await activityRepository.getOccurrences(series.activityId, from, to);
return mergeOccurrences(series, dates, overrides);
```

### 6.3 Floats for money

Every money value is integer cents (`coding-standards.md` §3, `data-model.md` §4.8).

```ts
// Wrong — 0.1 + 0.2 !== 0.3, and the balance stops reconciling within a week.
const each = expense.amount / participants.length;
const rounded = Math.round(each * 100) / 100;

// Right — integer division plus deterministic remainder distribution.
import { splitEqual, assertSplitsReconcile } from '@od/shared/money';
const lines = splitEqual(expense.amountCents, participantIds);
assertSplitsReconcile(expense.amountCents, lines);
```

### 6.4 DynamoDB outside the repository layer

The `DynamoDBDocumentClient` is reachable only from `services/api/src/repositories/**`, and
`pk`/`sk` strings are built only in `repositories/keys.ts`
(`tech-stack.md` §4.3, `repo-structure.md` §2.4).

```ts
// Wrong — in a handler or a service.
const res = await ddb.send(new GetCommand({
  TableName: process.env.TABLE_NAME,
  Key: { pk: `ACT#${activityId}`, sk: 'META' },
}));

// Right — the service asks for a domain object and never sees a key.
const activity = await activityRepository.get(activityId);
if (!activity) throw new NotFoundError('activity');
```

This is not style. Key construction in one place is what makes tenant isolation testable
(`security-privacy.md` §1 row 4).

### 6.5 Adding a second GSI

There is one index, `GSI1`, and every additional index is a second write on every mutation
(`data-model.md` §2).

```ts
// Wrong — "I need activities by type, so I'll add GSI2."
new dynamodb.Table(this, 'Main', { … }).addGlobalSecondaryIndex({
  indexName: 'GSI2', partitionKey: { name: 'gsi2pk', … },
});

// Right — model the access pattern onto GSI1's existing buckets, or filter a bounded
// Query result in memory. "Activities of type meal this month" is
// Query GSI1 U#<u>#S BETWEEN <month start> AND <month end>, then filter by type —
// the window is already bounded to 62 days, so the read is bounded too.
```

If a pattern genuinely cannot be served by `GSI1`, that is a §8 trigger, not a PR. Bring the
proposed key design and the write-amplification cost.

### 6.6 Using `Scan`

Banned in application code, denied by the Lambda's IAM policy, grepped in CI, and permitted
only in `infra/scripts/migrations/` (`data-model.md` §5, `security-privacy.md` §2.2).

```ts
// Wrong — and it will fail at runtime in dev with an authorization error, loudly.
const all = await ddb.send(new ScanCommand({ TableName, FilterExpression: 'ownerId = :u' }));

// Right
const items = await ddb.send(new QueryCommand({
  TableName,
  KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
  ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'LIST#' },
}));
```

A filter expression is not a substitute for a key condition. `Query` with a filter still
reads every item in the partition; it just discards some before returning them.

### 6.7 Mutating the series when acting on an occurrence

Snoozing, skipping, or completing one occurrence writes exactly one item —
`ACT#<id>/OCC#<date>` — and leaves `ACT#<id>/META` untouched (`data-model.md` §4.5, §7).

```ts
// Wrong — snoozes every future Tuesday, not this one.
await activityRepository.patch(activityId, {
  'schedule.time': until,
  'recurrence.startDate': tomorrow,
});

// Right
await activityRepository.putOccurrence({
  activityId,
  date: occurrenceDate,
  status: 'snoozed',
  snoozedUntil: until,
});
```

The required test asserts that `ACT#/META` is byte-identical before and after
(`testing.md` §3.3).

### 6.8 Duplicating a list item when scheduling it

`Plan this item` first requires an explicit Plan kind and **Just me / Choose people**
audience. Confirming creates an Activity with provenance back to the item and a
`ListItemActivityLink` for each authorised viewer who is also a list member. The ListItem
itself is byte-identical: it is not copied, deleted, moved, checked or given a global
Activity id (`data-model.md` §4.6, `api-contract.md` §2.7).

```ts
// Wrong — now there are two "Severance S2 E4"s and neither knows about the other.
const activity = await activityService.create({ type: inferredType, title: item.title, … });
await listRepository.deleteItem(listId, itemId);

// Right — the request already contains the user's Plan kind and audience.
await transact([
  putActivity({ ...draft, objectKind: 'plan', type: selectedPlanType,
                listItemId: item.itemId, listId }),
  putActivityIndex(ownerId, activity.activityId),
  ...viewerUserIds.map((viewerUserId) =>
    putListItemActivityLink({ listId, itemId, viewerUserId, activityId: activity.activityId })
  ),
]);
```

Another list member can plan the same item independently and cannot see this link unless
they were explicitly selected for the Plan. Deleting the Activity removes only its matching
viewer links. Deleting the ListItem clears Activity back-pointers but never cascade-deletes
an Activity.

### 6.9 Auto-creating something the product says must be suggested

"Suggest, never auto-create" is a testable product principle
(`overview.md` §4.4). The app may propose; it never writes without an explicit confirmation
in the same interaction.

```ts
// Wrong — all four of these.
onMealCompleted:      await listService.addItems(groceriesListId, meal.ingredients);
onWatchCompleted:     await activityService.create({ …nextEpisode });
onTripPlanCreated:    await listService.create({ templateKey: 'packing', sourceActivityId });
onCaptureParsed:      await activityService.create(parsed.fields);

// Right — return a suggestion; the client renders it; the user confirms; the client calls
// the create endpoint.
return { suggestions: [{ kind: 'add_ingredients', listId, items: meal.ingredients }] };
```

The tell: a `create` call inside a handler for a different operation.

### 6.10 Returning a balance without drill-down data

"No unexplained numbers" (`overview.md` §4.5, `expenses.md`). `Balance` is a cache; the API
must always be able to produce the expenses behind it
(`data-model.md` §4.8, `api-contract.md` §2.9).

```ts
// Wrong — a number the user cannot interrogate.
return { data: { netCents: balance.netCents, currency: balance.currency } };

// Right — the figure and its provenance, and the UI makes the figure tappable.
return {
  data: {
    netCents: balance.netCents,
    currency: balance.currency,
    unsettledExpenseCount: balance.unsettledExpenseCount,
    lastRecalculatedAt: balance.lastRecalculatedAt,
    expenses: lines,          // when ?include=expenses
  },
};
```

The same rule applies to every aggregate: counts, totals, progress figures. If the UI renders
it, a tap must reach the records that produced it.

### 6.11 Exposing internal `pk` / `sk`

The API speaks in IDs. Storage keys never appear in a response, a log line, an error message,
or anything a client can decode (`data-model.md` §8, `coding-standards.md` §5.2).

```ts
// Wrong — ships pk, sk, entity, gsi1pk, gsi1sk, and every future storage attribute.
return c.json({ data: item });
return c.json({ data: { ...item, activityId: item.activityId } });

// Right — field by field, in the repository's toDomain function.
return c.json({ data: toActivity(item) });
```

The endpoint test asserts `expect(body.data).not.toHaveProperty('pk')`. Add it.

### 6.12 Filling a chosen destination from a capture parse result

Before parsing begins, the user or contextual entry point has already selected `Task`, a
specific Plan kind, or a specific List. That target is sent with the capture request and is
immutable for the parse. The server never chooses a target, creates an Activity or adds a
ListItem from a parse result. It returns compatible draft fields; the client shows the
review screen; the user confirms with `Save task`, `Save plan`, or `Add to {list}`. This is a
product rule **and** the structural defence against prompt injection
(`api-contract.md` §2.11, `security-privacy.md` §1 row 7, `ai-capture.md`).

Reminder state is outside every capture allow-list. `reminder`, `reminders`, `offsetMinutes`
and notification actions from model output are rejected; text such as `remind me tomorrow`
cannot change the form's Reminder control. Only that visible control or the user's explicitly
saved default can supply a reminder.

```ts
// Wrong — a poster that says "ignore previous instructions" now writes to the database.
const parsed = await captureService.parse({ text });
const activity = await activityService.create(parsed.fields);
return c.json({ data: activity }, 201);

// Right
const parsed = await captureService.parse({ target: input.target, text: input.text });
return c.json({ data: parsed });     // compatible fields only, with per-field confidence
```

The model has no tools, no credentials, no write path, and no ability to return a different
object kind, Plan kind, List, participant set or sharing state. Keep it that way.

---

## 7. How to add a new API endpoint, end to end

Ordered. Do not skip a step, and do not reorder — the schema exists before anything that
uses it, and the docs are updated in the same PR, not later.

| # | Step | File |
| --- | --- | --- |
| 1 | Add the endpoint to the contract: method, path, body, response, error cases | `docs/02-architecture/api-contract.md` §2 |
| 2 | Add the access pattern, if the read or write is new | `docs/02-architecture/data-model.md` §5 (and §7 if it is a multi-item write) |
| 3 | Define the request and response schemas. Reuse the primitives in `common.ts`; export the inferred types from the same file | `packages/shared/src/schemas/<resource>.ts` |
| 4 | Add any new limit as a constant | `packages/shared/src/constants.ts` |
| 5 | Add any new error code to the closed union | `packages/shared/src/errors.ts` |
| 6 | Add the repository method — the only place keys are built | `services/api/src/repositories/<x>Repository.ts` |
| 7 | Add the service method: authorisation first (`assertActivityAccess`), then rules, then repository calls, then transaction composition | `services/api/src/services/<x>Service.ts` |
| 8 | Add the handler: validated input → service argument → `{ data, meta }` envelope → status code | `services/api/src/handlers/<x>.ts` |
| 9 | Mount the route with its `zValidator` | `services/api/src/routes/<resource>.ts` |
| 10 | Add the typed client function | `packages/shared/src/client/endpoints/<resource>.ts` |
| 11 | Add the feature hook (`useQuery` / `useMutation`, query key from `keys.ts`, optimistic update if the interaction must feel instant) | `apps/mobile/src/features/<f>/hooks/use<Thing>.ts` |
| 12 | Unit-test the service (mocked repository) and the pure logic | `services/api/src/services/<x>Service.test.ts` |
| 13 | Route test: happy path, 401, 400, 404-for-strangers, plus idempotency if it creates | `services/api/test/routes/<resource>.test.ts` |
| 14 | Integration test, if a new key or index behaviour is involved | `services/api/test/integration/<x>.int.test.ts` |
| 15 | Register the schemas for OpenAPI and regenerate | `packages/shared/src/openapi.ts`, then `pnpm run gen:openapi` |
| 16 | Add the error copy for any new failure the user can see | `docs/01-product/interaction-contract.md` §5.3 |
| 17 | `pnpm verify`, then open the PR | — |

Steps 1 and 2 are the ones agents skip. They are the ones that keep the next agent from
re-deriving your design from your code.

---

## 8. How to add a field to `Activity`, end to end

Additive, optional fields only. A required field or a removal is a two-step change across two
merges (`git-workflow.md` §6.3, `data-model.md` §9).

| # | Step | File |
| --- | --- | --- |
| 1 | Confirm the field belongs on `Activity` and not in `details` (type-specific) or on a separate item | `docs/02-architecture/data-model.md` §4.1, §4.4 |
| 2 | Confirm it is not on the deliberately-not-modelled list | `data-model.md` §10. If it is, stop — §9 trigger. |
| 3 | Add it to the `Activity` interface, optional | `packages/shared/src/types/activity.ts` |
| 4 | Add it to the entity table in the data model doc, with its meaning and constraints | `docs/02-architecture/data-model.md` §4.1 |
| 5 | Add it to the **response** schema | `packages/shared/src/schemas/activity.ts` |
| 6 | Add it to the **input** schemas only if the client may set it. Server-derived fields are never accepted from the client (`security-privacy.md` §4.1 rule 4) | same file |
| 7 | Bound it: length, range, format. Every string field has a maximum | same file, using `common.ts` primitives |
| 8 | Handle it in the repository's `toDomain` and `toItem` — field by field, never a spread | `services/api/src/repositories/activityRepository.ts` |
| 9 | Decide the upgrade-on-read default for existing items. Usually `undefined`, which needs no code | same file |
| 10 | If it can carry user content, add it to the pino redaction list | `services/api/src/lib/logger.ts` and `coding-standards.md` §7.3 |
| 11 | If it is personal data, add a row to the classification table | `docs/02-architecture/security-privacy.md` §3 |
| 12 | If it should appear on the public invite page, add it **explicitly** to that DTO. It must never arrive there by spreading an Activity | `services/api/src/handlers/public/invites.ts`, `security-privacy.md` §4.2 |
| 13 | Add it to `AgendaItem` only if Today or Plans needs it. `AgendaItem` is a trimmed projection and stays trimmed | `packages/shared/src/types/agenda.ts`, `api-contract.md` §2.2 |
| 14 | Surface it in the UI: form field, detail row, row subtitle — per the relevant product doc | `apps/mobile/src/features/**` |
| 15 | Tests: schema accepts and rejects, repository round-trips it, it does not leak to the public projection | — |
| 16 | `pnpm run gen:openapi`, `pnpm verify` | — |

Note what is **not** on this list: a schema version bump. Adding an optional attribute is the
"additive" migration class and needs none (`infrastructure.md` §4.5).

---

## 9. How to add a new screen, end to end

| # | Step | File |
| --- | --- | --- |
| 1 | Confirm the screen belongs in the three-noun navigation. A fourth tab is a §10 trigger | `docs/01-product/overview.md` §3 |
| 2 | Find its interaction rules: which gestures, which states, which empty and error copy | `docs/01-product/interaction-contract.md` §3, §5 |
| 3 | Create the route file. Thin: read params, render one feature component, nothing else | `apps/mobile/app/(app)/<path>.tsx` |
| 4 | Create the screen component | `apps/mobile/src/features/<f>/components/<Screen>.tsx` |
| 5 | Create the feature hook. It owns the query key, the fetch, the optimistic updates and the invalidation. It is the only place `useQuery` appears | `apps/mobile/src/features/<f>/hooks/use<Thing>.ts` |
| 6 | Put any derivation in a pure module and unit-test it — partitioning, sorting, grouping, formatting | `apps/mobile/src/features/<f>/model/*.ts` |
| 7 | Compose from `@od/ui` primitives only. A new visual pattern means a new primitive, added per `design-system.md` §5, not a bespoke `View` | `packages/ui/src/primitives/` |
| 8 | Implement all four states: loading (skeleton, matching layout), empty (heading + one line + at most one action), error, offline | `interaction-contract.md` §5 |
| 9 | Accessibility: reading order, roles, labels, custom actions for every swipe action, 44 pt targets | `interaction-contract.md` §6 |
| 10 | Responsive: verify at 320 pt, at `medium` (768), and at `expanded` (1200) where the layout becomes two-pane | `design-system.md` §7 |
| 11 | Web equivalents: hover-revealed actions, keyboard shortcuts, focus management | `interaction-contract.md` §7 |
| 12 | Dynamic type: verify at the largest accessibility size; rows reflow, nothing clips | `interaction-contract.md` §6.3 |
| 13 | Component tests: each state, each interaction, each accessibility label | `testing.md` §5 |
| 14 | Add an E2E flow **only** if this screen is on one of the critical paths in `testing.md` §6 | — |
| 15 | `pnpm verify` | — |

Step 8 is the one that gets skipped and the one that is always noticed. A screen without its
empty state is not done.

---

## 10. When to stop and ask the founder

Stop and ask when any of these is true. Do not decide, do not implement both, do not pick the
interpretation that makes your task finishable.

**Model and data**

1. Your feature needs a new DynamoDB access pattern that `GSI1` cannot serve.
2. Your feature seems to need a second GSI, a second table, or a `Scan`.
3. Your feature needs a field on something listed in `data-model.md` §10 as deliberately not
   modelled — nutrition, recipes, a social graph, payment rails, currency conversion,
   sub-lists, tags, priorities, custom categories.
4. Your feature needs a non-additive schema change: a required field, a removal, a type
   change, or a key change.
5. You need to store something the classification table in `security-privacy.md` §3 does not
   cover.

**Product**

6. Two canonical docs conflict (§2).
7. No canonical doc answers your question, and the answer changes what the user sees.
8. A change would introduce a fourth primary noun, a fourth tab, or a new destination in
   primary navigation.
9. A change would make the app create something without explicit user confirmation
   (`overview.md` §4.4), or make a `type` restrict rather than guide (§4.1), or make Today own
   data (§4.2), or render an aggregate that cannot be drilled into (§4.5).
10. The interaction you need is not in `interaction-contract.md` §3, or contradicts one of
    the six universal rules.
11. You need new user-facing copy for an error, empty, or confirmation state that
    `interaction-contract.md` does not specify.

**Security, privacy, cost**

12. You need a new IAM permission on the Lambda role.
13. You need to log, send to a third party, or expose on the public invite surface anything
    that is not already there.
14. You need to relax a security control: CORS, CSP, rate limit, `.strict()` on a schema, the
    404-not-403 rule, or the presigned-URL constraints.
15. A change would add recurring AWS cost, or move a resource out of an always-free tier
    (`cost-model.md`).

**Process**

16. Your task cannot be done inside its scope guards without also doing something the phase
    doc says not to do yet.
17. Your change requires a new npm dependency and you cannot make the case in
    `security-privacy.md` §7's terms.
18. Another agent's in-flight branch conflicts with yours on a shared contract
    (`git-workflow.md` §6.3 step 5).
19. Your change would take the diff well past 800 lines and cannot be split.
20. You are about to write "for now" or "temporarily" in a comment.

When you ask, bring: the two options, what each costs, which canonical docs bear on it, and
your recommendation. An agent that asks well is faster than an agent that guesses.

---

## 11. Glossary

Use these words exactly as defined. Consistent vocabulary across docs, code, tests, commit
messages, and UI copy is what keeps a distributed set of agents building one product.

| Term | Definition |
| --- | --- |
| **Activity** | The single stored schedulable entity. Everything a user creates is one. Carries `type`, `status`, an optional `schedule`, and a type-specific `details` sub-document. There is no other schedulable entity. |
| **Plan** | The user-facing word for an Activity the user intends to make happen, alone or with people. **A date is not what makes it one** — an undated plan sits in Plans → Needs a date. Not an entity, not a flag, not a table. |
| **Needs a date** | The first stage of the Plans tab, served by the `#P` GSI1 bucket: Activities with explicit `objectKind: 'plan'` and no date. Sorted by `lastActivityAt` descending. It never reaches Today, never carries a badge or a count, and is never nudged (`plans-and-lists.md` §1.3.2). |
| **Activity type** | One of `task`, `meal`, `watch`, `event`, `custom`. It guides which fields the form shows, which verb completion uses, and whether a checkbox renders. It never restricts what can be done. |
| **List** | An independent collection of things worth remembering. Carries one of three `ListBehaviour` values plus a `capabilities` record; there is no list `kind`. Separate from Activity and independent of it — a list that never produces an Activity is complete. **Shareable**, with 20 people total including the owner and pending invitations; only app users can edit. Its canonical row lives in its own `LIST#<l>` partition, never in the owner's. |
| **List member** | A non-owner person on a shared list, stored at `LIST#<l>` / `MEMBER#<personId>` with fixed role `member`. `status` is `invited` or `active`; an invited member has no `userId`, `reciprocalPersonId` or list index entry and can read nothing. Its immutable `addedAt` is shared by the ListIndex and reciprocal `LLINK#` keys. The owner has no `MEMBER#` row: ownership is `List.ownerId` plus the owner's `ListIndex` pointer, and the API synthesises their first roster row. `memberCount` includes that owner, so pending invitations count toward the 20-person cap. |
| **List index entry** | The `USER#<u>` / `LIST#<l>` pointer, one per **active** member. It is a near-pure pointer carrying `role` and `addedAt` and nothing else — no title, no counts — which is why renaming a shared list is one write and why the pointer's presence *is* the access check. Deliberately unlike an activity index entry, which must carry sortable display data. |
| **List behaviour** | `collection`, `watch` or `meals`. What the *application* does differently. Exactly three; adding a fourth is a product decision. |
| **List template** | A declarative preset — chooser label, one-line summary, editable default title, icon, behaviour, capability defaults, slot and empty-state copy — copied onto a List at creation and never re-resolved. `templateKey` remains provenance only. Unbounded; adding one is a config entry, never a code branch. |
| **ListItem** | A row in a List. `Plan this item` leaves it unchanged; the Activity carries provenance and the List partition carries caller-scoped `ListItemActivityLink` pointers. Different members may plan the same item independently. Never duplicated into an Activity. |
| **Occurrence** | One dated instance of a recurring series. A row exists only for a *modified* occurrence — completed, skipped, snoozed, rescheduled. Absence means "scheduled, not yet acted on". It carries **no participant identity**: completion is global, and on a plan only the owner may complete, skip or snooze (ADR-048). A prep task is a shared checklist item, so any participant of its parent may complete one (ADR-051). |
| **Reminder** | A `REM#<userId>#<reminderId>` item in the Activity's partition, belonging to **one user**. A shared plan has one schedule and many reminder sets; nobody inherits anybody else's. `Activity` has no `reminders[]` field. Read paths filter to the caller; the reminder scheduler keeps them all and fans out per user (ADR-047). |
| **DateSuggestion** | A `SUGG#` item proposing `{ date, time?, note? }` on an undated plan. Any participant adds one, capped at 5; others toggle themselves into `worksFor`, which is **availability, not a vote and not consent**; only the owner schedules, and every suggestion is deleted when they do. Guests cannot suggest (ADR-049). |
| **Series** | An Activity carrying a `recurrence`. It is one row; its future occurrences are computed at read time and never materialised. |
| **Recurrence** | The rule on a series: frequency, interval, weekdays, month days, months, start, end or count. The Repeat sheet always writes explicit anchors — `byMonth` + `byMonthDay` for `yearly`, `byMonthDay` for `monthly`. Mode is `fixed` in v1; `after_completion` is Phase 9+. |
| **Participant** | A Person attached to a specific Activity, with an `rsvp` and a `role`. Stored in the Activity's partition. Capped at 50 per Activity. |
| **Person** | A contact in one user's own address book. Lives under that user's partition and may link to a registered user via `linkedUserId`. It can arise from a manual add or an explicitly shared Plan/List; words never create it. A registered List share creates/reuses one on each side, not a global relationship or co-member graph. `PLINK#` is shared-Plan/finance projection; `LLINK#` is explicit List discovery/lifecycle projection; neither replaces the actual Activity/List access grant. |
| **Person↔list link** | `USER#<u>` / `LLINK#<personId>#<addedAt>#<listId>`. Active reciprocal rows power `sharedListCount` and `LISTS TOGETHER`; an invited owner-side row exists only for signup and lifecycle guards. It never affects People relevance/FREQUENT/RECENT and is never accepted by `assertListAccess`. |
| **Guest** | A Participant who is not a registered app user. Reaches the plan only through an invite link and the public projection. Gets no index entry and never appears on anyone's Today. |
| **Invite** | A capability token (22 chars, 128 bits of entropy, not a ULID) that grants read of one Activity's public projection and the ability to set one RSVP. Expires 90 days after the plan's date. |
| **Balance** | The cached net figure between the owner and one Person. Positive means they owe the owner. Always recomputable from Expenses and each Expense's `settledPersonIds` only; Settlement rows are audit history, never a second delta. Always drillable in the UI. |
| **Settlement** | An audit row saying the signed-in user marked selected expense obligations settled. It names the exact Expenses and stores their server-computed total for display; it does not assert how, where or how much money moved outside the app. |
| **Agenda** | The read-time projection that powers Today and Plans: one date window, with recurring series expanded and occurrence overrides applied. Served by `GET /v1/agenda`. Owns no data. |
| **AgendaItem** | The trimmed per-row shape the agenda endpoint returns. Not the full Activity. Adding a field to it is a deliberate act. |
| **Capture** | A field-filling step used only after the target is explicit: Task, a user-chosen Plan kind, or a specific List. Text, photo, screenshot or link becomes compatible draft fields for review. It may suggest visible date/time fields but never chooses or changes object kind, Plan kind, List, participants, sharing, or reminder/notification state, never commits a schedule, and never writes. Reminder comes only from its visible control or the user's explicitly saved default. Phase 8; stubbed as `501` before that. |
| **Shortcut** | A reserved concept on `details.shortcutId` for `custom` activities: a saved template for something a user creates repeatedly. Modelled but not built in v1. Do not implement it. |
| **Prep task** | An Activity of type `task` with `parentActivityId` set to a plan. Has its own schedule and completion. Nesting is capped at two levels. |
| **Activity index entry** | The `USER#<u>/IDX#<a>` item that carries `GSI1` attributes and puts an Activity on a user's Today, Plans, or Inbox feed. One exists per owner and per participating app user; guests get none. Distinct from a **list index entry**, above. |
| **`lastActivityAt` vs `updatedAt`** | Two fields, never one. `lastActivityAt` is bumped by RSVP changes, posted updates and added expenses — "this plan is being discussed" — and sorts Needs a date descending. `updatedAt` is bumped only by edits to the Activity itself, because it backs the `If-Match` optimistic-concurrency header. Bumping one field for both would make somebody's RSVP fail an unrelated open edit sheet with `409`. |
| **lexoRank** | The fractional-index string that orders ListItems, so a reorder is a single-item write rather than a renumber. Base62, ASCII-collation-ordered, generated by `lexoRankBetween`. |
| **Wall-clock time** | A date or time with no zone attached — `YYYY-MM-DD`, `HH:mm`. What "Today" and "6 PM" mean to a user. Stored separately from the absolute instant. |
| **Instant** | An absolute moment, ISO 8601 with an offset. Used for reminders, `.ics` export, and audit timestamps. Derived from wall-clock time plus a zone, never the other way round for scheduling logic. |
| **Envelope** | The response wrapper: `{ data, meta }` on success, `{ error }` on failure. Every endpoint returns one. |
| **Idempotency key** | A client-generated UUID on every creating `POST`, generated once at mutation time and reused on every retry, including after a restart. |
