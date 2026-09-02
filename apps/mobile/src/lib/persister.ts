import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
} from '@tanstack/react-query';
import { Platform } from 'react-native';
import { field } from '@/lib/unknown';

/**
 * Persistence for the **web query cache** and non-Activity native queries only.
 *
 * Native Activity/Agenda roots are filtered on hydrate/save after P2-63. Queued writes used
 * to live in this envelope, which is why they could vanish: a cache may be discarded by a
 * buster bump or age check, while accepted native actions may not. Current native actions
 * live in the transactional SQLite outbox; web is online-first and has no durable queue.
 * What remains here is reconstructable query state, and it keeps both disposal rules on
 * purpose.
 *
 * The one-time legacy bridge and the verified native retirement live in
 * `legacyPersistence.ts`; this file owns only the envelope and its ordinary lifecycle.
 */

const CACHE_KEY = 'ordinarydays-query-cache-v1';
const CACHE_BUSTER = 'p2-33-v1';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const RESTORE_DEADLINE_MS = 2_000;

interface StoredClient {
  timestamp: number;
  buster: string;
  clientState: DehydratedState;
}

/**
 * The envelope shape stays owned here. `legacyPersistence.ts` — the migration reader that
 * inventories and retires the pre-cutover envelope — is the one intended external consumer
 * of these helpers.
 */
export const NATIVE_ACTIVITY_QUERY_ROOTS = new Set(['activity', 'activities', 'agenda']);

export function isNativeActivityKey(key: unknown): boolean {
  return (
    Array.isArray(key) &&
    typeof key[0] === 'string' &&
    NATIVE_ACTIVITY_QUERY_ROOTS.has(key[0])
  );
}

/**
 * **A projection is not a cache entry** (P3-43 finding). The web Plans store lives under
 * `['plans', 'projection', …]` and keeps a `Map`, which JSON turns into a plain object; a
 * page that rehydrated it rendered `store.byDate.entries is not a function`. Projections
 * are rebuilt from the server on open, so they are neither persisted nor restored.
 */
export function isProjectionKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === 'plans' && key[1] === 'projection';
}

/** What a restore may hydrate: never a projection, and on iOS never native Activity state. */
export function restorableState(
  state: DehydratedState,
  platform: string,
): DehydratedState {
  const base = platform === 'ios' ? withoutNativeActivityState(state) : state;
  return {
    ...base,
    queries: base.queries.filter((query) => !isProjectionKey(query.queryKey)),
  };
}

export function withoutNativeActivityState(state: DehydratedState): DehydratedState {
  return {
    ...state,
    queries: state.queries.filter(
      (query) => !isNativeActivityKey(query.queryKey) && !isProjectionKey(query.queryKey),
    ),
    mutations: state.mutations.filter(
      (mutation) => !isNativeActivityKey(mutation.mutationKey),
    ),
  };
}

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: CACHE_KEY,
  throttleTime: 1_000,
});

function persistedState(client: QueryClient, platform = Platform.OS): StoredClient {
  return {
    timestamp: Date.now(),
    buster: CACHE_BUSTER,
    clientState: dehydrate(client, {
      /**
       * **No mutation is dehydrated here.** Native durability belongs only to the SQLite
       * outbox, while web actions fail visibly if their request cannot complete. Persisting
       * MutationCache records would reintroduce an unowned second queue.
       */
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: (query) =>
        query.state.status === 'success' &&
        !isProjectionKey(query.queryKey) &&
        (platform !== 'ios' || !isNativeActivityKey(query.queryKey)),
    }),
  };
}

export function validStoredClient(value: unknown): value is StoredClient {
  if (typeof value !== 'object' || value === null) return false;
  const timestamp = field(value, 'timestamp');
  const buster = field(value, 'buster');
  const clientState = field(value, 'clientState');
  return (
    typeof timestamp === 'number' &&
    buster === CACHE_BUSTER &&
    Date.now() - timestamp <= MAX_AGE &&
    typeof clientState === 'object' &&
    clientState !== null
  );
}

export function dehydratedStateFrom(value: unknown): DehydratedState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const state = field(value, 'clientState');
  const queries = field(state, 'queries');
  const mutations = field(state, 'mutations');
  if (!Array.isArray(queries) || !Array.isArray(mutations)) return undefined;
  /* TanStack exposes no persisted-state parser; its generic cannot infer the checked arrays. */
  return { queries, mutations } as DehydratedState;
}

