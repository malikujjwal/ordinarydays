import { describe, expect, it } from 'vitest';
import {
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  shouldCaptureDrag,
  shouldDismissOnRelease,
} from './sheetGesture';

/**
 * The swipe-to-dismiss policy (`design-system.md` §6.1).
 *
 * The reported defect was that a swipe down starting on a row did nothing while the identical
 * swipe on the title dismissed — the pan was bound to the header, so §6.1's "engages only while
 * the body is scrolled to its top" could never decide anything. The arbitration below is what
 * replaces that binding, and `Sheet.test.tsx` guards where it is attached.
 */
describe('shouldCaptureDrag', () => {
  const open = { draggable: true, bodyAtTop: true };

  it('takes a downward drag while the body is at its top, wherever it started', () => {
    expect(shouldCaptureDrag({ dx: 0, dy: 40 }, open)).toBe(true);
  });

  /** Mid-scroll the same gesture belongs to the list, which is the whole arbitration. */
  it('leaves the gesture to the body once the body has been scrolled', () => {
    expect(shouldCaptureDrag({ dx: 0, dy: 40 }, { ...open, bodyAtTop: false })).toBe(
      false,
    );
  });

  it('ignores an upward drag, which has nowhere to go on a bottom sheet', () => {
    expect(shouldCaptureDrag({ dx: 0, dy: -40 }, open)).toBe(false);
  });

  /** A tap and a jitter both live under the engage threshold, so child controls keep them. */
  it.each([0, 1, 6])('leaves a %d pt movement to the control under the finger', (dy) => {
    expect(shouldCaptureDrag({ dx: 0, dy }, open)).toBe(false);
  });

  it('engages just past the threshold', () => {
    expect(shouldCaptureDrag({ dx: 0, dy: 7 }, open)).toBe(true);
  });

  /** A mostly-sideways drag is a horizontal gesture, not a dismissal. */
  it('ignores a drag that travels further across than down', () => {
    expect(shouldCaptureDrag({ dx: 60, dy: 40 }, open)).toBe(false);
    expect(shouldCaptureDrag({ dx: -60, dy: 40 }, open)).toBe(false);
  });

  it('never engages on a sheet that cannot be dragged', () => {
    expect(shouldCaptureDrag({ dx: 0, dy: 300 }, { ...open, draggable: false })).toBe(
      false,
    );
  });
});

describe('shouldDismissOnRelease', () => {
  it('dismisses past the release distance', () => {
    expect(shouldDismissOnRelease({ dy: DISMISS_DISTANCE + 1, vy: 0 })).toBe(true);
  });

  it('springs back at and below it', () => {
    expect(shouldDismissOnRelease({ dy: DISMISS_DISTANCE, vy: 0 })).toBe(false);
    expect(shouldDismissOnRelease({ dy: 40, vy: 0 })).toBe(false);
  });

  /** A flick is a dismissal even when the finger barely travelled. */
  it('dismisses on a fast flick from a short distance', () => {
    expect(shouldDismissOnRelease({ dy: 20, vy: DISMISS_VELOCITY + 0.1 })).toBe(true);
  });

  it('does not dismiss on a slow short drag', () => {
    expect(shouldDismissOnRelease({ dy: 20, vy: 0.2 })).toBe(false);
  });
});
