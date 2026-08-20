import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Intent } from '@/lib/intentLog';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
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

function legacyShape(ownerUserId: string, intent: OutboxIntent): Intent {
  return {
    ...intent,
    ownerUserId,
  };
}

interface OutboxSnapshot {
  readonly version: number;
  readonly ownerUserId: string;
  readonly rows: Promise<readonly Intent[]>;
}

const snapshots = new WeakMap<OutboxRepository, OutboxSnapshot>();

function readOutbox(
  outbox: OutboxRepository,
  ownerUserId: string,
  version: number,
): Promise<readonly Intent[]> {
  const current = snapshots.get(outbox);
  if (current?.version === version && current.ownerUserId === ownerUserId) {
    return current.rows;
  }
  const rows = outbox
    .all()
    .then((intents) => intents.map((intent) => legacyShape(ownerUserId, intent)));
  snapshots.set(outbox, { version, ownerUserId, rows });
  return rows;
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
    let active = true;
    void readOutbox(state.outbox, state.coordinator.ownerUserId, version).then(
      (intents) => {
        if (active) {
          setRows(
            entityId === undefined
              ? intents
              : intents.filter((intent) => intent.entityId === entityId),
          );
        }
      },
    );
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
): AgendaRowIntentState {
  return agendaRowIntentState(useEntityIntents(entityId), entityId);
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
