import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Intent } from '@/lib/intentLog';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { OutboxIntent } from '@/lib/sqlite/outbox';

function legacyShape(ownerUserId: string, intent: OutboxIntent): Intent {
  return {
    ...intent,
    ownerUserId,
  };
}

function useOutbox(entityId?: string): readonly Intent[] {
  const state = requireActiveNativeState();
  const version = useSyncExternalStore(
    (listener) => state.account.subscriptions.subscribe('outbox', listener),
    () => state.account.subscriptions.version('outbox'),
    () => 0,
  );
  const [rows, setRows] = useState<readonly Intent[]>([]);
  useEffect(() => {
    void version;
    let active = true;
    const read =
      entityId === undefined ? state.outbox.all() : state.outbox.forEntity(entityId);
    void read.then((intents) => {
      if (active)
        setRows(
          intents.map((intent) => legacyShape(state.coordinator.ownerUserId, intent)),
        );
    });
    return () => {
      active = false;
    };
  }, [entityId, state, version]);
  return rows;
}

export function usePendingIntents(): readonly Intent[] {
  return useOutbox().filter((intent) => intent.status !== 'acknowledged');
}

export function useEntityIntents(entityId: string | undefined): readonly Intent[] {
  return useOutbox(entityId);
}

export function useIsPending(entityId: string | undefined): boolean {
  return useEntityIntents(entityId).some((intent) => intent.status !== 'acknowledged');
}

export interface PendingCreateState {
  pending: boolean;
  canCancel: boolean;
  intentId: string | undefined;
  status: Intent['status'] | undefined;
}

export function usePendingCreate(entityId: string | undefined): PendingCreateState {
  const create = useEntityIntents(entityId).find(
    (intent) =>
      intent.mutationKey[0] === 'activity' &&
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

export function useRecurrenceEditState(
  entityId: string | undefined,
): RecurrenceEditState {
  const edit = [...useEntityIntents(entityId)].reverse().find((intent) => {
    if (intent.mutationKey[1] !== 'patch') return false;
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

export async function cancelPendingCreate(intentId: string): Promise<boolean> {
  return requireActiveNativeState().coordinator.cancelPendingCreate(intentId);
}

export function useBlockedIntents(): readonly Intent[] {
  return usePendingIntents().filter((intent) => intent.status === 'needs_attention');
}

export function useIsOffline(): boolean {
  return !useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
