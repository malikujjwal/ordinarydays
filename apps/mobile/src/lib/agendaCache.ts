import { type Instant, type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { Activity, AgendaData, User } from '@od/shared/types';
import type { MutationKey, QueryClient } from '@tanstack/react-query';
import { applyCreate } from '@/features/agenda/model/applyCreate';
import { applyReschedule } from '@/features/agenda/model/applyReschedule';

const AGENDA_KEY = ['agenda'] as const;

/**
 * Writes a server-confirmed activity into the cached agenda windows (P2-46).
 *
 * **The problem this solves.** The agenda is served from `GSI1`, and a global secondary index
 * is eventually consistent — a consistent read on one does not exist. Invalidating the agenda
 * after a write fires a refetch within tens of milliseconds, which races the index write and
 * frequently loses. The server answers `200` with pre-write data, the client caches it, and
 * nothing retries, so Today shows a stale day until something else invalidates. Measured on a
 * local create: `201` at +1922 ms, refetch issued at +1967 ms, and the row absent from a
 * response the API served correctly six seconds later.
 *
 * Invalidation alone therefore cannot be the mechanism that makes a write reach Today; it can
 * only be the reconciliation behind one. Completing and snoozing never had this bug precisely
 * because they project into the cache first and treat the refetch as confirmation.
 *
 * Everything here is projected from the **server's response**, so there is no rollback path
 * and no invented identifier: by the time this runs the write is durable and its canonical
 * shape is known. Each projection is idempotent, so a refetch that did win the race cannot
 * produce a duplicate row.
 */
export function projectActivityWrite(
  client: QueryClient,
  mutationKey: MutationKey | undefined,
  data: unknown,
): void {
  const name = Array.isArray(mutationKey) ? mutationKey[1] : undefined;
  const activity = activityFrom(data);
  if (activity === undefined) return;

  const timezone = (client.getQueryData<User>(['me'])?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone;
  const now = new Date().toISOString() as Instant;
  const clock = {
    today: toWallDate(now, timezone),
    currentMinute: toWallTime(now, timezone),
  };

  if (name === 'create' || name === 'duplicate') {
    update(client, (agenda) => applyCreate(agenda, { activity, ...clock }));
    return;
  }

  if (name === 'schedule') {
    const date = activity.schedule?.date ?? null;
    update(client, (agenda) =>
      applyReschedule(agenda, {
        activityId: activity.activityId,
        date,
        ...(activity.schedule?.time === undefined
          ? {}
          : { time: activity.schedule.time }),
        ...(activity.schedule?.endTime === undefined
          ? {}
          : { endTime: activity.schedule.endTime }),
        ...clock,
      }),
    );
  }
}

/** Both a bare Activity and a `{ activity }` envelope reach this from different endpoints. */
function activityFrom(data: unknown): Activity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return 'activityId' in candidate ? (candidate as Activity) : undefined;
}

function update(client: QueryClient, project: (agenda: AgendaData) => AgendaData): void {
  client.setQueriesData<AgendaData>({ queryKey: AGENDA_KEY }, (agenda) =>
    agenda === undefined ? agenda : project(agenda),
  );
}
