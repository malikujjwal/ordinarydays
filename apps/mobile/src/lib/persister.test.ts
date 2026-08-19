import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectNativeLegacyPersistence } from '@/lib/legacyPersistence';
import {
  dehydratePersistedClient,
  queryPersister,
  restorePersistedClient,
  subscribeToPersistence,
} from '@/lib/persister';

const ACTIVITY = 'act_01J0000000000000000000000C';

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
});
