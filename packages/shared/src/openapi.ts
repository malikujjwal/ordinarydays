import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';
import {
  activity,
  activityCompletionResult,
  activityDetail,
  activityDetailQuery,
  activityListItem,
  activityListQuery,
  completeActivityInput,
  convertRecurrenceInput,
  createActivityInput,
  deletedActivity,
  patchActivityInput,
  skipActivityInput,
  uncompleteActivityInput,
} from './schemas/activity.js';
import { activityAgendaData, agendaData, agendaQuery } from './schemas/agenda.js';
import {
  captureExtractInput,
  captureLinkInput,
  captureParseInput,
} from './schemas/capture.js';
import { ulidId } from './schemas/common.js';
import {
  deletedDevice,
  device,
  deviceId,
  registerDeviceInput,
} from './schemas/device.js';
import { envelope } from './schemas/envelope.js';
import { errorResponse } from './schemas/error.js';
import { healthResponse } from './schemas/health.js';
import {
  createListInput,
  deletedList,
  listDetail,
  listDetailQuery,
  listListQuery,
  listView,
} from './schemas/list.js';
import { snoozeActivityInput, unsnoozeActivityInput } from './schemas/occurrence.js';
import { deletedReminder, reminder, reminderInput } from './schemas/reminder.js';
import { scheduleActivityInput, scheduleActivityResult } from './schemas/schedule.js';
import { patchUserInput, user } from './schemas/user.js';

/** `GET`/`PATCH /v1/me` both answer with the profile inside the standard envelope. */
const userResponse = envelope(user);

const deviceResponse = envelope(device);
const deletedDeviceResponse = envelope(deletedDevice);

const activityResponse = envelope(activity);
const activityDetailResponse = envelope(activityDetail);
const scheduleActivityResponse = envelope(scheduleActivityResult);
const activityCompletionResponse = envelope(activityCompletionResult);
const deletedActivityResponse = envelope(deletedActivity);
const reminderResponse = envelope(reminder);
const reminderListResponse = envelope(z.array(reminder));
const deletedReminderResponse = envelope(deletedReminder);

/**
 * The list envelope. `data` is an array and `meta.nextCursor` is present only when there is
 * another page — the shape `api-contract.md` §1 gives for every list response.
 */
const activityListResponse = envelope(z.array(activityListItem));
const agendaResponse = envelope(agendaData);
const activityAgendaResponse = envelope(activityAgendaData);

const listResponse = envelope(listView);
const listPageResponse = envelope(z.array(listView));
const listDetailResponse = envelope(listDetail);
const deletedListResponse = envelope(deletedList);

/** The `act_` path parameter. Declared because OpenAPI requires every path template to be. */
const activityId = ulidId('act');
const reminderId = ulidId('rem');
const listId = ulidId('lst');

/**
 * The OpenAPI document, generated from the **same Zod schemas both sides import**
 * (`api-contract.md` §6). It is written to `docs/generated/openapi.json` by
 * `pnpm gen:openapi`, checked in, and CI fails when it is stale.
 *
 * That is the whole value: the spec cannot drift from the code, because it is not written
 * by hand. A new agent discovers the API here instead of by reading every handler, and can
 * trust what it reads — a hand-maintained spec is a document that is wrong in a way nobody
 * notices until a client has been built against it.
 *
 * **Registering an endpoint is part of adding one** (`agent-playbook.md` §7 step 15), not a
 * cleanup pass afterwards.
 *
 * There is no `extendZodWithOpenApi(z)` call here, and that is deliberate. That helper adds
 * `.openapi()` by patching zod, and the patch only reaches schemas **constructed after it
 * runs** — verified rather than assumed: an instance created before the call still has no
 * `.openapi` afterwards. Every schema in this package is built at module load, so whether
 * registration worked would depend on which module the import graph happened to reach
 * first. Each shape names itself with Zod 4's native `.meta({ id })` instead, which the
 * generator reads identically and which no import order can defeat.
 */
export const registry = new OpenAPIRegistry();

