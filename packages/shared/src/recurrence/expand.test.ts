import { describe, expect, it } from 'vitest';
import type { Recurrence, RecurrenceSegment } from '../types/recurrence.js';
import { RecurrenceValidationError } from './error.js';
import { expandRecurrence } from './expand.js';

const timezone = 'America/New_York';

function recurrence(
  segment: RecurrenceSegment,
  ends: Pick<Recurrence, 'endDate' | 'count'> = {},
): Recurrence {
  return { mode: 'fixed', segments: [segment], ...ends };
}

function expand(rec: Recurrence, from: string, to: string, tz = timezone): string[] {
  return expandRecurrence(rec, from, to, tz);
}

describe('expandRecurrence frequencies', () => {
  it('expands daily dates from the anchor and clips the requested window', () => {
    const rec = recurrence({ freq: 'daily', effectiveFrom: '2026-08-01' });

    expect(expand(rec, '2026-08-03', '2026-08-05')).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    expect(expand(rec, '2026-07-30', '2026-08-02')).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('expands weekdays efficiently across weekday and weekend anchors', () => {
    expect(
      expand(
        recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-01' }),
        '2026-08-01',
        '2026-08-08',
      ),
    ).toEqual(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
    expect(
      expand(
        recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-02' }),
        '2026-08-02',
        '2026-08-03',
      ),
    ).toEqual(['2026-08-03']);
    expect(
      expand(
        recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-04' }),
        '2026-08-04',
        '2026-08-04',
      ),
    ).toEqual(['2026-08-04']);
  });

  it('expands weekly rules in anchor-relative weeks with sorted unique weekdays', () => {
    const rec = recurrence({
      freq: 'weekly',
      interval: 2,
      byWeekday: [5, 1, 1],
      effectiveFrom: '2026-08-05',
    });

    expect(expand(rec, '2026-08-01', '2026-08-31')).toEqual([
      '2026-08-07',
      '2026-08-17',
      '2026-08-21',
      '2026-08-31',
    ]);
    expect(
      expand(
        recurrence({
          freq: 'weekly',
          byWeekday: [4],
          effectiveFrom: '2026-08-06',
        }),
        '2026-08-13',
        '2026-08-13',
      ),
    ).toEqual(['2026-08-13']);
  });

  it('rejects malformed weekly rules', () => {
    expect(() =>
      expand(
        recurrence({ freq: 'weekly', effectiveFrom: '2026-08-01' }),
        '2026-08-01',
        '2026-08-07',
      ),
    ).toThrow(RecurrenceValidationError);
    expect(() =>
      expand(
        recurrence({
          freq: 'weekly',
          interval: 0,
          byWeekday: [1],
          effectiveFrom: '2026-08-01',
        }),
        '2026-08-01',
        '2026-08-07',
      ),
    ).toThrow('Weekly recurrence interval must be positive.');
  });

  it('expands monthly rules with explicit and fallback anchors and clamps month ends', () => {
    expect(
      expand(
        recurrence({
          freq: 'monthly',
          byMonthDay: [31],
          effectiveFrom: '2026-01-31',
        }),
        '2026-01-01',
        '2026-04-30',
      ),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(
      expand(
        recurrence({ freq: 'monthly', effectiveFrom: '2026-01-29' }),
        '2026-02-01',
        '2026-02-28',
      ),
    ).toEqual(['2026-02-28']);
    expect(
      expand(
        recurrence({
          freq: 'monthly',
          byMonthDay: [6],
          effectiveFrom: '2026-01-31',
        }),
        '2026-01-01',
        '2026-02-10',
      ),
    ).toEqual(['2026-02-06']);
  });

  it.each([0, 32])('rejects monthly anchor %i outside the calendar range', (day) => {
    expect(() =>
      expand(
        recurrence({
          freq: 'monthly',
          byMonthDay: [day],
          effectiveFrom: '2026-01-01',
        }),
        '2026-01-01',
        '2026-02-01',
      ),
    ).toThrow('Monthly recurrence day must be from 1 to 31.');
  });

  it('expands yearly rules with explicit anchors and effective-date fallbacks', () => {
    expect(
      expand(
        recurrence({
          freq: 'yearly',
          byMonth: [2],
          byMonthDay: [29],
          effectiveFrom: '2028-02-29',
        }),
        '2028-01-01',
        '2032-12-31',
      ),
    ).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    expect(
      expand(
        recurrence({ freq: 'yearly', effectiveFrom: '2026-08-06' }),
        '2026-01-01',
        '2028-12-31',
      ),
    ).toEqual(['2026-08-06', '2027-08-06', '2028-08-06']);
  });

  it('keeps an explicit yearly anchor behind the segment lower bound', () => {
    expect(
      expand(
        recurrence({
          freq: 'yearly',
          byMonth: [1],
          byMonthDay: [1],
          effectiveFrom: '2026-09-03',
        }),
        '2026-01-01',
        '2027-12-31',
      ),
    ).toEqual(['2027-01-01']);
  });

  it.each<RecurrenceSegment>([
    { freq: 'yearly', byMonth: [2], effectiveFrom: '2026-01-01' },
    { freq: 'yearly', byMonthDay: [2], effectiveFrom: '2026-01-01' },
    {
      freq: 'yearly',
      byMonth: [13 as 12],
      byMonthDay: [1],
      effectiveFrom: '2026-01-01',
    },
    {
      freq: 'yearly',
      byMonth: [1],
      byMonthDay: [0],
      effectiveFrom: '2026-01-01',
    },
    {
      freq: 'yearly',
      byMonth: [1],
      byMonthDay: [32],
      effectiveFrom: '2026-01-01',
    },
  ])('rejects partial or out-of-range yearly anchor %#', (segment) => {
    expect(() => expand(recurrence(segment), '2026-01-01', '2027-12-31')).toThrow(
      RecurrenceValidationError,
    );
  });

  it('expands every-N-days rules without re-anchoring on the window', () => {
    expect(
      expand(
        recurrence({
          freq: 'interval_days',
          interval: 3,
          effectiveFrom: '2026-08-01',
        }),
        '2026-08-05',
        '2026-08-14',
      ),
    ).toEqual(['2026-08-07', '2026-08-10', '2026-08-13']);
  });

  it.each([undefined, 1, 366])(
    'rejects missing or out-of-range every-N-days interval %s',
    (interval) => {
      expect(() =>
        expand(
          recurrence({
            freq: 'interval_days',
            ...(interval === undefined ? {} : { interval }),
            effectiveFrom: '2026-08-01',
          }),
          '2026-08-01',
          '2026-08-14',
        ),
      ).toThrow(RecurrenceValidationError);
    },
  );
});

describe('expandRecurrence series rules', () => {
  it('walks segments internally without blending their boundary dates', () => {
    const rec: Recurrence = {
      mode: 'fixed',
      segments: [
        { freq: 'weekdays', effectiveFrom: '2026-08-03' },
        {
          freq: 'weekly',
          byWeekday: [2, 4],
          effectiveFrom: '2026-08-10',
        },
      ],
    };

    expect(expand(rec, '2026-08-06', '2026-08-14')).toEqual([
      '2026-08-06',
      '2026-08-07',
      '2026-08-11',
      '2026-08-13',
    ]);
  });

  it('applies count across segments and consumes occurrences before the window', () => {
    const rec: Recurrence = {
      mode: 'fixed',
      count: 4,
      segments: [
        { freq: 'daily', effectiveFrom: '2026-01-01' },
        { freq: 'weekly', byWeekday: [0], effectiveFrom: '2026-01-04' },
        { freq: 'daily', effectiveFrom: '2026-01-11' },
      ],
    };

    expect(expand(rec, '2026-01-01', '2026-02-01')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(
      expand(
        recurrence({ freq: 'daily', effectiveFrom: '2026-01-01' }, { count: 3 }),
        '2026-03-01',
        '2026-03-31',
      ),
    ).toEqual([]);
  });

  it('uses the earlier of an inclusive end date and count', () => {
    expect(
      expand(
        recurrence(
          { freq: 'daily', effectiveFrom: '2026-08-01' },
          { count: 10, endDate: '2026-08-04' },
        ),
        '2026-08-01',
        '2026-08-20',
      ),
    ).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
    expect(
      expand(
        recurrence(
          { freq: 'daily', effectiveFrom: '2026-08-01' },
          { count: 2, endDate: '2026-08-20' },
        ),
        '2026-08-01',
        '2026-08-10',
      ),
    ).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('returns empty for windows or bounds that cannot contain an occurrence', () => {
    const rec = recurrence({ freq: 'daily', effectiveFrom: '2026-08-10' });

    expect(expand(rec, '2026-08-05', '2026-08-01')).toEqual([]);
    expect(expand(rec, '2026-08-01', '2026-08-05')).toEqual([]);
    expect(
      expand(
        recurrence(
          { freq: 'daily', effectiveFrom: '2026-08-10' },
          { endDate: '2026-08-09' },
        ),
        '2026-08-01',
        '2026-08-20',
      ),
    ).toEqual([]);
    expect(
      expand(
        recurrence({ freq: 'daily', effectiveFrom: '2026-08-10' }, { count: 0 }),
        '2026-08-01',
        '2026-08-20',
      ),
    ).toEqual([]);
  });

  it('does not enter a later segment outside the requested series window', () => {
    const rec: Recurrence = {
      mode: 'fixed',
      segments: [
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { freq: 'daily', effectiveFrom: '2026-08-10' },
      ],
    };

    expect(expand(rec, '2026-08-05', '2026-08-05')).toEqual(['2026-08-05']);
  });

  it('rejects unsupported modes, frequencies, missing segments and unordered segments', () => {
    expect(() =>
      expand({ mode: 'after_completion', segments: [] }, '2026-08-01', '2026-08-02'),
    ).toThrow('Completion-relative recurrence is not available until Phase 9.');
    expect(() =>
      expand({ mode: 'fixed', segments: [] }, '2026-08-01', '2026-08-02'),
    ).toThrow('Recurrence requires at least one segment.');
    expect(() =>
      expand(
        recurrence({ freq: 'custom', effectiveFrom: '2026-08-01' }),
        '2026-08-01',
        '2026-08-02',
      ),
    ).toThrow('Custom recurrence is not available until Phase 9.');
    expect(() =>
      expand(
        recurrence({
          freq: 'fortnightly' as never,
          effectiveFrom: '2026-08-01',
        }),
        '2026-08-01',
        '2026-08-02',
      ),
    ).toThrow('Unsupported recurrence frequency.');
    expect(() =>
      expand(
        {
          mode: 'fixed',
          segments: [
            { freq: 'daily', effectiveFrom: '2026-08-02' },
            { freq: 'daily', effectiveFrom: '2026-08-01' },
          ],
        },
        '2026-08-01',
        '2026-08-02',
      ),
    ).toThrow('Recurrence segments must be ordered by effective date.');
  });

  it('throws a typed error after 1,000 internal steps', () => {
    expect(() =>
      expand(
        recurrence({ freq: 'yearly', effectiveFrom: '2026-01-01' }),
        '2026-01-01',
        '3027-12-31',
      ),
    ).toThrow('Recurrence expansion exceeded 1,000 steps.');
  });

  it('is pure, deterministic, ascending and unique', () => {
    const rec: Recurrence = Object.freeze({
      mode: 'fixed',
      segments: Object.freeze([
        Object.freeze({
          freq: 'weekly',
          byWeekday: Object.freeze([3, 1, 3]),
          effectiveFrom: '2026-08-01',
        }),
      ]),
    }) as Recurrence;

    const first = expand(rec, '2026-08-01', '2026-08-31', 'Pacific/Auckland');
    const second = expand(rec, '2026-08-01', '2026-08-31', 'Pacific/Auckland');

    expect(first).toEqual(second);
    expect(first).toEqual([...new Set(first)].sort());
  });
});

describe('RecurrenceValidationError', () => {
  it('carries the closed validation code and stable error name', () => {
    const error = new RecurrenceValidationError('Bad recurrence.');

    expect(error).toMatchObject({
      name: 'RecurrenceValidationError',
      message: 'Bad recurrence.',
      code: 'validation_failed',
    });
  });
});
