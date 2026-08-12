import type { AgendaData } from '@od/shared/types';
import {
  type AgendaMutationTarget,
  type AgendaProjectionClock,
  findAgendaItem,
  replaceAgendaItem,
} from './applyCompletion';

export interface SkipProjectionVariables
  extends AgendaMutationTarget,
    AgendaProjectionClock {
  skipped: boolean;
}

/** Projects a one-off or recurring skip and its compensating uncomplete operation. */
export function applySkip(
  agenda: AgendaData,
  variables: SkipProjectionVariables,
): AgendaData {
  const found = findAgendaItem(agenda, variables);
  if (found === undefined) return agenda;
  const next = {
    ...found.item,
    status: variables.skipped
      ? variables.occurrenceDate === undefined
        ? ('skipped' as const)
        : ('skipped_occurrence' as const)
      : ('scheduled' as const),
  };
  return replaceAgendaItem(agenda, variables, next, found.sourceDate, variables);
}
