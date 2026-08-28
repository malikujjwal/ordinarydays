import {
  changeListBehaviour,
  completeActivity,
  convertRecurrence,
  createActivity,
  createList,
  createListItem,
  createReminder,
  deleteActivityForReplay,
  deleteListForReplay,
  deleteReminderForReplay,
  duplicateActivity,
  patchActivityForReplay,
  patchListForReplay,
  patchListItem,
  scheduleActivity,
  skipActivity,
  snoozeActivity,
  uncompleteActivity,
  undoListOperation,
  unsnoozeActivity,
} from '@od/shared/client';
import {
  type ChangeListBehaviourInput,
  type CompleteActivityInput,
  type CreateActivityInput,
  type CreateListInput,
  type CreateListItemInput,
  changeListBehaviourInput,
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
  type ReminderInput,
  reminderInput,
  type ScheduleActivityInput,
  type SkipActivityInput,
  type SnoozeActivityInput,
  scheduleActivityInput,
  skipActivityInput,
  snoozeActivityInput,
  type UncompleteActivityInput,
  type UnsnoozeActivityInput,
  uncompleteActivityInput,
  unsnoozeActivityInput,
} from '@od/shared/schemas';
import { apiClient } from '@/lib/apiClient';
import type { OutboxIntent } from '@/lib/sqlite/outbox';
import { field } from '@/lib/unknown';

