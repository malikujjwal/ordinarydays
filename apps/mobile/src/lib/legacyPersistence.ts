import type { DehydratedState, QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { type IntentLog, semanticallyIdenticalIntent } from '@/lib/intentLog';
import {
  dehydratedStateFrom,
  isNativeActivityKey,
  NATIVE_ACTIVITY_QUERY_ROOTS,
  queryPersister,
  validStoredClient,
  withoutNativeActivityState,
} from '@/lib/persister';
import { field, stringField } from '@/lib/unknown';

/**
 * The one-time bridge out of the old AsyncStorage envelope, and its verified retirement.
 *
 * Native legacy migration and web query persistence are separate concerns: this module owns
 * reading the pre-cutover envelope for import — paused mutations become durable intents,
 * the query-domain inventory becomes migration receipts — and removing those entries only
 * after their SQLite receipts exist. `persister.ts` keeps owning the envelope shape and the
 * ordinary persist/restore lifecycle.
 */

/**
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
