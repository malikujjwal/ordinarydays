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

function refreshActivityLists(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ACTIVITY_LIST_KEY });
  void client.invalidateQueries({ queryKey: AGENDA_KEY });
}

/** Registers every function a dehydrated mutation can need after its component is gone. */
export function registerActivityMutationDefaults(
  client: QueryClient,
  httpClient: HttpClient = apiClient,
): void {
  client.setMutationDefaults(activityMutationKeys.create, {
    mutationFn: ({ input, idempotencyKey }: CreateActivityVariables) =>
      createActivity(httpClient, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.duplicate, {
    mutationFn: ({ activityId, idempotencyKey }: DuplicateActivityVariables) =>
      duplicateActivity(httpClient, activityId, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.delete, {
    mutationFn: ({ activityId }: DeleteActivityVariables) =>
      deleteActivityForReplay(httpClient, activityId),
    onSuccess: (_data, { activityId }: DeleteActivityVariables) => {
      client.removeQueries({ queryKey: ['activity', activityId] });
      refreshActivityLists(client);
    },
  });
  client.setMutationDefaults(activityMutationKeys.patch, {
    mutationFn: ({ activityId, input, ifMatch }: PatchActivityVariables) =>
      patchActivityForReplay(httpClient, activityId, input, ifMatch),
    onSuccess: (activity) => {
      void client.invalidateQueries({ queryKey: ['activity', activity.activityId] });
      refreshActivityLists(client);
    },
  });
  client.setMutationDefaults(activityMutationKeys.schedule, {
    mutationFn: ({ activityId, input, idempotencyKey }: ScheduleActivityVariables) =>
      scheduleActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.complete, {
    mutationFn: ({ activityId, input, idempotencyKey }: CompleteActivityVariables) =>
      completeActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.uncomplete, {
    mutationFn: ({ activityId, input, idempotencyKey }: UncompleteActivityVariables) =>
      uncompleteActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.skip, {
    mutationFn: ({ activityId, input, idempotencyKey }: SkipActivityVariables) =>
      skipActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.snooze, {
    mutationFn: ({ activityId, input, idempotencyKey }: SnoozeActivityVariables) =>
      snoozeActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
  });
  client.setMutationDefaults(activityMutationKeys.unsnooze, {
    mutationFn: ({ activityId, input, idempotencyKey }: UnsnoozeActivityVariables) =>
      unsnoozeActivity(httpClient, activityId, input, idempotencyKey),
    onSuccess: () => refreshActivityLists(client),
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
