import type { AgendaData, AgendaItem } from '@od/shared/types';
import {
  type AgendaMutationTarget,
  type AgendaProjectionClock,
  findAgendaItem,
  replaceAgendaItem,
} from './applyCompletion';

interface SnoozeBase extends AgendaMutationTarget, AgendaProjectionClock {
  /** Viewer-local destination date/time, derived once by the mutation caller. */
  date: string;
}

export type SnoozeProjectionVariables = SnoozeBase &
  ({ snoozed: true; time: string } | { snoozed: false; time?: never });

function snoozedItem(item: AgendaItem, time: string): AgendaItem {
  const originalTime = item.originalTime ?? item.time;
  const next: AgendaItem = {
    ...item,
    time,
    isSnoozed: true,
    ...(originalTime === undefined || originalTime === time ? {} : { originalTime }),
  };
  if (originalTime === time) delete next.originalTime;
  return next;
}

function unsnoozedItem(item: AgendaItem): AgendaItem {
  const next: AgendaItem = {
    ...item,
    ...(item.originalTime === undefined ? {} : { time: item.originalTime }),
    isSnoozed: false,
  };
  delete next.originalTime;
  return next;
}

/** Projects snooze/unsnooze after the caller converts an instant to viewer wall time. */
export function applySnooze(
  agenda: AgendaData,
  variables: SnoozeProjectionVariables,
): AgendaData {
  const found = findAgendaItem(agenda, variables);
  if (found === undefined) return agenda;
  const next = variables.snoozed
    ? snoozedItem(found.item, variables.time)
    : unsnoozedItem(found.item);
  next.isPast =
    variables.date < variables.today ||
    (variables.date === variables.today &&
      next.time !== undefined &&
      (next.endTime ?? next.time) <= variables.currentMinute);
  return replaceAgendaItem(agenda, variables, next, variables.date, variables);
}
