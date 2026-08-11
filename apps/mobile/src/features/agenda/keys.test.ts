import { describe, expect, it } from 'vitest';
import { agendaKey, TODAY_AGENDA_INCLUDE } from './keys';

describe('agendaKey', () => {
  it('is identical for identical inputs', () => {
    const first = agendaKey(
      '2026-08-06',
      '2026-08-06',
      'America/New_York',
      TODAY_AGENDA_INCLUDE,
    );
    const second = agendaKey(
      '2026-08-06',
      '2026-08-06',
      'America/New_York',
      TODAY_AGENDA_INCLUDE,
    );

    expect(first).toEqual(second);
  });

  it('distinguishes Today from a same-day window with no include set', () => {
    const today = agendaKey(
      '2026-08-06',
      '2026-08-06',
      'America/New_York',
      TODAY_AGENDA_INCLUDE,
    );
    const plans = agendaKey('2026-08-06', '2026-08-06', 'America/New_York', undefined);

    expect(today).not.toEqual(plans);
  });

  it.each([
    ['from', agendaKey('2026-08-07', '2026-08-07', 'America/New_York', undefined)],
    ['to', agendaKey('2026-08-06', '2026-08-07', 'America/New_York', undefined)],
    ['tz', agendaKey('2026-08-06', '2026-08-06', 'Europe/London', undefined)],
    ['include', agendaKey('2026-08-06', '2026-08-06', 'America/New_York', 'overdue')],
  ])('includes %s in the identity', (_parameter, changed) => {
    expect(changed).not.toEqual(
      agendaKey('2026-08-06', '2026-08-06', 'America/New_York', undefined),
    );
  });
});
