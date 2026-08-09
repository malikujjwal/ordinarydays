import type { ActivityListQuery } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { listActivities } from '../services/activityService.js';

/**
 * `GET /v1/activities?filter=` (`api-contract.md` §2.2).
 *
 * Flat, paginated stages — **not Today**. Each filter reads one GSI1 bucket, so a page is one
 * Query and one cursor, and nothing is expanded: a recurring series is one row carrying
 * `isRecurring`, not one row per occurrence.
 *
 * ## Which day "today" is
 *
 * `upcoming` and `past` split the scheduled bucket at the caller's current date, so the
 * server has to know what date that is. `X-Client-Timezone` is the documented header for
 * exactly this — "IANA tz. Used when the body omits one" (`api-contract.md` §1) — and a `GET`
 * has no body to carry one. Absent or unusable, it falls back to UTC rather than failing: a
 * list that is a few hours out at the boundary is a far better answer than no list, and the
 * only rows affected are ones dated today.
 *
 * The profile's `timezone` would be the other candidate. It is deliberately not read here:
 * that is a second round trip on every list request to answer a question the client already
 * knows, and a user travelling wants the list for where they are.
 */
export const LIST_ACTIVITIES_PATH = '/';

/**
 * The caller's current date, as `YYYY-MM-DD`.
 *
 * `en-CA` because its short date format *is* ISO — `2026-08-09` — so no reassembly from
 * parts is needed and no locale can reorder it. An unknown or malformed zone makes
 * `Intl.DateTimeFormat` throw; that is caught rather than propagated, for the reason above.
 */
export function localToday(now: Date, timezone: string | undefined): string {
  if (timezone === undefined || timezone === '') return utcDate(now);

  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return utcDate(now);
  }
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function listActivitiesHandler(
  c: Context<AppEnv>,
  query: ActivityListQuery,
  now: Date,
): Promise<Response> {
  const page = await listActivities(
    requireUserId(c),
    query,
    localToday(now, c.req.header('X-Client-Timezone')),
  );

  return c.json({
    data: page.items,
    meta: {
      requestId: c.get('requestId'),
      /**
       * Present only when there is more. **A short page is not the end of the list** — the
       * `type` filter is applied after the Query, so a full page can come back nearly empty
       * with a cursor still set. A client that stops on a short page loses rows.
       */
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
  });
}
