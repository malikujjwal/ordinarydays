import type { HttpClient } from '@od/shared/client';
import type { Activity } from '@od/shared/types';
import type { MutationKey, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  type ActivityPostVariables,
  type ActivityUpdateDeleteVariables,
  type ActivityUpdatePostVariables,
  type ConvertRecurrenceVariables,
  type CreateActivityVariables,
  changesActivityLists,
  type DeleteActivityVariables,
  type DuplicateActivityVariables,
  type PatchActivityVariables,
  type ReminderDeleteVariables,
  refreshActivityDetails,
  registerActivityMutationDefaults,
} from '@/lib/mutationDefaults';
import {
  activityMutationKeys,
  activityUpdateMutationKeys,
  listMutationKeys,
} from '@/lib/mutationKeys';
import { shouldWarnBeforeUnload } from '@/lib/onlineManager';
import { dehydratePersistedClient } from '@/lib/persister';
import { createOfflineQueryClient } from '@/lib/queryClient';

const ACTIVITY_ID = 'act_01J0000000000000000000000A';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000001';

const activity: Activity = {
  activityId: ACTIVITY_ID,
  ownerId: 'usr_01J0000000000000000000000B',
  objectKind: 'task',
  type: 'task',
  status: 'saved',
  title: 'Call the dentist',
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  details: { kind: 'task' },
  icsSequence: 0,
  createdAt: '2026-08-08T10:00:00.000Z',
  lastActivityAt: '2026-08-08T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
  schemaVersion: 1,
};

type Variables =
  | CreateActivityVariables
  | ConvertRecurrenceVariables
  | DuplicateActivityVariables
  | DeleteActivityVariables
  | ReminderDeleteVariables
  | PatchActivityVariables
  | ActivityPostVariables<Record<string, unknown>>;

