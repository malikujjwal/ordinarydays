import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applySkip } from './applySkip';

const occurrence: AgendaItem = {
  activityId: 'act_SERIES',
  occurrenceDate: '2026-08-11',
  type: 'task',
  title: 'Daily stretch',
  status: 'scheduled',
  time: '17:00',
  isRecurring: true,
  recurrenceDescription: 'Every day',
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};
const cached: AgendaData = {
  days: [
    {
      date: '2026-08-11',
      upNext: occurrence,
      schedule: [occurrence],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
};
const target = {
  activityId: occurrence.activityId,
  occurrenceDate: '2026-08-11',
  today: '2026-08-11',
  currentMinute: '15:00',
};

describe('applySkip', () => {
  it('matches the self-seeded server response for an occurrence skip', () => {
    const recordedServerResponse: AgendaData = {
      days: [
        {
          date: '2026-08-11',
          schedule: [],
          anytime: [],
          earlier: [{ ...occurrence, status: 'skipped_occurrence' }],
        },
      ],
      warnings: [],
    };

    expect(applySkip(cached, { ...target, skipped: true })).toEqual(
      recordedServerResponse,
    );
  });

  it('returns the original cache deep-equal after the compensating mutation', () => {
    const skipped = applySkip(cached, { ...target, skipped: true });
    expect(applySkip(skipped, { ...target, skipped: false })).toEqual(cached);
  });
});
