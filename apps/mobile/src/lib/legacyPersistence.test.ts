import { hydrate, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import {
  importLegacyPausedMutations,
  inspectNativeLegacyPersistence,
  retireImportedLegacyPausedMutations,
  retireNativeActivityAgendaPersistence,
} from '@/lib/legacyPersistence';
import { queryPersister } from '@/lib/persister';

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

describe('legacy persistence migration', () => {
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

  it('treats an iOS restore failure as unavailable evidence, never as an empty source', async () => {
    vi.spyOn(queryPersister, 'restoreClient').mockRejectedValue(
      new Error('storage unavailable'),
    );
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();

    await expect(inspectNativeLegacyPersistence('ios')).rejects.toThrow(
      'storage unavailable',
    );
    await expect(importLegacyPausedMutations(log, 'ios')).rejects.toThrow(
      'storage unavailable',
    );
    await expect(
      retireNativeActivityAgendaPersistence(new QueryClient(), log, 'ios'),
    ).rejects.toThrow('storage unavailable');
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
