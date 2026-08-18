import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
} from '@tanstack/react-query';
import { Platform } from 'react-native';
import { type IntentLog, semanticallyIdenticalIntent } from '@/lib/intentLog';

/**
 * Persistence for the **query cache only**.
 *
 * Queued writes used to live in this envelope, which is why they could vanish: a cache is
 * allowed to be discarded by a buster bump or an age check, and user data is not. They now
 * live in the durable intent log (`intentLog.ts`, `tech-stack.md` §3.4 mechanism 4), which
 * has its own key, its own `schemaVersion` and no age expiry. What remains here is a
 * reconstructable projection of server responses, and it keeps both disposal rules on
 * purpose.
 *
 * `importLegacyPausedMutations` below carries the one-time bridge for devices that already
 * have paused mutations sitting in the old envelope.
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

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: CACHE_KEY,
  throttleTime: 1_000,
});

function persistedState(client: QueryClient): StoredClient {
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
}

export async function restorePersistedClient(
  client: QueryClient,
): Promise<RestoreOutcome> {
  let settleLate: (() => void) | undefined;
  const lateSettled = new Promise<void>((resolve) => {
    settleLate = resolve;
  });

  let timedOut = false;
  const restored = Promise.resolve(queryPersister.restoreClient())
    .catch(async () => {
      await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
      return undefined;
    })
    .then((value) => {
      if (!timedOut) return value;
      /**
       * The late arrival. The client may have been running empty for seconds by now, so
       * hydrate only what it does not already hold — `hydrate` merges, and a query the app
       * has since fetched is newer than this.
       */
      if (validStoredClient(value)) hydrate(client, value.clientState);
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
    return { status: 'timedOut', safeToPersist: lateSettled };
  }
  settleLate?.();
  if (value === undefined) {
    return { status: 'empty', safeToPersist: Promise.resolve() };
  }
  if (!validStoredClient(value)) {
    await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
    return { status: 'discarded', safeToPersist: Promise.resolve() };
  }
  hydrate(client, value.clientState);
  return { status: 'restored', safeToPersist: Promise.resolve() };
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
    void Promise.resolve(queryPersister.persistClient(persistedState(client))).catch(
      () => undefined,
    );
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

/**
 * The one-time bridge out of the old envelope.
 *
 * A device upgrading into this build may hold paused mutations dehydrated under the query
 * cache key. Each becomes an intent exactly once — keyed by the mutation's own persisted
 * `idempotencyKey` so a crash mid-import cannot double it — and the old copy is retired by
 * the first ordinary save, which no longer dehydrates mutations at all.
 *
 * Import failures are not swallowed: losing a legacy queued write silently is the exact
 * failure this whole task exists to end.
 */
export async function importLegacyPausedMutations(
  log: IntentLog,
  platform = Platform.OS,
): Promise<number> {
  if (platform !== 'ios') return 0;
  const stored: unknown = await Promise.resolve(queryPersister.restoreClient()).catch(
    () => undefined,
  );
  if (typeof stored !== 'object' || stored === null) return 0;
  const clientState = (stored as Partial<StoredClient>).clientState;
  const mutations = clientState?.mutations;
  if (!Array.isArray(mutations) || mutations.length === 0) return 0;

  let imported = 0;
  for (const [index, mutation] of mutations.entries()) {
    const key = mutation.mutationKey;
    const variables: unknown = mutation.state?.variables;
    if (!Array.isArray(key) || typeof variables !== 'object' || variables === null) {
      continue;
    }
    const fields = variables as {
      intentId?: unknown;
      idempotencyKey?: unknown;
      activityId?: unknown;
      input?: { activityId?: unknown };
    };
    /**
     * The persisted `Idempotency-Key` is the intent id. It was minted once when the mutation
     * was enqueued and is the same value the server deduplicates on, so an import that runs
     * twice produces one intent and, ultimately, one server write.
     */
    const entityId =
      typeof fields.activityId === 'string'
        ? fields.activityId
        : typeof fields.input?.activityId === 'string'
          ? fields.input.activityId
          : `legacy-entity-${index + 1}`;
    const baseIntentId =
      typeof fields.intentId === 'string'
        ? fields.intentId
        : typeof fields.idempotencyKey === 'string'
          ? fields.idempotencyKey
          : `legacy-${mutation.state?.submittedAt ?? 0}-${index + 1}`;
    const semantic = {
      mutationKey: key.map(String),
      variables,
      entityId,
    };
    const same = log
      .snapshot()
      .intents.find(
        (intent) =>
          intent.intentId === baseIntentId &&
          semanticallyIdenticalIntent(intent, semantic),
      );
    if (same !== undefined) continue;
    let intentId = baseIntentId;
    let suffix = 2;
    while (log.snapshot().intents.some((intent) => intent.intentId === intentId)) {
      intentId = `${baseIntentId}~legacy-${suffix}`;
      suffix += 1;
    }
    await log.append({
      intentId,
      ...semantic,
    });
    imported += 1;
  }
  return imported;
}

/**
 * Removes only legacy paused mutations whose durable replacement is present in the log.
 *
 * TanStack subscribes to connectivity internally and would otherwise resume these old
 * in-memory records alongside the log. Unknown or malformed mutations are deliberately left
 * alone: migration must never discard a write it failed to preserve first.
 */
export function retireImportedLegacyPausedMutations(
  client: QueryClient,
  log: IntentLog,
): number {
  const imported = log.pending();
  let retired = 0;
  for (const mutation of client.getMutationCache().getAll()) {
    if (!mutation.state.isPaused) continue;
    const variables = mutation.state.variables;
    if (typeof variables !== 'object' || variables === null) continue;
    const fields = variables as {
      activityId?: unknown;
      input?: { activityId?: unknown };
    };
    const entityId =
      typeof fields.activityId === 'string'
        ? fields.activityId
        : typeof fields.input?.activityId === 'string'
          ? fields.input.activityId
          : undefined;
    if (entityId === undefined || !Array.isArray(mutation.options.mutationKey)) continue;
    const semantic = {
      mutationKey: mutation.options.mutationKey.map(String),
      variables,
      entityId,
    };
    if (!imported.some((intent) => semanticallyIdenticalIntent(intent, semantic)))
      continue;
    client.getMutationCache().remove(mutation);
    retired += 1;
  }
  return retired;
}

/** Test seam for proving the query envelope no longer carries mutations. */
export function dehydratePersistedClient(client: QueryClient): DehydratedState {
  return persistedState(client).clientState;
}
