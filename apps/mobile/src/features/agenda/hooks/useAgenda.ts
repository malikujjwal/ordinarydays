import { getAgenda, getMe } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { type Instant, type TimeZone, toWallDate } from '@od/shared/time';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useClock } from '@/hooks/useClock';
import { guardAgendaResponse } from '@/lib/agendaCache';
import { apiClient } from '@/lib/apiClient';
import { agendaKey, TODAY_AGENDA_INCLUDE } from '../keys';

const ME_QUERY_KEY = ['me'] as const;

export interface AgendaWindow {
  from: AgendaQuery['from'];
  to: AgendaQuery['to'];
  include?: AgendaQuery['include'];
}

export interface UseAgendaOptions {
  /** Absent with no `days` means the product-owned Today request. */
  window?: AgendaWindow;
  /** An inclusive window beginning today. Plans supplies the endpoint's 62-day maximum. */
  days?: number;
  /** The P2-20 minute ticker supplies this value so crossing midnight changes the key. */
  now?: Instant;
}

/** The one hook used by Today and by every multi-day agenda consumer. */
export function useAgenda(options: UseAgendaOptions = {}) {
  const queryClient = useQueryClient();
  const clock = useClock();
  // Observe the existing profile query without starting a second screen-owned request.
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });
  const timezone = (me.data?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone;
  const today =
    options.now === undefined
      ? clock.todayIn(timezone)
      : toWallDate(options.now, timezone);
  const request: AgendaQuery =
    options.window !== undefined
      ? {
          from: options.window.from,
          to: options.window.to,
          tz: timezone,
          ...(options.window.include === undefined
            ? {}
            : { include: options.window.include }),
        }
      : options.days === undefined
        ? {
            from: today,
            to: today,
            tz: timezone,
            include: TODAY_AGENDA_INCLUDE,
          }
        : {
            from: today,
            to: addWallDays(today, options.days - 1),
            tz: timezone,
          };

  const queryKey = agendaKey(request.from, request.to, request.tz, request.include);
  const agenda = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      guardAgendaResponse(
        queryClient,
        queryKey,
        await getAgenda(apiClient, request, signal),
      ),
  });
  const refetch = agenda.refetch;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);

  return { ...agenda, timezone };
}
