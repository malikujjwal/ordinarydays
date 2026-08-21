import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity } from '@od/shared/types';

type WithoutOwner<T> = T extends Activity ? Omit<T, 'ownerId'> : never;

/** Local user-authored state. Server identity authority has not arrived yet. */
export type PendingActivity = WithoutOwner<Activity> & { readonly pending: true };

/** Builds the non-authoritative Activity shape stored by a native SQLite create transaction. */
export function pendingActivityFromInput(
  input: CreateActivityInput,
  activityId: string,
  mintedAt: string,
): PendingActivity {
  const common = {
    activityId,
    pending: true,
    status: input.schedule === undefined ? 'saved' : 'scheduled',
    title: input.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.schedule === undefined
      ? {}
      : { schedule: input.schedule as NonNullable<Activity['schedule']> }),
    ...(input.recurrence === undefined
      ? {}
      : { recurrence: input.recurrence as NonNullable<Activity['recurrence']> }),
    ...(input.location === undefined
      ? {}
      : { location: input.location as NonNullable<Activity['location']> }),
    ...(input.parentActivityId === undefined
      ? {}
      : { parentActivityId: input.parentActivityId }),
    // The input schema permits explicit `undefined` on optional nested authoring fields;
    // persistence strips those keys, yielding the exact stored ActivityDetails shape.
    details: (input.details ?? { kind: input.type }) as Activity['details'],
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: mintedAt,
    lastActivityAt: mintedAt,
    updatedAt: mintedAt,
    schemaVersion: 1,
  } as const;
  return input.objectKind === 'task'
    ? { ...common, objectKind: 'task', type: 'task' }
    : { ...common, objectKind: 'plan', type: input.type };
}
