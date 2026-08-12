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
