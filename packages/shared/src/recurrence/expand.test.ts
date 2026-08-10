import { readFileSync } from 'node:fs';
import { addDays, format, getDay, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isoDate } from '../schemas/common.js';
import { recurrence as recurrenceSchema } from '../schemas/recurrence.js';
import type {
  MonthNumber,
  Recurrence,
  RecurrenceSegment,
  Weekday,
} from '../types/recurrence.js';
import { toUtcInstant } from './calendar.js';
import { RecurrenceValidationError } from './error.js';
import { expandRecurrence } from './expand.js';

const DEFAULT_TIMEZONE = 'America/New_York';
const PROPERTY_RUNS = 1_000;

function recurrence(
  segment: RecurrenceSegment,
  ends: Pick<Recurrence, 'endDate' | 'count'> = {},
): Recurrence {
  return { mode: 'fixed', segments: [segment], ...ends };
}

function expand(
  rec: Recurrence,
  from: string,
  to: string,
  timezone = DEFAULT_TIMEZONE,
): string[] {
  return expandRecurrence(rec, from, to, timezone);
}

function addIsoDays(value: string, amount: number): string {
  return format(addDays(parseISO(`${value}T12:00:00`), amount), 'yyyy-MM-dd');
}

const goldenFixtureSchema = z
  .object({
    case: z.number().int(),
    name: z.string(),
    recurrence: z.unknown(),
    from: isoDate,
    to: isoDate,
    timezone: z.string().min(1),
    expectedDates: z.array(isoDate),
    expectedInstants: z.array(z.string()).optional(),
  })
  .strict();

type GoldenFixture = Omit<z.infer<typeof goldenFixtureSchema>, 'recurrence'> & {
  recurrence: Recurrence;
};

function loadGoldenFixture(name: string): GoldenFixture {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
  const fixture = goldenFixtureSchema.parse(raw);
  return {
    ...fixture,
    // The schema/interface parity suite pins this runtime shape to `Recurrence`.
    recurrence: recurrenceSchema.parse(fixture.recurrence) as Recurrence,
  };
}

function instantsForFixture(fixture: GoldenFixture): string[] {
  const time = fixture.recurrence.segments[0]?.time;
  if (time === undefined) throw new Error(`Golden fixture ${fixture.case} has no time.`);
  return fixture.expectedDates.map((date) => toUtcInstant(date, time, fixture.timezone));
}

interface EngineCase {
  number: number;
  name: string;
  recurrence: Recurrence;
  from: string;
  to: string;
  expectedDates: string[];
  timezone?: string;
}

