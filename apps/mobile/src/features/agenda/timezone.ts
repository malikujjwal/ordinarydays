import type { TimeZone } from '@od/shared/time';
import type { User } from '@od/shared/types';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The viewer timezone used by every product-owned agenda window.
 *
 * Observe the already-cached profile without starting a request; before it loads, the device
 * zone is the documented fallback. Local projections call this same resolver so their query
 * keys cannot drift from `useAgenda` when an activity is scheduled in another timezone.
 */
export function resolveAgendaTimezone(client: QueryClient): TimeZone {
  return (client.getQueryData<User>(['me'])?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone;
}
