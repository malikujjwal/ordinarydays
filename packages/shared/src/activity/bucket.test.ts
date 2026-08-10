import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Activity,
  ActivityDetails,
  ActivityType,
  Recurrence,
} from '../types/index.js';
import { deriveGsi1Bucket } from './bucket.js';

const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

function detailsFor(type: ActivityType): ActivityDetails {
  switch (type) {
    case 'task':
      return { kind: 'task' };
    case 'meal':
      return { kind: 'meal' };
    case 'watch':
      return { kind: 'watch', mediaTitle: 'The Bear' };
    case 'event':
      return { kind: 'event' };
    case 'custom':
      return { kind: 'custom' };
  }
}

function activity(
  objectKind: 'task' | 'plan',
  type: ActivityType,
  overrides: Partial<Activity> = {},
): Activity {
  return {
    activityId: ACTIVITY_ID,
    ownerId: 'usr_local_dev',
    objectKind,
    type,
    status: 'saved',
    title: 'Dinner at Zahav',
    details: detailsFor(type),
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  } as Activity;
}

const schedule = { date: '2026-08-14', timezone: 'America/New_York' } as const;
const daily: Recurrence = {
  mode: 'fixed',
  segments: [{ freq: 'daily', effectiveFrom: '2026-08-14' }],
};
const weekly: Recurrence = {
  mode: 'fixed',
  segments: [{ freq: 'weekly', byWeekday: [5], effectiveFrom: '2026-08-14' }],
};

describe('deriveGsi1Bucket', () => {
  it.each([
    ['1', activity('task', 'task', { schedule }), 'S'],
    ['2', activity('plan', 'event', { schedule }), 'S'],
    ['3', activity('task', 'task'), 'N'],
    ['4', activity('plan', 'custom'), 'P'],
    ['5', activity('plan', 'meal'), 'P'],
    ['6', activity('plan', 'event'), 'P'],
    ['7', activity('plan', 'watch'), 'P'],
    [
      '8',
      activity('plan', 'meal', {
        schedule: { ...schedule, date: '2026-08-15' },
      }),
      'S',
    ],
    ['9', activity('task', 'task', { recurrence: daily }), 'R'],
    ['10', activity('task', 'task', { recurrence: daily, schedule }), 'R'],
    ['11', activity('plan', 'meal', { recurrence: weekly }), 'R'],
  ] as const)('matrix row %s returns its literal bucket', (_row, subject, expected) => {
    expect(deriveGsi1Bucket(subject)).toBe(expected);
  });

  it.each([
    ['12', activity('task', 'task'), activity('task', 'task', { schedule }), 'N', 'S'],
    [
      '13',
      activity('plan', 'custom'),
      activity('plan', 'custom', { schedule }),
      'P',
      'S',
    ],
    ['14', activity('task', 'task', { schedule }), activity('task', 'task'), 'S', 'N'],
    [
      '15',
      activity('plan', 'custom', { schedule }),
      activity('plan', 'custom'),
      'S',
      'P',
    ],
    ['16', activity('task', 'task'), activity('plan', 'custom'), 'N', 'P'],
    ['17', activity('plan', 'custom'), activity('task', 'task'), 'P', 'N'],
    ['18', activity('plan', 'custom'), activity('plan', 'event'), 'P', 'P'],
    [
      '19',
      activity('plan', 'custom'),
      activity('plan', 'custom', { participantCount: 2 }),
      'P',
      'P',
    ],
    [
      '20',
      activity('plan', 'custom', { participantCount: 2 }),
      activity('plan', 'custom'),
      'P',
      'P',
    ],
    [
      '21',
      activity('plan', 'custom', { schedule }),
      activity('plan', 'event', { schedule }),
      'S',
      'S',
    ],
    [
      '22',
      activity('task', 'task', { schedule }),
      activity('task', 'task', { schedule, recurrence: daily }),
      'S',
      'R',
    ],
    [
      '23',
      activity('task', 'task', { schedule, recurrence: daily }),
      activity('task', 'task', { schedule }),
      'R',
      'S',
    ],
    [
      '24',
      activity('plan', 'custom', { recurrence: daily }),
      activity('plan', 'custom'),
      'R',
      'P',
    ],
  ] as const)(
    'transition row %s returns its before and after buckets',
    (_row, before, after, beforeBucket, afterBucket) => {
      expect(deriveGsi1Bucket(before)).toBe(beforeBucket);
      expect(deriveGsi1Bucket(after)).toBe(afterBucket);
    },
  );

  it('does not mutate a frozen Activity', () => {
    const segment = Object.freeze({
      freq: 'daily' as const,
      effectiveFrom: '2026-08-14',
    });
    const recurrence = Object.freeze({
      mode: 'fixed' as const,
      segments: Object.freeze([segment]),
    }) as unknown as Recurrence;
    const frozen = Object.freeze(
      activity('task', 'task', {
        schedule: Object.freeze({ ...schedule }),
        recurrence,
      }),
    );

    expect(deriveGsi1Bucket(frozen)).toBe('R');
  });

  it('is deterministic when the process clock moves', () => {
    vi.useFakeTimers();
    const subject = activity('plan', 'custom');
    vi.setSystemTime('2026-01-01T00:00:00.000Z');
    const first = deriveGsi1Bucket(subject);
    vi.setSystemTime('2036-12-31T23:59:59.999Z');

    expect(deriveGsi1Bucket(subject)).toBe(first);
  });

  it.each([
    ['task', 'task'],
    ['plan', 'meal'],
    ['plan', 'watch'],
    ['plan', 'event'],
    ['plan', 'custom'],
  ] as const)(
    'uses only objectKind for valid undated %s/%s and date for its dated form',
    (objectKind, type) => {
      expect(deriveGsi1Bucket(activity(objectKind, type))).toBe(
        objectKind === 'plan' ? 'P' : 'N',
      );
      expect(deriveGsi1Bucket(activity(objectKind, type, { schedule }))).toBe('S');
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});
