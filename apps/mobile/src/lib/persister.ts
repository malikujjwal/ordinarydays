import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
} from '@tanstack/react-query';
import { Platform } from 'react-native';

const CACHE_KEY = 'ordinarydays-query-cache-v1';
const CACHE_BUSTER = 'p2-33-v1';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const RESTORE_DEADLINE_MS = 2_000;

interface StoredClient {
  timestamp: number;
  buster: string;
  clientState: DehydratedState;
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
      // The query cache persists everywhere. The process-death mutation queue is iOS only.
      shouldDehydrateMutation: (mutation) =>
        platform === 'ios' && mutation.state.isPaused,
      shouldDehydrateQuery: (query) => query.state.status === 'success',
    }),
  };
}

function validStoredClient(value: unknown): value is StoredClient {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredClient>;
  return (
    typeof candidate.timestamp === 'number' &&
    candidate.buster === CACHE_BUSTER &&
    Date.now() - candidate.timestamp <= MAX_AGE &&
    typeof candidate.clientState === 'object' &&
    candidate.clientState !== null
  );
}

/**
 * Restores before feature hooks mount. A storage driver that never answers cannot hold the
 * app forever: after two seconds its eventual value is ignored rather than racing live data.
 */
export async function restorePersistedClient(client: QueryClient): Promise<void> {
  let acceptLateValue = true;
  const restored = Promise.resolve(queryPersister.restoreClient())
    .then((value) => (acceptLateValue ? value : undefined))
    .catch(async () => {
      await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
      return undefined;
    });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      acceptLateValue = false;
      resolve(undefined);
    }, RESTORE_DEADLINE_MS);
  });
  const value = await Promise.race([restored, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (value === undefined) return;
  if (!validStoredClient(value)) {
    await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
    return;
  }
  hydrate(client, value.clientState);
}

/** Starts throttled persistence after restoration so an empty client cannot overwrite it. */
export function subscribeToPersistence(client: QueryClient): () => void {
  const save = () => {
    void Promise.resolve(queryPersister.persistClient(persistedState(client))).catch(
      () => undefined,
    );
  };
  const queryUnsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed' || event.type === 'updated')
      save();
  });
  const mutationUnsubscribe = client.getMutationCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed' || event.type === 'updated')
      save();
  });
  return () => {
    queryUnsubscribe();
    mutationUnsubscribe();
  };
}

/** Test seam for proving platform-specific dehydration and rehydration. */
export function dehydratePersistedClient(
  client: QueryClient,
  platform: 'ios' | 'web' = Platform.OS === 'ios' ? 'ios' : 'web',
): DehydratedState {
  return persistedState(client, platform).clientState;
}