/**
 * **P1-06's schemas are not registered here, and cannot be.** Tried and reverted; the note
 * is what stops the next agent spending the same twenty minutes.
 *
 * `registry.register(id, schema)` is the API for adding a component without a path, and it
 * calls `zodSchema.openapi(refId)` internally — a method that exists only after
 * `extendZodWithOpenApi(z)` has patched Zod. This package deliberately does not call that
 * (see the note above): the patch reaches only schemas constructed *after* it runs, every
 * schema here is built at module load, and whether registration worked would then depend on
 * import order. Calling `register` without it throws `zodSchema.openapi is not a function`.
 *
 * So a shape reaches `components/schemas` when a **registered path references it**, and its
 * `.meta({ id })` supplies the name. `User`, `Activity`, `CreateActivityInput` and the rest
 * therefore appear as P1-07, P1-11 and their siblings mount routes — which is what
 * `agent-playbook.md` §7 step 15 already requires of every endpoint, so nothing is lost
 * except the illusion that this task could front-run it.
 */

/**
 * `/v1/me` (P1-07). The first authenticated pair, and the registration that brings `User`
 * and `PatchUserInput` into `components/schemas` — see the note above on why a shape reaches
 * the components map only when a registered path references it.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/me',
  summary: 'The signed-in user’s profile',
  description:
    'Profile, preferences, timezone and currency. In local mode this answers for the ' +
    'seeded development user rather than `401`, which falls out of the `IdentityProvider` ' +
    'seam rather than being special-cased.',
  tags: ['me'],
  responses: {
    200: {
      description: 'The profile.',
      content: { 'application/json': { schema: userResponse } },
    },
    404: {
      description:
        'No profile for this user. The message never describes a developer workflow — ' +
        'the same path serves an account whose post-confirmation trigger failed.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/me',
  summary: 'Update preferences',
  description:
    'Accepts `displayName`, `timezone`, `currency`, `weekStartsOn`, ' +
    '`defaultReminderOffset` and `defaultLists` — and nothing else. The body schema is ' +
    'strict, so any other field is `400` naming it: `email`, `cognitoSub` and ' +
    '`onboardingState` belong to the auth flow. `defaultReminderOffset` takes any integer ' +
    'in `[-10080, 0]`, where `0` is a real "at the time" reminder and `null` clears it to ' +
    'Off — the two are different states, not two spellings of one.',
  tags: ['me'],
  request: {
    body: {
      content: { 'application/json': { schema: patchUserInput } },
    },
  },
  responses: {
    200: {
      description: 'The updated profile.',
      content: { 'application/json': { schema: userResponse } },
    },
    400: {
      description: 'A field outside the accepted set, or a value out of range.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No profile for this user.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/me/devices` (P1-08). The push-token rows the Phase 5 reminder Lambda fans out over
 * (access pattern 15, ADR-009).
 */
