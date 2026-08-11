import { getAgenda, getMe } from '@od/shared/client';
import type { AgendaQuery } from '@od/shared/schemas';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { apiClient } from '@/lib/apiClient';
import { agendaKey, TODAY_AGENDA_INCLUDE } from '../keys';

const ME_QUERY_KEY = ['me'] as const;

export interface AgendaWindow {
  from: AgendaQuery['from'];
  to: AgendaQuery['to'];
  include?: AgendaQuery['include'];
}

export interface UseAgendaOptions {
  /** Absent means the product-owned Today request; supplied means a parameterised window. */
  window?: AgendaWindow;
  /** The P2-20 minute ticker supplies this value so crossing midnight changes the key. */
  now?: Date;
}

/** Derives a stable `YYYY-MM-DD` in a named zone without using the host's local day. */
function wallDateAt(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('The device could not derive the current calendar date.');
  }
  return `${year}-${month}-${day}`;
}

/** The one hook used by Today and by every multi-day agenda consumer. */
export function useAgenda(options: UseAgendaOptions = {}) {
  // Observe the existing profile query without starting a second screen-owned request.
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });
  const timezone = me.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = wallDateAt(options.now ?? new Date(), timezone);
  const request: AgendaQuery =
    options.window === undefined
      ? {
          from: today,
          to: today,
          tz: timezone,
          include: TODAY_AGENDA_INCLUDE,
        }
      : {
          from: options.window.from,
          to: options.window.to,
          tz: timezone,
          ...(options.window.include === undefined
            ? {}
            : { include: options.window.include }),
        };

  const agenda = useQuery({
    queryKey: agendaKey(request.from, request.to, request.tz, request.include),
    queryFn: ({ signal }) => getAgenda(apiClient, request, signal),
  });
  const refetch = agenda.refetch;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);

  return agenda;
}
