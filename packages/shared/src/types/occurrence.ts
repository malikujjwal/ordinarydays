import type { IsoDate } from '../schemas/common.js';

/**
 * One row per **modified** occurrence of a recurring series — `ACT#<activityId>` /
 * `OCC#<yyyy-mm-dd>` (`data-model.md` §4.5).
 *
 * Unmodified occurrences have no row; absence means "scheduled, not yet acted on". Writing a
 * row must **never** mutate the parent `Recurrence` — that is a product requirement from the
 * concept and a required Phase 2 test case.
 *
 * The repository reads and writes only modified rows; the expansion engine emits the
 * unmodified dates at read time and overlays these values.
 */

export type OccurrenceStatus = 'completed' | 'skipped' | 'snoozed' | 'rescheduled';

export interface Occurrence {
  activityId: string;
  /** The series' **nominal** date — the key, and what expansion matches on. */
  date: IsoDate;
  status: OccurrenceStatus;
  /** `HH:mm` same day, or an ISO instant. */
  snoozedUntil?: string;
  /** `HH:mm`. This occurrence starts at a different time; the series does not move. */
  overrideTime?: string;
  /**
   * A this-occurrence-only reschedule to another **date**. Expansion emits the occurrence
   * here instead of on `date`, rendered with a "moved from <date>" affix. The series is
   * untouched — which is the whole point, and the reason this is an override row rather than
   * an edit to the rule.
   */
  overrideDate?: IsoDate;
  completedAt?: string;
}
