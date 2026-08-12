import { ApiError } from '@od/shared/client';
import type { MutationKey } from '@tanstack/react-query';
import { create } from 'zustand';
import type { PatchActivityVariables } from '@/lib/mutationDefaults';
import { activityMutationKeys } from '@/lib/mutationKeys';

export const OFFLINE_QUEUE_FULL_MESSAGE =
  "You're offline and there's a lot waiting to sync.";

interface SyncStatusState {
  queueMessage: string | undefined;
  conflictChanges: string[];
  showQueueFull: () => void;
  captureMutationError: (
    error: unknown,
    mutationKey: MutationKey | undefined,
    variables: unknown,
  ) => void;
  dismiss: () => void;
}

function sameKey(left: MutationKey | undefined, right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const useSyncStatus = create<SyncStatusState>((set) => ({
  queueMessage: undefined,
  conflictChanges: [],
  showQueueFull: () => set({ queueMessage: OFFLINE_QUEUE_FULL_MESSAGE }),
  captureMutationError: (error, mutationKey, variables) => {
    if (
      !(error instanceof ApiError) ||
      error.status !== 409 ||
      !sameKey(mutationKey, activityMutationKeys.patch)
    ) {
      return;
    }
    const changeNames = (variables as PatchActivityVariables | undefined)?.changeNames;
    if (!Array.isArray(changeNames)) return;
    set((state) => ({
      conflictChanges: [...new Set([...state.conflictChanges, ...changeNames])],
    }));
  },
  dismiss: () => set({ queueMessage: undefined, conflictChanges: [] }),
}));
