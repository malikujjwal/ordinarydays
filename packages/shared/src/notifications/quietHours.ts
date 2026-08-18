import type { QuietHours } from '../types/user.js';

/**
 * Quiet hours, evaluated once (`notifications.md` §4).
 *
 * §4 is emphatic that it is "the single definition of both; no other document restates it".
 * The same has to be true of the code, because quiet hours are evaluated in two places that
 * must never disagree: the device arming a local notification (P2-57) and the reminder Lambda
 * deciding whether to send a push (P5-13). If those two drift, a user gets a reminder held on
 * one path and delivered on the other — the duplicate that the local-first model exists to
 * avoid.
 *
 * So this module is **pure**: wall-clock strings in, a verdict out. No clock, no timezone
 * database, no I/O. The caller has already resolved the instant into the user's local wall
 * time, because only the caller knows whose zone applies.
 *
 * ## The one rule that surprises people
 *
 * A reminder is judged by **the activity's own time**, not by the reminder's fire time. A 6 AM
 * flight is exactly what quiet hours must not suppress, so its reminder is delivered even
 * though 6 AM is inside a 22:00–07:00 window. An early reminder for a 2 PM meeting that
 * happens to land at 6 AM is held — the activity is outside the window, so there is nothing
 * urgent about the small hours for it.
 */

/** `HH:mm`, the shape `hhmm` validates and the shape stored on the user. */
export type WallTime = string;

export type QuietHoursVerdict =
  | { kind: 'deliver' }
  /** Hold until the window's end, which is the morning delivery §4 describes. */
  | { kind: 'hold'; until: WallTime };

function minutes(time: WallTime): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour * 60 + minute;
}

/**
 * Whether a local wall time falls inside the window.
 *
 * The window normally **wraps midnight** — 22:00–07:00 is the default — so a naive
 * `start <= t && t < end` comparison is wrong for every realistic setting. A wrapping window
 * is the union of two ranges; a non-wrapping one (09:00–17:00, which the settings screen
 * allows) is the ordinary case.
 */
export function insideQuietHours(at: WallTime, window: QuietHours): boolean {
  if (!window.enabled) return false;
  const value = minutes(at);
  const start = minutes(window.start);
  const end = minutes(window.end);
  // A zero-length window silences nothing rather than everything.
  if (start === end) return false;
  return start < end ? value >= start && value < end : value >= start || value < end;
}

/**
 * The verdict for a **reminder**, per §4's reminder row.
 *
 * `activityAt` is the activity's own local start time and is what the rule turns on.
 * `fireAt` is when the reminder would otherwise be delivered. A reminder for an activity
 * inside the window is delivered; one for an activity outside it that merely lands inside is
 * held to the window's end.
 *
 * An activity with **no time** — an all-day reminder — has no start instant to be inside or
 * outside anything, so it is judged on its own fire time like any ordinary notification.
 */
export function reminderDelivery(input: {
  fireAt: WallTime;
  activityAt: WallTime | undefined;
  window: QuietHours | undefined;
}): QuietHoursVerdict {
  const { window } = input;
  if (window === undefined || !window.enabled) return { kind: 'deliver' };
  if (!insideQuietHours(input.fireAt, window)) return { kind: 'deliver' };
  if (input.activityAt !== undefined && insideQuietHours(input.activityAt, window)) {
    return { kind: 'deliver' };
  }
  return { kind: 'hold', until: window.end };
}

/**
 * The verdict for everything that is not a reminder (§4's remaining rows).
 *
 * `imminentActivityAt` carries the imminent-change exception: a `plan_changes` notification
 * for an activity starting less than 12 hours out is delivered immediately, measured against
 * the activity's **new** start. Callers that are not `plan_changes`, or whose activity has no
 * date, pass `undefined` and are held like anything else.
 *
 * Kept beside the reminder rule rather than in the Lambda that will first need it, because
 * §4's whole point is that one document defines both — and one module should too. P2-57 uses
 * only `reminderDelivery`; this is here so P5-13 has no reason to write a second copy.
 */
export function notificationDelivery(input: {
  fireAt: WallTime;
  window: QuietHours | undefined;
  hoursUntilActivity?: number | undefined;
}): QuietHoursVerdict {
  const { window } = input;
  if (window === undefined || !window.enabled) return { kind: 'deliver' };
  if (!insideQuietHours(input.fireAt, window)) return { kind: 'deliver' };
  if (input.hoursUntilActivity !== undefined && input.hoursUntilActivity < 12) {
    return { kind: 'deliver' };
  }
  return { kind: 'hold', until: window.end };
}
