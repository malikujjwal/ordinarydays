import type { AgendaItem } from '@od/shared/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  type CompletionCommitSnapshot,
  completionCommitGateFor,
  completionTargetKey,
} from '@/features/agenda/completionCommitGate';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';

export interface CompletionCommitState {
  readonly locked: boolean;
  /** Requested value while committing, then the durable override until projection catches up. */
  readonly checkedOverride: boolean | undefined;
}

function stateFromSnapshot(snapshot: CompletionCommitSnapshot): CompletionCommitState {
  if (snapshot === 'committed-checked' || snapshot === 'committing-checked') {
    return { locked: true, checkedOverride: true };
  }
  if (snapshot === 'committed-unchecked' || snapshot === 'committing-unchecked') {
    return { locked: true, checkedOverride: false };
  }
  return { locked: false, checkedOverride: undefined };
}

/** Subscribes only the target row; unrelated completion commits cannot re-render it. */
export function useCompletionCommitState(
  item: AgendaItem,
  failedIntentIds: readonly string[] = [],
): CompletionCommitState {
  const state = requireActiveNativeState();
  const gate = completionCommitGateFor(state.coordinator);
  const key = completionTargetKey(item);
  const failedIntentKey = failedIntentIds.join('\u0000');
  const subscribe = useCallback(
    (listener: () => void) => gate.subscribe(key, listener),
    [gate, key],
  );
  const getSnapshot = useCallback(() => gate.snapshotForKey(key), [gate, key]);
  const snapshot = useSyncExternalStore<CompletionCommitSnapshot>(
    subscribe,
    getSnapshot,
    () => 'idle',
  );
  useEffect(() => {
    if (failedIntentKey === '') return;
    for (const intentId of failedIntentKey.split('\u0000')) gate.rejectIntent(intentId);
  }, [failedIntentKey, gate]);
  return stateFromSnapshot(snapshot);
}

/** Subscribes one row to its exact local-commit lock; unrelated rows do not re-render. */
export function useCompletionCommitLock(item: AgendaItem): boolean {
  return useCompletionCommitState(item).locked;
}
