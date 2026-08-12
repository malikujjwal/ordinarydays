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
}

/** Projects the sole schedule write path for one-offs and recurring occurrences. */
export function applyReschedule(
  agenda: AgendaData,
  variables: RescheduleProjectionVariables,
): AgendaData {
  const found = findAgendaItem(agenda, variables);
  if (found === undefined) return agenda;
  const destinationDate = variables.date ?? agenda.days[0]?.date;
  if (destinationDate === undefined) return agenda;

  const next: AgendaItem = {
    ...found.item,
    status:
      found.item.status === 'completed' || found.item.status === 'skipped'
        ? found.item.status
        : variables.date === null
          ? 'saved'
          : 'scheduled',
    isPast: false,
    ...(variables.time === undefined ? {} : { time: variables.time }),
    ...(variables.endTime === undefined ? {} : { endTime: variables.endTime }),
  };
  if (variables.time === undefined) delete next.time;
  if (variables.endTime === undefined) delete next.endTime;
  if (variables.date === null) delete next.overdueFromDate;
  next.isPast =
    variables.date !== null &&
    (variables.date < variables.today ||
      (variables.date === variables.today &&
        next.time !== undefined &&
        (next.endTime ?? next.time) <= variables.currentMinute));

  return replaceAgendaItem(agenda, variables, next, destinationDate, variables);
}
