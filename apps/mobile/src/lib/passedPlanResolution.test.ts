import type { ActivityType, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  canResolvePassedAgendaItem,
  isNegativeOutcome,
  outcomeVerb,
  passedPlanResolution,
} from './passedPlanResolution';

const item = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_01J8SEED000000000000000000',
  type: 'event',
  title: 'Dentist appointment',
  status: 'scheduled',
  time: '14:30',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: false,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: true,
  ...patch,
});

describe('passed-plan resolution copy', () => {
  it.each([
    ['task', 'Done?', 'Complete', "Didn't happen", 'done', 'didnt_happen'],
    ['meal', 'How did it go?', 'Had it', "Didn't happen", 'had_it', 'didnt_happen'],
    ['watch', 'How did it go?', 'Watched', "Didn't happen", 'watched', 'didnt_happen'],
    ['event', 'How did it go?', 'Attended', "Didn't go", 'attended', 'didnt_go'],
    ['custom', 'Done?', 'Done', "Didn't happen", 'done', 'didnt_happen'],
  ] as const)(
    'maps %s to its exact prompt and outcomes',
    (type, prompt, positive, negative, positiveOutcome, negativeOutcome) => {
      expect(passedPlanResolution(type as ActivityType)).toEqual({
        prompt,
        positive: { label: positive, outcome: positiveOutcome },
        negative: { label: negative, outcome: negativeOutcome },
      });
    },
  );
});

describe('passed-plan resolution eligibility', () => {
  it('shows only for an authorized passed item that is still scheduled', () => {
    expect(canResolvePassedAgendaItem(item())).toBe(true);
    expect(canResolvePassedAgendaItem(item({ isPast: false }))).toBe(false);
    expect(canResolvePassedAgendaItem(item({ status: 'completed' }))).toBe(false);
    expect(
      canResolvePassedAgendaItem(
        item({ capabilities: { complete: false, skip: false, snooze: false } }),
      ),
    ).toBe(false);
  });
});

/**
 * The stored outcome decides the state, not the type alone. Reported from the built app:
 * answering `Didn't go` on an event still rendered `Attended` — the opposite of the choice.
 */
describe('outcomeVerb — declined outcomes', () => {
  it('reports the words the user chose on an event', () => {
    expect(outcomeVerb('event', 'didnt_go')).toBe("Didn't go");
  });

  it.each(['task', 'meal', 'watch', 'custom'] as const)(
    'reports Didn\u2019t happen on a %s',
    (type) => {
      expect(outcomeVerb(type, 'didnt_happen')).toBe("Didn't happen");
    },
  );

  it('is unchanged for a positive outcome, with or without one supplied', () => {
    expect(outcomeVerb('event', 'attended')).toBe('Attended');
    expect(outcomeVerb('event')).toBe('Attended');
    expect(outcomeVerb('task', 'done')).toBe('Done');
    expect(outcomeVerb('task')).toBe('Done');
  });

  it('classifies the two negative outcomes and nothing else', () => {
    expect(isNegativeOutcome('didnt_go')).toBe(true);
    expect(isNegativeOutcome('didnt_happen')).toBe(true);
    expect(isNegativeOutcome('attended')).toBe(false);
    expect(isNegativeOutcome('done')).toBe(false);
  });
});