const engineCases: EngineCase[] = [
  {
    number: 1,
    name: 'daily',
    recurrence: recurrence({
      freq: 'daily',
      interval: 1,
      effectiveFrom: '2026-08-01',
    }),
    from: '2026-08-01',
    to: '2026-08-07',
    expectedDates: [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ],
  },
  {
    number: 2,
    name: 'daily with the window starting mid-series',
    recurrence: recurrence({
      freq: 'daily',
      interval: 1,
      effectiveFrom: '2026-08-01',
    }),
    from: '2026-08-05',
    to: '2026-08-07',
    expectedDates: ['2026-08-05', '2026-08-06', '2026-08-07'],
  },
  {
    number: 3,
    name: 'weekdays',
    recurrence: recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-03' }),
    from: '2026-08-01',
    to: '2026-08-14',
    expectedDates: [
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ],
  },
  {
    number: 4,
    name: 'weekdays starting on a weekend',
    recurrence: recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-01' }),
    from: '2026-08-01',
    to: '2026-08-07',
    expectedDates: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
  },
  {
    number: 5,
    name: 'weekly by day',
    recurrence: recurrence({
      freq: 'weekly',
      interval: 1,
      byWeekday: [4],
      effectiveFrom: '2026-08-06',
    }),
    from: '2026-08-01',
    to: '2026-08-31',
    expectedDates: ['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27'],
  },
  {
    number: 6,
    name: 'weekly with multiple weekdays',
    recurrence: recurrence({
      freq: 'weekly',
      interval: 1,
      byWeekday: [1, 3, 5],
      effectiveFrom: '2026-08-03',
    }),
    from: '2026-08-03',
    to: '2026-08-23',
    expectedDates: [
      '2026-08-03',
      '2026-08-05',
      '2026-08-07',
      '2026-08-10',
      '2026-08-12',
      '2026-08-14',
      '2026-08-17',
      '2026-08-19',
      '2026-08-21',
    ],
  },
  {
    number: 7,
    name: 'weekly with interval two',
    recurrence: recurrence({
      freq: 'weekly',
      interval: 2,
      byWeekday: [1],
      effectiveFrom: '2026-08-03',
    }),
    from: '2026-08-01',
    to: '2026-08-31',
    expectedDates: ['2026-08-03', '2026-08-17', '2026-08-31'],
  },
  {
    number: 8,
    name: 'monthly by date',
    recurrence: recurrence({
      freq: 'monthly',
      byMonthDay: [6],
      effectiveFrom: '2026-08-06',
    }),
    from: '2026-08-01',
    to: '2026-10-31',
    expectedDates: ['2026-08-06', '2026-09-06', '2026-10-06'],
  },
  {
    number: 10,
    name: 'month-end rollover for the 30th in February',
    recurrence: recurrence({
      freq: 'monthly',
      byMonthDay: [30],
      effectiveFrom: '2026-01-30',
    }),
    from: '2026-02-01',
    to: '2026-02-28',
    expectedDates: ['2026-02-28'],
  },
  {
    number: 11,
    name: 'month-end in a leap year',
    recurrence: recurrence({
      freq: 'monthly',
      byMonthDay: [31],
      effectiveFrom: '2028-01-31',
    }),
    from: '2028-02-01',
    to: '2028-02-29',
    expectedDates: ['2028-02-29'],
  },
  {
    number: 12,
    name: 'month-end for the 29th in a non-leap year',
    recurrence: recurrence({
      freq: 'monthly',
      byMonthDay: [29],
      effectiveFrom: '2026-01-29',
    }),
    from: '2026-02-01',
    to: '2026-02-28',
    expectedDates: ['2026-02-28'],
  },
  {
    number: 13,
    name: 'every N days',
    recurrence: recurrence({
      freq: 'interval_days',
      interval: 3,
      effectiveFrom: '2026-08-01',
    }),
    from: '2026-08-01',
    to: '2026-08-14',
    expectedDates: ['2026-08-01', '2026-08-04', '2026-08-07', '2026-08-10', '2026-08-13'],
  },
  {
    number: 14,
    name: 'every N days with the window offset from the anchor',
    recurrence: recurrence({
      freq: 'interval_days',
      interval: 3,
      effectiveFrom: '2026-08-01',
    }),
    from: '2026-08-05',
    to: '2026-08-14',
    expectedDates: ['2026-08-07', '2026-08-10', '2026-08-13'],
  },
  {
    number: 20,
    name: 'series end date',
    recurrence: recurrence(
      { freq: 'daily', effectiveFrom: '2026-08-01' },
      { endDate: '2026-08-05' },
    ),
    from: '2026-08-01',
    to: '2026-08-10',
    expectedDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
  },
  {
    number: 21,
    name: 'end date before the window',
    recurrence: recurrence(
      { freq: 'daily', effectiveFrom: '2026-08-01' },
      { endDate: '2026-08-05' },
    ),
    from: '2026-08-06',
    to: '2026-08-10',
    expectedDates: [],
  },
  {
    number: 22,
    name: 'count limit',
    recurrence: recurrence(
      {
        freq: 'weekly',
        byWeekday: [1],
        effectiveFrom: '2026-08-03',
      },
      { count: 3 },
    ),
    from: '2026-08-01',
    to: '2026-09-30',
    expectedDates: ['2026-08-03', '2026-08-10', '2026-08-17'],
  },
  {
    number: 23,
    name: 'count exhausted before the window',
    recurrence: recurrence(
      {
        freq: 'weekly',
        byWeekday: [1],
        effectiveFrom: '2026-08-03',
      },
      { count: 3 },
    ),
    from: '2026-09-01',
    to: '2026-09-30',
    expectedDates: [],
  },
  {
    number: 24,
    name: 'count and end date together',
    recurrence: recurrence(
      { freq: 'daily', effectiveFrom: '2026-08-01' },
      { count: 10, endDate: '2026-08-04' },
    ),
    from: '2026-08-01',
    to: '2026-08-20',
    expectedDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
  },
  {
    number: 31,
    name: 'empty window',
    recurrence: recurrence({ freq: 'daily', effectiveFrom: '2026-08-01' }),
    from: '2026-08-10',
    to: '2026-08-01',
    expectedDates: [],
  },
  {
    number: 32,
    name: 'start after the window returns before rule dispatch',
    // Deliberate contract: a window before the first anchor short-circuits before rule validation.
    recurrence: recurrence({
      freq: 'fortnightly' as never,
      effectiveFrom: '2027-08-01',
    }),
    from: '2026-08-01',
    to: '2026-08-31',
    expectedDates: [],
  },
  {
    number: 33,
    name: '62-day daily window',
    recurrence: recurrence({ freq: 'daily', effectiveFrom: '2026-08-01' }),
    from: '2026-08-01',
    to: '2026-10-01',
    expectedDates: [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ],
  },
  {
    number: 37,
    name: 'yearly with explicit anchors',
    recurrence: recurrence({
      freq: 'yearly',
      byMonth: [9],
      byMonthDay: [3],
      effectiveFrom: '2026-09-03',
    }),
    from: '2026-01-01',
    to: '2029-12-31',
    expectedDates: ['2026-09-03', '2027-09-03', '2028-09-03', '2029-09-03'],
  },
  {
    number: 38,
    name: 'yearly on 29 February in a leap year',
    recurrence: recurrence({ freq: 'yearly', effectiveFrom: '2028-02-29' }),
    from: '2028-02-01',
    to: '2028-02-29',
    expectedDates: ['2028-02-29'],
  },
  {
    number: 39,
    name: 'yearly on 29 February across leap and non-leap years',
    recurrence: recurrence({ freq: 'yearly', effectiveFrom: '2028-02-29' }),
    from: '2028-01-01',
    to: '2032-12-31',
    expectedDates: ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'],
  },
  {
    number: 40,
    name: 'yearly hand-constructed without explicit anchors',
    recurrence: recurrence({ freq: 'yearly', effectiveFrom: '2026-08-06' }),
    from: '2026-01-01',
    to: '2028-12-31',
    expectedDates: ['2026-08-06', '2027-08-06', '2028-08-06'],
  },
  {
    number: 41,
    name: 'yearly with an inclusive end date',
    recurrence: recurrence(
      { freq: 'yearly', effectiveFrom: '2026-09-03' },
      { endDate: '2028-09-03' },
    ),
    from: '2026-01-01',
    to: '2030-12-31',
    expectedDates: ['2026-09-03', '2027-09-03', '2028-09-03'],
  },
];

