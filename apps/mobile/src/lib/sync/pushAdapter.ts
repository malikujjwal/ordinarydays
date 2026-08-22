import {
  completeActivity,
  convertRecurrence,
  createActivity,
  createReminder,
  deleteActivityForReplay,
  deleteReminderForReplay,
  duplicateActivity,
  patchActivityForReplay,
  scheduleActivity,
  skipActivity,
  snoozeActivity,
  uncompleteActivity,
  unsnoozeActivity,
} from '@od/shared/client';
import {
  type CompleteActivityInput,
  type CreateActivityInput,
  completeActivityInput,
  createActivityInput,
  type PatchActivityInput,
  patchActivityInput,
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
  ) {}

  async execute(intent: OutboxIntent): Promise<unknown> {
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
}

function variablesFrom(value: unknown, name: string): object {
  if (typeof value !== 'object' || value === null) {
    throw new DurableActivityIntentError(`Durable ${name} input is malformed.`);
  }
  return value;
}
