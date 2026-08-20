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
 * to live in this envelope, which is why they could vanish: a cache is
 * allowed to be discarded by a buster bump or an age check, and user data is not. They now
 * live in the durable intent log (`intentLog.ts`, `tech-stack.md` §3.4 mechanism 4), which
 * has its own key, its own `schemaVersion` and no age expiry. What remains here is a
 * reconstructable projection of server responses, and it keeps both disposal rules on
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

export function withoutNativeActivityState(state: DehydratedState): DehydratedState {
  return {
    ...state,
    queries: state.queries.filter((query) => !isNativeActivityKey(query.queryKey)),
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
       * **No mutation is dehydrated here any more.** The intent log is the durability
       * boundary; TanStack is the execution layer (ADR-055). Writing them to both would give
       * one action two records that disagree the moment either store is pruned.
       */
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: (query) =>
        query.state.status === 'success' &&
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
        hydrate(
          client,
          platform === 'ios'
            ? withoutNativeActivityState(value.clientState)
            : value.clientState,
        );
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
  hydrate(
    client,
    platform === 'ios'
      ? withoutNativeActivityState(value.clientState)
      : value.clientState,
  );
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
