import { describe, expect, it, vi } from 'vitest';
import type { OutboxIntent } from '@/lib/sqlite/outbox';
import { ActivityPushAdapter, type ActivityPushTransport } from './pushAdapter';

const ACTIVITY = 'act_01J0000000000000000000000A';
const REMINDER = 'rem_01J0000000000000000000000A';

function intent(name: string, variables: unknown): OutboxIntent {
  return {
    intentId: `intent-${name}`,
    mutationKey: ['activity', name],
    variables,
    entityId: ACTIVITY,
    orderingKey: `activity:${ACTIVITY}`,
    status: 'in_flight',
    createdAt: 1,
    seq: 1,
    attempts: 1,
  };
}

function transport(called: (name: string, values: readonly unknown[]) => void) {
  const operation = (name: string) =>
    vi.fn(async (...values: unknown[]) => {
      called(name, values);
      return { name };
    });
  return {
    create: operation('create'),
    duplicate: operation('duplicate'),
    remove: operation('remove'),
    patch: operation('patch'),
    convertRecurrence: operation('convertRecurrence'),
    schedule: operation('schedule'),
    complete: operation('complete'),
    uncomplete: operation('uncomplete'),
    skip: operation('skip'),
    snooze: operation('snooze'),
    unsnooze: operation('unsnooze'),
    createReminder: operation('createReminder'),
    deleteReminder: operation('deleteReminder'),
  } satisfies ActivityPushTransport;
}

describe('ActivityPushAdapter', () => {
  it.each([
    {
      mutation: 'create',
      method: 'create',
      variables: {
        input: {
          activityId: ACTIVITY,
          objectKind: 'task',
          type: 'task',
          title: 'Offline task',
        },
        idempotencyKey: 'create-key',
      },
    },
    {
      mutation: 'duplicate',
      method: 'duplicate',
      variables: { activityId: ACTIVITY, idempotencyKey: 'duplicate-key' },
    },
    {
      mutation: 'delete',
      method: 'remove',
      variables: { activityId: ACTIVITY, intentId: 'delete-key' },
    },
    {
      mutation: 'patch',
      method: 'patch',
      variables: {
        activityId: ACTIVITY,
        intentId: 'patch-key',
        input: { title: 'Edited' },
        ifMatch: '2026-08-19T00:00:00.000Z',
      },
    },
    {
      mutation: 'convert-recurrence',
      method: 'convertRecurrence',
      variables: {
        activityId: ACTIVITY,
        input: { selectedDate: '2026-08-19' },
        idempotencyKey: 'convert-key',
      },
    },
    {
      mutation: 'schedule',
      method: 'schedule',
      variables: {
        activityId: ACTIVITY,
        input: { date: '2026-08-20', time: '09:00', timezone: 'UTC' },
        idempotencyKey: 'schedule-key',
      },
    },
    {
      mutation: 'complete',
      method: 'complete',
      variables: {
        activityId: ACTIVITY,
        input: { occurrenceDate: '2026-08-19' },
        idempotencyKey: 'complete-key',
      },
    },
    {
      mutation: 'uncomplete',
      method: 'uncomplete',
      variables: {
        activityId: ACTIVITY,
        input: { occurrenceDate: '2026-08-19' },
        idempotencyKey: 'uncomplete-key',
      },
    },
    {
      mutation: 'skip',
      method: 'skip',
      variables: {
        activityId: ACTIVITY,
        input: { occurrenceDate: '2026-08-19' },
        idempotencyKey: 'skip-key',
      },
    },
    {
      mutation: 'snooze',
      method: 'snooze',
      variables: {
        activityId: ACTIVITY,
        input: { occurrenceDate: '2026-08-19', until: '10:30' },
        idempotencyKey: 'snooze-key',
      },
    },
    {
      mutation: 'unsnooze',
      method: 'unsnooze',
      variables: {
        activityId: ACTIVITY,
        input: { occurrenceDate: '2026-08-19', until: '09:00' },
        idempotencyKey: 'unsnooze-key',
      },
    },
    {
      mutation: 'reminder-create',
      method: 'createReminder',
      variables: {
        activityId: ACTIVITY,
        input: { reminderId: REMINDER, offsetMinutes: -15 },
        idempotencyKey: 'reminder-create-key',
      },
    },
    {
      mutation: 'reminder-delete',
      method: 'deleteReminder',
      variables: {
        activityId: ACTIVITY,
        reminderId: REMINDER,
        intentId: 'reminder-delete-key',
        idempotencyKey: 'reminder-delete-key',
      },
    },
  ])('dispatches $mutation through the typed $method endpoint', async (fixture) => {
    const calls: Array<{ name: string; values: readonly unknown[] }> = [];
    const adapter = new ActivityPushAdapter(
      transport((name, values) => calls.push({ name, values })),
    );

    await adapter.execute(intent(fixture.mutation, fixture.variables));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(fixture.method);
    expect(calls[0]?.values[0]).toEqual(
      fixture.mutation === 'create' ? fixture.variables.input : ACTIVITY,
    );
    if (fixture.mutation === 'unsnooze') {
      expect(calls[0]?.values[1]).toEqual({ occurrenceDate: '2026-08-19' });
    }
  });

  it('refuses malformed or unsupported durable callbacks before transport', async () => {
    const called = vi.fn();
    const adapter = new ActivityPushAdapter(transport(called));

    await expect(
      adapter.execute(
        intent('patch', { activityId: ACTIVITY, input: { title: 'No version' } }),
      ),
    ).rejects.toThrow('ifMatch');
    await expect(
      adapter.execute(intent('unknown', { activityId: ACTIVITY, idempotencyKey: 'x' })),
    ).rejects.toThrow('Unsupported native Activity mutation');
    expect(called).not.toHaveBeenCalled();
  });

  it('marks an invalid persisted patch as permanent and actionable', async () => {
    const called = vi.fn();
    const adapter = new ActivityPushAdapter(transport(called));

    await expect(
      adapter.execute(
        intent('patch', {
          activityId: ACTIVITY,
          input: {
            recurrence: {
              mode: 'fixed',
              segments: [
                { freq: 'daily', effectiveFrom: '2026-08-21', time: '09:00' },
                { freq: 'daily', effectiveFrom: '2026-08-21', time: '10:30' },
              ],
            },
            editedFromDate: '2026-08-21',
          },
          ifMatch: '2026-08-21T00:00:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      message: expect.stringContaining(
        'This saved change is invalid. Discard it and try again.',
      ),
    });
    expect(called).not.toHaveBeenCalled();
  });
});
