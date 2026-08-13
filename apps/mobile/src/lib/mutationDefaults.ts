import {
  completeActivity,
  createActivity,
  createReminder,
  deleteActivityForReplay,
  duplicateActivity,
  type HttpClient,
  patchActivityForReplay,
  scheduleActivity,
  skipActivity,
  snoozeActivity,
  uncompleteActivity,
  unsnoozeActivity,
} from '@od/shared/client';
import type {
  CompleteActivityInput,
  CreateActivityInput,
  PatchActivityInput,
  ReminderInput,
  ScheduleActivityInput,
  SkipActivityInput,
  SnoozeActivityInput,
  UncompleteActivityInput,
  UnsnoozeActivityInput,
} from '@od/shared/schemas';
import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { activityMutationKeys } from '@/lib/mutationKeys';

export interface CreateActivityVariables {
  input: CreateActivityInput;
  idempotencyKey: string;
}

export interface ActivityPostVariables<TInput> {
  activityId: string;
  input: TInput;
  idempotencyKey: string;
}

export interface DuplicateActivityVariables {
  activityId: string;
  idempotencyKey: string;
}

export interface DeleteActivityVariables {
  activityId: string;
}

export interface PatchActivityVariables {
  activityId: string;
  input: PatchActivityInput;
  ifMatch: string;
  /** Human-readable field names retained so one resumed-conflict banner can name them. */
  changeNames: string[];
}

export type ScheduleActivityVariables = ActivityPostVariables<ScheduleActivityInput>;
export type CompleteActivityVariables = ActivityPostVariables<CompleteActivityInput>;
export type UncompleteActivityVariables = ActivityPostVariables<UncompleteActivityInput>;
export type SkipActivityVariables = ActivityPostVariables<SkipActivityInput>;
export type SnoozeActivityVariables = ActivityPostVariables<SnoozeActivityInput>;
export type UnsnoozeActivityVariables = ActivityPostVariables<UnsnoozeActivityInput>;
export type ReminderCreateVariables = ActivityPostVariables<ReminderInput>;

const ACTIVITY_LIST_KEY = ['activities'] as const;
const AGENDA_KEY = ['agenda'] as const;

/**
 * Everything a successful activity write makes stale.
 *
 * The **root** keys, not one window: a write lands in whichever agenda windows its date
 * implies, and no caller has any business working out which.
 *
 * Called from exactly one place — the `MutationCache`'s `onSuccess` in `queryClient.ts`
 * (P2-46). Not from a component's `onSuccess`, and not from a per-key default. See
 * `changesActivityLists` below for why.
 */
export function refreshActivityLists(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ACTIVITY_LIST_KEY });
  /**
   * **`refetchType: 'none'` is the whole point — do not "fix" this by removing it.**
   *
   * The agenda is read from `GSI1`, and a global secondary index is eventually consistent. A
   * refetch issued in the milliseconds after a write races that index and usually loses: the
   * server answers `200` with pre-write data and the client caches it, discarding whatever the
   * client had just projected. Measured locally: `201` at +1922 ms, refetch at +1967 ms, row
   * absent from a response the API served correctly six seconds later.
   *
   * So the agenda is marked **stale without refetching**. The client already holds the truth —
   * either the server's own response (create, duplicate, schedule) or an optimistic projection
   * (complete, skip, snooze) — and the next natural refetch on remount, foreground or staleTime
   * expiry reconciles against an index that has long since caught up.
   */
  void client.invalidateQueries({ queryKey: AGENDA_KEY, refetchType: 'none' });
}

