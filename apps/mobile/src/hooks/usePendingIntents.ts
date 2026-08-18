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

/**
 * Whether one entity has unacknowledged work.
 *
 * Entity-generic on purpose: a row passes whatever id it is about — `act_`, `rem_`, Phase 3's
 * `itm_` — and gets the same answer. Phase 3's `Plan will finish syncing` is a copy parameter
 * of this, not a second mechanism.
 */
export function useIsPending(entityId: string | undefined): boolean {
  const intents = usePendingIntents();
  if (entityId === undefined) return false;
  return intents.some((intent) => intent.entityId === entityId);
}

/** Intents the user has to resolve: permanently rejected, or parked by age or clock doubt. */
export function useBlockedIntents(): readonly Intent[] {
  const intents = usePendingIntents();
  return intents.filter(
    (intent) => intent.status === 'failed' || intent.status === 'needs_confirmation',
  );
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
