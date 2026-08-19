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
import { field, stringField } from '@/lib/unknown';

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
 * `importLegacyPausedMutations` below carries the one-time bridge for devices that already
 * have paused mutations sitting in the old envelope; retirement requires SQLite receipts.
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

const NATIVE_ACTIVITY_QUERY_ROOTS = new Set(['activity', 'activities', 'agenda']);

function isNativeActivityKey(key: unknown): boolean {
  return (
    Array.isArray(key) &&
    typeof key[0] === 'string' &&
    NATIVE_ACTIVITY_QUERY_ROOTS.has(key[0])
  );
}

function withoutNativeActivityState(state: DehydratedState): DehydratedState {
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

function validStoredClient(value: unknown): value is StoredClient {
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

function dehydratedStateFrom(value: unknown): DehydratedState | undefined {
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
  const restored = Promise.resolve(queryPersister.restoreClient())
    .catch(async () => {
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
    return { status: 'timedOut', safeToPersist: lateSettled };
  }
  settleLate?.();
  if (value === undefined) {
    return { status: 'empty', safeToPersist: Promise.resolve() };
  }
  if (!validStoredClient(value)) {
    /* Native migration still needs an expired/buster-old envelope's paused mutations. */
    if (platform !== 'ios') {
      await Promise.resolve(queryPersister.removeClient()).catch(() => undefined);
    }
    return { status: 'discarded', safeToPersist: Promise.resolve() };
  }
  hydrate(
    client,
    platform === 'ios'
      ? withoutNativeActivityState(value.clientState)
      : value.clientState,
  );
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
  const clientState = field(stored, 'clientState');
  const mutations = field(clientState, 'mutations');
  if (!Array.isArray(mutations) || mutations.length === 0) return 0;

  let imported = 0;
  for (const [index, mutation] of mutations.entries()) {
    const key = mutation.mutationKey;
    const variables: unknown = mutation.state?.variables;
    if (!Array.isArray(key) || typeof variables !== 'object' || variables === null) {
      continue;
    }
    /**
     * The persisted `Idempotency-Key` is the intent id. It was minted once when the mutation
     * was enqueued and is the same value the server deduplicates on, so an import that runs
     * twice produces one intent and, ultimately, one server write.
     */
    const entityId =
      stringField(variables, 'activityId') ??
      stringField(field(variables, 'input'), 'activityId') ??
      `legacy-entity-${index + 1}`;
    const baseIntentId =
      stringField(variables, 'intentId') ??
      stringField(variables, 'idempotencyKey') ??
      `legacy-${mutation.state?.submittedAt ?? 0}-${index + 1}`;
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
    const entityId =
      stringField(variables, 'activityId') ??
      stringField(field(variables, 'input'), 'activityId');
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

export interface NativeLegacyPersistenceSnapshot {
  readonly domainRecordKeys: readonly string[];
  readonly domainMutationCount: number;
  readonly ownerUserId?: string;
}

/** Inventories the native cache source before its receipt is written. */
export async function inspectNativeLegacyPersistence(
  platform = Platform.OS,
): Promise<NativeLegacyPersistenceSnapshot> {
  if (platform !== 'ios') return { domainRecordKeys: [], domainMutationCount: 0 };
  const stored: unknown = await Promise.resolve(queryPersister.restoreClient()).catch(
    () => undefined,
  );
  if (stored === undefined) return { domainRecordKeys: [], domainMutationCount: 0 };
  const clientState = dehydratedStateFrom(stored);
  if (clientState === undefined) {
    throw new Error('Native legacy query persistence is malformed and was not retired.');
  }
  const domainQueries = clientState.queries.filter((query) =>
    isNativeActivityKey(query.queryKey),
  );
  const domainMutations = clientState.mutations.filter((mutation) =>
    isNativeActivityKey(mutation.mutationKey),
  );
  const profile = clientState.queries.find(
    (query) => Array.isArray(query.queryKey) && query.queryKey[0] === 'me',
  )?.state.data;
  const profileUserId = field(profile, 'userId');
  const ownerUserId = typeof profileUserId === 'string' ? profileUserId : undefined;
  return {
    domainRecordKeys: domainQueries.map(
      (query, index) =>
        `query:${query.queryHash || JSON.stringify(query.queryKey) || index + 1}`,
    ),
    domainMutationCount: domainMutations.length,
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  };
}

function mutationSemantic(mutation: DehydratedState['mutations'][number]):
  | {
      readonly mutationKey: readonly string[];
      readonly variables: unknown;
      readonly entityId: string;
    }
  | undefined {
  if (
    !Array.isArray(mutation.mutationKey) ||
    !mutation.mutationKey.every((part) => typeof part === 'string') ||
    typeof mutation.state.variables !== 'object' ||
    mutation.state.variables === null
  ) {
    return undefined;
  }
  const variables = mutation.state.variables;
  const entityId =
    stringField(variables, 'activityId') ??
    stringField(field(variables, 'input'), 'activityId');
  return entityId === undefined
    ? undefined
    : { mutationKey: mutation.mutationKey, variables, entityId };
}

/**
 * Retires only after the caller has committed SQLite receipts for both the intent log and
 * this cache-domain inventory. Any unpreserved mutation aborts retirement instead of being
 * guessed away.
 */
export async function retireNativeActivityAgendaPersistence(
  client: QueryClient,
  log: IntentLog,
  platform = Platform.OS,
): Promise<void> {
  if (platform !== 'ios') return;
  const stored: unknown = await Promise.resolve(queryPersister.restoreClient()).catch(
    () => undefined,
  );
  if (stored !== undefined) {
    const clientState = dehydratedStateFrom(stored);
    if (clientState === undefined) {
      throw new Error(
        'Native legacy query persistence is malformed and was not retired.',
      );
    }
    for (const mutation of clientState.mutations) {
      if (!isNativeActivityKey(mutation.mutationKey)) continue;
      const semantic = mutationSemantic(mutation);
      if (
        semantic === undefined ||
        !log
          .snapshot()
          .intents.some((intent) => semanticallyIdenticalIntent(intent, semantic))
      ) {
        throw new Error(
          'A native legacy mutation was not verified in durable SQLite; retirement stopped.',
        );
      }
    }
    if (validStoredClient(stored)) {
      await Promise.resolve(
        queryPersister.persistClient({
          ...stored,
          clientState: withoutNativeActivityState(clientState),
        }),
      );
    } else {
      await Promise.resolve(queryPersister.removeClient());
    }
  }
  for (const root of NATIVE_ACTIVITY_QUERY_ROOTS) {
    client.removeQueries({ queryKey: [root] });
  }
  for (const mutation of client.getMutationCache().getAll()) {
    if (isNativeActivityKey(mutation.options.mutationKey)) {
      client.getMutationCache().remove(mutation);
    }
  }
}

/** Test seam for proving the query envelope no longer carries mutations. */
export function dehydratePersistedClient(
  client: QueryClient,
  platform = Platform.OS,
): DehydratedState {
  return persistedState(client, platform).clientState;
}
