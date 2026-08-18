import { onlineManager } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { Intent } from '@/lib/intentLog';
import { getActiveIntentLog } from '@/lib/intentReplay';

/**
 * Reads the active intent log reactively.
 *
 * `useSyncExternalStore` rather than a zustand mirror: the log already is the store, and a
 * second copy of queue state is exactly the kind of divergence this phase exists to remove.
 * The envelope is replaced on every committed write, so identity comparison is enough and no
 * snapshot is recomputed on each render.
 *
 * Returns nothing on web, where no log is registered (ADR-024).
 */
function subscribeToLog(listener: () => void): () => void {
  const log = getActiveIntentLog();
  if (log === undefined) return () => undefined;
  return log.subscribe(listener);
}

const NO_INTENTS: readonly Intent[] = [];

export function usePendingIntents(): readonly Intent[] {
  const snapshot = useCallback(() => {
    const log = getActiveIntentLog();
    return log === undefined ? NO_INTENTS : log.snapshot().intents;
  }, []);
  const intents = useSyncExternalStore(subscribeToLog, snapshot, snapshot);
  return intents.filter((intent) => intent.status !== 'acknowledged');
}

export function useEntityIntents(entityId: string | undefined): readonly Intent[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const log = getActiveIntentLog();
      if (log === undefined || entityId === undefined) return () => undefined;
      return log.subscribeEntity(entityId, listener);
    },
    [entityId],
  );
  const snapshot = useCallback(() => {
    const log = getActiveIntentLog();
    return log === undefined || entityId === undefined
      ? NO_INTENTS
      : log.snapshotFor(entityId);
  }, [entityId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Whether one entity has unacknowledged work.
 *
 * Entity-generic on purpose: a row passes whatever id it is about — `act_`, `rem_`, Phase 3's
 * `itm_` — and gets the same answer. Phase 3's `Plan will finish syncing` is a copy parameter
 * of this, not a second mechanism.
 */
export function useIsPending(entityId: string | undefined): boolean {
  const intents = useEntityIntents(entityId);
  if (entityId === undefined) return false;
  return intents.some((intent) => intent.status !== 'acknowledged');
}

/**
 * What a surface needs to know about an entity whose create has not landed (P2-50).
 *
 * `pending` is specifically an unacknowledged **create**, not any queued write: a row with a
 * queued completion exists on the server and stays fully usable, while one whose create is
 * still waiting does not exist there at all and can accept nothing.
 *
 * `canCancel` is `queued` only. A request already on the wire cannot be retracted, so an
 * `in_flight` intent offers no cancel rather than a cancel that might silently do nothing.
 */
export interface PendingCreateState {
  pending: boolean;
  canCancel: boolean;
  intentId: string | undefined;
  status: Intent['status'] | undefined;
}

export function usePendingCreate(entityId: string | undefined): PendingCreateState {
  const intents = useEntityIntents(entityId);
  if (entityId === undefined) {
    return { pending: false, canCancel: false, intentId: undefined, status: undefined };
  }
  const create = intents.find(
    (intent) =>
      intent.entityId === entityId &&
      intent.mutationKey[1] === 'create' &&
      (intent.status === 'queued' || intent.status === 'in_flight'),
  );
  return {
    pending: create !== undefined,
    canCancel: create?.status === 'queued',
    intentId: create?.intentId,
    status: create?.status,
  };
}

export interface RecurrenceEditState {
  inert: boolean;
  message: string | undefined;
  status: 'idle' | 'queued' | 'updating' | 'retry' | 'failed';
}

/** Durable row presentation for recurrence PATCH lifecycle only; CREATE never enters it. */
export function useRecurrenceEditState(
  entityId: string | undefined,
): RecurrenceEditState {
  const intents = useEntityIntents(entityId);
  const edit = [...intents].reverse().find((intent) => {
    if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'patch') {
      return false;
    }
    const input = (intent.variables as { input?: unknown } | undefined)?.input;
    return (
      typeof input === 'object' && input !== null && Object.hasOwn(input, 'recurrence')
    );
  });
  if (edit === undefined) return { inert: false, message: undefined, status: 'idle' };
  if (edit.status === 'queued') {
    return { inert: true, message: 'Will update when online', status: 'queued' };
  }
  if (edit.status === 'in_flight') {
    return { inert: true, message: 'Updating schedule…', status: 'updating' };
  }
  if (edit.status === 'acknowledged') {
    return edit.lastError === undefined
      ? { inert: true, message: 'Updating schedule…', status: 'updating' }
      : { inert: true, message: "Couldn't refresh schedule · Retry", status: 'retry' };
  }
  return {
    inert: false,
    message: edit.lastError ?? 'Schedule update needs attention',
    status: 'failed',
  };
}

/** Cancels a queued create, removing the intent. Returns false if it was already dispatched. */
export async function cancelPendingCreate(intentId: string): Promise<boolean> {
  const log = getActiveIntentLog();
  if (log === undefined) return false;
  return log.cancel(intentId);
}

/** Intents the user has to resolve: permanently rejected, or parked by age or clock doubt. */
export function useBlockedIntents(): readonly Intent[] {
  const intents = usePendingIntents();
  return intents.filter((intent) => intent.status === 'needs_attention');
}

/**
 * Connectivity as the offline bar means it.
 *
 * `onlineManager` rather than a raw NetInfo subscription, so the bar and the replay trigger
 * can never disagree about whether the app is online — a bar that says "Offline" while the
 * queue is draining is worse than no bar.
 */
export function useIsOffline(): boolean {
  return !useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