const cases: Array<{ key: MutationKey; variables: Variables }> = [
  {
    key: activityMutationKeys.create,
    variables: {
      input: { objectKind: 'task', type: 'task', title: 'Call the dentist' },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  },
  {
    key: activityMutationKeys.duplicate,
    variables: { activityId: ACTIVITY_ID, idempotencyKey: IDEMPOTENCY_KEY },
  },
  {
    key: activityMutationKeys.delete,
    variables: { activityId: ACTIVITY_ID, intentId: 'delete-intent-stable' },
  },
  {
    key: activityMutationKeys.patch,
    variables: {
      activityId: ACTIVITY_ID,
      intentId: 'patch-intent-stable',
      input: { title: 'Dentist' },
      ifMatch: activity.updatedAt,
      changeNames: ['Title'],
    },
  },
  {
    key: activityMutationKeys.convertRecurrence,
    variables: {
      activityId: ACTIVITY_ID,
      input: { selectedDate: '2026-08-12' },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  },
  {
    key: activityMutationKeys.schedule,
    variables: {
      activityId: ACTIVITY_ID,
      input: { date: '2026-08-12', timezone: 'UTC' },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  },
  {
    key: activityMutationKeys.complete,
    variables: { activityId: ACTIVITY_ID, input: {}, idempotencyKey: IDEMPOTENCY_KEY },
  },
  {
    key: activityMutationKeys.uncomplete,
    variables: { activityId: ACTIVITY_ID, input: {}, idempotencyKey: IDEMPOTENCY_KEY },
  },
  {
    key: activityMutationKeys.skip,
    variables: { activityId: ACTIVITY_ID, input: {}, idempotencyKey: IDEMPOTENCY_KEY },
  },
  {
    key: activityMutationKeys.snooze,
    variables: {
      activityId: ACTIVITY_ID,
      input: { until: '20:00' },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  },
  {
    key: activityMutationKeys.unsnooze,
    variables: { activityId: ACTIVITY_ID, input: {}, idempotencyKey: IDEMPOTENCY_KEY },
  },
  {
    key: activityMutationKeys.reminderCreate,
    variables: {
      activityId: ACTIVITY_ID,
      input: { offsetMinutes: -15 },
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  },
  {
    key: activityMutationKeys.reminderDelete,
    variables: {
      activityId: ACTIVITY_ID,
      reminderId: 'rem_01J0000000000000000000000A',
      intentId: 'reminder-delete-intent-stable',
    },
  },
];

function fakeHttpClient() {
  const request = vi.fn((options: { path: string }) => {
    if (options.path.endsWith('/updates')) {
      return Promise.resolve({
        data: {
          update: {
            updateId: 'upd_01J0000000000000000000000A',
            activityId: ACTIVITY_ID,
            kind: 'user',
            authorUserId: activity.ownerId,
            body: 'A durable note',
            createdAt: '2026-08-08T11:00:00.000Z',
            schemaVersion: 1,
          },
          lastActivityAt: '2026-08-08T11:00:00.000Z',
        },
      });
    }
    if (options.path.includes('/updates/')) {
      return Promise.resolve({
        data: { updateId: 'upd_01J0000000000000000000000A' },
      });
    }
    if (options.path.endsWith('/reminders')) {
      return Promise.resolve({
        data: {
          reminderId: 'rem_01J0000000000000000000000A',
          activityId: ACTIVITY_ID,
          userId: 'usr_01J0000000000000000000000B',
          offsetMinutes: -15,
          createdAt: '2026-08-08T10:00:00.000Z',
          updatedAt: '2026-08-08T10:00:00.000Z',
          schemaVersion: 1,
        },
      });
    }
    if (options.path.includes('/reminders/')) {
      return Promise.resolve({
        data: { reminderId: 'rem_01J0000000000000000000000A' },
      });
    }
    if (options.path === `/v1/activities/${ACTIVITY_ID}` && 'method' in options) {
      return Promise.resolve(
        (options as { method?: string }).method === 'DELETE'
          ? { data: { activityId: ACTIVITY_ID } }
          : { data: activity },
      );
    }
    if (options.path.endsWith('/schedule'))
      return Promise.resolve({ data: { activity } });
    if (
      options.path.endsWith('/complete') ||
      options.path.endsWith('/uncomplete') ||
      options.path.endsWith('/skip') ||
      options.path.endsWith('/snooze') ||
      options.path.endsWith('/unsnooze')
    ) {
      return Promise.resolve({ data: { activity } });
    }
    return Promise.resolve({ data: activity });
  });
  return { request, client: { request } as unknown as HttpClient };
}

function addPausedMutation(client: QueryClient, key: MutationKey, variables: Variables) {
  client.getMutationCache().build(
    client,
    { mutationKey: key },
    {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: 'pending',
      variables,
      submittedAt: 1,
    },
  );
}

describe('the query client defaults', () => {
  it('keeps one week of offlineFirst history with retries owned by the transport', () => {
    const client = createOfflineQueryClient();
    expect(client.getDefaultOptions().queries).toMatchObject({
      networkMode: 'offlineFirst',
      staleTime: 60_000,
      gcTime: 7 * 24 * 60 * 60 * 1000,
      retry: false,
    });
    expect(client.getDefaultOptions().mutations).toMatchObject({
      networkMode: 'offlineFirst',
      retry: false,
    });
  });

  it('owns exactly the thirteen stable persisted keys', () => {
    expect(Object.values(activityMutationKeys)).toEqual([
      ['activity', 'create'],
      ['activity', 'duplicate'],
      ['activity', 'delete'],
      ['activity', 'patch'],
      ['activity', 'convert-recurrence'],
      ['activity', 'schedule'],
      ['activity', 'complete'],
      ['activity', 'uncomplete'],
      ['activity', 'skip'],
      ['activity', 'snooze'],
      ['activity', 'unsnooze'],
      ['activity', 'reminder-create'],
      ['activity', 'reminder-delete'],
    ]);
  });

  it('does not refresh activity lists for reminder-only writes', () => {
    expect(changesActivityLists(activityMutationKeys.reminderCreate)).toBe(false);
    expect(changesActivityLists(activityMutationKeys.reminderDelete)).toBe(false);
    expect(changesActivityLists(activityUpdateMutationKeys.post)).toBe(false);
    expect(changesActivityLists(activityUpdateMutationKeys.delete)).toBe(false);
  });

  it('marks the series and every occurrence detail stale after an activity write', () => {
    const client = createOfflineQueryClient();
    const seriesKey = ['activity', ACTIVITY_ID] as const;
    const firstOccurrenceKey = [
      'activity',
      ACTIVITY_ID,
      'occurrence',
      '2026-08-12',
    ] as const;
    const secondOccurrenceKey = [
      'activity',
      ACTIVITY_ID,
      'occurrence',
      '2026-08-13',
    ] as const;
    client.setQueryData(seriesKey, { activity });
    client.setQueryData(firstOccurrenceKey, { activity });
    client.setQueryData(secondOccurrenceKey, { activity });

    expect(
      refreshActivityDetails(client, activityMutationKeys.snooze, {
        activityId: ACTIVITY_ID,
      }),
    ).toBe(true);

    expect(client.getQueryState(seriesKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(firstOccurrenceKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(secondOccurrenceKey)?.isInvalidated).toBe(true);
  });

  it.each([
    activityMutationKeys.patch,
    activityMutationKeys.convertRecurrence,
    activityMutationKeys.schedule,
    activityMutationKeys.complete,
    activityMutationKeys.uncomplete,
    activityMutationKeys.skip,
    activityMutationKeys.snooze,
    activityMutationKeys.unsnooze,
    activityMutationKeys.reminderCreate,
    activityMutationKeys.reminderDelete,
  ])('covers detail invalidation for %s/%s', (scope, name) => {
    const client = createOfflineQueryClient();

    expect(
      refreshActivityDetails(client, [scope, name], { activityId: ACTIVITY_ID }),
    ).toBe(true);
  });

  it('refreshes the parent detail when a Prep task completes from its own screen', () => {
    const client = createOfflineQueryClient();
    const PARENT_ID = 'act_01J0000000000000000000000P';
    client.setQueryData(['activity', ACTIVITY_ID], {
      activity: { ...activity, parentActivityId: PARENT_ID },
    });
    client.setQueryData(['activity', PARENT_ID], { activity });
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');

    expect(
      refreshActivityDetails(client, activityMutationKeys.uncomplete, {
        activityId: ACTIVITY_ID,
      }),
    ).toBe(true);

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['activity', PARENT_ID] });
    expect(client.getQueryState(['activity', PARENT_ID])?.isInvalidated).toBe(true);
  });

  it('refreshes the parent named by Today when the child detail was never cached', () => {
    const client = createOfflineQueryClient();
    const PARENT_ID = 'act_01J0000000000000000000000P';
    client.setQueryData(['activity', PARENT_ID], { activity });

    expect(
      refreshActivityDetails(client, activityMutationKeys.complete, {
        activityId: ACTIVITY_ID,
        parentActivityId: PARENT_ID,
      }),
    ).toBe(true);

    expect(client.getQueryState(['activity', PARENT_ID])?.isInvalidated).toBe(true);
  });

  it('refreshes the open Plan after an existing List is attached', () => {
    const client = createOfflineQueryClient();
    client.setQueryData(['activity', ACTIVITY_ID], { activity });

    expect(
      refreshActivityDetails(client, listMutationKeys.patch, {
        list: { listId: 'lst_01J0000000000000000000000L' },
        input: { sourceActivityId: ACTIVITY_ID },
      }),
    ).toBe(true);

    expect(client.getQueryState(['activity', ACTIVITY_ID])?.isInvalidated).toBe(true);
  });

  it.each([activityMutationKeys.create, activityMutationKeys.duplicate])(
    'does not invent a detail target for %s/%s',
    (scope, name) => {
      const client = createOfflineQueryClient();
      expect(
        refreshActivityDetails(client, [scope, name], { activityId: ACTIVITY_ID }),
      ).toBe(false);
    },
  );

  it('marks a deleted detail stale without removing or refetching it', () => {
    const client = createOfflineQueryClient();
    const key = ['activity', ACTIVITY_ID, 'occurrence', '2026-08-12'] as const;
    client.setQueryData(key, { activity });
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    const removeQueries = vi.spyOn(client, 'removeQueries');

    expect(
      refreshActivityDetails(client, activityMutationKeys.delete, {
        activityId: ACTIVITY_ID,
      }),
    ).toBe(true);

    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['activity', ACTIVITY_ID],
      refetchType: 'none',
    });
    expect(removeQueries).not.toHaveBeenCalled();
  });
});

describe('persisted mutation defaults', () => {
  it('persists queries and never a mutation, on either platform', () => {
    const source = createOfflineQueryClient();
    source.setQueryData(['agenda', '2026-08-12'], { sections: [] });
    const firstCase = cases[0];
    if (firstCase === undefined) throw new Error('The create fixture is required.');
    addPausedMutation(source, firstCase.key, firstCase.variables);

    const state = dehydratePersistedClient(source);

    /**
     * The exclusion used to be conditional on the platform, because iOS kept its queue in
     * here. Nothing keeps a queue in here now — one action must not have two records that
     * disagree the moment either store is pruned — so the assertion is unconditional.
     */
    expect(state.queries).toHaveLength(1);
    expect(state.mutations).toHaveLength(0);
    expect(shouldWarnBeforeUnload(source)).toBe(true);
  });

  it('reuses each stored POST key when its default runs again after a resume', async () => {
    const target = createOfflineQueryClient();
    const fake = fakeHttpClient();
    registerActivityMutationDefaults(target, fake.client);
    const postCases = cases.filter((entry) => 'idempotencyKey' in entry.variables);

    for (const entry of postCases) {
      const mutationFn = target.getMutationDefaults(entry.key).mutationFn;
      expect(mutationFn).toBeTypeOf('function');
      await mutationFn?.(entry.variables, {
        client: target,
        meta: undefined,
        mutationKey: entry.key,
      });
      await mutationFn?.(entry.variables, {
        client: target,
        meta: undefined,
        mutationKey: entry.key,
      });
    }

    const headers = fake.request.mock.calls.map(
      ([options]) => (options as { headers?: Record<string, string> }).headers,
    );
    expect(headers).toHaveLength(postCases.length * 2);
    expect(headers.every((value) => value?.['Idempotency-Key'] === IDEMPOTENCY_KEY)).toBe(
      true,
    );
  });

  it('registers replay-complete update post and delete recipes under their stable keys', async () => {
    const target = createOfflineQueryClient();
    const fake = fakeHttpClient();
    registerActivityMutationDefaults(target, fake.client);
    const post: ActivityUpdatePostVariables = {
      activityId: ACTIVITY_ID,
      body: 'A durable note',
      localId: 'local-update-id',
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    const remove: ActivityUpdateDeleteVariables = {
      activityId: ACTIVITY_ID,
      updateId: 'upd_01J0000000000000000000000A',
    };
    const postFn = target.getMutationDefaults(activityUpdateMutationKeys.post).mutationFn;
    const deleteFn = target.getMutationDefaults(
      activityUpdateMutationKeys.delete,
    ).mutationFn;
    expect(postFn).toBeTypeOf('function');
    expect(deleteFn).toBeTypeOf('function');

    for (const variables of [post, post]) {
      await postFn?.(variables, {
        client: target,
        meta: undefined,
        mutationKey: activityUpdateMutationKeys.post,
      });
    }
    for (const variables of [remove, remove]) {
      await deleteFn?.(variables, {
        client: target,
        meta: undefined,
        mutationKey: activityUpdateMutationKeys.delete,
      });
    }

    expect(
      fake.request.mock.calls.map(
        ([options]) => (options as { path: string; method?: string }).path,
      ),
    ).toEqual([
      `/v1/activities/${ACTIVITY_ID}/updates`,
      `/v1/activities/${ACTIVITY_ID}/updates`,
      `/v1/activities/${ACTIVITY_ID}/updates/${remove.updateId}`,
      `/v1/activities/${ACTIVITY_ID}/updates/${remove.updateId}`,
    ]);
    expect(
      fake.request.mock.calls
        .slice(0, 2)
        .map(
          ([options]) =>
            (options as { headers?: Record<string, string> }).headers?.[
              'Idempotency-Key'
            ],
        ),
    ).toEqual([IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);
  });
});
