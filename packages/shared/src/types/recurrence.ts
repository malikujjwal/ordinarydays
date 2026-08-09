import type { Hhmm, IsoDate } from '../schemas/common.js';

/**
 * A recurring series (`data-model.md` §4.2).
 *
 * **One Activity row holds the whole series.** Recurring activities are never materialised
 * into future rows (`CLAUDE.md` rule 3); the agenda expands the rule at read time and merges
 * `Occurrence` overrides over the top.
 */

export type RecurrenceMode = 'fixed' | 'after_completion';

/** Phase 2 ships `fixed`; `after_completion` — "three days after I last did it" — is Phase 9. */
export type RecurrenceFreq =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'interval_days'
  | 'weekdays'
  | 'custom';

/** `0` = Sunday, matching `User.weekStartsOn`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * One rule, in force for part of a series' life.
 *
 * Segments exist so that **history renders under the rule that was in force at the time**
 * (`today-and-tasks.md` §6.2). An "all future occurrences" edit appends a segment; it never
 * mutates or deletes an existing one, so last month's Tuesdays stay Tuesdays after you move
 * the series to Wednesdays.
 */
export interface RecurrenceSegment {
  freq: RecurrenceFreq;
  /** For `interval_days` and every-N-weeks. */
  interval?: number;
  byWeekday?: Weekday[];
  byMonthDay?: number[];
  /** `yearly` only. */
  byMonth?: MonthNumber[];
  /** RFC 5545, for `custom`. Phase 9. */
  rrule?: string;
  /**
   * This segment's expansion anchor. The first segment carries `schedule.date` as it was
   * when recurrence was set; an appended segment carries the date the "all future" edit took
   * effect.
   *
   * The Repeat sheet always writes explicit `byMonth`/`byMonthDay` anchors rather than
   * relying on this, so a birthday cannot drift because you moved this year's dinner. The
   * expansion falls back to `effectiveFrom` only for a hand-constructed series.
   */
  effectiveFrom: IsoDate;
  /** The time in force during this segment, snapshotted from `schedule` when it was created. */
  time?: Hhmm;
  endTime?: Hhmm;
}

export interface Recurrence {
  mode: RecurrenceMode;
  /**
   * Ordered, `effectiveFrom` strictly ascending, 1–20. A segment runs from its
   * `effectiveFrom` to the day before the next one's; the last runs until `endDate`/`count`,
   * or forever.
   */
  segments: RecurrenceSegment[];
  /** Series-level "Ends: on a date". */
  endDate?: IsoDate;
  /** Series-level "Ends: after N occurrences", counted across all segments. */
  count?: number;
}
