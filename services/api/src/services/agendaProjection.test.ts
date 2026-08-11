import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { projectAgendaItem } from './agendaProjection.js';
import type { AgendaCandidate } from './agendaService.js';

const clock = {
  now: '2026-08-06T19:00:00.000Z',
  timezone: 'America/New_York',
  today: '2026-08-06',
};

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    ownerId: 'usr_owner',
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'Agenda row',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  } as Activity;
}

function candidate(
  subject: Activity,
  overrides: Partial<AgendaCandidate> = {},
): AgendaCandidate {
  return {
    activity: subject,
    status: subject.status,
    viewerDate: '2026-08-06',
    isSnoozed: false,
    participantAvatars: [],
    actionContext: {
      activity: subject,
      callerId: subject.ownerId,
      callerRole: 'owner',
      participatesInParent: false,
    },
    ...overrides,
  };
}

describe('AgendaItem presentation', () => {
  it('projects the parent id only for a seeded prep task', () => {
    const parentActivityId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
    const prepTask = activity({ parentActivityId });

    expect(projectAgendaItem(candidate(prepTask), clock)).toHaveProperty(
      'parentActivityId',
      parentActivityId,
    );
    expect(projectAgendaItem(candidate(activity()), clock)).not.toHaveProperty(
      'parentActivityId',
    );
  });

  it.each([
    {
      name: 'task',
      subject: activity({ parentActivityId: 'act_parent' }),
      parentTitle: 'New York Trip',
      hasCheckbox: true,
      subtitle: 'New York Trip',
    },
    {
      name: 'meal',
      subject: activity({
        objectKind: 'plan',
        type: 'meal',
        details: { kind: 'meal', mealSlot: 'dinner' },
      }),
      hasCheckbox: false,
      subtitle: 'Meal · Dinner',
    },
    {
      name: 'watch episode',
      subject: activity({
        objectKind: 'plan',
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
      }),
      hasCheckbox: false,
      subtitle: 'Watch · S2 E4',
    },
    {
      name: 'watch media kind fallback',
      subject: activity({
        objectKind: 'plan',
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Arrival', mediaKind: 'movie' },
      }),
      hasCheckbox: false,
      subtitle: 'Watch · Movie',
    },
    {
      name: 'event organiser',
      subject: activity({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event', organiser: 'Dr Patel' },
        location: { label: 'Medical centre' },
      }),
      hasCheckbox: false,
      subtitle: 'Dr Patel',
    },
    {
      name: 'event location fallback',
      subject: activity({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
        location: { label: 'Zahav' },
      }),
      hasCheckbox: false,
      subtitle: 'Zahav',
    },
    {
      name: 'custom',
      subject: activity({
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      }),
      hasCheckbox: false,
    },
  ])('derives the checkbox and subtitle for $name', (testCase) => {
    const row = candidate(testCase.subject, {
      actionContext: {
        activity: testCase.subject,
        callerId: testCase.subject.ownerId,
        callerRole: 'owner',
        participatesInParent: false,
        ...(testCase.parentTitle === undefined
          ? {}
          : { parentTitle: testCase.parentTitle }),
      },
    });

    expect(projectAgendaItem(row, clock)).toMatchObject({
      hasCheckbox: testCase.hasCheckbox,
      ...(testCase.subtitle === undefined ? {} : { subtitle: testCase.subtitle }),
    });
    if (testCase.subtitle === undefined) {
      expect(projectAgendaItem(row, clock)).not.toHaveProperty('subtitle');
    }
  });

  it('projects only the caller-safe trimmed fields', () => {
    const subject = activity({
      participantCount: 2,
      location: { label: 'Theatre', address: 'Not part of the row' },
      notes: 'Never leave the detail projection',
    });
    const row = projectAgendaItem(
      candidate(subject, {
        participantAvatars: [
          {
            personId: 'psn_alice',
            displayName: 'Alice',
            avatarUrl: 'https://example.com/a',
          },
        ],
      }),
      clock,
    );

    expect(row).toMatchObject({
      participantCount: 2,
      participantAvatars: [{ personId: 'psn_alice', displayName: 'Alice' }],
      locationLabel: 'Theatre',
    });
    expect(row).not.toHaveProperty('ownerId');
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('activity');
  });
});

describe('occurrence fields', () => {
  it('uses the effective snooze and reschedule times and preserves a changed original', () => {
    const subject = activity();

    expect(
      projectAgendaItem(
        candidate(subject, {
          time: '20:00',
          originalTime: '18:00',
          isSnoozed: true,
        }),
        clock,
      ),
    ).toMatchObject({ time: '20:00', originalTime: '18:00' });
    expect(projectAgendaItem(candidate(subject, { time: '08:30' }), clock).time).toBe(
      '08:30',
    );
  });

  it('includes occurrenceDate only for an expanded series item', () => {
    const series = activity({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });

    expect(
      projectAgendaItem(candidate(series, { occurrenceDate: '2026-08-06' }), clock),
    ).toHaveProperty('occurrenceDate', '2026-08-06');
    expect(projectAgendaItem(candidate(activity()), clock)).not.toHaveProperty(
      'occurrenceDate',
    );
  });

  it('authors recurrence copy from the request-window date', () => {
    const series = activity({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        endDate: '2027-08-31',
      },
    });

    expect(projectAgendaItem(candidate(series), clock).recurrenceDescription).toBe(
      'Daily until 31 Aug 2027',
    );
    expect(
      projectAgendaItem(candidate(series), { ...clock, today: '2027-01-01' })
        .recurrenceDescription,
    ).toBe('Daily until 31 Aug');
    expect(projectAgendaItem(candidate(activity()), clock)).not.toHaveProperty(
      'recurrenceDescription',
    );
  });
});

describe('isPast', () => {
  it.each([
    {
      name: 'end time',
      candidate: { time: '14:00', endTime: '15:00' },
      clock,
    },
    {
      name: 'start time when there is no end',
      candidate: { time: '15:00' },
      clock,
    },
    {
      name: 'end of the local day for an untimed item',
      candidate: { viewerDate: '2026-08-05' },
      clock: {
        now: '2026-08-06T04:00:00.000Z',
        timezone: 'America/New_York',
        today: '2026-08-06',
      },
    },
  ])('becomes past at exactly the $name boundary', (testCase) => {
    expect(
      projectAgendaItem(candidate(activity(), testCase.candidate), testCase.clock).isPast,
    ).toBe(true);
  });

  it('keeps an untimed item current until its local day ends', () => {
    expect(projectAgendaItem(candidate(activity()), clock).isPast).toBe(false);
  });
});
