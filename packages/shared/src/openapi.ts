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
import {
  activityUpdatePage,
  postActivityUpdateInput,
  postActivityUpdateResult,
} from './schemas/activityUpdate.js';
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
  addIngredientsToListInput,
  addIngredientsToListResult,
  bulkCreateListItemsInput,
  changeListBehaviourInput,
  changeListBehaviourQuery,
  createListInput,
  createListItemInput,
  deletedList,
  listDetail,
  listDetailItem,
  listDetailQuery,
  listItemPageQuery,
  listItemView,
  listListQuery,
  listSettingsMutation,
  listTemplate,
  listUndoResult,
  listView,
  patchListInput,
  patchListItemInput,
  reversibleItemMutation,
  scheduledListItem,
  scheduleListItemInput,
  undoListOperationInput,
} from './schemas/list.js';
import { snoozeActivityInput, unsnoozeActivityInput } from './schemas/occurrence.js';
import { plansData, plansMode } from './schemas/plans.js';
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
const addIngredientsToListResponse = envelope(addIngredientsToListResult);
const deletedActivityResponse = envelope(deletedActivity);
const reminderResponse = envelope(reminder);
const reminderListResponse = envelope(z.array(reminder));
const deletedReminderResponse = envelope(deletedReminder);
const plansResponse = envelope(plansData);
const activityUpdatePageResponse = envelope(activityUpdatePage);
const postActivityUpdateResponse = envelope(postActivityUpdateResult);

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
const listTemplateListResponse = envelope(z.array(listTemplate));
const listItemResponse = envelope(listItemView);
const scheduledListItemResponse = envelope(scheduledListItem);
const listItemListResponse = envelope(z.array(listItemView));
const listItemPageResponse = envelope(z.array(listDetailItem));
const reversibleItemMutationResponse = envelope(reversibleItemMutation);
const listSettingsMutationResponse = envelope(listSettingsMutation);
const listUndoResultResponse = envelope(listUndoResult);

