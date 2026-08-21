import { expandRecurrence } from '@od/shared/recurrence';
import { type CreateActivityInput, createActivityInput } from '@od/shared/schemas';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import type { Intent } from '@/lib/intent';

type WithoutOwner<T> = T extends Activity ? Omit<T, 'ownerId'> : never;

/** Local user-authored state. Server identity authority has not arrived yet. */
export type PendingActivity = WithoutOwner<Activity> & { readonly pending: true };

export type PendingActivityDetail = Omit<ActivityDetail, 'activity'> & {
  readonly activity: PendingActivity;
};

/** Builds the non-authoritative Activity shape used while its durable create is pending. */
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

/**
 * Reconstructs the detail view for an entity the server has not acknowledged yet.
 *
 * The create intent contains every user-authored field. No server read is useful here—the
 * expected server answer is 404 until replay succeeds—so pending detail renders from that
 * durable source and exposes no server-directed capabilities.
 */
export function pendingActivityDetailFromIntent(
  intent: Intent,
  target: ActivityDetailTarget,
): PendingActivityDetail | undefined {
  if (
    intent.entityId !== target.activityId ||
    intent.mutationKey[0] !== 'activity' ||
    intent.mutationKey[1] !== 'create' ||
    intent.status === 'acknowledged'
  ) {
    return undefined;
  }
  const rawInput = (intent.variables as { input?: unknown } | undefined)?.input;
  const parsed = createActivityInput.safeParse(rawInput);
  if (!parsed.success || parsed.data.activityId !== target.activityId) return undefined;

  const activity = pendingActivityFromInput(
    parsed.data,
    target.activityId,
    new Date(intent.createdAt).toISOString(),
  );
  const reminders = (parsed.data.reminders ?? []).flatMap((reminder) =>
    reminder.reminderId === undefined
      ? []
      : [
          {
            reminderId: reminder.reminderId,
            activityId: target.activityId,
            userId: intent.ownerUserId,
            offsetMinutes: reminder.offsetMinutes,
            channel: 'push' as const,
          },
        ],
  );
  let occurrence: OccurrenceDetailProjection | undefined;
  if (target.kind === 'occurrence') {
    const recurrence = activity.recurrence;
    const schedule = activity.schedule;
    if (
      recurrence === undefined ||
      schedule === undefined ||
      !expandRecurrence(recurrence, target.date, target.date, schedule.timezone).includes(
        target.date,
      )
    ) {
      return undefined;
    }
    const segment = [...recurrence.segments]
      .reverse()
      .find((candidate) => candidate.effectiveFrom <= target.date);
    const time = segment?.time ?? schedule.time;
    const endTime = segment?.endTime ?? schedule.endTime;
    occurrence = {
      nominalDate: target.date,
      date: target.date,
      ...(time === undefined ? {} : { time }),
      ...(endTime === undefined ? {} : { endTime }),
      status: 'scheduled',
      isSnoozed: false,
    };
  }

  return {
    activity,
    reminders,
    capabilities: { complete: false, skip: false, snooze: false },
    ...(occurrence === undefined ? {} : { occurrence }),
  };
}
