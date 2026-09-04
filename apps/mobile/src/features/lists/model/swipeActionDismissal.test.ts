import { describe, expect, it } from 'vitest';
import type { ListSwipeAction } from './listSwipeActions';
import { closeSwipeAction, selectSwipeAction } from './swipeActionDismissal';

const archive: ListSwipeAction = {
  name: 'archive',
  label: 'Archive',
  destructive: false,
};
const remove: ListSwipeAction = { name: 'delete', label: 'Delete', destructive: true };

describe('native List swipe dismissal boundary', () => {
  it('holds a destructive action until close and consumes it exactly once', () => {
    const selected = selectSwipeAction(remove);
    expect(selected).toEqual({ pending: remove, dispatch: undefined });

    const closed = closeSwipeAction(selected.pending);
    expect(closed).toEqual({ pending: undefined, dispatch: remove });
    expect(closeSwipeAction(closed.pending)).toEqual({
      pending: undefined,
      dispatch: undefined,
    });
  });

  it('dispatches a non-destructive action immediately without queueing it', () => {
    expect(selectSwipeAction(archive)).toEqual({
      pending: undefined,
      dispatch: archive,
    });
  });
});
