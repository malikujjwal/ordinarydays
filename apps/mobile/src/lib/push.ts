import * as Notifications from 'expo-notifications';
import type { LocalNotificationRequest } from './push.types';

const IDENTIFIER_PREFIX = 'ordinarydays:local:';
const OWNER_KEY = 'ordinaryDaysOwner';
const OWNER_VALUE = 'local-reminder';

/** Native local notifications are available; permission is checked without prompting. */
export const localNotificationsSupported = true;

/**
 * Replaces only the local reminders this adapter owns.
 *
 * Permission prompting belongs to Phase 5. A user who has not already granted permission
 * gets a silent no-op here, while the reminder controls remain fully usable.
 */
export async function replaceLocalNotifications(
  requests: readonly LocalNotificationRequest[],
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;

  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const notification of scheduled) {
    if (notification.identifier.startsWith(IDENTIFIER_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }

  // Cancellation must finish before replacement, so an old request can never survive beside
  // its updated copy. The agenda window is bounded and each activity has at most 3 reminders.
  for (const request of requests) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${IDENTIFIER_PREFIX}${request.identifier}`,
      content: {
        title: request.title,
        body: request.body,
        data: { [OWNER_KEY]: OWNER_VALUE, route: request.route },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(request.fireAt),
      },
    });
  }
}
