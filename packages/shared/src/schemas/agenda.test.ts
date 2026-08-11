import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { AgendaIncludeToken, AgendaItem } from '../types/index.js';
import { agendaIncludeToken, agendaItem } from './agenda.js';

const subject = {
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  type: 'task',
  title: 'Call apartment office',
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
} as const;

describe('AgendaItem contract', () => {
  it('matches the hand-written type in both directions', () => {
    expectTypeOf<z.infer<typeof agendaItem>>().toEqualTypeOf<AgendaItem>();
  });

  it('accepts an overdue row with its original stored date', () => {
    expect(
      agendaItem.safeParse({ ...subject, overdueFromDate: '2026-08-04' }).success,
    ).toBe(true);
  });

  it('rejects a malformed overdue date', () => {
    expect(agendaItem.safeParse({ ...subject, overdueFromDate: 'Tuesday' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields and overlong presentation text', () => {
    expect(agendaItem.safeParse({ ...subject, ownerId: 'usr_owner' }).success).toBe(
      false,
    );
    expect(agendaItem.safeParse({ ...subject, title: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(
      agendaItem.safeParse({
        ...subject,
        capabilities: { complete: true, skip: true, snooze: true, delete: true },
      }).success,
    ).toBe(false);
  });
});

describe('agenda include tokens', () => {
  it('keeps overdue in the closed token union', () => {
    expect(agendaIncludeToken.options).toEqual([
      'anytime_unscheduled',
      'overdue',
      'reminders',
    ]);
    expectTypeOf<
      z.infer<typeof agendaIncludeToken>
    >().toEqualTypeOf<AgendaIncludeToken>();
  });
});
