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
  completeActivityInput,
  createActivityInput,
  patchActivityInput,
  reminderInput,
  scheduleActivityInput,
  skipActivityInput,
  snoozeActivityInput,
  uncompleteActivityInput,
  unsnoozeActivityInput,
} from '@od/shared/schemas';
import { apiClient } from '@/lib/apiClient';
import type { OutboxIntent } from '@/lib/sqlite/outbox';

type PushVariables = Record<string, unknown>;

export interface ActivityPushTransport {
  create(input: unknown, idempotencyKey: string): Promise<unknown>;
  duplicate(activityId: string, idempotencyKey: string): Promise<unknown>;
  remove(activityId: string): Promise<unknown>;
  patch(activityId: string, input: unknown, ifMatch: string): Promise<unknown>;
  convertRecurrence(
    activityId: string,
    selectedDate: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  schedule(activityId: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  complete(activityId: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  uncomplete(
    activityId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  skip(activityId: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  snooze(activityId: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  unsnooze(activityId: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  createReminder(
    activityId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  deleteReminder(activityId: string, reminderId: string): Promise<unknown>;
}

export const sharedActivityPushTransport: ActivityPushTransport = {
  create: (input, idempotencyKey) =>
    createActivity(apiClient, createActivityInput.parse(input), idempotencyKey),
  duplicate: (activityId, idempotencyKey) =>
    duplicateActivity(apiClient, activityId, idempotencyKey),
  remove: (activityId) => deleteActivityForReplay(apiClient, activityId),
  patch: (activityId, input, ifMatch) =>
    patchActivityForReplay(
      apiClient,
      activityId,
      patchActivityInput.parse(input),
      ifMatch,
    ),
  convertRecurrence: (activityId, selectedDate, idempotencyKey) =>
    convertRecurrence(apiClient, activityId, selectedDate, idempotencyKey),
  schedule: (activityId, input, idempotencyKey) =>
    scheduleActivity(
      apiClient,
      activityId,
      scheduleActivityInput.parse(input),
      idempotencyKey,
    ),
  complete: (activityId, input, idempotencyKey) =>
    completeActivity(
      apiClient,
      activityId,
      completeActivityInput.parse(input),
      idempotencyKey,
    ),
  uncomplete: (activityId, input, idempotencyKey) =>
    uncompleteActivity(
      apiClient,
      activityId,
      uncompleteActivityInput.parse(input),
      idempotencyKey,
    ),
  skip: (activityId, input, idempotencyKey) =>
    skipActivity(apiClient, activityId, skipActivityInput.parse(input), idempotencyKey),
  snooze: (activityId, input, idempotencyKey) =>
    snoozeActivity(
      apiClient,
      activityId,
      snoozeActivityInput.parse(input),
      idempotencyKey,
    ),
  unsnooze: (activityId, input, idempotencyKey) =>
    unsnoozeActivity(
      apiClient,
      activityId,
      unsnoozeActivityInput.parse(input),
      idempotencyKey,
    ),
  createReminder: (activityId, input, idempotencyKey) =>
    createReminder(apiClient, activityId, reminderInput.parse(input), idempotencyKey),
  deleteReminder: (activityId, reminderId) =>
    deleteReminderForReplay(apiClient, activityId, reminderId),
};

function variables(intent: OutboxIntent): PushVariables {
  if (typeof intent.variables !== 'object' || intent.variables === null) {
    throw new Error('Durable Activity intent variables are malformed.');
  }
  return intent.variables as PushVariables;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Durable Activity intent is missing ${name}.`);
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
      throw new Error(
        `Unsupported native outbox domain: ${intent.mutationKey[0] ?? ''}.`,
      );
    }
    const name = intent.mutationKey[1];
    const value = variables(intent);
    const activityId = requiredString(value.activityId ?? intent.entityId, 'activityId');
    if (activityId !== intent.entityId) {
      throw new Error(
        'Durable Activity intent entity identity does not match its payload.',
      );
    }
    if (name === 'create') {
      return this.transport.create(
        createActivityInput.parse(value.input),
        requiredString(value.idempotencyKey, 'idempotencyKey'),
      );
    }
    if (name === 'duplicate') {
      return this.transport.duplicate(
        activityId,
        requiredString(value.idempotencyKey, 'idempotencyKey'),
      );
    }
    if (name === 'delete') return this.transport.remove(activityId);
    if (name === 'patch') {
      return this.transport.patch(
        activityId,
        patchActivityInput.parse(value.input),
        requiredString(value.ifMatch, 'ifMatch'),
      );
    }
    if (name === 'convert-recurrence') {
      const input = variablesFrom(value.input, 'recurrence conversion');
      return this.transport.convertRecurrence(
        activityId,
        requiredString(input.selectedDate, 'selectedDate'),
        requiredString(value.idempotencyKey, 'idempotencyKey'),
      );
    }
    const idempotencyKey = requiredString(value.idempotencyKey, 'idempotencyKey');
    if (name === 'schedule') {
      return this.transport.schedule(
        activityId,
        scheduleActivityInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'complete') {
      return this.transport.complete(
        activityId,
        completeActivityInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'uncomplete') {
      return this.transport.uncomplete(
        activityId,
        uncompleteActivityInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'skip') {
      return this.transport.skip(
        activityId,
        skipActivityInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'snooze') {
      return this.transport.snooze(
        activityId,
        snoozeActivityInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'unsnooze') {
      const input = variablesFrom(value.input, 'unsnooze');
      return this.transport.unsnooze(
        activityId,
        unsnoozeActivityInput.parse({
          ...(typeof input.occurrenceDate === 'string'
            ? { occurrenceDate: input.occurrenceDate }
            : {}),
        }),
        idempotencyKey,
      );
    }
    if (name === 'reminder-create') {
      return this.transport.createReminder(
        activityId,
        reminderInput.parse(value.input),
        idempotencyKey,
      );
    }
    if (name === 'reminder-delete') {
      return this.transport.deleteReminder(
        activityId,
        requiredString(value.reminderId, 'reminderId'),
      );
    }
    throw new Error(`Unsupported native Activity mutation: ${name ?? ''}.`);
  }
}

function variablesFrom(value: unknown, name: string): PushVariables {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Durable ${name} input is malformed.`);
  }
  return value as PushVariables;
}
