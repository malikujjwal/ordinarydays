import { MAX_OFFLINE_MUTATIONS } from '@od/shared';
import type { HttpClient } from '@od/shared/client';
import type { Activity } from '@od/shared/types';
import { hydrate, type MutationKey, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  type ActivityPostVariables,
  type CreateActivityVariables,
  changesActivityLists,
  type DeleteActivityVariables,
  type DuplicateActivityVariables,
  type PatchActivityVariables,
  type ReminderDeleteVariables,
  registerActivityMutationDefaults,
} from '@/lib/mutationDefaults';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { shouldWarnBeforeUnload } from '@/lib/onlineManager';
import { dehydratePersistedClient } from '@/lib/persister';
import { createOfflineQueryClient } from '@/lib/queryClient';
import { OFFLINE_QUEUE_FULL_MESSAGE, useSyncStatus } from '@/stores/syncStatus';

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
  { key: activityMutationKeys.delete, variables: { activityId: ACTIVITY_ID } },
  {
    key: activityMutationKeys.patch,
    variables: {
      activityId: ACTIVITY_ID,
      input: { title: 'Dentist' },
      ifMatch: activity.updatedAt,
      changeNames: ['Title'],
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
    },
  },
];

function fakeHttpClient() {
  const request = vi.fn((options: { path: string }) => {
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

  it('owns exactly the twelve stable persisted keys', () => {
    expect(Object.values(activityMutationKeys)).toEqual([
      ['activity', 'create'],
      ['activity', 'duplicate'],
      ['activity', 'delete'],
      ['activity', 'patch'],
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
  });
});

describe('persisted mutation defaults', () => {
  it('dehydrates, rehydrates and resolves all twelve iOS mutations', async () => {
    const source = createOfflineQueryClient();
    for (const entry of cases) addPausedMutation(source, entry.key, entry.variables);
    const state = dehydratePersistedClient(source, 'ios');
    expect(state.mutations).toHaveLength(12);

    const target = createOfflineQueryClient();
    const fake = fakeHttpClient();
    registerActivityMutationDefaults(target, fake.client);
    hydrate(target, state);
    await target.resumePausedMutations();

    expect(
      target
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.status),
    ).toEqual(Array.from({ length: 12 }, () => 'success'));
    expect(fake.request).toHaveBeenCalledTimes(12);
  });

  it('refuses mutation 201 on iOS with the canonical offline message', async () => {
    const client = createOfflineQueryClient('ios');
    const firstCase = cases[0];
    if (firstCase === undefined) throw new Error('The create fixture is required.');
    const variables = firstCase.variables;
    for (let index = 0; index < MAX_OFFLINE_MUTATIONS; index += 1) {
      addPausedMutation(client, ['test', index], variables);
    }
    const mutation = client.getMutationCache().build(client, {
      mutationKey: activityMutationKeys.create,
    });

    await expect(mutation.execute(variables)).rejects.toThrow(OFFLINE_QUEUE_FULL_MESSAGE);
    expect(useSyncStatus.getState().queueMessage).toBe(OFFLINE_QUEUE_FULL_MESSAGE);
  });

  it('persists queries but excludes the process-death mutation queue on web', () => {
    const source = createOfflineQueryClient();
    source.setQueryData(['agenda', '2026-08-12'], { sections: [] });
    const firstCase = cases[0];
    if (firstCase === undefined) throw new Error('The create fixture is required.');
    addPausedMutation(source, firstCase.key, firstCase.variables);

    const state = dehydratePersistedClient(source, 'web');

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
});