describe('P2-02 exhaustive recurrence matrix', () => {
  it.each(engineCases)('case $number: $name', (testCase) => {
    const actual = expand(
      testCase.recurrence,
      testCase.from,
      testCase.to,
      testCase.timezone,
    );

    expect(actual).toEqual(testCase.expectedDates);
  });

  it('case 9: matches the golden month-end fixture', () => {
    const fixture = loadGoldenFixture('case-09-month-end-31.json');

    const actual = expand(fixture.recurrence, fixture.from, fixture.to, fixture.timezone);

    expect(actual).toEqual(fixture.expectedDates);
  });

  it('case 15: matches the corrected spring-forward golden fixture', () => {
    const fixture = loadGoldenFixture('case-15-dst-spring-forward.json');

    const dates = expand(fixture.recurrence, fixture.from, fixture.to, fixture.timezone);
    const instants = instantsForFixture(fixture);

    expect(dates).toEqual(fixture.expectedDates);
    expect(instants).toEqual(fixture.expectedInstants);
  });

  it('case 16: emits a missing spring-forward wall time at 03:00 local', () => {
    const rec = recurrence({
      freq: 'daily',
      effectiveFrom: '2026-03-08',
      time: '02:30',
    });

    const dates = expand(rec, '2026-03-08', '2026-03-08');
    const instant = toUtcInstant('2026-03-08', '02:30', DEFAULT_TIMEZONE);

    expect(dates).toEqual(['2026-03-08']);
    expect(instant).toBe('2026-03-08T07:00:00.000Z');
    expect(formatInTimeZone(instant, DEFAULT_TIMEZONE, 'yyyy-MM-dd HH:mm')).toBe(
      '2026-03-08 03:00',
    );
  });

  it('case 17: matches the fall-back golden fixture and emits once', () => {
    const fixture = loadGoldenFixture('case-17-dst-fall-back.json');

    const dates = expand(fixture.recurrence, fixture.from, fixture.to, fixture.timezone);
    const instants = instantsForFixture(fixture);

    expect(dates).toEqual(fixture.expectedDates);
    expect(instants).toEqual(fixture.expectedInstants);
  });

  it('case 18: shifts instants across a southern-hemisphere transition', () => {
    const rec = recurrence({
      freq: 'daily',
      effectiveFrom: '2026-10-03',
      time: '18:00',
    });

    const dates = expand(rec, '2026-10-03', '2026-10-05', 'Australia/Sydney');
    const instants = dates.map((date) => toUtcInstant(date, '18:00', 'Australia/Sydney'));

    expect(dates).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    expect(instants).toEqual([
      '2026-10-03T08:00:00.000Z',
      '2026-10-04T07:00:00.000Z',
      '2026-10-05T07:00:00.000Z',
    ]);
  });

  it('case 19: preserves a 30-minute timezone offset', () => {
    const rec = recurrence({
      freq: 'daily',
      effectiveFrom: '2026-01-01',
      time: '18:00',
    });

    const dates = expand(rec, '2026-01-01', '2026-01-03', 'Asia/Kolkata');
    const instants = dates.map((date) => toUtcInstant(date, '18:00', 'Asia/Kolkata'));

    expect(dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(instants).toEqual([
      '2026-01-01T12:30:00.000Z',
      '2026-01-02T12:30:00.000Z',
      '2026-01-03T12:30:00.000Z',
    ]);
  });

  it('case 34: throws a typed error after 1,000 non-emitting steps', () => {
    const pathological = recurrence({
      freq: 'weekly',
      interval: 1,
      byWeekday: [-10_000 as Weekday],
      effectiveFrom: '2026-01-01',
    });

    const call = () => expand(pathological, '2026-01-01', '2046-01-01');

    expect(call).toThrow(RecurrenceValidationError);
    expect(call).toThrow('Recurrence expansion exceeded 1,000 steps.');
  });

  it('case 35: is deterministic when the process clock moves a day', () => {
    const rec = recurrence({
      freq: 'weekly',
      byWeekday: [1, 3, 5],
      effectiveFrom: '2026-08-03',
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-08-01T00:00:00.000Z');
      const first = expand(rec, '2026-08-01', '2026-08-31');
      vi.setSystemTime('2026-08-02T00:00:00.000Z');
      const second = expand(rec, '2026-08-01', '2026-08-31');

      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 36: accepts a deeply frozen recurrence without mutation', () => {
    const rec = Object.freeze({
      mode: 'fixed',
      segments: Object.freeze([
        Object.freeze({
          freq: 'weekly',
          byWeekday: Object.freeze([3, 1, 3]),
          effectiveFrom: '2026-08-01',
        }),
      ]),
    }) as unknown as Recurrence;

    const actual = expand(rec, '2026-08-01', '2026-08-31');

    expect(actual).toEqual([
      '2026-08-03',
      '2026-08-05',
      '2026-08-10',
      '2026-08-12',
      '2026-08-17',
      '2026-08-19',
      '2026-08-24',
      '2026-08-26',
      '2026-08-31',
    ]);
  });

  it('case 42: keeps a yearly 01:30 wall time through fall-back and an ordinary year', () => {
    const rec = recurrence({
      freq: 'yearly',
      effectiveFrom: '2026-11-01',
      time: '01:30',
    });

    const dates = expand(rec, '2026-01-01', '2027-12-31');
    const instants = dates.map((date) => toUtcInstant(date, '01:30', 'America/New_York'));

    expect(dates).toEqual(['2026-11-01', '2027-11-01']);
    expect(instants).toEqual(['2026-11-01T05:30:00.000Z', '2027-11-01T05:30:00.000Z']);
  });

  it('case 43: explicit yearly anchors survive a rewritten lower bound', () => {
    const stored = recurrence({
      freq: 'yearly',
      byMonth: [9],
      byMonthDay: [3],
      effectiveFrom: '2026-09-03',
    });
    const rewrittenLowerBound = recurrence({
      freq: 'yearly',
      byMonth: [9],
      byMonthDay: [3],
      effectiveFrom: '2026-09-10',
    });
    const expected = ['2027-09-03', '2028-09-03', '2029-09-03'];

    const storedDates = expand(stored, '2027-01-01', '2029-12-31');
    const rewrittenDates = expand(rewrittenLowerBound, '2027-01-01', '2029-12-31');

    expect(storedDates).toEqual(expected);
    expect(rewrittenDates).toEqual(expected);
  });
});

describe('segmented recurrence matrix', () => {
  const segmented: Recurrence = {
    mode: 'fixed',
    segments: [
      {
        freq: 'weekdays',
        effectiveFrom: '2026-01-05',
        time: '18:00',
      },
      {
        freq: 'weekly',
        byWeekday: [2, 4],
        effectiveFrom: '2026-08-10',
        time: '18:00',
      },
    ],
  };
  const segmentCases: Array<{
    name: string;
    recurrences: Recurrence[];
    from: string;
    to: string;
    expectedDates: string[];
  }> = [
    {
      name: 'uses the new segment on its boundary without blending the old rule',
      recurrences: [segmented],
      from: '2026-08-06',
      to: '2026-08-14',
      expectedDates: ['2026-08-06', '2026-08-07', '2026-08-11', '2026-08-13'],
    },
    {
      name: 'uses an earlier segment for a window wholly inside its in-force period',
      recurrences: [segmented],
      from: '2026-01-12',
      to: '2026-01-16',
      expectedDates: [
        '2026-01-12',
        '2026-01-13',
        '2026-01-14',
        '2026-01-15',
        '2026-01-16',
      ],
    },
    {
      name: 'leaves an elapsed window unchanged when a later segment is appended',
      recurrences: [
        recurrence({
          freq: 'weekdays',
          effectiveFrom: '2026-01-05',
          time: '18:00',
        }),
        segmented,
      ],
      from: '2026-07-06',
      to: '2026-07-10',
      expectedDates: [
        '2026-07-06',
        '2026-07-07',
        '2026-07-08',
        '2026-07-09',
        '2026-07-10',
      ],
    },
    {
      name: 'self-anchors an every-N-days second segment',
      recurrences: [
        {
          mode: 'fixed',
          segments: [
            { freq: 'daily', effectiveFrom: '2026-08-01' },
            {
              freq: 'interval_days',
              interval: 3,
              effectiveFrom: '2026-08-10',
            },
          ],
        },
      ],
      from: '2026-08-08',
      to: '2026-08-20',
      expectedDates: [
        '2026-08-08',
        '2026-08-09',
        '2026-08-10',
        '2026-08-13',
        '2026-08-16',
        '2026-08-19',
      ],
    },
    {
      name: 'applies one count across the combined segment stream',
      recurrences: [
        {
          mode: 'fixed',
          count: 4,
          segments: [
            { freq: 'daily', effectiveFrom: '2026-01-01' },
            { freq: 'weekly', byWeekday: [0], effectiveFrom: '2026-01-04' },
            { freq: 'daily', effectiveFrom: '2026-01-11' },
          ],
        },
      ],
      from: '2026-01-01',
      to: '2026-02-01',
      expectedDates: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'],
    },
    {
      name: 'does not enter a segment beyond the series end',
      recurrences: [
        {
          mode: 'fixed',
          endDate: '2026-08-05',
          segments: [
            { freq: 'daily', effectiveFrom: '2026-08-01' },
            { freq: 'daily', effectiveFrom: '2026-08-10' },
          ],
        },
      ],
      from: '2026-08-01',
      to: '2026-08-20',
      expectedDates: [
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
        '2026-08-04',
        '2026-08-05',
      ],
    },
  ];

  it.each(segmentCases)('$name', (testCase) => {
    for (const rec of testCase.recurrences) {
      expect(expand(rec, testCase.from, testCase.to)).toEqual(testCase.expectedDates);
    }
  });
});

function naiveDailyOrWeekdays(rec: Recurrence, from: string, to: string): string[] {
  const segment = rec.segments[0];
  if (segment === undefined) return [];
  const dates: string[] = [];
  let date = segment.effectiveFrom;
  let occurrenceCount = 0;

  while (date <= to && (rec.endDate === undefined || date <= rec.endDate)) {
    const weekday = getDay(parseISO(`${date}T12:00:00`));
    const occurs = segment.freq === 'daily' || (weekday !== 0 && weekday !== 6);
    if (occurs) {
      occurrenceCount += 1;
      if (rec.count !== undefined && occurrenceCount > rec.count) break;
      if (date >= from) dates.push(date);
    }
    date = addIsoDays(date, 1);
  }

  return dates;
}

function naiveMonthly(rec: Recurrence, from: string, to: string): string[] {
  const segment = rec.segments[0];
  if (segment === undefined) return [];
  const [anchorYear, anchorMonth, anchorDay] = segment.effectiveFrom
    .split('-')
    .map(Number);
  const recurrenceDay = segment.byMonthDay?.[0] ?? anchorDay;
  if (
    anchorYear === undefined ||
    anchorMonth === undefined ||
    recurrenceDay === undefined
  )
    return [];
  const dates: string[] = [];

  for (let offset = 0; ; offset += 1) {
    const month = new Date(Date.UTC(anchorYear, anchorMonth - 1 + offset, 1));
    const year = month.getUTCFullYear();
    const monthNumber = month.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(Math.min(recurrenceDay, lastDay)).padStart(2, '0')}`;
    if (date > to) break;
    if (date >= segment.effectiveFrom && date >= from) dates.push(date);
  }

  return dates;
}

describe('independent recurrence cross-checks', () => {
  const crossCheckCases = [
    {
      name: 'daily with a count consumed before the window',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { count: 7 },
      ),
      from: '2026-08-05',
      to: '2026-08-10',
      expectedDates: ['2026-08-05', '2026-08-06', '2026-08-07'],
    },
    {
      name: 'weekdays from a weekend anchor through an inclusive end',
      recurrence: recurrence(
        { freq: 'weekdays', effectiveFrom: '2026-08-01' },
        { endDate: '2026-08-10' },
      ),
      from: '2026-08-01',
      to: '2026-08-14',
      expectedDates: [
        '2026-08-03',
        '2026-08-04',
        '2026-08-05',
        '2026-08-06',
        '2026-08-07',
        '2026-08-10',
      ],
    },
  ];

  it.each(crossCheckCases)('$name', (testCase) => {
    const engine = expand(testCase.recurrence, testCase.from, testCase.to);
    const naive = naiveDailyOrWeekdays(testCase.recurrence, testCase.from, testCase.to);

    expect(engine).toEqual(testCase.expectedDates);
    expect(naive).toEqual(testCase.expectedDates);
    expect(engine).toEqual(naive);
  });

  it('matches a component-based month walker across short months', () => {
    const rec = recurrence({
      freq: 'monthly',
      byMonthDay: [31],
      effectiveFrom: '2026-01-31',
    });
    const expected = [
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ];
    const engine = expand(rec, '2026-01-01', '2026-06-30');
    const naive = naiveMonthly(rec, '2026-01-01', '2026-06-30');

    expect(engine).toEqual(expected);
    expect(naive).toEqual(expected);
    expect(engine).toEqual(naive);
  });
});

type GeneratedRule = Omit<RecurrenceSegment, 'effectiveFrom'>;

const ruleArbitrary: fc.Arbitrary<GeneratedRule> = fc.oneof(
  fc.constant({ freq: 'daily' as const, interval: 1 }),
  fc.constant({ freq: 'weekdays' as const }),
  fc
    .record({
      interval: fc.integer({ min: 1, max: 4 }),
      byWeekday: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), {
        minLength: 1,
        maxLength: 7,
      }),
    })
    .map(({ interval, byWeekday }) => ({
      freq: 'weekly' as const,
      interval,
      byWeekday: byWeekday as Weekday[],
    })),
  fc.integer({ min: 1, max: 31 }).map((monthDay) => ({
    freq: 'monthly' as const,
    byMonthDay: [monthDay],
  })),
  fc.integer({ min: 2, max: 365 }).map((interval) => ({
    freq: 'interval_days' as const,
    interval,
  })),
  fc
    .record({
      month: fc.integer({ min: 1, max: 12 }),
      monthDay: fc.integer({ min: 1, max: 31 }),
    })
    .map(({ month, monthDay }) => ({
      freq: 'yearly' as const,
      byMonth: [month as MonthNumber],
      byMonthDay: [monthDay],
    })),
);

const recurrenceWindowArbitrary = fc
  .record({
    rule: ruleArbitrary,
    startOffset: fc.integer({ min: 0, max: 365 }),
    windowOffset: fc.integer({ min: 0, max: 365 }),
    windowLength: fc.integer({ min: 1, max: 62 }),
    count: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    endOffset: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
    timezone: fc.constantFrom(
      'America/New_York',
      'Europe/London',
      'Australia/Sydney',
      'Asia/Kolkata',
      'Pacific/Auckland',
    ),
  })
  .map(
    ({ rule, startOffset, windowOffset, windowLength, count, endOffset, timezone }) => {
      const effectiveFrom = addIsoDays('2026-01-01', startOffset);
      const from = addIsoDays(effectiveFrom, windowOffset);
      const to = addIsoDays(from, windowLength - 1);
      const rec: Recurrence = {
        mode: 'fixed',
        segments: [{ ...rule, effectiveFrom }],
        ...(count === undefined ? {} : { count }),
        ...(endOffset === undefined
          ? {}
          : { endDate: addIsoDays(effectiveFrom, endOffset) }),
      };

      return { rec, from, to, windowLength, timezone };
    },
  );

describe('property-based recurrence invariants', () => {
  it('holds monotonicity, bounds, termination, composition and purity', () => {
    fc.assert(
      fc.property(
        recurrenceWindowArbitrary,
        ({ rec, from, to, windowLength, timezone }) => {
          const before = JSON.stringify(rec);
          const output = expand(rec, from, to, timezone);
          const second = expand(rec, from, to, timezone);
          const middle = addIsoDays(from, Math.floor((windowLength - 1) / 2));
          const rightFrom = addIsoDays(middle, 1);
          const composed = [
            ...expand(rec, from, middle, timezone),
            ...expand(rec, rightFrom, to, timezone),
          ];
          const firstEffectiveFrom = rec.segments[0]?.effectiveFrom;
          if (firstEffectiveFrom === undefined) return false;
          const strictlyAscending = output.every((date, index) => {
            const previous = output[index - 1];
            return index === 0 || (previous !== undefined && date > previous);
          });
          const inWindow = output.every(
            (date) => date >= from && date <= to && date >= firstEffectiveFrom,
          );
          const withinEnds = output.every(
            (date) => rec.endDate === undefined || date <= rec.endDate,
          );
          const withinCount = rec.count === undefined || output.length <= rec.count;
          return (
            strictlyAscending &&
            new Set(output).size === output.length &&
            inWindow &&
            withinEnds &&
            withinCount &&
            JSON.stringify(rec) === before &&
            JSON.stringify(second) === JSON.stringify(output) &&
            JSON.stringify(composed) === JSON.stringify(output)
          );
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: 0x0d0202 },
    );
  });

  it('keeps 18:00 local across generated IANA-zone transition dates', () => {
    const transitionArbitrary = fc.constantFrom(
      { timezone: 'America/New_York', from: '2026-03-07' },
      { timezone: 'America/New_York', from: '2026-10-31' },
      { timezone: 'Europe/London', from: '2026-03-28' },
      { timezone: 'Europe/London', from: '2026-10-24' },
      { timezone: 'Australia/Sydney', from: '2026-10-03' },
      { timezone: 'Pacific/Auckland', from: '2026-09-26' },
      { timezone: 'Asia/Kolkata', from: '2026-03-07' },
    );

    const transitionDateArbitrary = fc
      .tuple(transitionArbitrary, fc.integer({ min: 0, max: 2 }))
      .map(([transition, dayOffset]) => ({
        timezone: transition.timezone,
        date: addIsoDays(transition.from, dayOffset),
      }));
    const wallTimeByZoneDate = new Map<string, string>();

    fc.assert(
      fc.property(transitionDateArbitrary, ({ timezone, date }) => {
        const rec = recurrence({
          freq: 'daily',
          effectiveFrom: date,
          time: '18:00',
        });
        const dates = expand(rec, date, date, timezone);

        return dates.every((emittedDate) => {
          const key = `${timezone}:${emittedDate}`;
          let wallTime = wallTimeByZoneDate.get(key);
          if (wallTime === undefined) {
            wallTime = formatInTimeZone(
              toUtcInstant(emittedDate, '18:00', timezone),
              timezone,
              'HH:mm',
            );
            wallTimeByZoneDate.set(key, wallTime);
          }
          return wallTime === '18:00';
        });
      }),
      { numRuns: PROPERTY_RUNS, seed: 0x0d0203 },
    );
  });
});

describe('invalid and defensive recurrence paths', () => {
  const invalidCases: Array<{
    name: string;
    recurrence: Recurrence;
    message: string;
  }> = [
    {
      name: 'completion-relative mode',
      recurrence: { mode: 'after_completion', segments: [] },
      message: 'Completion-relative recurrence is not available until Phase 9.',
    },
    {
      name: 'missing segment',
      recurrence: { mode: 'fixed', segments: [] },
      message: 'Recurrence requires at least one segment.',
    },
    {
      name: 'custom frequency',
      recurrence: recurrence({ freq: 'custom', effectiveFrom: '2026-08-01' }),
      message: 'Custom recurrence is not available until Phase 9.',
    },
    {
      name: 'unknown frequency',
      recurrence: recurrence({
        freq: 'fortnightly' as never,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Unsupported recurrence frequency.',
    },
    {
      name: 'unordered segments',
      recurrence: {
        mode: 'fixed',
        segments: [
          { freq: 'daily', effectiveFrom: '2026-08-02' },
          { freq: 'daily', effectiveFrom: '2026-08-01' },
        ],
      },
      message: 'Recurrence segments must be ordered by effective date.',
    },
    {
      name: 'weekly without weekdays',
      recurrence: recurrence({ freq: 'weekly', effectiveFrom: '2026-08-01' }),
      message: 'Weekly recurrence requires at least one weekday.',
    },
    {
      name: 'weekly with a non-positive interval',
      recurrence: recurrence({
        freq: 'weekly',
        interval: 0,
        byWeekday: [1],
        effectiveFrom: '2026-08-01',
      }),
      message: 'Weekly recurrence interval must be positive.',
    },
    {
      name: 'monthly with day zero',
      recurrence: recurrence({
        freq: 'monthly',
        byMonthDay: [0],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Monthly recurrence day must be from 1 to 31.',
    },
    {
      name: 'monthly with day 32',
      recurrence: recurrence({
        freq: 'monthly',
        byMonthDay: [32],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Monthly recurrence day must be from 1 to 31.',
    },
    {
      name: 'yearly with month but no day',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [2],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence requires both month and month-day anchors, or neither.',
    },
    {
      name: 'yearly with day but no month',
      recurrence: recurrence({
        freq: 'yearly',
        byMonthDay: [2],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence requires both month and month-day anchors, or neither.',
    },
    {
      name: 'yearly with month zero',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [0 as MonthNumber],
        byMonthDay: [1],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence anchors are out of range.',
    },
    {
      name: 'yearly with month 13',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [13 as MonthNumber],
        byMonthDay: [1],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence anchors are out of range.',
    },
    {
      name: 'yearly with day zero',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [1],
        byMonthDay: [0],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence anchors are out of range.',
    },
    {
      name: 'yearly with day 32',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [1],
        byMonthDay: [32],
        effectiveFrom: '2026-01-01',
      }),
      message: 'Yearly recurrence anchors are out of range.',
    },
    {
      name: 'every-N-days without an interval',
      recurrence: recurrence({
        freq: 'interval_days',
        effectiveFrom: '2026-08-01',
      }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
    {
      name: 'every-N-days with interval one',
      recurrence: recurrence({
        freq: 'interval_days',
        interval: 1,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
    {
      name: 'every-N-days with interval 366',
      recurrence: recurrence({
        freq: 'interval_days',
        interval: 366,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
  ];

  it.each(invalidCases)('rejects $name', (testCase) => {
    const call = () => expand(testCase.recurrence, '2026-01-01', '2027-12-31');

    expect(call).toThrow(RecurrenceValidationError);
    expect(call).toThrow(testCase.message);
  });

  it('returns empty when the end date precedes the first anchor', () => {
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
  });

  it('returns empty for a non-positive count', () => {
    expect(
      expand(
        recurrence({ freq: 'daily', effectiveFrom: '2026-08-10' }, { count: 0 }),
        '2026-08-01',
        '2026-08-20',
      ),
    ).toEqual([]);
  });

  it('clamps an explicit yearly anchor behind the first lower bound', () => {
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

  it('uses the segment date as the monthly anchor when no day is stored', () => {
    expect(
      expand(
        recurrence({ freq: 'monthly', effectiveFrom: '2026-01-29' }),
        '2026-02-01',
        '2026-02-28',
      ),
    ).toEqual(['2026-02-28']);
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