/**
 * Whether a successful mutation changes what a list or an agenda window contains.
 *
 * **Why this lives on the `MutationCache` and not on the mutations themselves (P2-46).** A
 * component's `onSuccess` is bound to that component's observer, so it never runs once the
 * component has gone — and the two writes that most need to refresh Today are precisely the
 * two that close their own surface on success: compose unmounts on save, and the reschedule
 * sheet unmounts when it closes. Attaching the refresh there puts it in the one place it
 * cannot fire. Completing or snoozing from a Today row always worked for the same reason
 * inverted: nothing unmounts, so the handler survives long enough to run.
 *
 * The `MutationCache` outlives every component and every screen, and it also covers mutations
 * replayed from the offline queue after a restart, which have no component at all.
 *
 * Every activity mutation key is `['activity', <name>]`. Only a reminder leaves lists and
 * agenda windows untouched.
 */
export function changesActivityLists(mutationKey: unknown): boolean {
  if (!Array.isArray(mutationKey)) return false;
  const [scope, name] = mutationKey as readonly unknown[];
  return scope === 'activity' && name !== 'reminder-create';
}

/** Registers every function a dehydrated mutation can need after its component is gone. */
export function registerActivityMutationDefaults(
  client: QueryClient,
  httpClient: HttpClient = apiClient,
): void {
  client.setMutationDefaults(activityMutationKeys.create, {
    mutationFn: ({ input, idempotencyKey }: CreateActivityVariables) =>
      createActivity(httpClient, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.duplicate, {
    mutationFn: ({ activityId, idempotencyKey }: DuplicateActivityVariables) =>
      duplicateActivity(httpClient, activityId, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.delete, {
    mutationFn: ({ activityId }: DeleteActivityVariables) =>
      deleteActivityForReplay(httpClient, activityId),
    onSuccess: (_data, { activityId }: DeleteActivityVariables) => {
      client.removeQueries({ queryKey: ['activity', activityId] });
    },
  });
  client.setMutationDefaults(activityMutationKeys.patch, {
    mutationFn: ({ activityId, input, ifMatch }: PatchActivityVariables) =>
      patchActivityForReplay(httpClient, activityId, input, ifMatch),
    onSuccess: (activity) => {
      void client.invalidateQueries({ queryKey: ['activity', activity.activityId] });
    },
  });
  client.setMutationDefaults(activityMutationKeys.schedule, {
    mutationFn: ({ activityId, input, idempotencyKey }: ScheduleActivityVariables) =>
      scheduleActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.complete, {
    mutationFn: ({ activityId, input, idempotencyKey }: CompleteActivityVariables) =>
      completeActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.uncomplete, {
    mutationFn: ({ activityId, input, idempotencyKey }: UncompleteActivityVariables) =>
      uncompleteActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.skip, {
    mutationFn: ({ activityId, input, idempotencyKey }: SkipActivityVariables) =>
      skipActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.snooze, {
    mutationFn: ({ activityId, input, idempotencyKey }: SnoozeActivityVariables) =>
      snoozeActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.unsnooze, {
    mutationFn: ({ activityId, input, idempotencyKey }: UnsnoozeActivityVariables) =>
      unsnoozeActivity(httpClient, activityId, input, idempotencyKey),
  });
  client.setMutationDefaults(activityMutationKeys.reminderCreate, {
    mutationFn: ({ activityId, input, idempotencyKey }: ReminderCreateVariables) =>
      createReminder(httpClient, activityId, input, idempotencyKey),
    onSuccess: (_data, { activityId }: ReminderCreateVariables) => {
      void client.invalidateQueries({ queryKey: ['activity', activityId] });
    },
  });
}

const PATCH_LABELS: Record<keyof PatchActivityInput, string> = {
  title: 'Title',
  notes: 'Notes',
  recurrence: 'Repeat',
  editedFromDate: 'Repeat',
  location: 'Location',
  details: 'Details',
  sourceUrl: 'Link',
  parentActivityId: 'Prep task',
  status: 'Status',
  objectKind: 'Plan type',
  type: 'Plan type',
};

export function patchChangeNames(input: PatchActivityInput): string[] {
  return [
    ...new Set(
      (Object.keys(input) as Array<keyof PatchActivityInput>).map(
        (field) => PATCH_LABELS[field],
      ),
    ),
  ];
}
