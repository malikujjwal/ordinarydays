import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { AgendaData, AgendaIncludeToken, AgendaItem } from '../types/index.js';
import {
  agendaData,
  agendaIncludeToken,
  agendaItem,
  agendaQuery,
  parseAgendaInclude,
} from './agenda.js';

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

  it('accepts server-authored recurrence and changed-snooze presentation fields', () => {
    expect(
      agendaItem.safeParse({
        ...subject,
        isRecurring: true,
        recurrenceDescription: 'Weekdays',
        isSnoozed: true,
        originalTime: '18:00',
        time: '20:00',
      }).success,
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

describe('agenda query', () => {
  it('accepts a 62-day inclusive window and parses combined include tokens', () => {
    const result = agendaQuery.parse({
      from: '2026-08-01',
      to: '2026-10-01',
      tz: 'America/New_York',
      include: 'anytime_unscheduled,overdue,reminders',
    });

    expect(parseAgendaInclude(result.include)).toEqual([
      'anytime_unscheduled',
      'overdue',
      'reminders',
    ]);
  });

  it('rejects a 63-day window, a reversed window and unknown fields', () => {
    expect(
      agendaQuery.safeParse({ from: '2026-08-01', to: '2026-10-02', tz: 'UTC' }).success,
    ).toBe(false);
    expect(
      agendaQuery.safeParse({ from: '2026-08-02', to: '2026-08-01', tz: 'UTC' }).success,
    ).toBe(false);
    expect(
      agendaQuery.safeParse({
        from: '2026-08-01',
        to: '2026-08-01',
        tz: 'UTC',
        page: 'today',
      }).success,
    ).toBe(false);
  });

  it.each([
    '',
    'overdue,overdue',
    'overdue,unknown',
    'anytime_unscheduled,overdue,reminders,overdue',
  ])('rejects include=%s', (include) => {
    expect(
      agendaQuery.safeParse({
        from: '2026-08-01',
        to: '2026-08-01',
        tz: 'UTC',
        include,
      }).success,
    ).toBe(false);
  });
});

describe('agenda response', () => {
  it('matches the hand-written stable payload type', () => {
    expectTypeOf<z.infer<typeof agendaData>>().toEqualTypeOf<AgendaData>();
  });

  it('accepts both warning forms and rejects an unrecognised warning', () => {
    const base = {
      days: [{ date: '2026-08-01', schedule: [], anytime: [], earlier: [] }],
    };
    expect(
      agendaData.safeParse({
        ...base,
        warnings: [
          'series_limit_exceeded',
          'duplicate_occurrence:act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
        ],
      }).success,
    ).toBe(true);
    expect(agendaData.safeParse({ ...base, warnings: ['partial_data'] }).success).toBe(
      false,
    );
  });
});
