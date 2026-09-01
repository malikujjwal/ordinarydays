import { type QueryClient, useQuery } from '@tanstack/react-query';

/** Cross-feature cache key for the web Plans/Updates monotonic ordering seam. */
export const PLAN_ACTIVITY_FLOORS_KEY = ['plans', 'activity-floors'] as const;

/**
 * The web client's floor under each Plan's `lastActivityAt` (P3-40).
 *
 * The Updates acknowledgement is authoritative while the Plans GSI can briefly answer with
 * older data. Keeping the floor in the shared query client makes that fact available across
 * the detail and Plans screens, and prevents a stale refetch from lowering it.
 */
export type PlanActivityFloors = Readonly<Record<string, string>>;

export function usePlanActivityFloors(
  _activityIds?: readonly string[],
): PlanActivityFloors {
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
