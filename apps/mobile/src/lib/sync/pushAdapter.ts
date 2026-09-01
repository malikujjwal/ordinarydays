import {
  completeActivity,
  convertRecurrence,
  createActivity,
  createList,
  createListItem,
  createReminder,
  deleteActivityForReplay,
  deleteActivityUpdate,
  deleteListForReplay,
  deleteListItemForReplay,
  deleteReminderForReplay,
  duplicateActivity,
  patchActivityForReplay,
  patchListForReplay,
  patchListItem,
  postActivityUpdate,
  scheduleActivity,
  scheduleListItem,
  skipActivity,
  snoozeActivity,
  uncompleteActivity,
  undoListOperation,
  unsnoozeActivity,
} from '@od/shared/client';
import {
  type CompleteActivityInput,
  type CreateActivityInput,
  type CreateListInput,
  type CreateListItemInput,
  completeActivityInput,
  createActivityInput,
  createListInput,
  createListItemInput,
  type PatchActivityInput,
  type PatchListInput,
  type PatchListItemInput,
  patchActivityInput,
  patchListInput,
  patchListItemInput,
  postActivityUpdateInput,
  type ReminderInput,
  reminderInput,
  type ScheduleActivityInput,
  type ScheduleListItemInput,
  type SkipActivityInput,
  type SnoozeActivityInput,
  scheduleActivityInput,
  scheduleListItemInput,
  skipActivityInput,
  snoozeActivityInput,
  type UncompleteActivityInput,
  type UnsnoozeActivityInput,
  uncompleteActivityInput,
  unsnoozeActivityInput,
} from '@od/shared/schemas';
import { apiClient } from '@/lib/apiClient';
import { activityUpdateMutationKeys, listMutationKeys } from '@/lib/mutationKeys';
import type { OutboxIntent } from '@/lib/sqlite/outbox';
import { field } from '@/lib/unknown';

