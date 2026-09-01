import { type QueryClient, useQuery } from '@tanstack/react-query';

/**
 * The client's floor under each Plan's `lastActivityAt` (P3-40).
 *
 * `POST /v1/activities/:id/updates` answers with the authoritative `lastActivityAt`, but the
 * Plans tab's needs-a-date stage is read back through GSI1, which is eventually consistent —
 * a refetch issued after the post can answer with a projection **older than the write the
 * caller just made**, putting the row it just touched back where it was. This cache entry keeps the
 * newest authoritative value the client has seen per activity, and `usePlans` merges
 * monotonically against it: a fetched row's `lastActivityAt` may only ever be raised to the
 * floor, never used to lower it. The floor loses nothing when it is stale — a fetched value
 * newer than the floor simply wins.
 *
 * TanStack rather than component state because the write happens on the detail screen and the
 * read on the Plans tab: two mounted screens, one server-authored fact. The native adapter
 * persists the equivalent fence on the Activity row in SQLite.
 */
const PLAN_ACTIVITY_FLOORS_KEY = ['plans', 'activity-floors'] as const;

export type PlanActivityFloors = Readonly<Record<string, string>>;

export function usePlanActivityFloors(): PlanActivityFloors {
  return useQuery({
    queryKey: PLAN_ACTIVITY_FLOORS_KEY,
    queryFn: () => Promise.resolve<PlanActivityFloors>({}),
    initialData: {},
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }).data;
}

/** Raises one floor in TanStack's web cache; an older acknowledgement is a no-op. */
export function raisePlanActivityFloor(
  queryClient: QueryClient,
  activityId: string,
  lastActivityAt: string,
): void {
  queryClient.setQueryData<PlanActivityFloors>(
    PLAN_ACTIVITY_FLOORS_KEY,
    (current = {}) => {
      const held = current[activityId];
      return held !== undefined && held >= lastActivityAt
        ? current
        : { ...current, [activityId]: lastActivityAt };
    },
  );
}

export function readPlanActivityFloor(
  queryClient: QueryClient,
  activityId: string,
): string | undefined {
  return queryClient.getQueryData<PlanActivityFloors>(PLAN_ACTIVITY_FLOORS_KEY)?.[
    activityId
  ];
}