/** The `act_` path parameter. Declared because OpenAPI requires every path template to be. */
const activityId = ulidId('act');
const reminderId = ulidId('rem');
const listId = ulidId('lst');
const itemId = ulidId('itm');

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
    'Off — the two are different states, not two spellings of one. `defaultLists` is a ' +
    '**nested per-slot patch**, not a replacement of the stored map: each supplied value ' +
    'is a `lst_` id or `null`, an omitted slot is preserved untouched, and `null` removes ' +
    'only that key. So two devices choosing different slots both keep their answer. The ' +
    'stored map never holds a null — clearing removes the key.',
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
    'are always scoped to the authenticated caller. Responses carry a weak `ETag` — ' +
    '`W/"…"` — over `data` only and `Cache-Control: private, max-age=60`; a matching ' +
    '`If-None-Match` returns `304` with no body. The validator is weak because ' +
    '`meta.requestId` differs on every response, so no tag over `data` can claim the ' +
    'byte-identity a strong one asserts.',
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
  path: '/v1/activities/{id}/ingredients/add-to-list',
  summary: 'Send selected meal ingredients to a list the caller has chosen',
  description:
    'Requires an `Idempotency-Key`. Owner-only, and only on a `meal`. `listId` is required ' +
    'and must be a `collection` the caller may write: the destination is resolved on the ' +
    'client, from the `groceries` slot, and shown to the user before this is called — the ' +
    'server never resolves a slot and never falls back to one. Each selected ingredient is ' +
    'named by its stable `ing_` id and resolved against the current ingredient array, so a ' +
    'reorder cannot redirect the action; an id that was removed or replaced rejects the ' +
    'whole request without writing anything. Titles, `sourceActivityId` and `sourceLabel` ' +
    'are derived server-side and are not accepted on input here or on the ordinary bulk ' +
    'route. Selections are grouped by normalized title: each group extends one matching ' +
    '**unchecked** row or creates one row, while a **checked** match was already bought. ' +
    'Provenance ownership is retained as storage-only Activity-keyed segments rather than ' +
    'inferred by splitting the rendered label. `itemId` is optional; a supplied id remains ' +
    'durably bound to its outcome after the receipt expires, including when deduplication ' +
    'absorbed it into an existing row.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: addIngredientsToListInput } } },
  },
  responses: {
    201: {
      description:
        'What happened to each selected ingredient, and the one label the operation used.',
      content: { 'application/json': { schema: addIngredientsToListResponse } },
    },
    400: {
      description:
        'Missing idempotency key, a non-meal activity, a destination that is not a ' +
        'writable collection, or an ingredient id the meal no longer has.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity or list, or no relationship to either.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'A supplied destination id belongs to another outcome, or its permanently bound ' +
        'target was deleted.',
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
    'Pages all of the caller’s List access pointers 50 at a time, then batch-reads that ' +
    'page’s current META rows — including archived Lists — with one Query and one ' +
    'BatchGetItem per page. The endpoint does not filter by `archived`; a filtered-empty ' +
    'page may still carry `meta.nextCursor`, and the client pages until it is absent. The ' +
    '100 cap applies to Lists the caller owns, not memberships received from other owners.',
  tags: ['lists'],
  request: { query: listListQuery },
  responses: {
    200: {
      description: 'One unfiltered page of the caller’s Lists, in pointer order.',
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
    'the caller’s own `viewerLink` / trimmed `viewerPlan` pair per linked item — never ' +
    'another member’s pointer or Plan state. The caller filter precedes one bounded Activity ' +
    'hydration. The pair is present only when the pointer resolves to a readable **Plan**: an ' +
    'unlinked row, one whose Activity the caller may not read, and one whose Plan has since ' +
    'been converted to a Task all carry neither field. A repair or ' +
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

/**
 * `/v1/lists/{id}` settings and `/v1/lists/{id}/behaviour` (P3-09). The registrations that
 * bring `PatchListInput`, `ChangeListBehaviourInput` and `ListSettingsMutation` into
 * `components/schemas`.
 */
registry.registerPath({
  method: 'patch',
  path: '/v1/lists/{id}',
  summary: 'Change a list’s title, capabilities, default slot or archived state',
  description:
    'Requires `If-Match` carrying the `updatedAt` the client read; omitting it is `400`, ' +
    'not `428`, because the error union is closed. Everything this route changes is ' +
    '**additive in both directions** and applies immediately with no confirmation: ' +
    'turning `checkable` off retains every item\u2019s `checked` value and turning ' +
    '`supportsLocation` off retains every stored location, so re-enabling either ' +
    'restores exactly what was there. `capabilities` is a partial patch of the two ' +
    'flags. `slot` is nullable \u2014 `null` clears it \u2014 and changing or clearing ' +
    'it removes the caller\u2019s `defaultLists[oldSlot]` in the same transaction, but ' +
    'only while that slot still names this list, so a newer destination chosen on ' +
    'another device survives. The body is strict: `behaviour` belongs to the ' +
    'replay-protected action below and `templateKey` is immutable provenance, so ' +
    'either one is a `400` naming it. A change that actually moves something answers ' +
    'with a settings Undo token; a rename alone does not, because renaming a list has ' +
    'no undo offer. A member may rename; only the owner may change capabilities, slot ' +
    'or archived state.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    body: { content: { 'application/json': { schema: patchListInput } } },
  },
  responses: {
    200: {
      description: 'The updated list, with the Undo offer when the change is reversible.',
      content: { 'application/json': { schema: listSettingsMutationResponse } },
    },
    400: {
      description:
        'A missing `If-Match`, an empty body, or a field this route does not accept — ' +
        '`behaviour` and `templateKey` among them.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A member reaching for capabilities, slot or archived state.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'The `If-Match` version has moved on. `details[0]` carries the current ' +
        '`updatedAt` so the client can refetch and re-apply rather than guess.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/behaviour',
  summary: 'Change a list’s behaviour, through its gated migration',
  description:
    'Owner only, and the only route that changes `behaviour`. Requires both `If-Match` ' +
    'and an `Idempotency-Key`: it starts a bounded, resumable item migration that a ' +
    'retried request must join rather than duplicate, and the operation is identified ' +
    'by that key. The first transaction leaves public behaviour, `updatedAt` and every ' +
    'item unchanged and only installs the migration marker; while it stands, every ' +
    'item read and mutation attempts a bounded drain and otherwise answers ' +
    '`503 internal` with `Retry-After: 1`. The final transaction alone flips the ' +
    'behaviour, advances `rankVersion` \u2014 so item cursors issued before the ' +
    'migration are rejected rather than resumed \u2014 records the Undo inverse and the ' +
    'receipt, and clears the marker. `collection` to `watch` gives every item ' +
    '`watchStatus: "want"` and `collection` to `meals` an empty ingredient list; both ' +
    'are additive and answer with a 6-second Undo offer. Leaving `watch` or `meals` ' +
    'for anything else \u2014 `watch` to `meals` included \u2014 is destructive. The first ' +
    'call answers `409` with a typed `confirmation` containing source/target behaviours, ' +
    '`itemVersion`, item count and field labels, and writes nothing. The confirmed action ' +
    'echoes that complete object under a new key; migration installation and its gated ' +
    'snapshot reject any intervening item mutation or changed loss summary with a fresh ' +
    '`409`. A list carrying none of the data being removed loses nothing, so it needs no ' +
    'confirmation and changes immediately.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    query: changeListBehaviourQuery,
    body: { content: { 'application/json': { schema: changeListBehaviourInput } } },
  },
  responses: {
    200: {
      description:
        'The migrated list. An upgrade also carries its Undo token; a confirmed downgrade ' +
        'does not, because its only path back is another confirmed call.',
      content: { 'application/json': { schema: listSettingsMutationResponse } },
    },
    400: {
      description: 'A missing `If-Match` or `Idempotency-Key`, or an unknown behaviour.',
      content: { 'application/json': { schema: errorResponse } },
    },
    403: {
      description: 'A member. Changing behaviour is the owner’s.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'Either a stale `If-Match`, or the data-loss preview. The preview carries the typed ' +
        'top-level `confirmation` object that a confirmed request must echo unchanged.',
      content: { 'application/json': { schema: errorResponse } },
    },
    503: {
      description:
        'The migration is still running after this request’s bounded drain. Retry after ' +
        '`Retry-After`; the same key resumes the same operation.',
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
 * `/v1/lists/{id}/items` (P3-08). The registrations that bring `CreateListItemInput`,
 * `PatchListItemInput`, `ListItemView` and `ReversibleItemMutation` into
 * `components/schemas`.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/lists/{id}/items',
  summary: 'One page of a list’s items',
  description:
    'Pages 50 strongly consistent item rows at a time in `(rank, itemId)` order. A linked ' +
    'row carries the **caller’s own** `viewerLink` / trimmed `viewerPlan` pair and nobody ' +
    'else’s pointer or Plan state. The pair is present only when the pointer resolves to a ' +
    'readable **Plan**: an unlinked row, one whose Activity the caller may not read, and one ' +
    'whose Plan has since been converted to a Task all carry neither. The caller ' +
    'filter precedes one bounded Activity hydration. Strong META reads before and ' +
    'after the query must agree on `rankVersion` and find neither a rank-repair nor a ' +
    'behaviour-migration marker; a failed fence returns `503 internal` with ' +
    '`Retry-After: 1` and no rows, and the client restarts at page one. `meta.nextCursor` ' +
    'is bound to the rank generation that issued it, so a cursor minted before a repair is ' +
    'rejected rather than resumed across changed sort keys.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    query: listItemPageQuery,
  },
  responses: {
    200: {
      description:
        'One page of items. A row carries the caller’s `viewerLink` and trimmed ' +
        '`viewerPlan` together, or neither — the pair is present only when the pointer ' +
        'resolves to a readable Plan.',
      content: { 'application/json': { schema: listItemPageResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/items',
  summary: 'Add one item to a list',
  description:
    '`afterItemId` places the item — the server converts it to a rank and the client never ' +
    'sends one. The body is strict, so `checked`, `rank`, `itemRevision`, `sourceActivityId` ' +
    'and `sourceLabel` are rejected rather than dropped: the first is server-gated and the ' +
    'rest are server-derived. `location` is accepted only on a `collection` whose ' +
    '`supportsLocation` capability is on, and `details` only when the behaviour has that ' +
    'shape and the discriminant matches. Beyond 500 items the answer is `400` with ' +
    '`List is full.` Optional `itemId` is the permanent client-minted `itm_` ULID, ' +
    'condition-checked against the item tombstone. Creating, so an `Idempotency-Key` is ' +
    'required.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    body: { content: { 'application/json': { schema: createListItemInput } } },
  },
  responses: {
    201: {
      description: 'The created item.',
      content: { 'application/json': { schema: listItemResponse } },
    },
    400: {
      description:
        'A full list, a field this list’s behaviour or capabilities do not allow, a ' +
        'mismatched `details.behaviour`, a malformed client id, or a missing ' +
        '`Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or an `afterItemId` that names no item on it.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description:
        'A client-minted `itemId` already in use or retained by a deletion tombstone. The ' +
        'message carries no metadata about the id’s fate.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/items/bulk',
  summary: 'Add many items in one ordered operation',
  description:
    'Ordinary item creation only: provenance and source-ingredient fields are rejected, ' +
    'because deriving them is the meal action’s alone. The batch is one ordered sequence ' +
    'from one position — the first member may carry `afterItemId`, a later one may not — ' +
    'allocated from a single rank generation and committed as one transaction when it ' +
    'fits, or as a resumable chunked series when it does not. Idempotent under the ' +
    '`Idempotency-Key`, and after that receipt expires under the stable per-item ids, so a ' +
    'replay of a partially committed batch completes it rather than duplicating it.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    body: { content: { 'application/json': { schema: bulkCreateListItemsInput } } },
  },
  responses: {
    201: {
      description: 'The items created by this call, in the order they were sent.',
      content: { 'application/json': { schema: listItemListResponse } },
    },
    400: {
      description:
        'A batch that would exceed 500 items, a member carrying a provenance or ' +
        'server-owned field, a position on a member other than the first, or a missing ' +
        '`Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/lists/{id}/items/{itemId}',
  summary: 'One item by its stable id',
  description:
    'The authoritative exact read durable creation reconciles a lost response against: ' +
    '`200` adopts the server row, `404` parks the intent for explicit Retry or Discard. It ' +
    'follows the identity locator under the same strong fence as a page, so a missing item ' +
    'and a tombstoned one are deliberately indistinguishable.',
  tags: ['lists'],
  request: { params: z.object({ id: listId, itemId }) },
  responses: {
    200: {
      description: 'The item.',
      content: { 'application/json': { schema: listItemResponse } },
    },
    404: {
      description: 'No such list or item, or a tombstoned id.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/lists/{id}/items/{itemId}',
  summary: 'Edit an item, or move it',
  description:
    '**No `If-Match`.** Item writes are per-field last-write-wins — optimistic concurrency ' +
    'on every checkbox in a grocery list would produce constant spurious `409`s — and the ' +
    'internal item revision is a retry fence rather than a client-visible conflict. ' +
    '`note` and `location` accept `null` to clear the field, which is a different ' +
    'intention from omitting it — and clearing is gated exactly as setting is, so a value ' +
    'retained behind a switched-off capability cannot be removed. `afterItemId` requests a ' +
    'reorder (`null` moves the item to the front) and **may arrive alongside ordinary ' +
    'fields**: they land in one transaction, because the reorder already re-puts the whole ' +
    'row at its new key. `checked` and `location` are subject to the same two-part ' +
    'behaviour and capability gates as creation.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId, itemId }),
    body: { content: { 'application/json': { schema: patchListItemInput } } },
  },
  responses: {
    200: {
      description: 'The updated item.',
      content: { 'application/json': { schema: listItemResponse } },
    },
    400: {
      description:
        'A field this list’s behaviour or capabilities do not allow, a mismatched ' +
        '`details.behaviour`, an empty patch, or a reorder mixed with a field edit.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list or item.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/lists/{id}/items/{itemId}',
  summary: 'Delete an item, reversibly',
  description:
    'Removes the ranked row and its identity locator, and leaves a replay-window tombstone ' +
    'holding the exact deletion snapshot — the item, its rank, its current viewer links ' +
    'and the matching Activity provenance — under a single-use Undo operation. Answers ' +
    '`{ affectedCount, undoToken, undoExpiresAt }` rather than the deleted row, because a ' +
    'client must not send row contents back as authority. `undoExpiresAt` is the UI’s ' +
    '6-second offer deadline, not the server’s replay deadline: an Undo the user has ' +
    'already accepted stays valid for the shared retention window, so an offline inverse ' +
    'cannot expire in transit. Restoring is `POST /v1/lists/{id}/undo`.',
  tags: ['lists'],
  request: { params: z.object({ id: listId, itemId }) },
  responses: {
    200: {
      description: 'The item is gone, and `data` carries the Undo offer.',
      content: { 'application/json': { schema: reversibleItemMutationResponse } },
    },
    404: {
      description: 'No such list or item — and the answer a repeated delete gets.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/list-templates` (P3-06). The registration that brings `ListTemplate` into
 * `components/schemas`, so a generated client can render the chooser from the spec.
 */
registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/items/{itemId}/schedule',
  summary: 'Plan this item — the optional bridge to Activities',
  description:
    'Creates a Plan from a list item and links it for the caller. **The item is not ' +
    'touched**: it is not copied, moved, checked, hidden or given an Activity id, and it ' +
    'comes back in the response unchanged so a client can see the bridge linked rather ' +
    'than duplicated. `creationTarget` and `audience` are both **required** and neither is ' +
    'ever inferred — the server does not read the list’s `behaviour`, `templateKey` or ' +
    'capabilities to choose a Plan kind, so a `watch` list does not make a `watch` Plan. ' +
    'In this phase only `just_me` is accepted; `selected_people` is `400` with ' +
    '`Sharing is coming soon.` until Phase 6, and a non-empty `attachmentIds` is `400` ' +
    'until the confirm-and-link path lands. `activityId` and every `reminderId` are ' +
    'permanent client-minted ids, required here because this path is offline-capable: a ' +
    'replay after the 24-hour receipt expires adopts an Activity already standing at that ' +
    'id with the same owner, list and item, and rewrites nothing — least of all the ' +
    'caller’s current pointer, which may name a newer Plan. Any other collision is the ' +
    'metadata-free durable-create conflict. `viewerLink` is the caller’s own pointer and ' +
    'never another viewer’s.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId, itemId }),
    body: { content: { 'application/json': { schema: scheduleListItemInput } } },
  },
  responses: {
    201: {
      description: 'The Plan, the unchanged item, and the caller’s link.',
      content: { 'application/json': { schema: scheduledListItemResponse } },
    },
    400: {
      description:
        'A missing or incomplete `creationTarget` or `audience`, `details.kind` that ' +
        'contradicts the chosen Plan kind, a reminder without its id, an unknown field at ' +
        'any depth, `selected_people`, or a non-empty `attachmentIds`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list or item, or a tombstoned id.',
      content: { 'application/json': { schema: errorResponse } },
    },
    409: {
      description: 'That `activityId` is already in use by something else.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * `/v1/lists/{id}` bulk actions and their compensation (P3-10). The registrations that bring
 * `UndoListOperationInput` and `ListUndoResult` into `components/schemas`.
 */
registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/clear-checked',
  summary: 'Delete every checked item, reversibly',
  description:
    'The end of a shopping trip. **No confirmation dialog** — the count is in the button the ' +
    'user tapped, they ticked each of those rows one at a time, and the 10-second undo ' +
    'window is the safety net. This is the single deliberate exception to the ' +
    'destructive-change rule, recorded in `00-open-decisions.md` item 33. Each deleted item ' +
    'leaves a replay-window tombstone holding its exact snapshot — the row, its rank, its ' +
    'current viewer links and the matching Activity provenance — under **one** single-use ' +
    'operation, however many transactions the delete needed. ' +
    'Valid only on a `collection` whose `checkable` capability is on — on any other list, ' +
    'including one whose stored flag a behaviour change left behind, it is `400`. The ' +
    'hidden retained checks such a list carries are exactly what these must not reach.' +
    ' Both answer `{ affectedCount, undoToken, undoExpiresAt }` with a **10-second** ' +
    'window, and `undoExpiresAt` is the client\u2019s presentation deadline: stop offering a ' +
    'new Undo at that instant, while an inverse the user already accepted stays valid ' +
    'through the shared replay retention.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
  },
  responses: {
    200: {
      description: 'How many were deleted, and the token that can put them back.',
      content: { 'application/json': { schema: reversibleItemMutationResponse } },
    },
    400: {
      description:
        'Not a collection, or a collection whose checkboxes are off — or a missing ' +
        '`Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/uncheck-all',
  summary: 'Uncheck every checked item, reversibly',
  description:
    'The start of the next trip. Not destructive, so no dialog is in question — it still ' +
    'gets the canonical 10-second toast, because every bulk reversible action does. The ' +
    'operation records **exactly the ids it changed**, so compensation re-checks those and ' +
    'not whatever happens to be unchecked when it arrives; an item deleted during the ' +
    'window is simply skipped. ' +
    'Valid only on a `collection` whose `checkable` capability is on — on any other list, ' +
    'including one whose stored flag a behaviour change left behind, it is `400`. The ' +
    'hidden retained checks such a list carries are exactly what these must not reach.' +
    ' Both answer `{ affectedCount, undoToken, undoExpiresAt }` with a **10-second** ' +
    'window, and `undoExpiresAt` is the client\u2019s presentation deadline: stop offering a ' +
    'new Undo at that instant, while an inverse the user already accepted stays valid ' +
    'through the shared replay retention.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
  },
  responses: {
    200: {
      description: 'How many were unchecked, and the token that re-checks them.',
      content: { 'application/json': { schema: reversibleItemMutationResponse } },
    },
    400: {
      description:
        'Not a collection, or a collection whose checkboxes are off — or a missing ' +
        '`Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/lists/{id}/undo',
  summary: 'Apply one recorded compensation',
  description:
    'Takes the opaque token a reversible operation returned and applies the inverse **the ' +
    'server recorded** — clients never send deleted row contents back as authority. It is ' +
    'the only route allowed to reclaim an item id protected by a tombstone, and it earns ' +
    'that by naming the operation: every tombstone it removes must carry the same operation ' +
    'id, so one delete\u2019s token can never reclaim another\u2019s ids. Restored items come back ' +
    'with their original ids, their **previous ranks**, their still-live viewer links and ' +
    'the matching Activity provenance; a link whose Activity was deleted or repointed ' +
    'meanwhile is omitted rather than restored dead. Requires its own `Idempotency-Key`. ' +
    '`undoExpiresAt` is **not** consulted here: it governs whether a client may offer a new ' +
    'Undo, never whether an accepted inverse may run, so an inverse replayed after that ' +
    'deadline still applies for as long as the shared retention lasts. Answers `200` with a ' +
    'discriminated outcome — `applied` with its count, `expired` for a token that names ' +
    'nothing or has passed retention, `no_longer_applicable` for one already used or whose ' +
    'recorded preconditions have since moved. The last two write nothing, and none of the ' +
    'three is an error.',
  tags: ['lists'],
  request: {
    params: z.object({ id: listId }),
    body: { content: { 'application/json': { schema: undoListOperationInput } } },
  },
  responses: {
    200: {
      description: 'What happened to the compensation.',
      content: { 'application/json': { schema: listUndoResultResponse } },
    },
    400: {
      description:
        'A body carrying anything but the token, or a missing `Idempotency-Key`.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such list, or none this caller has a pointer to.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/list-templates',
  summary: 'The list template catalogue',
  description:
    'The exact shared catalogue, as data: every field of every record, in the fixed order ' +
    'the style chooser renders. There is no filtering, no query parameter, no ranking and ' +
    'no title matcher — the user taps one record, and that tap is the only thing that sets ' +
    '`templateKey`. Static, so it performs no database read: `Cache-Control: public, ' +
    'max-age=86400` and a weak `ETag` — `W/"…"` — over the catalogue itself, which changes ' +
    'when a shipped record is edited, added or reordered. It is weak rather than strong ' +
    'because `meta.requestId` differs on every response even though the catalogue does ' +
    'not. A matching `If-None-Match` answers `304`. The mobile creation sheet bundles a ' +
    'projection of this same shared module, so first-launch offline creation never depends ' +
    'on this request.',
  tags: ['lists'],
  responses: {
    200: {
      description: 'Every template, in catalogue order.',
      content: { 'application/json': { schema: listTemplateListResponse } },
    },
    304: { description: 'The caller already holds this exact catalogue.' },
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
 * The plan's activity feed (§2.5, P3-19).
 *
 * Only `POST` mutates, so only it takes an `Idempotency-Key`.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/activities/{id}/updates',
  summary: 'One newest-first page of the plan’s feed',
  description:
    'Fifty entries per page, newest first, continued with the opaque `cursor` the previous ' +
    'page returned. The first page is already embedded in activity detail, so a client ' +
    'opening a plan issues no request here until it pages older entries.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    query: z.object({ cursor: z.string().min(1).optional() }),
  },
  responses: {
    200: {
      description: 'One page of entries, with a cursor when more remain.',
      content: { 'application/json': { schema: activityUpdatePageResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/activities/{id}/updates',
  summary: 'Post one entry to the plan’s feed',
  description:
    'Takes `{ body }` and nothing else: `kind`, `authorUserId` and `createdAt` are ' +
    'server-authored, and a request carrying any of them is `validation_failed` rather than ' +
    'a save that quietly ignores them. Requires `Idempotency-Key`. The response carries the ' +
    'plan’s new `lastActivityAt`, authoritative while the GSI projection converges.',
  tags: ['activities'],
  request: {
    params: z.object({ id: activityId }),
    body: { content: { 'application/json': { schema: postActivityUpdateInput } } },
  },
  responses: {
    201: {
      description: 'The stored entry and the plan’s new `lastActivityAt`.',
      content: { 'application/json': { schema: postActivityUpdateResponse } },
    },
    400: {
      description:
        'An empty or oversized body, a server-authored field, or a missing idempotency key.',
      content: { 'application/json': { schema: errorResponse } },
    },
    404: {
      description: 'No such activity, or the caller is a stranger.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/activities/{id}/updates/{updateId}',
  summary: 'Delete one of the caller’s own feed entries',
  description:
    'Author only, and only on `kind: user` entries — a system entry is the record of ' +
    'what happened and is undeletable. A missing entry, a system entry and another author’s ' +
    'entry all answer `404`, so the response reports nothing about a row the caller may not read.',
  tags: ['activities'],
  request: { params: z.object({ id: activityId, updateId: ulidId('upd') }) },
  responses: {
    204: { description: 'The entry is gone.' },
    404: {
      description:
        'No such activity, no caller relationship, or no caller-authored user entry.',
      content: { 'application/json': { schema: errorResponse } },
    },
  },
});

/**
 * The Plans tab (§2.2a, P3-20).
 *
 * One route, four modes. The query and the response are both discriminated unions on `mode`,
 * and the response's **inactive stage keys are absent rather than empty** — a continuation
 * that read only past `#S` must not be able to answer with an `upcoming` a client would merge
 * over the stage it already had.
 */
registry.registerPath({
  method: 'get',
  path: '/v1/plans',
  summary: 'The three-stage Plans tab',
  description:
    'One request renders the screen. `mode=initial` starts four Query streams and returns ' +
    'Needs a date, Upcoming and Past; continuations start only the streams their stage needs ' +
    'and omit the others from the response. Upcoming windows may span at most ' +
    '`MAX_AGENDA_DAYS` (62) inclusive dates; `upcomingWindow.nextFrom` is the earliest later ' +
    'one-off or recurring date, so a scroll may jump an empty gap without skipping a row. ' +
    '`past_window` reports the interval it actually exhausted, which is not the same as the ' +
    'dates that returned rows: a dense grid answers `complete: false` until drained. No ' +
    'stage carries a count, total or badge.',
  tags: ['activities'],
  /**
   * **Flat here, a discriminated union at runtime.** OpenAPI describes query parameters as a
   * flat set, so the arms cannot be expressed in `request.query` — the fields are listed
   * optional and the description says which mode requires which. `plansQuery` remains the
   * only validator, and it is strict: a field belonging to another mode is a `400`, not a
   * parameter this document's shape quietly permits.
   */
  request: {
    query: z.object({
      mode: plansMode,
      tz: z.string(),
      upcomingFrom: z.string().optional(),
      upcomingTo: z.string().optional(),
      pastFrom: z.string().optional(),
      pastBefore: z.string().optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'The stages active for the requested mode.',
      content: { 'application/json': { schema: plansResponse } },
    },
    400: {
      description:
        'An unsupported timezone, a window past the cap, a reversed range, a field belonging ' +
        'to another mode, or a cursor issued for different bounds.',
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
