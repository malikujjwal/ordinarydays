import type { ListSwipeAction } from './listSwipeActions';

export interface SwipeActionTransition {
  pending: ListSwipeAction | undefined;
  dispatch: ListSwipeAction | undefined;
}

/**
 * Non-destructive actions preserve their immediate contract. A destructive action crosses the
 * modal boundary only after the swipe row reports that it is fully closed.
 */
export function selectSwipeAction(selected: ListSwipeAction): SwipeActionTransition {
  return selected.destructive
    ? { pending: selected, dispatch: undefined }
    : { pending: undefined, dispatch: selected };
}

/** Idempotent because native close callbacks may be repeated during gesture interruption. */
export function closeSwipeAction(
  pending: ListSwipeAction | undefined,
): SwipeActionTransition {
  return { pending: undefined, dispatch: pending };
}
