import {
  completeActivity,
  convertRecurrence,
  createActivity,
  createReminder,
  deleteActivityForReplay,
  deleteReminderForReplay,
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
  ConvertRecurrenceInput,
  CreateActivityInput,
  PatchActivityInput,
  ReminderInput,
  ScheduleActivityInput,
  SkipActivityInput,
  SnoozeActivityInput,
  UncompleteActivityInput,
  UnsnoozeActivityInput,
} from '@od/shared/schemas';
import type { AgendaData } from '@od/shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { projectPendingActivityCreate } from '@/lib/agendaCache';
import { apiClient } from '@/lib/apiClient';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { activityKey } from '@/lib/queryKeys';

export interface CreateActivityVariables {
  input: CreateActivityInput;
  idempotencyKey: string;
}

const AGENDA_QUERY_KEY = ['agenda'] as const;

interface CreateProjectionContext {
  previous: Array<[readonly unknown[], AgendaData | undefined]>;
  seededKey?: readonly unknown[];
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
  intentId: string;
}

export interface PatchActivityVariables {
  activityId: string;
  /** Stable logical-write identity retained across transport retries and settlement. */
  intentId: string;
  input: PatchActivityInput;
  ifMatch: string;
  /** Human-readable field names retained so one resumed-conflict banner can name them. */
  changeNames: string[];
}

export type ScheduleActivityVariables = ActivityPostVariables<ScheduleActivityInput>;
export type CompleteActivityVariables = ActivityPostVariables<CompleteActivityInput>;
export type ConvertRecurrenceVariables = ActivityPostVariables<{
  selectedDate: ConvertRecurrenceInput[keyof ConvertRecurrenceInput];
}>;
export type UncompleteActivityVariables = ActivityPostVariables<UncompleteActivityInput>;
export type SkipActivityVariables = ActivityPostVariables<SkipActivityInput>;
export type SnoozeActivityVariables = ActivityPostVariables<SnoozeActivityInput>;
export type UnsnoozeActivityVariables = ActivityPostVariables<UnsnoozeActivityInput>;
export type ReminderCreateVariables = ActivityPostVariables<ReminderInput>;

export interface ReminderDeleteVariables {
  activityId: string;
  reminderId: string;
  intentId: string;
}

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
 * Marks every cached detail projection for one Activity stale without refetching it in place.
 *
 * Occurrence detail has its own key (`['activity', id, 'occurrence', date]`), so updating only
 * `['activity', id]` leaves a previously opened occurrence looking current for the full
 * 60-second stale window. Prefix invalidation covers the series and every occurrence. It uses
 * `refetchType: 'none'` because the mutation's mounted caller writes its exact response into
 * the open detail; starting another request here creates a cancellable fetch just as a sheet
 * or screen is closing. Inactive variants refetch normally the next time they are opened.
 *
 * Delete is invalidated by the same no-refetch path. That prevents browser-back or a stale
 * deep link from treating the deleted detail as fresh without destroying or cancelling the
 * query while its screen is navigating away.
 */
export function refreshActivityDetails(
  client: QueryClient,
  mutationKey: unknown,
  variables: unknown,
): boolean {
  if (!Array.isArray(mutationKey)) return false;
  const [scope, name] = mutationKey as readonly unknown[];
  /**
   * A create refreshes nothing about itself — the id is new — but a **prep-task** create
   * (P3-38) changes its parent's detail: the PREP section is projected from the `SUB#`
   * pointer the same transaction wrote, and the plan screen is still mounted behind the
   * compose modal. The detail read is a strongly consistent partition read, so an immediate
   * refetch cannot lose the race the agenda's `refetchType: 'none'` exists for.
   */
  if (scope === 'activity' && name === 'create') {
    const parentActivityId = (
      variables as { input?: { parentActivityId?: unknown } } | undefined
    )?.input?.parentActivityId;
    if (typeof parentActivityId === 'string') {
      void client.invalidateQueries({ queryKey: activityKey(parentActivityId) });
      return true;
    }
    return false;
  }
  if (scope !== 'activity' || name === 'duplicate') {
    return false;
  }
  if (typeof variables !== 'object' || variables === null) return false;
  const activityId = (variables as { activityId?: unknown }).activityId;
  if (typeof activityId !== 'string') return false;

  void client.invalidateQueries({
    queryKey: activityKey(activityId),
    refetchType: 'none',
  });
  return true;
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
 * The web `MutationCache` outlives every component and screen for the life of the process.
 *
 * Every activity mutation key is `['activity', <name>]`. Reminder writes leave lists and
 * agenda windows untouched.
 */
export function changesActivityLists(mutationKey: unknown): boolean {
  if (!Array.isArray(mutationKey)) return false;
  const [scope, name] = mutationKey as readonly unknown[];
  // The bridge is a `list` key that creates an Activity (P3-34): the new plan lands in the
  // activity lists and the agenda exactly as a create does. `projectActivityWrite` no-ops on
  // the key — its response shape is the bridge's, not an Activity envelope — so this buys the
  // stale-marking only, which the next natural refetch reconciles.
  if (scope === 'list' && name === 'item-schedule') return true;
  return scope === 'activity' && name !== 'reminder-create' && name !== 'reminder-delete';
}

/** Registers the process-wide web mutation functions and optimistic handlers. */
export function registerActivityMutationDefaults(
  client: QueryClient,
  httpClient: HttpClient = apiClient,
): void {
  client.setMutationDefaults(activityMutationKeys.create, {
    onMutate: (variables: CreateActivityVariables) => {
      const previous = client.getQueriesData<AgendaData>({ queryKey: AGENDA_QUERY_KEY });
      const projection = projectPendingActivityCreate(client, variables);
      return {
        previous,
        ...(projection.seededKey === undefined
          ? {}
          : { seededKey: projection.seededKey }),
      } satisfies CreateProjectionContext;
    },
    onError: (
      _error,
      _variables: CreateActivityVariables,
      context: CreateProjectionContext | undefined,
    ) => {
      if (context === undefined) return;
      for (const [key, agenda] of context.previous) client.setQueryData(key, agenda);
      if (context.seededKey !== undefined) {
        client.removeQueries({ queryKey: context.seededKey, exact: true });
      }
    },
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
  });
  client.setMutationDefaults(activityMutationKeys.patch, {
    mutationFn: ({ activityId, input, ifMatch }: PatchActivityVariables) =>
      patchActivityForReplay(httpClient, activityId, input, ifMatch),
  });
  client.setMutationDefaults(activityMutationKeys.convertRecurrence, {
    mutationFn: ({ activityId, input, idempotencyKey }: ConvertRecurrenceVariables) =>
      convertRecurrence(httpClient, activityId, input.selectedDate, idempotencyKey),
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
  });
  client.setMutationDefaults(activityMutationKeys.reminderDelete, {
    mutationFn: ({ activityId, reminderId }: ReminderDeleteVariables) =>
      deleteReminderForReplay(httpClient, activityId, reminderId),
  });
}
