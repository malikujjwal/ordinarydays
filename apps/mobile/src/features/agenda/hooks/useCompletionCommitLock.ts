import type { AgendaItem } from '@od/shared/types';

export interface CompletionCommitState {
  readonly locked: boolean;
  readonly checkedOverride: boolean | undefined;
}

/** Web completion already projects synchronously through the query cache. */
export function useCompletionCommitState(
  _item: AgendaItem,
  _failedIntentIds: readonly string[] = [],
): CompletionCommitState {
  return { locked: false, checkedOverride: undefined };
}

/** Web completion already projects synchronously through the query cache. */
export function useCompletionCommitLock(_item: AgendaItem): boolean {
  return false;
}
