import { describe, expect, it, vi } from 'vitest';
import type { OutboxIntent } from '@/lib/sqlite/outbox';
import {
  ActivityPushAdapter,
  type ActivityPushTransport,
  type ListPushTransport,
} from './pushAdapter';

const ACTIVITY = 'act_01J0000000000000000000000A';
const REMINDER = 'rem_01J0000000000000000000000A';
const LIST = 'lst_01J0000000000000000000000A';

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
    [
      'patch',
      {
        listId: LIST,
        intentId: 'patch-list',
        idempotencyKey: 'patch-list',
        input: { archived: true },
        ifMatch: 'v1',
      },
      'patch',
    ],
    [
      // The minted `lst_` travels in the body and is reused verbatim on every retry (§P3-05).
      'create',
      {
        listId: LIST,
        intentId: 'create-list',
        idempotencyKey: 'create-list',
        input: { listId: LIST, title: 'Costco run', templateKey: 'groceries' },
        seed: {
          behaviour: 'collection',
          capabilities: { checkable: true, supportsLocation: false },
          slot: 'groceries',
          icon: 'cart',
          emptyStateCopy: 'Add something to buy.',
        },
      },
      'create',
    ],
    [
      // The P3-32 inventory extension: its own route, its own body, its own key (§P3-09).
      'behaviour',
      {
        listId: LIST,
        intentId: 'behaviour-list',
        idempotencyKey: 'behaviour-list',
        input: { behaviour: 'watch' },
        ifMatch: 'v1',
      },
      'changeBehaviour',
    ],
    ['delete', { listId: LIST, intentId: 'delete-list' }, 'remove'],
    [
      'undo',
      {
        listId: LIST,
        intentId: 'undo-list',
        idempotencyKey: 'undo-list',
        undoToken: 'undo-token',
      },
      'undo',
    ],
  ] as const)('dispatches durable List %s intents', async (name, variables, method) => {
    const listTransport: ListPushTransport = {
      create: vi.fn(async () => ({})),
      createItem: vi.fn(async () => ({})),
      patchItem: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      changeBehaviour: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
      undo: vi.fn(async () => ({})),
    };
    const adapter = new ActivityPushAdapter(
      transport(() => undefined),
      listTransport,
    );
    await adapter.execute({
      ...intent(name, variables),
      mutationKey: ['list', name],
      entityId: LIST,
      orderingKey: `list:${LIST}`,
    });
    expect(listTransport[method]).toHaveBeenCalled();
  });

  /**
   * §P3-09: the confirmed downgrade replays the server's **complete** preview. A replay that
   * trimmed or re-derived it would be confirming a different item generation, so the whole
   * object is asserted, not the fact that one was sent.
   */
  it('replays a confirmed downgrade with its confirmation whole', async () => {
    const listTransport: ListPushTransport = {
      create: vi.fn(async () => ({})),
      createItem: vi.fn(async () => ({})),
      patchItem: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      changeBehaviour: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
      undo: vi.fn(async () => ({})),
    };
    const confirmation = {
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      itemVersion: 12,
      itemCount: 7,
      fields: ['Watch status', 'Season', 'Episode'],
    };
    const adapter = new ActivityPushAdapter(
      transport(() => undefined),
      listTransport,
    );
    await adapter.execute({
      ...intent('behaviour', {
        listId: LIST,
        intentId: 'confirmed-downgrade',
        idempotencyKey: 'confirmed-downgrade',
        input: { behaviour: 'collection', confirmation },
        ifMatch: 'v1',
      }),
      mutationKey: ['list', 'behaviour'],
      entityId: LIST,
      orderingKey: `list:${LIST}`,
    });

    expect(listTransport.changeBehaviour).toHaveBeenCalledWith(
      LIST,
      { behaviour: 'collection', confirmation },
      'v1',
      'confirmed-downgrade',
    );
  });

  /**
   * An **item** intent's entity is the item, and its route takes no `Idempotency-Key`
   * (§P3-29, §5.11.5). Both are asserted at the call rather than described in a comment.
   */
  describe('durable list item intents', () => {
    const ITEM = 'itm_01J000000000000000000000AA';

    function listTransport(): ListPushTransport {
      return {
        create: vi.fn(async () => ({})),
        createItem: vi.fn(async () => ({})),
        patchItem: vi.fn(async () => ({})),
        patch: vi.fn(async () => ({})),
        changeBehaviour: vi.fn(async () => ({})),
        remove: vi.fn(async () => ({})),
        undo: vi.fn(async () => ({})),
      };
    }

    function itemIntent(name: string, variables: unknown, entityId = ITEM): OutboxIntent {
      return {
        ...intent(name, variables),
        mutationKey: ['list', name],
        entityId,
        orderingKey: `list:${LIST}`,
      };
    }

    it('sends the fields with no idempotency key', async () => {
      const list = listTransport();
      await new ActivityPushAdapter(
        transport(() => undefined),
        list,
      ).execute(
        itemIntent('item-patch', {
          listId: LIST,
          itemId: ITEM,
          intentId: 'patch-item',
          idempotencyKey: 'patch-item',
          input: { title: 'Oat milk' },
        }),
      );

      expect(list.patchItem).toHaveBeenCalledWith(LIST, ITEM, { title: 'Oat milk' });
      expect(vi.mocked(list.patchItem).mock.calls[0]).toHaveLength(3);
    });

    it('refuses an edit whose payload names a different item', async () => {
      const list = listTransport();
      await expect(
        new ActivityPushAdapter(
          transport(() => undefined),
          list,
        ).execute(
          itemIntent(
            'item-patch',
            {
              listId: LIST,
              itemId: ITEM,
              intentId: 'patch-item',
              idempotencyKey: 'patch-item',
              input: { title: 'Oat milk' },
            },
            'itm_01J000000000000000000000BB',
          ),
        ),
      ).rejects.toThrow('entity identity does not match');
      expect(list.patchItem).not.toHaveBeenCalled();
    });

    it('refuses a payload an older build wrote that the schema no longer accepts', async () => {
      const list = listTransport();
      await expect(
        new ActivityPushAdapter(
          transport(() => undefined),
          list,
        ).execute(
          itemIntent('item-patch', {
            listId: LIST,
            itemId: ITEM,
            intentId: 'patch-item',
            idempotencyKey: 'patch-item',
            input: { rank: 'm' },
          }),
        ),
      ).rejects.toThrow('This saved change is invalid.');
    });
  });

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
