import { describe, expect, it } from 'vitest';
import type { Intent } from '@/lib/intentLog';
import { pendingActivityDetailFromIntent } from '@/lib/pendingActivity';

const ACTIVITY_ID = 'act_01J0000000000000000000000A';

function intent(): Intent {
  return {
    intentId: 'idem-pending-detail',
    ownerUserId: 'usr_01J0000000000000000000000A',
    mutationKey: ['activity', 'create'],
    variables: {
      idempotencyKey: 'idem-pending-detail',
      input: {
        activityId: ACTIVITY_ID,
        objectKind: 'task',
        type: 'task',
        title: 'Offline daily task',
        schedule: {
          date: '2026-08-18',
          time: '09:00',
          timezone: 'America/New_York',
        },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-18' }],
        },
      },
    },
    entityId: ACTIVITY_ID,
    status: 'queued',
    createdAt: Date.parse('2026-08-18T12:00:00.000Z'),
    seq: 1,
    attempts: 0,
  };
}

describe('pendingActivityDetailFromIntent', () => {
  it('projects the exact recurring occurrence opened from Today without a server read', () => {
    const detail = pendingActivityDetailFromIntent(intent(), {
      kind: 'occurrence',
      activityId: ACTIVITY_ID,
      date: '2026-08-19',
    });

    expect(detail?.activity.title).toBe('Offline daily task');
    expect(detail?.activity).toMatchObject({ pending: true });
    expect(detail?.activity).not.toHaveProperty('ownerId');
    expect(detail?.occurrence).toMatchObject({
      nominalDate: '2026-08-19',
      date: '2026-08-19',
      time: '09:00',
      status: 'scheduled',
      isSnoozed: false,
    });
    expect(detail?.capabilities).toEqual({
      complete: false,
      skip: false,
      snooze: false,
    });
  });

  it('refuses to invent an occurrence the pending rule does not emit', () => {
    const weekly = intent();
    const variables = weekly.variables as { input: { recurrence: unknown } };
    variables.input.recurrence = {
      mode: 'fixed',
      segments: [
        {
          freq: 'weekly',
          interval: 1,
          byWeekday: [2],
          effectiveFrom: '2026-08-18',
        },
      ],
    };

    expect(
      pendingActivityDetailFromIntent(weekly, {
        kind: 'occurrence',
        activityId: ACTIVITY_ID,
        date: '2026-08-19',
      }),
    ).toBeUndefined();
  });
});
