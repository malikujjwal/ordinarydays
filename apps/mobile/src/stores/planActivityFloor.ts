import { create } from 'zustand';

/**
 * The client's floor under each Plan's `lastActivityAt` (P3-40).
 *
 * `POST /v1/activities/:id/updates` answers with the authoritative `lastActivityAt`, but the
 * Plans tab's needs-a-date stage is read back through GSI1, which is eventually consistent —
 * a refetch issued after the post can answer with a projection **older than the write the
 * caller just made**, putting the row it just touched back where it was. This store keeps the
 * newest authoritative value the client has seen per activity, and `usePlans` merges
 * monotonically against it: a fetched row's `lastActivityAt` may only ever be raised to the
 * floor, never used to lower it. The floor loses nothing when it is stale — a fetched value
 * newer than the floor simply wins.
 *
 * A store rather than hook state because the write happens on the detail screen and the read
 * on the Plans tab: two mounted screens, one fact. Stores are composition points, so this is
 * also how the two features share it without importing each other.
 */
interface PlanActivityFloorState {
  readonly floors: Readonly<Record<string, string>>;
  /** Raises the floor; an older value than the current floor is ignored. */
  raise: (activityId: string, lastActivityAt: string) => void;
}

export const usePlanActivityFloor = create<PlanActivityFloorState>((set) => ({
  floors: {},
  raise: (activityId, lastActivityAt) =>
    set((state) => {
      const current = state.floors[activityId];
      // ISO-8601 UTC instants compare correctly as strings.
      if (current !== undefined && current >= lastActivityAt) return state;
      return { floors: { ...state.floors, [activityId]: lastActivityAt } };
    }),
}));
