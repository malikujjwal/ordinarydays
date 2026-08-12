import type { ActivityListItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { toAnytimeAgendaItem } from './toAnytimeAgendaItem';

describe('toAnytimeAgendaItem', () => {
  it('adds only the presentation defaults absent from the saved-list projection', () => {
    const saved: ActivityListItem = {
      activityId: 'act_01J0000000000000000000000A',
      type: 'task',
      title: 'Return the library books',
      status: 'saved',
      isRecurring: false,
      participantCount: 0,
      subtitle: 'Errands',
    };

    expect(toAnytimeAgendaItem(saved)).toEqual({
      ...saved,
      isSnoozed: false,
      hasCheckbox: true,
      capabilities: { complete: true, skip: false, snooze: false },
      participantAvatars: [],
      isPast: false,
    });
  });

  it('preserves every optional row value returned by the saved-list projection', () => {
    const saved: ActivityListItem = {
      activityId: 'act_01J0000000000000000000000B',
      type: 'meal',
      title: 'Soup night',
      status: 'saved',
      time: '18:00',
      endTime: '19:00',
      isRecurring: false,
      participantCount: 2,
      locationLabel: 'Home',
    };

    expect(toAnytimeAgendaItem(saved)).toMatchObject({
      time: '18:00',
      endTime: '19:00',
      locationLabel: 'Home',
      hasCheckbox: false,
    });
  });
});