registry.registerPath({
  method: 'post',
  path: '/v1/me/devices',
  summary: 'Register an Expo push token',
  description:
    'Registers one install and returns the `deviceId` the server minted. The body carries ' +
    'no id: token rotation is delete-then-create rather than an upsert, so the client ' +
    'stores the returned id and `DELETE`s it when the token changes or the user signs out. ' +
    'Creating, so an `Idempotency-Key` is required — a timed-out retry that actually ' +
    'succeeded would otherwise leave a device row whose id the client never learned.',
  tags: ['me'],
  request: {
    body: {
      content: { 'application/json': { schema: registerDeviceInput } },
    },
  },
  responses: {
    201: {
      description: 'The registered device, including its server-minted id.',
      content: { 'application/json': { schema: deviceResponse } },
    },
    400: {
      description:
        'A malformed Expo push token, an unsupported platform, or a field outside the ' +
        'accepted set — the body schema is strict.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/me/devices/{deviceId}',
  summary: 'Unregister a push token',
  description:
    'Removes one device from the caller’s own partition, so push stops immediately. ' +
    'Called on sign-out **before** tokens are cleared, and on token rotation. Answers ' +
    '`200` with the envelope rather than `204`, because every response carries ' +
    '`{ data, meta }` and a `204` has no body to carry one in.',
  tags: ['me'],
  /**
   * Declared, because OpenAPI requires every variable in a templated path to be — a
   * `{deviceId}` with no matching parameter is an incomplete document that generators
   * silently produce clients for. The handler itself deliberately does **not** validate the
   * id against this shape: a malformed one addresses no row and already answers `404`, and
   * checking it first would turn "no such device" into two statuses for one fact.
   */
  request: {
    params: z.object({ deviceId }),
  },
  responses: {
    200: {
      description: 'The device is gone. `data` names the id that was removed.',
      content: { 'application/json': { schema: deletedDeviceResponse } },
    },
    404: {
      description:
        'This user has no such device — whether the id was never theirs or the row is ' +
        'already gone. A retried sign-out `DELETE` lands here, and for that caller `404` ' +
        'means "already gone".',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/agenda',
  summary: 'The complete agenda for a caller-local date window',
  description:
    'Hydrates one-off and recurring activities, applies occurrence overrides, converts ' +
    'effective instants into `tz`, and returns the trimmed caller-specific rows Today and ' +
    'Plans render. The inclusive window is capped at 62 days. `include` accepts the distinct ' +
    'comma-separated tokens `anytime_unscheduled`, `overdue`, and `reminders`; reminder rows ' +
    'are always scoped to the authenticated caller. Responses carry a strong `ETag` over ' +
    '`data` only and `Cache-Control: private, max-age=60`; a matching `If-None-Match` returns ' +
    '`304` with no body.',
  tags: ['agenda'],
  request: { query: agendaQuery },
  responses: {
    200: {
      description: 'Every projected day plus any bounded-read warnings.',
      content: { 'application/json': { schema: agendaResponse } },
    },
    304: { description: 'The caller already holds this exact data payload.' },
    400: {
      description:
        'A malformed date or timezone, an invalid include token, or a window over 62 days.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/agenda/activities/{id}',
  summary: 'Canonical agenda rows for one activity',
  description:
    'Reads the ACT partition strongly consistently, expands that activity for the requested ' +
    'window without GSI discovery, and returns the META version used. An empty rows array is ' +
    'authoritative. Intended for post-PATCH series reconciliation.',
  tags: ['agenda'],
  request: {
    params: z.object({ id: activityId }),
    query: agendaQuery,
  },
  responses: {
    200: {
      description: 'Canonical rows and the activity version used to produce them.',
      content: { 'application/json': { schema: activityAgendaResponse } },
    },
    400: {
      description: 'Malformed activity id, date window, include token, or timezone.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'The activity is absent or not visible to the caller.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/activities` (P1-11). The registration that brings `Activity` and
 * `CreateActivityInput` into `components/schemas`.
 *
 * `CreateActivityInput` renders as a `oneOf` on `objectKind`, which is the contract's
 * explicit-intent rule made machine-readable: a generated client cannot construct a request
 * body without a complete, valid target pair.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/activities',
  summary: 'A flat, paginated stage of activities',
  description:
    'Four stages, each reading one GSI1 bucket so a page is one query and one cursor: ' +
    '`upcoming` (dated, today forward, ascending), `past` (dated, before today, ' +
    'descending), `needs_date` (undated plans, most recently discussed first) and `saved` ' +
    '(undated tasks, newest first). **Not for Today** — nothing is expanded here, so a ' +
    'recurring series is one row carrying `isRecurring` rather than one row per ' +
    'occurrence. `filter` is required and has no default. `type` narrows the page **after** ' +
    'the query, so a page can be shorter than `limit` — even empty — while `nextCursor` is ' +
    'still set; page until the cursor is absent, not until a page is short. `upcoming` and ' +
    '`past` split at the caller’s current date, taken from `X-Client-Timezone` and falling ' +
    'back to UTC.',
  tags: ['activities'],
  request: {
    query: activityListQuery,
  },
  responses: {
    200: {
      description: 'One page of the stage, newest or earliest first per the filter.',
      content: { 'application/json': { schema: activityListResponse } },
    },
    400: {
      description:
        'A missing or unknown `filter`, an unknown `type`, a malformed cursor, or a ' +
        '`limit` outside 1–200.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities',
  summary: 'Create a Task or a Plan',
  description:
    'Creates the object kind and type **the client chose** — both are required and neither ' +
    'has a server default. Omitting either, sending an incompatible pair, or putting ' +
    'participants on a Task is `400 validation_failed` naming the field; the same title ' +
    'sent under two different targets produces two different objects, and nothing about ' +
    'the words selects one. `status`, `visibility`, the counters, `scheduledAtUtc` and the ' +
    'timestamps are all server-derived. Reminders belong to the creator alone. ' +
    '`listId` and `listItemId` are not accepted here: only the list-scoped scheduling ' +
    'endpoint may establish that relationship, after list access has been checked. ' +
    'Creating, so an `Idempotency-Key` is required.',
  tags: ['activities'],
  request: {
    body: {
      content: { 'application/json': { schema: createActivityInput } },
    },
  },
  responses: {
    201: {
      description: 'The created activity, echoing the target that was stored.',
      content: { 'application/json': { schema: activityResponse } },
    },
    400: {
      description:
        'No target, half a target, an incompatible `details.kind`, a Task carrying ' +
        'participants, more than three reminders, or a missing `Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description:
        'A `parentActivityId` this caller has no relationship to — `404`, never `403`, so ' +
        'guessing an id cannot confirm that it exists.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/activities/{id}',
  summary: 'One activity, with the caller’s own reminders',
  description:
    'Returns `{ activity, reminders, occurrence? }` — an object of named collections, so participants, ' +
    'expenses, updates, attachments, children and date suggestions are **added** as their ' +
    'phases land rather than changing the envelope. `reminders` is the caller’s own and ' +
    'nobody else’s: every participant’s rows live in the partition this reads, and the ' +
    'projection filters to the caller before responding — a shared plan has one schedule ' +
    'and many reminder sets, and nobody sees that anybody else has any. `listId` and ' +
    '`listItemId` are not returned: the contract gates them on a list-access check that ' +
    'arrives with lists in Phase 3. A caller with no relationship to the activity gets ' +
    '`404`, never `403`. Supplying `occurrenceDate` explicitly targets that nominal recurring ' +
    'occurrence and returns its authoritative effective date, time and status after overrides; ' +
    'without it the response is series/activity detail and never guesses an occurrence.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    query: activityDetailQuery,
  },
  responses: {
    200: {
      description: 'The activity and the caller’s reminders on it.',
      content: { 'application/json': { schema: activityDetailResponse } },
    },
    404: {
      description:
        'No such activity, or none this caller has any relationship to. The two are ' +
        'deliberately indistinguishable.',
      content: { 'application/json': { schema: errorResponse } },
    },
    400: {
      description:
        'Malformed occurrence date, or a date that this recurrence does not emit.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/activities/{id}',
  summary: 'Update an activity, with optimistic concurrency',
  description:
    'Partial update. **`If-Match` is required** and carries the `updatedAt` the client ' +
    'read; omitting it is `400`, and a stale value is `409` with the current `updatedAt` in ' +
    '`error.details`, so the client can refetch and re-apply. A cross-object change must ' +
    'send a complete valid target pair — `objectKind` alone never lets the server choose a ' +
    'type — and Plan → Task is `409` while the plan has participants, expenses or prep ' +
    'tasks, naming each. Changing kind never changes `status`, `completedAt` or `outcome`. ' +
    '`status` is accepted only as `cancelled`; every other value is derived.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: {
      content: { 'application/json': { schema: patchActivityInput } },
    },
  },
  responses: {
    200: {
      description: 'The updated activity.',
      content: { 'application/json': { schema: activityResponse } },
    },
    400: {
      description:
        'A missing `If-Match`, half a target pair, or a field outside the schema.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description:
        'A participant reaching for a field only the owner may change — title, place, ' +
        'or the object or Plan kind.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or none this caller has any relationship to.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'A stale `If-Match`, or a Plan → Task conversion the plan’s own participants, ' +
        'expenses or prep tasks block.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/schedule',
  summary: 'Schedule, reschedule or unschedule an activity',
  description:
    'The sole schedule write path. Requires `Idempotency-Key`; `{ date: null }` ' +
    'unschedules. With `occurrenceDate`, changes only that emitted recurring occurrence ' +
    'and leaves the series META row unchanged.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: scheduleActivityInput } } },
  },
  responses: {
    200: {
      description: 'The committed activity state and any non-disclosing reset flags.',
      content: { 'application/json': { schema: scheduleActivityResponse } },
    },
    400: {
      description: 'Invalid schedule, timezone, recurrence occurrence, or missing key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A participant attempted the owner-only schedule action.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/recurrence/convert',
  summary: 'Convert one recurring occurrence to a one-off',
  description:
    'The atomic Does-not-repeat operation. The selected nominal occurrence supplies the ' +
    'effective schedule; recurrence is removed while stored occurrence history is retained. ' +
    'Requires `Idempotency-Key`.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: convertRecurrenceInput } } },
  },
  responses: {
    200: {
      description: 'The converted one-off activity.',
      content: { 'application/json': { schema: activityResponse } },
    },
    400: {
      description: 'Invalid occurrence target, a non-recurring activity, or missing key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A non-owner attempted to convert the series.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description: 'The activity or selected occurrence changed during conversion.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/activities/{id}',
  summary: 'Delete an activity',
  description:
    'Owner only — a participant gets `403`, anyone else `404`. Removes the activity and ' +
    'everything in its partition, plus every index entry pointing at it. **Prep tasks ' +
    'survive**: their `parentActivityId` is cleared and they become ordinary tasks, because ' +
    'somebody who cancels a trip may still need to return the rental car. The removal ' +
    'batches rather than transacting, so it is safe to call again after a partial failure; ' +
    'the second call finds nothing and answers `404`. Answers `200` with the envelope ' +
    'rather than `204`.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
  },
  responses: {
    200: {
      description: 'The activity is gone. `data` names the id that was removed.',
      content: { 'application/json': { schema: deletedActivityResponse } },
    },
    403: {
      description: 'A participant. They can see the plan; deleting it is the owner’s.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description:
        'No such activity, or none this caller has any relationship to — and the answer a ' +
        'repeated delete gets once the first has succeeded.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/duplicate',
  summary: 'Copy an activity',
  description:
    'Copies `objectKind`, title, type, `details`, `location` and `notes` — and nothing ' +
    'else. Schedule, reminders, participants, expenses, attachments, prep children, lists ' +
    'and completion state are all left behind, each deliberately: re-inviting people is an ' +
    'act the user must take, and a reminder is an offset from a schedule the copy does not ' +
    'have. The copy belongs to the **caller**, is private, and carries no relationship to ' +
    'the original. Its title is suffixed ` (copy)`. Takes no body. Creating, so an ' +
    '`Idempotency-Key` is required.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
  },
  responses: {
    201: {
      description: 'The copy, owned by the caller.',
      content: { 'application/json': { schema: activityResponse } },
    },
    400: {
      description: 'A missing `Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or none this caller has any relationship to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/complete',
  summary: 'Complete an activity or recurring occurrence',
  description:
    'Requires an `Idempotency-Key`. Without `occurrenceDate`, updates META, every direct ' +
    'participant index and a prep-task parent pointer atomically. With `occurrenceDate`, ' +
    'writes exactly one occurrence override and leaves series META unchanged. Plan completion ' +
    'is owner-only; a prep task may also be completed by its parent plan owner or participant.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: completeActivityInput } } },
  },
  responses: {
    200: {
      description: 'The completed activity or occurrence.',
      content: { 'application/json': { schema: activityCompletionResponse } },
    },
    400: {
      description:
        'Missing idempotency key, invalid outcome, or occurrence on a non-series.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A related participant who lacks completion authority.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or no relationship to it.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/uncomplete',
  summary: 'Reverse activity or occurrence completion',
  description:
    'Requires an `Idempotency-Key` and applies the same authority and transaction split as ' +
    'completion. One-off state returns to scheduled or saved; occurrence state is deleted.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: uncompleteActivityInput } } },
  },
  responses: {
    200: {
      description: 'The restored activity, or the series and nominal occurrence date.',
      content: { 'application/json': { schema: activityCompletionResponse } },
    },
    400: {
      description: 'Missing idempotency key or occurrence on a non-series.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A related participant who lacks completion authority.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or no relationship to it.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/skip',
  summary: 'Skip an activity or recurring occurrence',
  description:
    'Requires an `Idempotency-Key` and uses the same authority and transaction split as ' +
    'completion. Without `occurrenceDate`, activity META, every direct participant index ' +
    'and a prep-task parent pointer change atomically. With `occurrenceDate`, exactly one ' +
    'override becomes skipped and series META remains unchanged.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: skipActivityInput } } },
  },
  responses: {
    200: {
      description: 'The skipped activity or occurrence.',
      content: { 'application/json': { schema: activityCompletionResponse } },
    },
    400: {
      description: 'Missing idempotency key or occurrence on a non-series.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A related participant who lacks skip authority.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or no relationship to it.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/snooze',
  summary: 'Snooze an activity or recurring occurrence',
  description:
    'Requires an `Idempotency-Key`. A wall time keeps the item on its nominal date; an ISO ' +
    'instant may move a recurring occurrence to another local date, at most 60 calendar days away.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: snoozeActivityInput } } },
  },
  responses: {
    200: {
      description: 'The snoozed activity or occurrence.',
      content: { 'application/json': { schema: activityCompletionResponse } },
    },
    400: {
      description: 'Invalid target, time, range, or missing idempotency key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A related participant who lacks snooze authority.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or no relationship to it.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/unsnooze',
  summary: 'Remove activity or occurrence snooze state',
  description:
    'Requires an `Idempotency-Key`. Deletes only snooze state and never erases completion, ' +
    'skip or reschedule state. Cross-day move-marker references are updated atomically.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: unsnoozeActivityInput } } },
  },
  responses: {
    200: {
      description: 'The restored activity or nominal recurring occurrence date.',
      content: { 'application/json': { schema: activityCompletionResponse } },
    },
    400: {
      description: 'Invalid target or missing idempotency key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A related participant who lacks snooze authority.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or no relationship to it.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/activities/{id}/reminders',
  summary: 'List the caller’s reminders for one activity',
  description:
    'Returns only rows under the signed-in user’s reminder prefix. The activity must have a ' +
    'date; no response exposes another participant’s reminder id, offset, or count.',
  tags: ['activities'],
  request: { params: z.object({ id: activityId }) },
  responses: {
    200: {
      description: 'The caller’s reminder rows, possibly empty.',
      content: { 'application/json': { schema: reminderListResponse } },
    },
    400: {
      description: 'The activity has no scheduled date.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/reminders',
  summary: 'Create one caller-owned reminder',
  description:
    'Any participant may create a reminder for themselves. Requires `Idempotency-Key`; a ' +
    'same-key replay returns the original row, while a new request at the same offset is ' +
    '`409`. The per-user, per-activity cap is three.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: reminderInput } } },
  },
  responses: {
    201: {
      description: 'The server-id reminder row created for the caller.',
      content: { 'application/json': { schema: reminderResponse } },
    },
    400: {
      description: 'Invalid offset, undated activity, or missing idempotency key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description: 'This caller already has a reminder at the requested offset.',
      content: { 'application/json': { schema: errorResponse } },
    },
    422: {
      description: 'This caller already has three reminders on this activity.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/activities/{id}/reminders/{reminderId}',
  summary: 'Delete one caller-owned reminder',
  description:
    'The key is built under the signed-in user’s prefix. Another participant’s reminder id ' +
    'therefore resolves to `404`, never `403`.',
  tags: ['activities'],
  request: { params: z.object({ id: activityId, reminderId }) },
  responses: {
    200: {
      description: 'The reminder is gone. `data` names the id removed.',
      content: { 'application/json': { schema: deletedReminderResponse } },
    },
    400: {
      description: 'The activity has no scheduled date.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description:
        'No such activity, no caller relationship, or no caller-owned reminder.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/lists` (P3-05). The registrations that bring `ListView`, `CreateListInput`,
 * `ListDetail` and `DeletedList` into `components/schemas`.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/lists',
  summary: 'The caller’s lists, a page at a time',
  description:
    'Pages active List pointers 50 at a time, then batch-reads that page’s current META ' +
    'rows — one Query and one BatchGetItem per page. `meta.nextCursor` is present only ' +
    'when there is another page; a client pages until it is absent. The 100 cap applies ' +
    'to Lists the caller owns, not memberships received from other owners, which is why ' +
    'the cursor is not optional.',
  tags: ['lists'],
  request: { query: listListQuery },
  responses: {
    200: {
      description: 'One page of the caller’s Lists, in pointer order.',
      content: { 'application/json': { schema: listPageResponse } },
    },
    400: {
      description: 'A malformed cursor, or a parameter outside the strict query schema.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists',
  summary: 'Create a list from an explicitly selected template',
  description:
    'Requires the visible `title` and the `templateKey` the user tapped. The server copies ' +
    'behaviour, capabilities, slot, icon and empty-state copy from that exact catalogue ' +
    'entry onto the new row — values, never a live reference — and stores `templateKey` as ' +
    'provenance only. A missing or unknown key is `400`; there is no `simple-list` ' +
    'fallback and no title matching. The body is strict, so a client-supplied `behaviour`, ' +
    '`capabilities`, `slot`, `icon` or `emptyStateCopy` is a `400` naming it. ' +
    '`sourceActivityId` must name an owned Plan and forces the copied slot to `null`, ' +
    'writing the id-only reverse projection in the same transaction. Optional `listId` is ' +
    'the permanent client-minted `lst_` ULID for durable offline creation; a collision ' +
    'answers with the same metadata-free conflict as Activity creation. Creating, so an ' +
    '`Idempotency-Key` is required. At 100 owned lists, creation is refused.',
  tags: ['lists'],
  request: {
    body: { content: { 'application/json': { schema: createListInput } } },
  },
  responses: {
    201: {
      description: 'The created list, with every copied field on the row.',
      content: { 'application/json': { schema: listResponse } },
    },
    400: {
      description:
        'A missing or unknown template, an empty title, a copied field in the body, a ' +
        'malformed client id, the owned-list cap, or a missing `Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'A `sourceActivityId` this caller has no relationship to.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'A client-minted `listId` that is already in use or retained by a deletion ' +
        'tombstone. The message carries no metadata about the id’s fate.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/lists/{id}',
  summary: 'One list, with an optional first item page',
  description:
    'META alone by default. With `includeItems=true`, adds the strongly fenced first 50 ' +
    'items in `(rank, itemId)` order, an opaque cursor bound to the META rank version, and ' +
    'the caller’s own `viewerLink` per item — never another member’s. A repair or ' +
    'behaviour-migration fence returns `503` with `Retry-After: 1` and no item rows. Also ' +
    'the authoritative read durable creation reconciles a lost response against: `200` ' +
    'adopts the server row, `404` parks the intent.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    query: listDetailQuery,
  },
  responses: {
    200: {
      description: 'The list, and the fenced first item page when asked for.',
      content: { 'application/json': { schema: listDetailResponse } },
    },
    404: {
      description:
        'No such list, or none this caller has a pointer to. The two are deliberately ' +
        'indistinguishable.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/lists/{id}',
  summary: 'Delete a list',
  description:
    'Owner only — a member gets `403`, anyone else `404`. Writes the replay-window ' +
    'tombstone, removes the `SOURCE_LIST#` projection when present, clears `listId` and ' +
    '`listItemId` on Activities named by current viewer links — never deleting an ' +
    'Activity — then removes every item, link and pointer, and clears the caller’s ' +
    'profile default for the list’s slot when it still points here. Safe to retry; once ' +
    'complete, a second call answers `404`. Answers `200` with the envelope, never `204`.',
  tags: ['lists'],
  request: { params: z.object({ id: listId }) },
  responses: {
    200: {
      description: 'The list is gone. `data` names the id that was removed.',
      content: { 'application/json': { schema: deletedListResponse } },
    },
    403: {
      description: 'A member. They can see the list; deleting it is the owner’s.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description:
        'No such list, none this caller can see — and the answer a repeated delete gets ' +
        'once the first has succeeded.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/capture/*` (P1-18). **Stubs until Phase 8**, and published anyway.
 *
 * The whole reason they ship early is that the client integration is written once against a
 * settled contract, so the shapes belong in the spec from the first commit — a generated
 * client should be able to build a correct request seven phases before one succeeds.
 */
for (const route of [
  {
    path: '/v1/capture/parse',
    schema: captureParseInput,
    summary: 'Parse text into draft fields',
    what: 'text',
  },
  {
    path: '/v1/capture/extract',
    schema: captureExtractInput,
    summary: 'Extract draft fields from an attachment',
    what: 'an uploaded photo or screenshot',
  },
  {
    path: '/v1/capture/link',
    schema: captureLinkInput,
    summary: 'Extract draft fields from a link',
    what: 'a pasted URL',
  },
] as const) {
  registry.registerPath({
    method: 'post',
    path: route.path,
    summary: `${route.summary} (not available until Phase 8)`,
    description:
      `Turns ${route.what} into **draft fields for review**. Returns ` +
      '`501 not_implemented` in this build — the body is still validated against the real ' +
      'schema first, so a client can be written and exercised against the settled shape ' +
      'now rather than discovering seven phases later that it was sending the wrong thing.' +
      '\n\n' +
      '`creationTarget` is **required and has no default**: capture fills fields inside a ' +
      'destination the user already chose and never chooses one. `objectKind` and `type` ' +
      'outside the target, `listId`, participants, audience, visibility and ' +
      '`reminder`/`reminders`/`offsetMinutes` are rejected by name — they are never model ' +
      'output. Text such as "remind me an hour before" stays source text and cannot move ' +
      'the Reminder control.',
    tags: ['capture'],
    request: {
      body: {
        content: { 'application/json': { schema: route.schema } },
      },
    },
    responses: {
      400: {
        description:
          'A missing or invalid `creationTarget`, or any field outside the schema — ' +
          'returned **before** the `501`, which is what proves validation runs first.',
        content: { 'application/json': { schema: errorResponse } },
      },
      501: {
        description: 'A well-formed request. Capture arrives in Phase 8.',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}

registry.registerPath({
  method: 'get',
  path: '/v1/health',
  summary: 'Liveness and build identity',
  description:
    'Returns the deployed git SHA and stage. Performs no I/O — a liveness signal that ' +
    'fails because the table is throttled is not a liveness signal. Unauthenticated by ' +
    'exception in `routeSplit`, and the only route in `/v1` that is.',
  tags: ['system'],
  responses: {
    200: {
      description: 'The service is up.',
      content: { 'application/json': { schema: healthResponse } },
    },
    500: {
      description: 'Unexpected failure. The message is always the literal safe string.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * Builds the document. Pure — it takes no arguments, reads no environment and writes no
 * file, so it can be asserted in a test. `scripts/gen-openapi.ts` is what puts it on disk.
 *
 * The return type is annotated rather than inferred because `OpenAPIObject` comes from
 * `openapi3-ts`, which `zod-to-openapi` does not re-export: inferring it produced TS2883,
 * "cannot be named without a reference … this is likely not portable". `openapi3-ts` is
 * therefore a declared dev dependency rather than a phantom one reached through another
 * package's `node_modules`.
 */
export function buildOpenApiDocument(): OpenAPIObject {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ordinary Days API',
      version: '0.1.0',
      description:
        'The API behind Today, Plans and Lists. Generated from the Zod schemas in ' +
        '`packages/shared`; never edited by hand.',
    },
    /**
     * Present with one entry rather than omitted, even though there is no deployed URL yet
     * (P0-25). Phase 4 adds the `execute-api` host and Phase 5 the custom domain, and each
     * is then a one-line addition to an array that already exists — rather than a new key
     * appearing in the document and producing a diff that hides the change that mattered.
     */
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  });
}
