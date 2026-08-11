import type { AgendaQuery } from '@od/shared/schemas';

/** The exact product-owned include set for a Today-screen agenda request. */
export const TODAY_AGENDA_INCLUDE = 'anytime_unscheduled,overdue' as const;

/**
 * The sole agenda query-key constructor.
 *
 * Every wire parameter participates, including the absence of `include`, so Today and a
 * Plans window can never alias even when their dates happen to match.
 */
export function agendaKey(
  from: AgendaQuery['from'],
  to: AgendaQuery['to'],
  tz: AgendaQuery['tz'],
  include: AgendaQuery['include'],
) {
  return ['agenda', from, to, tz, include ?? null] as const;
}
