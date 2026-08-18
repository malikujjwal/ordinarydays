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
import { getActiveIntentLog } from '@/lib/intentReplay';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { activityKey } from '@/lib/queryKeys';

export interface CreateActivityVariables {
  input: CreateActivityInput;
  idempotencyKey: string;
}

interface CreateAcceptance {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const createAcceptances = new Map<string, CreateAcceptance>();
const AGENDA_QUERY_KEY = ['agenda'] as const;

interface CreateProjectionContext {
  previous: Array<[readonly unknown[], AgendaData | undefined]>;
  seededKey?: readonly unknown[];
}

export interface ActivityCreateAcceptance {
  readonly promise: Promise<void>;
  /** Stops retaining this compose surface if it unmounts before the boundary settles. */
  readonly dispose: () => void;
}

/** Only native sessions with an active durable log may acknowledge before the response. */
export function hasDurableActivityCreateQueue(): boolean {
  return getActiveIntentLog() !== undefined;
}

/**
 * Resolves once the create is durable and projected, without waiting for its network result.
 * The compose surface uses this boundary to dismiss immediately online or offline.
 */
export function waitForActivityCreateAcceptance(
  idempotencyKey: string,
): ActivityCreateAcceptance {
  let acceptance: CreateAcceptance;
  const promise = new Promise<void>((resolve, reject) => {
    acceptance = { resolve, reject };
    createAcceptances.set(idempotencyKey, acceptance);
  });
  return {
    promise,
    dispose: () => {
      if (createAcceptances.get(idempotencyKey) !== acceptance) return;
      createAcceptances.delete(idempotencyKey);
      // Nobody observes acceptance after its compose surface has gone; settle the waiter so
      // its suspended save closure can be collected as well.
      acceptance.resolve();
    },
  };
}

function acceptActivityCreate(idempotencyKey: string): void {
  const acceptance = createAcceptances.get(idempotencyKey);
  if (acceptance === undefined) return;
  try {
    acceptance.resolve();
  } finally {
    if (createAcceptances.get(idempotencyKey) === acceptance) {
      createAcceptances.delete(idempotencyKey);
    }
  }
}

function refuseActivityCreate(idempotencyKey: string, error: unknown): void {
  const acceptance = createAcceptances.get(idempotencyKey);
  if (acceptance === undefined) return;
  try {
    acceptance.reject(error);
  } finally {
    if (createAcceptances.get(idempotencyKey) === acceptance) {
      createAcceptances.delete(idempotencyKey);
    }
  }
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
  /** Stable logical-write identity retained across persistence, replay and settlement. */
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
  if (scope !== 'activity' || name === 'create' || name === 'duplicate') {
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
 * The `MutationCache` outlives every component and every screen, and it also covers mutations
 * replayed from the offline queue after a restart, which have no component at all.
 *
 * Every activity mutation key is `['activity', <name>]`. Reminder writes leave lists and
 * agenda windows untouched.
 */
export function changesActivityLists(mutationKey: unknown): boolean {
  if (!Array.isArray(mutationKey)) return false;
  const [scope, name] = mutationKey as readonly unknown[];
  return scope === 'activity' && name !== 'reminder-create' && name !== 'reminder-delete';
}

/** Registers every function a dehydrated mutation can need after its component is gone. */
export function registerActivityMutationDefaults(
  client: QueryClient,
  httpClient: HttpClient = apiClient,
): void {
  client.setMutationDefaults(activityMutationKeys.create, {
    onMutate: (variables: CreateActivityVariables) => {
      const previous = client.getQueriesData<AgendaData>({ queryKey: AGENDA_QUERY_KEY });
      const projection = projectPendingActivityCreate(client, variables);
      acceptActivityCreate(variables.idempotencyKey);
      return {
        previous,
        ...(projection.seededKey === undefined
          ? {}
          : { seededKey: projection.seededKey }),
      } satisfies CreateProjectionContext;
    },
    onError: (
      error,
      variables: CreateActivityVariables,
      context: CreateProjectionContext | undefined,
    ) => {
      refuseActivityCreate(variables.idempotencyKey, error);
      if (hasDurableActivityCreateQueue() || context === undefined) return;
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
