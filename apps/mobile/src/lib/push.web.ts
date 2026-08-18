import type { LocalNotificationRequest } from './push.types';

/** Web push and local browser notifications are outside v1. */
export const localNotificationsSupported = false;

/** Explicit sanctioned web no-op; the scheduler checks support before doing network work. */
export function replaceLocalNotifications(
  _requests: readonly LocalNotificationRequest[],
): Promise<void> {
  console.debug('local_notification_schedule_skipped_web');
  return Promise.resolve();
}

/**
 * Nothing is ever armed on web, so nothing is ever held (P2-57).
 *
 * The empty array is the honest answer rather than a stub: verification compares it against
 * an equally empty intended set, so a web build's schedule verifies trivially instead of
 * staying permanently dirty and retrying forever.
 */
export function readScheduledLocalNotifications(): Promise<string[]> {
  return Promise.resolve([]);
}
