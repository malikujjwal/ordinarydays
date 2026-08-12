import { createHttpClient, nullTokenProvider } from '@od/shared/client';
import { fixedClock, type Instant } from '@od/shared/time';
import { describe, expect, it, vi } from 'vitest';
import {
  computeLocalNotifications,
  installLocalReminderScheduler,
  refreshLocalNotifications,
} from './localSchedule';

const ACTIVITY_ID = 'act_01J8SEED000000000000000001';
const REMINDER_ID = 'rem_01J8SEED000000000000000001';
const USER_ID = 'usr_01J8SEED000000000000000001';
const NOW = '2026-08-06T12:00:00.000Z' as Instant;

type Agenda = Parameters<typeof computeLocalNotifications>[0];
type AgendaItem = Agenda['days'][number]['schedule'][number];

const item = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: ACTIVITY_ID,
  type: 'task',
  title: 'Gym',
  status: 'scheduled',
  time: '18:00',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  reminders: [
    {
      reminderId: REMINDER_ID,
      activityId: ACTIVITY_ID,
      userId: USER_ID,
      offsetMinutes: -15,
      channel: 'push',
    },
  ],
  ...patch,
});

const agenda = (date: string, entry: AgendaItem): Agenda => ({
  days: [{ date, upNext: entry, schedule: [entry], anytime: [], earlier: [] }],
  warnings: [],
});

describe('computeLocalNotifications', () => {
  it('subtracts a timed offset from the viewer-zone occurrence instant', () => {
    const result = computeLocalNotifications(
      agenda('2026-08-13', item()),
      { timezone: 'America/New_York' },
      NOW,
      () => '6:00 PM',
    );

    expect(result).toEqual([
      {
        identifier: `${ACTIVITY_ID}:${REMINDER_ID}:2026-08-13`,
        title: 'Gym',
        body: 'In 15 minutes · 6:00 PM',
        fireAt: '2026-08-13T21:45:00.000Z',
        route: `/activity/${ACTIVITY_ID}`,
      },
    ]);
  });

  it('applies an untimed offset in whole calendar days at the profile all-day hour', () => {
    const untimed = item({
      time: undefined,
      title: 'Submit insurance form',
      reminders: [
        {
          reminderId: REMINDER_ID,
          activityId: ACTIVITY_ID,
          userId: USER_ID,
          offsetMinutes: -1440,
          channel: 'push',
        },
      ],
    });

    const result = computeLocalNotifications(
      agenda('2026-08-13', untimed),
      { timezone: 'America/New_York', allDayReminderHour: 7 },
      NOW,
    );

    expect(result[0]).toMatchObject({
      body: 'Tomorrow',
      fireAt: '2026-08-12T11:00:00.000Z',
    });
  });

  it('defaults untimed reminders to 09:00 local and drops past or terminal requests', () => {
    const future = item({
      time: undefined,
      reminders: [
        {
          reminderId: REMINDER_ID,
          activityId: ACTIVITY_ID,
          userId: USER_ID,
          offsetMinutes: 0,
          channel: 'push',
        },
      ],
    });
    const completed = item({ status: 'completed' });
    const result = computeLocalNotifications(
      {
        days: [
          {
            date: '2026-08-06',
            schedule: [item()],
            anytime: [],
            earlier: [],
          },
          {
            date: '2026-08-07',
            schedule: [],
            anytime: [future],
            earlier: [completed],
          },
        ],
        warnings: [],
      },
      { timezone: 'America/New_York' },
      '2026-08-06T23:00:00.000Z' as Instant,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      body: 'Today',
      fireAt: '2026-08-07T13:00:00.000Z',
    });
  });
});

describe('local reminder refresh', () => {
  it('makes one eight-day reminder agenda request per tick and no Activity reminder request', async () => {
    const urls: string[] = [];
    const sevenDaysAway = agenda(
      '2026-08-13',
      item({
        reminders: [
          {
            reminderId: REMINDER_ID,
            activityId: ACTIVITY_ID,
            userId: USER_ID,
            offsetMinutes: -10080,
            channel: 'push',
          },
        ],
      }),
    );
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      tokenProvider: nullTokenProvider,
      timezone: 'UTC',
      clientVersion: 'ios/test',
      strictResponses: true,
      fetch: (url) => {
        urls.push(url);
        const body = url.endsWith('/v1/me')
          ? {
              data: {
                userId: USER_ID,
                displayName: 'Test User',
                timezone: 'America/New_York',
                currency: 'USD',
                weekStartsOn: 0,
                allDayReminderHour: 9,
                createdAt: '2026-08-01',
                updatedAt: '2026-08-01',
                schemaVersion: 1,
              },
              meta: { requestId: 'req_profile' },
            }
          : { data: sevenDaysAway, meta: { requestId: 'req_agenda' } };
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      },
    });
    const replace = vi.fn(
      (_requests: Readonly<ReturnType<typeof computeLocalNotifications>>) =>
        Promise.resolve(),
    );
    const clock = fixedClock(NOW);

    await refreshLocalNotifications({ client, clock, supported: true, replace });
    await refreshLocalNotifications({ client, clock, supported: true, replace });

    const agendaUrls = urls.filter((url) => url.includes('/v1/agenda?'));
    expect(agendaUrls).toEqual([
      'https://api.test/v1/agenda?from=2026-08-06&to=2026-08-13&tz=America%2FNew_York&include=reminders',
      'https://api.test/v1/agenda?from=2026-08-06&to=2026-08-13&tz=America%2FNew_York&include=reminders',
    ]);
    expect(urls.some((url) => url.includes(`/activities/${ACTIVITY_ID}/reminders`))).toBe(
      false,
    );
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0]?.[0]?.[0]).toMatchObject({
      fireAt: '2026-08-06T22:00:00.000Z',
    });
  });

  it('runs on startup and each transition into the background', async () => {
    let listener: ((state: string) => void) | undefined;
    const remove = vi.fn();
    const fetch = vi.fn((url: string) => {
      const body = url.endsWith('/v1/me')
        ? {
            data: {
              userId: USER_ID,
              displayName: 'Test User',
              timezone: 'UTC',
              currency: 'USD',
              weekStartsOn: 0,
              createdAt: '2026-08-01',
              updatedAt: '2026-08-01',
              schemaVersion: 1,
            },
            meta: { requestId: 'req_profile' },
          }
        : { data: { days: [], warnings: [] }, meta: { requestId: 'req_agenda' } };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    });
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      tokenProvider: nullTokenProvider,
      timezone: 'UTC',
      clientVersion: 'ios/test',
      strictResponses: true,
      fetch,
    });
    const onError = vi.fn();
    const stop = installLocalReminderScheduler({
      client,
      clock: fixedClock(NOW),
      supported: true,
      replace: () => Promise.resolve(),
      onError,
      appState: {
        addEventListener: (_event, next) => {
          listener = next;
          return { remove };
        },
      },
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    listener?.('active');
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    listener?.('background');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(onError).not.toHaveBeenCalled();

    stop();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does no network or device work on web', async () => {
    const fetch = vi.fn();
    const replace = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      tokenProvider: nullTokenProvider,
      timezone: 'UTC',
      clientVersion: 'web/test',
      strictResponses: true,
      fetch,
    });

    await refreshLocalNotifications({
      client,
      clock: fixedClock(NOW),
      supported: false,
      replace,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
