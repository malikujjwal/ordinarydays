import type { AgendaData, AgendaItem } from '@od/shared/types';
import {
  type AgendaMutationTarget,
  type AgendaProjectionClock,
  findAgendaItem,
  replaceAgendaItem,
} from './applyCompletion';

export interface RescheduleProjectionVariables
  extends AgendaMutationTarget,
    AgendaProjectionClock {
  date: string | null;
  time?: string;
  endTime?: string;
  /** Durable Activity fallback when the paged Anytime item was never in retained Agenda rows. */
  fallbackItem?: AgendaItem;
}

/** Projects the sole schedule write path for one-offs and recurring occurrences. */
export function applyReschedule(
  agenda: AgendaData,
  variables: RescheduleProjectionVariables,
): AgendaData {
  const found = findAgendaItem(agenda, variables);
  const source = found?.item ?? variables.fallbackItem;
  if (source === undefined) return agenda;
  const destinationDate = variables.date ?? variables.today;

  const next: AgendaItem = {
    ...source,
    status:
      source.status === 'completed' || source.status === 'skipped'
        ? source.status
        : variables.date === null
          ? 'saved'
          : 'scheduled',
    isPast: false,
    ...(variables.time === undefined ? {} : { time: variables.time }),
    ...(variables.endTime === undefined ? {} : { endTime: variables.endTime }),
  };
  if (variables.time === undefined) delete next.time;
  if (variables.endTime === undefined) delete next.endTime;
  // The old date is no longer overdue once the schedule itself has been replaced. Keeping this
  // marker makes Plans correctly treat the moved row as a Today-only copy and hide it.
  delete next.overdueFromDate;

  /**
   * **A reschedule ends the snooze, so the glyph and the arrow go with it.**
   *
   * `today-and-tasks.md` §5.3 renders a snoozed row with a snooze glyph and its original time
   * de-emphasised — `6:00 PM → 8:00 PM`. Once the schedule itself moves there is no original
   * time left to contrast against: the affix would be describing a schedule that no longer
   * exists. The server clears the underlying snooze on the same write; this is the same fact
   * projected, so the row stops claiming it immediately rather than at the next refetch.
   */
  next.isSnoozed = false;
  delete next.originalTime;
  next.isPast =
    variables.date !== null &&
    (variables.date < variables.today ||
      (variables.date === variables.today &&
        next.time !== undefined &&
        (next.endTime ?? next.time) <= variables.currentMinute));

  return replaceAgendaItem(
    agenda,
    variables,
    next,
    destinationDate,
    variables,
    variables.fallbackItem !== undefined || variables.date === null,
  );
}
