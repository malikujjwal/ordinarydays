import { Animated } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cubicBezierPoints,
  DIALOG_ENTER_SCALE,
  dragReleaseOutcome,
  FRAME_SLACK_MS,
  runTransition,
} from './sheetMotion';

/** The present / dismiss decisions behind `Sheet` (`design-system.md` §4.3, P3-51). */

const current = (value: Animated.Value): number =>
  (value as unknown as { __getValue(): number }).__getValue();

/** The driver reads the clock and asks for frames; both are faked so time is the test's. */
const useFrameClock = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });

afterEach(() => vi.useRealTimers());

describe('dragReleaseOutcome', () => {
  /** Already at its final offset: leave by opacity from there, never snap back first. */
  it('fades out from the finger on a clean sheet released past the threshold', () => {
    expect(dragReleaseOutcome(true, false)).toBe('dismiss-fade');
  });

  /** A dirty sheet cannot leave; it settles, then the discard prompt takes over. */
  it('settles a dirty sheet before its discard prompt rather than hanging displaced', () => {
    expect(dragReleaseOutcome(true, true)).toBe('settle-then-discard');
  });

  it('settles a release short of the threshold, dirty or not', () => {
    expect(dragReleaseOutcome(false, false)).toBe('settle');
    expect(dragReleaseOutcome(false, true)).toBe('settle');
  });
});

describe('cubicBezierPoints', () => {
  it.each([
    ['cubic-bezier(0.2, 0, 0, 1)', [0.2, 0, 0, 1]],
    ['cubic-bezier(0, 0, 0, 1)', [0, 0, 0, 1]],
    ['cubic-bezier(0.3, 0, 1, 1)', [0.3, 0, 1, 1]],
  ] as const)('reads the token spelling %s', (css, points) => {
    expect(cubicBezierPoints(css)).toEqual(points);
  });

  it('rejects anything that is not a four-point bezier', () => {
    expect(() => cubicBezierPoints('ease-in')).toThrow(/Not a cubic-bezier/);
    expect(() => cubicBezierPoints('cubic-bezier(a, b, c, d)')).toThrow(
      /Not a cubic-bezier/,
    );
  });
});

describe('runTransition', () => {
  const decelerate = 'cubic-bezier(0, 0, 0, 1)';

  /**
   * Reduce Motion resolves every duration to `0`, and `0` must complete **before the call
   * returns** — a frame later would order `onClose` after the exit only by accident.
   */
  it('completes a zero-duration transition synchronously, without a frame', () => {
    useFrameClock();
    const value = new Animated.Value(1);
    const onDone = vi.fn();
    runTransition(value, { toValue: 0, duration: 0, easing: decelerate }, onDone);

    expect(onDone).toHaveBeenCalledOnce();
    expect(current(value)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arrives at the target only once the duration has elapsed', () => {
    useFrameClock();
    const value = new Animated.Value(0);
    const onDone = vi.fn();
    runTransition(value, { toValue: 1, duration: 260, easing: decelerate }, onDone);

    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onDone).not.toHaveBeenCalled();
    // Decelerating: well past the midpoint by 100 ms of 260, but not there.
    expect(current(value)).toBeGreaterThan(0.5);
    expect(current(value)).toBeLessThan(1);

    vi.advanceTimersByTime(300);
    expect(onDone).toHaveBeenCalledOnce();
    expect(current(value)).toBe(1);
  });

  it('starts from wherever the value already is, not from zero', () => {
    useFrameClock();
    const value = new Animated.Value(0.5);
    runTransition(value, { toValue: 1, duration: 260, easing: decelerate }, () => {});
    vi.advanceTimersByTime(20);

    expect(current(value)).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * A hidden tab pauses `requestAnimationFrame`. The clock still finishes the transition —
   * just after it would have ended — so a dismissal always reports and nothing stays mounted
   * waiting for a frame that is not coming.
   */
  it('finishes on the clock when no frame ever arrives', () => {
    useFrameClock();
    const noFrames = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', noFrames);
    try {
      const value = new Animated.Value(0);
      const onDone = vi.fn();
      runTransition(value, { toValue: 1, duration: 260, easing: decelerate }, onDone);

      vi.advanceTimersByTime(260);
      expect(onDone).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FRAME_SLACK_MS);
      expect(onDone).toHaveBeenCalledOnce();
      expect(current(value)).toBe(1);
      expect(noFrames).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** And when frames do arrive, the frame loop finishes first and the clock reports nothing. */
  it('reports exactly once when frames and the clock both run', () => {
    useFrameClock();
    const value = new Animated.Value(0);
    const onDone = vi.fn();
    runTransition(value, { toValue: 1, duration: 260, easing: decelerate }, onDone);
    vi.advanceTimersByTime(1000);

    expect(onDone).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  /** A reopen mid-exit supersedes the exit: the cancelled transition never reports done. */
  it('never reports done once cancelled', () => {
    useFrameClock();
    const value = new Animated.Value(0);
    const onDone = vi.fn();
    const cancel = runTransition(
      value,
      { toValue: 1, duration: 260, easing: decelerate },
      onDone,
    );
    vi.advanceTimersByTime(50);
    cancel();
    const frozen = current(value);
    vi.advanceTimersByTime(500);

    expect(onDone).not.toHaveBeenCalled();
    expect(current(value)).toBe(frozen);
  });
});

describe('the dialog entrance', () => {
  it('scales up from a slight settle, not a zoom', () => {
    expect(DIALOG_ENTER_SCALE).toBeGreaterThan(0.9);
    expect(DIALOG_ENTER_SCALE).toBeLessThan(1);
  });
});
