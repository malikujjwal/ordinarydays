/**
 * The drag-to-dismiss policy for `Sheet`, as two pure decisions (`design-system.md` §6.1).
 *
 * ## Why this is not inline in the component
 *
 * The gesture is the one part of `Sheet` a component test cannot reach: React Native Web's
 * responder system does not run on the synthetic touch events jsdom and Testing Library can
 * produce, so a test that "drives a swipe" there passes whether the sheet dismisses or not —
 * which is worse than no test. Split out, the thresholds and the arbitration are ordinary pure
 * functions with ordinary assertions, and the only thing left unasserted is which element the
 * handlers hang on. That part is guarded by the source check in `Sheet.test.tsx`, because it is
 * exactly what regressed.
 */

/** Past this many points, releasing dismisses. Below it the sheet springs back. */
export const DISMISS_DISTANCE = 96;

/** A fast flick dismisses even from a short distance — points per millisecond. */
export const DISMISS_VELOCITY = 0.6;

/** Below this the gesture is still a tap or a jitter, and the child controls keep it. */
const ENGAGE_DISTANCE = 6;

export interface DragGesture {
  dx: number;
  dy: number;
}

/**
 * Whether the sheet takes this gesture from whatever is under the finger.
 *
 * `bodyAtTop` is the whole arbitration: at the top of the body a downward drag has only one
 * sensible reading, so the sheet moves; mid-scroll the same drag belongs to the list. Binding
 * this to the header instead — where nothing ever scrolls — is what made a swipe from a row do
 * nothing at all.
 */
export function shouldCaptureDrag(
  gesture: DragGesture,
  options: { draggable: boolean; bodyAtTop: boolean },
): boolean {
  return (
    options.draggable &&
    options.bodyAtTop &&
    gesture.dy > ENGAGE_DISTANCE &&
    Math.abs(gesture.dy) > Math.abs(gesture.dx)
  );
}

/** Whether releasing here dismisses, rather than settling back to rest. */
export function shouldDismissOnRelease(gesture: { dy: number; vy: number }): boolean {
  return gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY;
}
