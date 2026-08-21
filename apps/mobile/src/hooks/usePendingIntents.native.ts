import { systemClock, type TimeZone, toWallTime } from '@od/shared/time';
import { onlineManager } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { Intent } from '@/lib/intent';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { OutboxPresentationSnapshot } from '@/lib/sqlite/outboxPresentationStore';
import {
  type AgendaRowIntentState,
  agendaRowIntentState,
  type PendingCreateState,
  pendingCreateState,
  type RecurrenceEditState,
  recurrenceEditState,
} from './pendingIntentState';

export type { AgendaRowIntentState, PendingCreateState, RecurrenceEditState };

/** Native pending rows may open their committed SQLite-backed, read-only detail. */
export const pendingCreateAllowsOpen = true;

function useGlobalOutbox(): OutboxPresentationSnapshot {
  const store = requireActiveNativeState().outboxPresentation;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePendingIntents(): readonly Intent[] {
  return useGlobalOutbox().pending;
}

export function useEntityIntents(entityId: string | undefined): readonly Intent[] {
  const store = requireActiveNativeState().outboxPresentation;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeEntity(entityId, listener),
    [entityId, store],
  );
  const getSnapshot = useCallback(
    () => store.getEntitySnapshot(entityId),
    [entityId, store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useIsPending(entityId: string | undefined): boolean {
  return useEntityIntents(entityId).some((intent) => intent.status !== 'acknowledged');
}

export function usePendingCreate(entityId: string | undefined): PendingCreateState {
  return pendingCreateState(useEntityIntents(entityId), entityId);
}

export function useRecurrenceEditState(
  entityId: string | undefined,
): RecurrenceEditState {
  return recurrenceEditState(useEntityIntents(entityId));
}

/** One SQLite-backed subscription/effect for the two pieces of state each row needs. */
export function useAgendaRowIntentState(
  entityId: string | undefined,
  occurrenceDate?: string,
): AgendaRowIntentState {
  const store = requireActiveNativeState().outboxPresentation;
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribeOccurrence(entityId, occurrenceDate, listener),
    [entityId, occurrenceDate, store],
  );
  const getSnapshot = useCallback(
    () => store.getOccurrenceSnapshot(entityId, occurrenceDate),
    [entityId, occurrenceDate, store],
  );
  const intents = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return agendaRowIntentState(intents, entityId, occurrenceDate);
}

export async function cancelPendingCreate(intentId: string): Promise<boolean> {
  return requireActiveNativeState().coordinator.cancelPendingCreate(intentId);
}

export async function retryBlockedIntent(intentId: string): Promise<boolean> {
  const timezone = (Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC') as TimeZone;
  const now = systemClock.now();
  const freshIntentId = (await import('expo-crypto')).randomUUID();
  const result = await requireActiveNativeState().coordinator.retryAttention(
    intentId,
    freshIntentId,
    {
      today: systemClock.todayIn(timezone),
      currentMinute: toWallTime(now, timezone),
    },
  );
  if (result.kind === 'refused') throw result.error;
  return true;
}

export async function discardBlockedIntent(intentId: string): Promise<boolean> {
  return requireActiveNativeState().coordinator.discardAttention(intentId);
}

export function useBlockedIntents(): readonly Intent[] {
  return useGlobalOutbox().blocked;
}

export function useIsOffline(): boolean {
  return !useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