export interface ActivityPushTransport {
  create(input: CreateActivityInput, idempotencyKey: string): Promise<unknown>;
  duplicate(activityId: string, idempotencyKey: string): Promise<unknown>;
  remove(activityId: string): Promise<unknown>;
  patch(activityId: string, input: PatchActivityInput, ifMatch: string): Promise<unknown>;
  convertRecurrence(
    activityId: string,
    selectedDate: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  schedule(
    activityId: string,
    input: ScheduleActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  complete(
    activityId: string,
    input: CompleteActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  uncomplete(
    activityId: string,
    input: UncompleteActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  skip(
    activityId: string,
    input: SkipActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  snooze(
    activityId: string,
    input: SnoozeActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  unsnooze(
    activityId: string,
    input: UnsnoozeActivityInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  createReminder(
    activityId: string,
    input: ReminderInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  deleteReminder(activityId: string, reminderId: string): Promise<unknown>;
}

export interface ListPushTransport {
  create(input: CreateListInput, idempotencyKey: string): Promise<unknown>;
  createItem(
    listId: string,
    input: CreateListItemInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  /** No `Idempotency-Key`: the route is not replay-protected, per §5.11.5 (P3-29). */
  patchItem(listId: string, itemId: string, input: PatchListItemInput): Promise<unknown>;
  patch(
    listId: string,
    input: PatchListInput,
    ifMatch: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  /**
   * `POST /v1/lists/:id/behaviour` — the P3-32 inventory extension (§P3-09).
   *
   * Separate from {@link ListPushTransport.patch} because it is a separate route with a separate
   * body type: `PatchListInput` has no `behaviour` field, and the key here identifies a resumable
   * item **migration** rather than deduplicating one conditional write.
   */
  changeBehaviour(
    listId: string,
    input: ChangeListBehaviourInput,
    ifMatch: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  remove(listId: string): Promise<unknown>;
  undo(listId: string, undoToken: string, idempotencyKey: string): Promise<unknown>;
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
  create: (input, idempotencyKey) => createActivity(apiClient, input, idempotencyKey),
  duplicate: (activityId, idempotencyKey) =>
    duplicateActivity(apiClient, activityId, idempotencyKey),
  remove: (activityId) => deleteActivityForReplay(apiClient, activityId),
  patch: (activityId, input, ifMatch) =>
    patchActivityForReplay(apiClient, activityId, input, ifMatch),
  convertRecurrence: (activityId, selectedDate, idempotencyKey) =>
    convertRecurrence(apiClient, activityId, selectedDate, idempotencyKey),
  schedule: (activityId, input, idempotencyKey) =>
    scheduleActivity(apiClient, activityId, input, idempotencyKey),
  complete: (activityId, input, idempotencyKey) =>
    completeActivity(apiClient, activityId, input, idempotencyKey),
  uncomplete: (activityId, input, idempotencyKey) =>
    uncompleteActivity(apiClient, activityId, input, idempotencyKey),
  skip: (activityId, input, idempotencyKey) =>
    skipActivity(apiClient, activityId, input, idempotencyKey),
  snooze: (activityId, input, idempotencyKey) =>
    snoozeActivity(apiClient, activityId, input, idempotencyKey),
  unsnooze: (activityId, input, idempotencyKey) =>
    unsnoozeActivity(apiClient, activityId, input, idempotencyKey),
  createReminder: (activityId, input, idempotencyKey) =>
    createReminder(apiClient, activityId, input, idempotencyKey),
  deleteReminder: (activityId, reminderId) =>
    deleteReminderForReplay(apiClient, activityId, reminderId),
};

export const sharedListPushTransport: ListPushTransport = {
  create: (input, idempotencyKey) => createList(apiClient, input, idempotencyKey),
  createItem: (listId, input, idempotencyKey) =>
    createListItem(apiClient, listId, input, idempotencyKey),
  patchItem: (listId, itemId, input) => patchListItem(apiClient, listId, itemId, input),
  patch: (listId, input, ifMatch, idempotencyKey) =>
    patchListForReplay(apiClient, listId, input, ifMatch, idempotencyKey),
  changeBehaviour: (listId, input, ifMatch, idempotencyKey) =>
    changeListBehaviour(apiClient, listId, input, ifMatch, idempotencyKey),
  remove: (listId) => deleteListForReplay(apiClient, listId),
  undo: (listId, undoToken, idempotencyKey) =>
    undoListOperation(apiClient, listId, undoToken, idempotencyKey).then(
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

  async execute(intent: OutboxIntent): Promise<unknown> {
    if (intent.mutationKey[0] === 'list') return this.executeList(intent);
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
      );
    }
    if (name === 'duplicate') {
      return this.transport.duplicate(
        activityId,
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
      );
    }
    if (name === 'delete') return this.transport.remove(activityId);
    if (name === 'patch') {
      return this.transport.patch(
        activityId,
        parsePersisted(patchActivityInput, field(value, 'input')),
        requiredString(field(value, 'ifMatch'), 'ifMatch'),
      );
    }
    if (name === 'convert-recurrence') {
      const input = variablesFrom(field(value, 'input'), 'recurrence conversion');
      return this.transport.convertRecurrence(
        activityId,
        requiredString(field(input, 'selectedDate'), 'selectedDate'),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
      );
    }
    if (name === 'reminder-delete') {
      return this.transport.deleteReminder(
        activityId,
        requiredString(field(value, 'reminderId'), 'reminderId'),
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
      );
    }
    if (name === 'complete') {
      return this.transport.complete(
        activityId,
        parsePersisted(completeActivityInput, field(value, 'input')),
        idempotencyKey,
      );
    }
    if (name === 'uncomplete') {
      return this.transport.uncomplete(
        activityId,
        parsePersisted(uncompleteActivityInput, field(value, 'input')),
        idempotencyKey,
      );
    }
    if (name === 'skip') {
      return this.transport.skip(
        activityId,
        parsePersisted(skipActivityInput, field(value, 'input')),
        idempotencyKey,
      );
    }
    if (name === 'snooze') {
      return this.transport.snooze(
        activityId,
        parsePersisted(snoozeActivityInput, field(value, 'input')),
        idempotencyKey,
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
      );
    }
    if (name === 'reminder-create') {
      return this.transport.createReminder(
        activityId,
        parsePersisted(reminderInput, field(value, 'input')),
        idempotencyKey,
      );
    }
    throw new DurableActivityIntentError(
      `Unsupported native Activity mutation: ${name ?? ''}.`,
    );
  }

  private executeList(intent: OutboxIntent): Promise<unknown> {
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
      );
    }
    if (name === 'behaviour') {
      /*
       * The confirmation travels inside the persisted body and is replayed **whole**: it binds
       * the user's decision to the item generation the server previewed, so a replay that
       * trimmed or re-derived it would be confirming something else (§P3-09).
       */
      return this.listTransport.changeBehaviour(
        listId,
        parsePersisted(changeListBehaviourInput, field(value, 'input')),
        requiredString(field(value, 'ifMatch'), 'ifMatch'),
        requiredString(
          field(value, 'idempotencyKey') ?? field(value, 'intentId'),
          'idempotencyKey',
        ),
      );
    }
    if (name === 'delete') return this.listTransport.remove(listId);
    if (name === 'undo') {
      return this.listTransport.undo(
        listId,
        requiredString(field(value, 'undoToken'), 'undoToken'),
        requiredString(field(value, 'idempotencyKey'), 'idempotencyKey'),
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
