import { describe, expect, it } from 'vitest';
import { latestNativeAgendaCoverage, nativeVisibleAgendaQuery } from './agendaCoverage';

describe('native visible Agenda coverage', () => {
  it('adds the visible Anytime and overdue domains to ordinary native windows', () => {
    expect(
      nativeVisibleAgendaQuery({
        from: '2026-08-19',
        to: '2026-10-19',
        tz: 'UTC',
      }),
    ).toEqual({
      from: '2026-08-19',
      to: '2026-10-19',
      tz: 'UTC',
      include: 'anytime_unscheduled,overdue',
    });
  });

  it('retains reminder projection while using one deterministic include order', () => {
    expect(
      nativeVisibleAgendaQuery({
        from: '2026-08-19',
        to: '2026-08-26',
        tz: 'UTC',
        include: 'reminders',
      }),
    ).toEqual({
      from: '2026-08-19',
      to: '2026-08-26',
      tz: 'UTC',
      include: 'anytime_unscheduled,overdue,reminders',
    });
  });

  it('coalesces legacy and normalized receipts into the latest rolling domain', () => {
    expect(
      latestNativeAgendaCoverage([
        { from: '2026-08-18', to: '2026-10-18', timezone: 'UTC' },
        {
          from: '2026-08-19',
          to: '2026-10-19',
          timezone: 'UTC',
          include: 'anytime_unscheduled,overdue',
        },
        {
          from: '2026-08-19',
          to: '2026-08-26',
          timezone: 'UTC',
          include: 'reminders',
        },
      ]),
    ).toEqual([
      {
        from: '2026-08-19',
        to: '2026-10-19',
        timezone: 'UTC',
        include: 'anytime_unscheduled,overdue',
      },
      {
        from: '2026-08-19',
        to: '2026-08-26',
        timezone: 'UTC',
        include: 'anytime_unscheduled,overdue,reminders',
      },
    ]);
  });
});