export interface ActivityPushTransport {
  create(
    input: CreateActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  duplicate(
    activityId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  remove(activityId: string, signal: AbortSignal): Promise<unknown>;
  patch(
    activityId: string,
    input: PatchActivityInput,
    ifMatch: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  convertRecurrence(
    activityId: string,
    selectedDate: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  schedule(
    activityId: string,
    input: ScheduleActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  complete(
    activityId: string,
    input: CompleteActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  uncomplete(
    activityId: string,
    input: UncompleteActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  skip(
    activityId: string,
    input: SkipActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  snooze(
    activityId: string,
    input: SnoozeActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  unsnooze(
    activityId: string,
    input: UnsnoozeActivityInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  createReminder(
    activityId: string,
    input: ReminderInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  deleteReminder(
    activityId: string,
    reminderId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  postUpdate?(
    activityId: string,
    body: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  deleteUpdate?(
    activityId: string,
    updateId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface ListPushTransport {
  create(
    input: CreateListInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  createItem(
    listId: string,
    input: CreateListItemInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** The `Plan this item` bridge (P3-34): one replay-protected Activity-creating POST. */
  scheduleItem(
    listId: string,
    itemId: string,
    input: ScheduleListItemInput,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** No `Idempotency-Key`: the route is not replay-protected, per §5.11.5 (P3-29). */
  patchItem(
    listId: string,
    itemId: string,
    input: PatchListItemInput,
    signal: AbortSignal,
  ): Promise<unknown>;
  removeItem(
    listId: string,
    itemId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  patch(
    listId: string,
    input: PatchListInput,
    ifMatch: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  remove(listId: string, signal: AbortSignal): Promise<unknown>;
  undo(
    listId: string,
    undoToken: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** A persisted payload that cannot become valid by waiting for connectivity or retrying. */
class DurableActivityIntentError extends Error {
  readonly status = 422;
  readonly code = 'validation_failed';

  constructor(message: string) {
    super(message);
    this.name = 'DurableActivityIntentError';
  }
}

type SafeParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly { readonly message: string }[] };
    };

function parsePersisted<T>(
  schema: { readonly safeParse: (value: unknown) => SafeParseResult<T> },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues[0]?.message;
  throw new DurableActivityIntentError(
    `This saved change is invalid. Discard it and try again.${detail === undefined ? '' : ` ${detail}`}`,
  );
}

export const sharedActivityPushTransport: ActivityPushTransport = {
  create: (input, idempotencyKey, signal) =>
    createActivity(apiClient, input, idempotencyKey, signal),
  duplicate: (activityId, idempotencyKey, signal) =>
    duplicateActivity(apiClient, activityId, idempotencyKey, signal),
  remove: (activityId, signal) => deleteActivityForReplay(apiClient, activityId, signal),
  patch: (activityId, input, ifMatch, signal) =>
    patchActivityForReplay(apiClient, activityId, input, ifMatch, signal),
  convertRecurrence: (activityId, selectedDate, idempotencyKey, signal) =>
    convertRecurrence(apiClient, activityId, selectedDate, idempotencyKey, signal),
  schedule: (activityId, input, idempotencyKey, signal) =>
    scheduleActivity(apiClient, activityId, input, idempotencyKey, signal),
  complete: (activityId, input, idempotencyKey, signal) =>
    completeActivity(apiClient, activityId, input, idempotencyKey, signal),
  uncomplete: (activityId, input, idempotencyKey, signal) =>
    uncompleteActivity(apiClient, activityId, input, idempotencyKey, signal),
  skip: (activityId, input, idempotencyKey, signal) =>
    skipActivity(apiClient, activityId, input, idempotencyKey, signal),
  snooze: (activityId, input, idempotencyKey, signal) =>
    snoozeActivity(apiClient, activityId, input, idempotencyKey, signal),
  unsnooze: (activityId, input, idempotencyKey, signal) =>
    unsnoozeActivity(apiClient, activityId, input, idempotencyKey, signal),
  createReminder: (activityId, input, idempotencyKey, signal) =>
    createReminder(apiClient, activityId, input, idempotencyKey, signal),
  deleteReminder: (activityId, reminderId, signal) =>
    deleteReminderForReplay(apiClient, activityId, reminderId, signal),
  postUpdate: (activityId, body, idempotencyKey, signal) =>
    postActivityUpdate(apiClient, activityId, body, idempotencyKey, signal),
  deleteUpdate: (activityId, updateId, signal) =>
    deleteActivityUpdate(apiClient, activityId, updateId, signal),
};

export const sharedListPushTransport: ListPushTransport = {
  create: (input, idempotencyKey, signal) =>
    createList(apiClient, input, idempotencyKey, signal),
  createItem: (listId, input, idempotencyKey, signal) =>
    createListItem(apiClient, listId, input, idempotencyKey, signal),
  scheduleItem: (listId, itemId, input, idempotencyKey, signal) =>
    scheduleListItem(apiClient, listId, itemId, input, idempotencyKey, signal),
  patchItem: (listId, itemId, input, signal) =>
    patchListItem(apiClient, listId, itemId, input, signal),
  removeItem: (listId, itemId, idempotencyKey, signal) =>
    deleteListItemForReplay(apiClient, listId, itemId, idempotencyKey, signal),
  patch: (listId, input, ifMatch, idempotencyKey, signal) =>
    patchListForReplay(apiClient, listId, input, ifMatch, idempotencyKey, signal),
  remove: (listId, signal) => deleteListForReplay(apiClient, listId, signal),
  undo: (listId, undoToken, idempotencyKey, signal) =>
    undoListOperation(apiClient, listId, undoToken, idempotencyKey, signal).then(
      (response) => response.data,
    ),
};

function variables(intent: OutboxIntent): object {
  if (typeof intent.variables !== 'object' || intent.variables === null) {
    throw new DurableActivityIntentError(
      'Durable Activity intent variables are malformed.',
    );
  }
  return intent.variables;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DurableActivityIntentError(`Durable Activity intent is missing ${name}.`);
  }
  return value;
}

/** Executes persisted variables directly through typed shared endpoint clients. */
export class ActivityPushAdapter {
  constructor(
    private readonly transport: ActivityPushTransport = sharedActivityPushTransport,
    private readonly listTransport: ListPushTransport = sharedListPushTransport,
  ) {}

  async execute(
    intent: OutboxIntent,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    if (intent.mutationKey[0] === 'list') return this.executeList(intent, signal);
    if (intent.mutationKey[0] !== 'activity') {
      throw new DurableActivityIntentError(
        `Unsupported native outbox domain: ${intent.mutationKey[0] ?? ''}.`,
      );
    }
    const name = intent.mutationKey[1];
    const value = variables(intent);
    const activityId = requiredString(
      field(value, 'activityId') ?? intent.entityId,
      'activityId',
    );
    if (activityId !== intent.entityId) {
      throw new DurableActivityIntentError(
        'Durable Activity intent entity identity does not match its payload.',
      );
    }
    if (name === 'create') {
      return this.transport.create(
        parsePersisted(createActivityInput, field(value, 'input')),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === 'duplicate') {
      return this.transport.duplicate(
        activityId,
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === 'delete') return this.transport.remove(activityId, signal);
    if (name === 'patch') {
      return this.transport.patch(
        activityId,
        parsePersisted(patchActivityInput, field(value, 'input')),
        requiredString(field(value, 'ifMatch'), 'ifMatch'),
        signal,
      );
    }
    if (name === 'convert-recurrence') {
      const input = variablesFrom(field(value, 'input'), 'recurrence conversion');
      return this.transport.convertRecurrence(
        activityId,
        requiredString(field(input, 'selectedDate'), 'selectedDate'),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === 'reminder-delete') {
      return this.transport.deleteReminder(
        activityId,
        requiredString(field(value, 'reminderId'), 'reminderId'),
        signal,
      );
    }
    if (name === activityUpdateMutationKeys.delete[1]) {
      if (this.transport.deleteUpdate === undefined) {
        throw new DurableActivityIntentError('Native update deletion is not ready.');
      }
      return this.transport.deleteUpdate(
        activityId,
        requiredString(field(value, 'updateId'), 'updateId'),
        signal,
      );
    }
    const idempotencyKey = requiredString(
      field(value, 'idempotencyKey'),
      'idempotencyKey',
    );
    if (name === 'schedule') {
      return this.transport.schedule(
        activityId,
        parsePersisted(scheduleActivityInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'complete') {
      return this.transport.complete(
        activityId,
        parsePersisted(completeActivityInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'uncomplete') {
      return this.transport.uncomplete(
        activityId,
        parsePersisted(uncompleteActivityInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'skip') {
      return this.transport.skip(
        activityId,
        parsePersisted(skipActivityInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'snooze') {
      return this.transport.snooze(
        activityId,
        parsePersisted(snoozeActivityInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'unsnooze') {
      const input = variablesFrom(field(value, 'input'), 'unsnooze');
      return this.transport.unsnooze(
        activityId,
        parsePersisted(unsnoozeActivityInput, {
          ...(typeof field(input, 'occurrenceDate') === 'string'
            ? { occurrenceDate: field(input, 'occurrenceDate') }
            : {}),
        }),
        idempotencyKey,
        signal,
      );
    }
    if (name === 'reminder-create') {
      return this.transport.createReminder(
        activityId,
        parsePersisted(reminderInput, field(value, 'input')),
        idempotencyKey,
        signal,
      );
    }
    if (name === activityUpdateMutationKeys.post[1]) {
      if (this.transport.postUpdate === undefined) {
        throw new DurableActivityIntentError('Native update posting is not ready.');
      }
      return this.transport.postUpdate(
        activityId,
        parsePersisted(postActivityUpdateInput, { body: field(value, 'body') }).body,
        idempotencyKey,
        signal,
      );
    }
    throw new DurableActivityIntentError(
      `Unsupported native Activity mutation: ${name ?? ''}.`,
    );
  }

  private executeList(intent: OutboxIntent, signal: AbortSignal): Promise<unknown> {
    const name = intent.mutationKey[1];
    const value = variables(intent);
    const listId = requiredString(field(value, 'listId'), 'listId');
    if (name === 'item-create') {
      /*
       * An **item** intent's entity is the item, not the list — its ordering key names the
       * list so items land in the order they were typed, and the identity a collision Retry
       * re-mints is the item's. So the entity check here is against `itemId`.
       */
      const itemId = requiredString(field(value, 'itemId'), 'itemId');
      if (itemId !== intent.entityId) {
        throw new DurableActivityIntentError(
          'Durable list item intent entity identity does not match its payload.',
        );
      }
      return this.listTransport.createItem(
        listId,
        parsePersisted(createListItemInput, field(value, 'input')),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === listMutationKeys.itemSchedule[1]) {
      /*
       * The bridge's entity is the **minted Activity** (P3-34): that id is the identity a
       * replay must not re-mint, and it is what the guards protect from canonical pulls while
       * the intent is unresolved. The list and item ids live in the payload.
       */
      const activityId = requiredString(field(value, 'activityId'), 'activityId');
      if (activityId !== intent.entityId) {
        throw new DurableActivityIntentError(
          'Durable bridge intent entity identity does not match its payload.',
        );
      }
      return this.listTransport.scheduleItem(
        listId,
        requiredString(field(value, 'itemId'), 'itemId'),
        parsePersisted(scheduleListItemInput, field(value, 'input')),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === 'item-patch') {
      /* The entity is the item here too, and for the same reason the create records. */
      const itemId = requiredString(field(value, 'itemId'), 'itemId');
      if (itemId !== intent.entityId) {
        throw new DurableActivityIntentError(
          'Durable list item intent entity identity does not match its payload.',
        );
      }
      return this.listTransport.patchItem(
        listId,
        itemId,
        parsePersisted(patchListItemInput, field(value, 'input')),
        signal,
      );
    }
    if (name === listMutationKeys.itemDelete[1]) {
      const itemId = requiredString(field(value, 'itemId'), 'itemId');
      if (itemId !== intent.entityId) {
        throw new DurableActivityIntentError(
          'Durable list item intent entity identity does not match its payload.',
        );
      }
      return this.listTransport.removeItem(
        listId,
        itemId,
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === listMutationKeys.itemUndo[1]) {
      const itemId = requiredString(field(value, 'itemId'), 'itemId');
      if (itemId !== intent.entityId) {
        throw new DurableActivityIntentError(
          'Durable list item intent entity identity does not match its payload.',
        );
      }
      return this.listTransport.undo(
        listId,
        requiredString(field(field(value, 'receipt'), 'undoToken'), 'undoToken'),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (listId !== intent.entityId) {
      throw new DurableActivityIntentError(
        'Durable List intent entity identity does not match its payload.',
      );
    }
    if (name === 'create') {
      /*
       * The minted `lst_` travels inside the body, so the payload's own id is what the entity
       * check above has already agreed with. The idempotency key is the durable intent's, and
       * both are reused verbatim by every transport retry (§P3-05).
       */
      return this.listTransport.create(
        parsePersisted(createListInput, field(value, 'input')),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    if (name === 'patch') {
      return this.listTransport.patch(
        listId,
        parsePersisted(patchListInput, field(value, 'input')),
        requiredString(field(value, 'ifMatch'), 'ifMatch'),
        requiredString(
          field(value, 'idempotencyKey') ?? field(value, 'intentId'),
          'idempotencyKey',
        ),
        signal,
      );
    }
    if (name === 'delete') return this.listTransport.remove(listId, signal);
    if (name === 'undo') {
      return this.listTransport.undo(
        listId,
        requiredString(field(value, 'undoToken'), 'undoToken'),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
        signal,
      );
    }
    throw new DurableActivityIntentError(
      `Unsupported native List mutation: ${name ?? ''}.`,
    );
  }
}

function variablesFrom(value: unknown, name: string): object {
  if (typeof value !== 'object' || value === null) {
    throw new DurableActivityIntentError(`Durable ${name} input is malformed.`);
  }
  return value;
}
