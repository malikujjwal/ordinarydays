import {
  type ActivityScope,
  type AgendaItem,
  activityScope,
  occurrenceScope,
  targetsWholeSeries,
} from '@od/shared/types';

/**
 * The scope a write against this row means — the sole place a row's scope is decided.
 *
 * Every surface used to read `item.occurrenceDate` and spread it into a request itself, so a
 * recurring row that happened to carry no occurrence date produced an activity-scoped write
 * without anyone choosing one. That is how the Today checkbox came to complete a whole series.
 */
export function scopeForRow(item: AgendaItem): ActivityScope {
  return item.occurrenceDate === undefined
    ? activityScope()
    : occurrenceScope(item.occurrenceDate);
}

/**
 * Whether a write against this row would land on the series instead of one of its days.
 *
 * A recurring row is expected to name its day; one that does not is a row the client built
 * wrong (`applyCreate` and `applyPatch` both did), and no write may be sent from it. The
 * caller declines rather than falling back, because there is no honest day to fall back to —
 * the series anchor is where the series starts, not what the user is looking at.
 */
export function wouldCompleteWholeSeries(item: AgendaItem): boolean {
  return targetsWholeSeries(item.isRecurring, scopeForRow(item));
}

/** A generated series occurrence strictly after the caller's wall-clock day. */
export function isFutureRecurringOccurrence(item: AgendaItem, today: string): boolean {
  if (!item.isRecurring) return false;
  const scope = scopeForRow(item);
  return scope.kind === 'occurrence' && scope.date > today;
}
