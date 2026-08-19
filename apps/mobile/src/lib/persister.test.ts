import { hydrate, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import {
  dehydratePersistedClient,
  importLegacyPausedMutations,
  inspectNativeLegacyPersistence,
  queryPersister,
  restorePersistedClient,
  retireImportedLegacyPausedMutations,
  retireNativeActivityAgendaPersistence,
  subscribeToPersistence,
} from '@/lib/persister';

const USER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000C';

function memoryStorage(): IntentLogStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the query-cache persister', () => {
  /**
   * The third of the three data-loss paths the 2026-08-13 review found.
   *
   * A storage read slower than the two-second deadline was abandoned, and the persistence
   * subscription then saved the **empty** client straight over the stored one. Before the
   * envelope split that destroyed every queued write; it still destroys a week of cached
   * agenda, so it is fixed regardless of the split.
   */
  it('does not let a slow restore be overwritten by the empty client', async () => {
    vi.useFakeTimers();
    const stored = {
      timestamp: Date.now(),
      buster: 'p2-33-v1',
      clientState: { queries: [], mutations: [] },
    };
    let releaseRead: (() => void) | undefined;
    vi.spyOn(queryPersister, 'restoreClient').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve(stored);
        }),
    );
    const persistClient = vi
      .spyOn(queryPersister, 'persistClient')
      .mockResolvedValue(undefined);

    const client = new QueryClient();
    const restore = restorePersistedClient(client);
    await vi.advanceTimersByTimeAsync(2_100);
    const outcome = await restore;
    expect(outcome.status).toBe('timedOut');

    // The app is live and writing to the cache while the slow read is still outstanding.
    const stop = subscribeToPersistence(client, outcome.safeToPersist);
    client.setQueryData(['agenda', '2026-08-17'], { sections: [] });
    await vi.advanceTimersByTimeAsync(50);

    // Nothing may be written yet: doing so would save an empty client over the stored one.
    expect(persistClient).not.toHaveBeenCalled();

    releaseRead?.();
    await vi.advanceTimersByTimeAsync(50);
    await outcome.safeToPersist;
    await vi.advanceTimersByTimeAsync(50);

    // Only once the read has landed does saving resume.
    expect(persistClient).toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });

  it('imports a legacy paused mutation exactly once', async () => {
    const legacy = {
      timestamp: Date.now(),
      buster: 'p2-33-v1',
      clientState: {
        queries: [],
        mutations: [
          {
            mutationKey: ['activity', 'complete'],
            state: {
              isPaused: true,
              variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-key-1' },
            },
          },
        ],
      },
    };
    vi.spyOn(queryPersister, 'restoreClient').mockResolvedValue(
      legacy as unknown as Awaited<ReturnType<typeof queryPersister.restoreClient>>,
    );

    const storage = memoryStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();

    expect(await importLegacyPausedMutations(log, 'ios')).toBe(1);
    expect(log.pending()).toHaveLength(1);
    expect(log.pending()[0]?.intentId).toBe('legacy-key-1');

    /**
     * Run again, as a crash mid-import or a second launch would. The persisted
     * `Idempotency-Key` is the intent id, so the second pass recognises its own work.
     */
    expect(await importLegacyPausedMutations(log, 'ios')).toBe(0);
    expect(log.pending()).toHaveLength(1);
  });

  it('retires an in-memory legacy mutation only after its intent was imported', async () => {
    const client = new QueryClient();
    hydrate(client, {
      mutations: [
        {
          mutationKey: ['activity', 'complete'],
          state: {
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: 'pending',
            variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-key-1' },
            submittedAt: 1,
          },
        },
        {
          mutationKey: ['activity', 'complete'],
          state: {
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: 'pending',
            variables: { activityId: ACTIVITY, idempotencyKey: 'not-imported' },
            submittedAt: 2,
          },
        },
      ],
      queries: [],
    });
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();
    await log.append({
      intentId: 'legacy-key-1',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-key-1' },
      entityId: ACTIVITY,
    });

    expect(retireImportedLegacyPausedMutations(client, log)).toBe(1);
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(client.getMutationCache().getAll()[0]?.state.variables).toMatchObject({
      idempotencyKey: 'not-imported',
    });
  });

  it('imports nothing on web, where there is no queue to migrate', async () => {
    const restoreClient = vi.spyOn(queryPersister, 'restoreClient');
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();

    expect(await importLegacyPausedMutations(log, 'web')).toBe(0);
    expect(restoreClient).not.toHaveBeenCalled();
  });

  it('never hydrates or persists native Activity/Agenda TanStack authority', async () => {
    const legacy = {
      timestamp: Date.now(),
      buster: 'p2-33-v1',
      clientState: {
        queries: [
          {
            queryKey: ['agenda', '2026-08-19'],
            queryHash: '["agenda","2026-08-19"]',
            state: {
              data: { legacy: true },
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: 'success',
              fetchStatus: 'idle',
            },
          },
        ],
        mutations: [],
      },
    };
    vi.spyOn(queryPersister, 'restoreClient').mockResolvedValue(
      legacy as unknown as Awaited<ReturnType<typeof queryPersister.restoreClient>>,
    );
    const client = new QueryClient();

    await restorePersistedClient(client, 'ios');
    expect(client.getQueryData(['agenda', '2026-08-19'])).toBeUndefined();
    client.setQueryData(['agenda', '2026-08-19'], { committedElsewhere: true });
    expect(dehydratePersistedClient(client, 'ios').queries).toEqual([]);
    expect(dehydratePersistedClient(client, 'web').queries).toHaveLength(1);
  });

  it('does not discard an expired native envelope before its intents are imported', async () => {
    vi.spyOn(queryPersister, 'restoreClient').mockResolvedValue({
      timestamp: 0,
      buster: 'old-buster',
      clientState: {
        queries: [],
        mutations: [
          {
            mutationKey: ['activity', 'complete'],
            state: {
              isPaused: true,
              variables: { activityId: ACTIVITY, idempotencyKey: 'old-write' },
            } as never,
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof queryPersister.restoreClient>>);
    const remove = vi.spyOn(queryPersister, 'removeClient').mockResolvedValue();

    expect((await restorePersistedClient(new QueryClient(), 'ios')).status).toBe(
      'discarded',
    );
    expect(remove).not.toHaveBeenCalled();
    expect(await inspectNativeLegacyPersistence('ios')).toMatchObject({
      domainMutationCount: 1,
    });
  });

  it('retires native query and paused-mutation persistence only after preservation', async () => {
    const legacy = {
      timestamp: Date.now(),
      buster: 'p2-33-v1',
      clientState: {
        queries: [
          {
            queryKey: ['agenda', '2026-08-19'],
            queryHash: 'agenda-hash',
            state: {} as never,
          },
          {
            queryKey: ['me'],
            queryHash: 'profile-hash',
            state: { data: { userId: USER } } as never,
          },
        ],
        mutations: [
          {
            mutationKey: ['activity', 'complete'],
            state: {
              isPaused: true,
              variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-key-1' },
            } as never,
          },
        ],
      },
    };
    vi.spyOn(queryPersister, 'restoreClient').mockResolvedValue(
      legacy as unknown as Awaited<ReturnType<typeof queryPersister.restoreClient>>,
    );
    const persist = vi.spyOn(queryPersister, 'persistClient').mockResolvedValue();
    const client = new QueryClient();
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();

    expect(await inspectNativeLegacyPersistence('ios')).toEqual({
      domainRecordKeys: ['query:agenda-hash'],
      domainMutationCount: 1,
      ownerUserId: USER,
    });
    await expect(
      retireNativeActivityAgendaPersistence(client, log, 'ios'),
    ).rejects.toThrow('not verified in durable SQLite');
    expect(persist).not.toHaveBeenCalled();

    await log.append({
      intentId: 'legacy-key-1',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-key-1' },
      entityId: ACTIVITY,
    });
    await retireNativeActivityAgendaPersistence(client, log, 'ios');
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        clientState: expect.objectContaining({
          queries: [expect.objectContaining({ queryHash: 'profile-hash' })],
          mutations: [],
        }),
      }),
    );
  });
});