/**
 * What happened on restore, and whether persistence may start.
 *
 * `timedOut` is the important one. The old code returned nothing in that case and the caller
 * immediately subscribed persistence, which saved the **empty** client over a stored copy
 * that was merely slow to read — losing a week of cached agenda, and before the split, every
 * queued write with it. `safeToPersist` resolves only once the late read has settled, so the
 * stored copy is never overwritten by a client that has not yet seen it.
 */
export interface RestoreOutcome {
  status: 'restored' | 'empty' | 'discarded' | 'timedOut';
  safeToPersist: Promise<void>;
  /** Exact bounded evidence consumed by native legacy migration without another read. */
  nativeLegacyPersistence?:
    | { readonly kind: 'available'; readonly storedClient: unknown }
    | { readonly kind: 'unavailable'; readonly error: Error };
}

export async function restorePersistedClient(
  client: QueryClient,
  platform = Platform.OS,
): Promise<RestoreOutcome> {
  let settleLate: (() => void) | undefined;
  const lateSettled = new Promise<void>((resolve) => {
    settleLate = resolve;
  });

  let timedOut = false;
  let restoreFailure: Error | undefined;
  const restored = Promise.resolve(queryPersister.restoreClient())
    .catch(async (error: unknown) => {
      restoreFailure = error instanceof Error ? error : new Error(String(error));
      if (platform !== 'ios') {
        await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
      }
      return undefined;
    })
    .then((value) => {
      if (!timedOut) return value;
      /**
       * The late arrival. The client may have been running empty for seconds by now, so
       * hydrate only what it does not already hold — `hydrate` merges, and a query the app
       * has since fetched is newer than this.
       */
      if (validStoredClient(value)) {
        hydrate(client, restorableState(value.clientState, platform));
      }
      settleLate?.();
      return value;
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, RESTORE_DEADLINE_MS);
  });

  const value = await Promise.race([restored, deadline]);
  if (timer !== undefined) clearTimeout(timer);

  if (value === 'timeout') {
    return {
      status: 'timedOut',
      safeToPersist: lateSettled,
      nativeLegacyPersistence: {
        kind: 'unavailable',
        error: new Error('Native legacy persistence read exceeded 2 seconds.'),
      },
    };
  }
  settleLate?.();
  if (value === undefined) {
    return {
      status: 'empty',
      safeToPersist: Promise.resolve(),
      nativeLegacyPersistence:
        restoreFailure === undefined
          ? { kind: 'available', storedClient: undefined }
          : { kind: 'unavailable', error: restoreFailure },
    };
  }
  if (!validStoredClient(value)) {
    /* Native migration still needs an expired/buster-old envelope's paused mutations. */
    if (platform !== 'ios') {
      await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
    }
    return {
      status: 'discarded',
      safeToPersist: Promise.resolve(),
      nativeLegacyPersistence: { kind: 'available', storedClient: value },
    };
  }
  hydrate(client, restorableState(value.clientState, platform));
  return {
    status: 'restored',
    safeToPersist: Promise.resolve(),
    nativeLegacyPersistence: { kind: 'available', storedClient: value },
  };
}

/**
 * Starts throttled persistence once it cannot destroy a slower read.
 *
 * `safeToPersist` is the gate. Callers pass the outcome of `restorePersistedClient`; the
 * subscription is live immediately so no change is missed, but saves are held until the gate
 * opens.
 */
export function subscribeToPersistence(
  client: QueryClient,
  safeToPersist: Promise<void> = Promise.resolve(),
  platform = Platform.OS,
): () => void {
  let open = false;
  let missed = false;
  let stopped = false;

  void safeToPersist.then(() => {
    open = true;
    if (missed && !stopped) save();
  });

  function save(): void {
    if (!open) {
      missed = true;
      return;
    }
    void Promise.resolve(
      queryPersister.persistClient(persistedState(client, platform)),
    ).catch(() => undefined);
  }

  const queryUnsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed' || event.type === 'updated')
      save();
  });
  return () => {
    stopped = true;
    queryUnsubscribe();
  };
}

/** Test seam for proving the query envelope no longer carries mutations. */
export function dehydratePersistedClient(
  client: QueryClient,
  platform = Platform.OS,
): DehydratedState {
  return persistedState(client, platform).clientState;
}
