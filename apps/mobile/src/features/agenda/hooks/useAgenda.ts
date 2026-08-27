import { getMe } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { type Instant, toWallDate } from '@od/shared/time';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useClock } from '@/hooks/useClock';
import { loadAgendaWithReconciliation } from '@/lib/agendaCache';
import { apiClient } from '@/lib/apiClient';
import { resolveViewerTimezone } from '@/lib/viewerTimezone';
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
  /** Native-only narrow-read hint; web query invalidation is already cache-coalesced. */
  incrementalLocalTargetReconciliation?: boolean;
}

/** The one hook used by Today and by every multi-day agenda consumer. */
export function useAgenda(options: UseAgendaOptions = {}) {
  const queryClient = useQueryClient();
  const clock = useClock();
  // Observe the existing profile query without starting a second screen-owned request.
  useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });
  const timezone = resolveViewerTimezone(queryClient);
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
            /**
             * **Two days, one request** (P2-45). Today's window reaches tomorrow so the
             * look-ahead at the foot of the screen comes out of the same response — Today is the
             * most loaded screen in the product, and a second query would mean a second cache
             * entry and a second `ETag` for one section.
             *
             * The `include` tokens stay day-scoped by construction: the server pins an undated
             * task to `input.from` and a rolled-forward overdue task to *today*
             * (`agendaService.ts`), and `partitionDays` files each candidate under exactly one
             * `viewerDate`. So widening the window cannot make either appear twice, and the
             * client needs no de-duplication of its own — which is the thing P2-45 said to
             * establish before writing anything.
             *
             * The query key carries the window, so the first launch after this ships refetches.
             * That is expected, not a cache bug.
             */
            from: today,
            to: addWallDays(today, 1),
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
    queryFn: ({ signal }) =>
      loadAgendaWithReconciliation(queryClient, queryKey, request, signal),
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
