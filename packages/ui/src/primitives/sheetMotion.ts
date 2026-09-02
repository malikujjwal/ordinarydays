import { type Animated, Easing } from 'react-native';

/**
 * The present / dismiss motion for `Sheet`, as pure decisions plus one small driver
 * (`design-system.md` §4.3, P3-51).
 *
 * ## Why this is not inline in the component
 *
 * Same reason as `sheetGesture.ts`: the parts a rendered test cannot reach — which exit a
 * release chooses, what a bezier string means, whether a zero duration still completes — are
 * ordinary functions here with ordinary assertions. `Sheet.tsx` keeps only the wiring, and
 * `Sheet.test.tsx` asserts the lifecycle that wiring produces.
 *
 * ## Why the driver is its own frame loop rather than `Animated.timing`
 *
 * `Animated.timing` is a different implementation on each platform and, under jsdom, ends
 * synchronously without ever requesting a frame — so a test could not tell "after the exit"
 * from "with it", which is the one ordering this task exists to pin. Stepping the value on
 * `requestAnimationFrame` with the token's own bezier is the same few lines everywhere, and
 * costs nothing the drag does not already cost: the drag writes the same `Animated.Value`
 * from the JS thread on every move.
 */

/** Where the sheet is in its life. `closed` is the only state in which the modal is unmounted. */
export type SheetPhase = 'closed' | 'presenting' | 'open' | 'dismissing';

/**
 * How the surface leaves.
 *
 * - `travel` — the reverse of its entrance: a bottom sheet slides down, a dialog fades and
 *   shrinks. Used when a control or the owner closes it.
 * - `fade` — opacity only, from wherever the sheet already is. A sheet dismissed by the drag is
 *   already at its final offset, so it must not snap back before leaving (§4.3 edge case).
 */
export type SheetExit = 'travel' | 'fade';

/** What releasing a drag does, given how far it went and whether there is anything to lose. */
export type DragReleaseOutcome = 'dismiss-fade' | 'settle-then-discard' | 'settle';

/**
 * The one decision a drag release makes.
 *
 * A release past the dismiss threshold on a clean sheet leaves by `fade` from the finger's
 * last offset. The same release on a `dirty` sheet cannot leave — every exit routes through
 * the discard prompt — so the sheet settles back to rest first and *then* asks, rather than
 * hanging displaced under the prompt. Anything short of the threshold settles.
 */
export function dragReleaseOutcome(dismiss: boolean, dirty: boolean): DragReleaseOutcome {
  if (!dismiss) return 'settle';
  return dirty ? 'settle-then-discard' : 'dismiss-fade';
}

/** `cubic-bezier(x1, y1, x2, y2)` — the token's CSS spelling — as the four control points. */
export function cubicBezierPoints(css: string): [number, number, number, number] {
  const match = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/.exec(
    css.trim(),
  );
  if (match === null) throw new Error(`Not a cubic-bezier easing: ${css}`);
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
    throw new Error(`Not a cubic-bezier easing: ${css}`);
  }
  return [x1, y1, x2, y2];
}

export interface TransitionSpec {
  toValue: number;
  /** A token duration. `0` — Reduce Motion — completes synchronously, with no frame. */
  duration: number;
  /** The token's CSS easing string; converted here so callers never spell a bezier twice. */
  easing: string;
}

/**
 * Drive `value` to `toValue` over `duration`, and report when it arrives.
 *
 * **Zero duration is not a short animation; it is no animation.** The value is set and
 * `onDone` runs before this returns — which is what "instant" has to mean for `onClose` to be
 * ordered after the exit in both modes, and why a Reduce Motion dismissal is observable
 * without timers.
 *
 * Returns a cancel. A superseded transition — a reopen mid-exit — is cancelled by its owner
 * and never reports done.
 */
export function runTransition(
  value: Animated.Value,
  spec: TransitionSpec,
  onDone: () => void,
): () => void {
  if (spec.duration === 0) {
    value.setValue(spec.toValue);
    onDone();
    return () => {};
  }

  const from = (value as unknown as { __getValue(): number }).__getValue();
  const ease = Easing.bezier(...cubicBezierPoints(spec.easing));
  const startedAt = Date.now();
  let frame: number | null = null;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    clearTimeout(deadline);
    value.setValue(spec.toValue);
    onDone();
  };

  const step = () => {
    if (done) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= spec.duration) {
      finish();
      return;
    }
    value.setValue(from + ease(elapsed / spec.duration) * (spec.toValue - from));
    frame = requestAnimationFrame(step);
  };

  /**
   * **The clock finishes what frames may not.** A hidden tab or a backgrounded app pauses
   * `requestAnimationFrame`; without this, a sheet dismissed just before that would stay
   * mounted and never report `onClose` until the next frame arrived. The deadline lands a
   * few milliseconds after the tween would have, so on a visible screen the frame loop is
   * what completes it and nothing snaps.
   */
  const deadline = setTimeout(finish, spec.duration + FRAME_SLACK_MS);
  frame = requestAnimationFrame(step);

  return () => {
    if (done) return;
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    clearTimeout(deadline);
  };
}

/** How long past the duration the clock waits for the last frame before finishing itself. */
export const FRAME_SLACK_MS = 50;

/** The dialog's entrance scale — a slight settle, not a zoom (§4.3 edge case). */
export const DIALOG_ENTER_SCALE = 0.96;
