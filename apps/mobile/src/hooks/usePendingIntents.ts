import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Intent } from '@/lib/intent';
import {
  type AgendaRowIntentState,
  agendaRowIntentState,
  type PendingCreateState,
  pendingCreateState,
  type RecurrenceEditState,
  recurrenceEditState,
} from './pendingIntentState';

export type { AgendaRowIntentState, PendingCreateState, RecurrenceEditState };

/** Web is online-first and deliberately has no durable mutation queue. */
export const pendingCreateAllowsOpen = false;

const NO_INTENTS: readonly Intent[] = Object.freeze([]);

export function usePendingIntents(): readonly Intent[] {
  return NO_INTENTS;
}

export function useEntityIntents(_entityId: string | undefined): readonly Intent[] {
  return NO_INTENTS;
}

export function useIsPending(_entityId: string | undefined): boolean {
  return false;
}

export function usePendingCreate(entityId: string | undefined): PendingCreateState {
  return pendingCreateState(NO_INTENTS, entityId);
}

export function useRecurrenceEditState(
  _entityId: string | undefined,
): RecurrenceEditState {
  return recurrenceEditState(NO_INTENTS);
}

export function useAgendaRowIntentState(
  entityId: string | undefined,
  occurrenceDate?: string,
): AgendaRowIntentState {
  return agendaRowIntentState(NO_INTENTS, entityId, occurrenceDate);
}

export async function cancelPendingCreate(_intentId: string): Promise<boolean> {
  return false;
}

export async function retryBlockedIntent(_intentId: string): Promise<boolean> {
  return false;
}

export async function discardBlockedIntent(_intentId: string): Promise<boolean> {
  return false;
}

export function useBlockedIntents(): readonly Intent[] {
  return NO_INTENTS;
}

export function useIsOffline(): boolean {
  return !useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
