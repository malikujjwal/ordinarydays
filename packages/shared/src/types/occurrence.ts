import type { IsoDate } from '../schemas/common.js';

/**
 * One row per **modified** occurrence of a recurring series — `ACT#<activityId>` /
 * `OCC#<yyyy-mm-dd>` (`data-model.md` §4.5).
 *
 * Unmodified occurrences have no row; absence means "scheduled, not yet acted on". Writing a
 * row must **never** mutate the parent `Recurrence` — that is a product requirement from the
 * concept and a required Phase 2 test case.
 *
 * **The shape ships in Phase 1; nothing reads or writes it until Phase 2.** The expansion
 * engine, the completion endpoints and the rows themselves are P2-01 onward. It is defined
 * here so the series and its overrides are described in one place, by one task, rather than
 * the override shape being invented alongside the engine that consumes it.
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
