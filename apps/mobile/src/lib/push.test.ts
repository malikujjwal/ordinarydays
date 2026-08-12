import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  getAllScheduledNotificationsAsync: vi.fn(),
  cancelScheduledNotificationAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  ...notifications,
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

const nativePath = './push.ts';

async function nativePush(): Promise<typeof import('./push.web')> {
  return (await import(nativePath)) as typeof import('./push.web');
}

beforeEach(() => {
  vi.clearAllMocks();
  notifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  notifications.scheduleNotificationAsync.mockResolvedValue('scheduled');
});

describe('native push adapter', () => {
  it('silently no-ops without requesting permission when permission is not granted', async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: false });
    const push = await nativePush();

    await push.replaceLocalNotifications([]);

    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getAllScheduledNotificationsAsync).not.toHaveBeenCalled();
  });

  it('cancels only owned requests before scheduling replacements', async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
    notifications.getAllScheduledNotificationsAsync.mockResolvedValue([
      { identifier: 'ordinarydays:local:old' },
      { identifier: 'another-feature' },
    ]);
    const push = await nativePush();

    await push.replaceLocalNotifications([
      {
        identifier: 'new',
        title: 'Gym',
        body: 'In 15 minutes · 6:00 PM',
        fireAt: '2026-08-06T21:45:00.000Z',
        route: '/activity/act_test',
      },
    ]);

    expect(
      notifications.cancelScheduledNotificationAsync,
    ).toHaveBeenCalledExactlyOnceWith('ordinarydays:local:old');
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'ordinarydays:local:new',
      content: {
        title: 'Gym',
        body: 'In 15 minutes · 6:00 PM',
        data: {
          ordinaryDaysOwner: 'local-reminder',
          route: '/activity/act_test',
        },
      },
      trigger: { type: 'date', date: new Date('2026-08-06T21:45:00.000Z') },
    });
  });
});

describe('web push adapter', () => {
  it('has the same public surface and is an explicit debug-logged no-op', async () => {
    const web = await import('./push.web');
    const native = await nativePush();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await web.replaceLocalNotifications([]);

    expect(Object.keys(web).sort()).toEqual(Object.keys(native).sort());
    expect(web.localNotificationsSupported).toBe(false);
    expect(debug).toHaveBeenCalledWith('local_notification_schedule_skipped_web');
  });
});
