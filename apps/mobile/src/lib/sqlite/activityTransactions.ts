import { MAX_TITLE_LEN } from '@od/shared';
import type {
  CreateActivityInput,
  PatchActivityInput,
  ScheduleActivityInput,
} from '@od/shared/schemas';
import {
  activity as activitySchema,
  recurrence as recurrenceSchema,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  Activity,
  ActivityDetail,
  ActivityOutcome,
  AgendaData,
  AgendaItem,
  Recurrence,
  RecurrenceSegment,
  Reminder,
} from '@od/shared/types';
import {
  applyCompletion,
  projectDay,
  uniqueItems,
} from '@/features/agenda/model/applyCompletion';
import { applyCreate } from '@/features/agenda/model/applyCreate';
import { applyReschedule } from '@/features/agenda/model/applyReschedule';
import { applySkip } from '@/features/agenda/model/applySkip';
import { applySnooze } from '@/features/agenda/model/applySnooze';
import { pendingActivityFromInput } from '@/lib/pendingActivity';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type {
  OutboxAppendInput,
  OutboxIntent,
  OutboxRepository,
} from '@/lib/sqlite/outbox';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export interface ProjectionClock {
  readonly today: string;
  readonly currentMinute: string;
}

export interface ActivityCreateVariables {
  readonly input: CreateActivityInput;
  readonly idempotencyKey: string;
}

export interface ActivityPatchVariables {
  readonly activityId: string;
  readonly intentId: string;
  readonly input: PatchActivityInput;
  readonly ifMatch: string;
  readonly changeNames?: readonly string[];
}

export interface ActivityScheduleVariables {
  readonly activityId: string;
  readonly input: ScheduleActivityInput;
  readonly idempotencyKey: string;
}

export interface ActivityCompletionVariables {
  readonly activityId: string;
  readonly input: {
    readonly occurrenceDate?: string;
    readonly outcome?: ActivityOutcome;
  };
  readonly idempotencyKey: string;
}

export interface ActivitySnoozeVariables {
  readonly activityId: string;
  readonly input: { readonly occurrenceDate?: string; readonly until: string };
  readonly idempotencyKey: string;
}

export interface ActivityReminderVariables {
  readonly activityId: string;
  readonly idempotencyKey: string;
  readonly input: { readonly reminderId: string; readonly offsetMinutes: number };
}

export interface ActivityReminderDeleteVariables {
  readonly activityId: string;
  readonly reminderId: string;
  readonly intentId: string;
}

export interface TransactionalIntentResult {
  readonly kind: 'inserted' | 'existing';
  readonly intent: OutboxIntent;
}

export interface ActivityIdentityVariables {
  readonly activityId: string;
  readonly idempotencyKey?: string;
  readonly intentId?: string;
}

function variablesObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Durable activity variables are malformed.');
  }
  return value as Record<string, unknown>;
}

function mutation(
  name: string,
  intentId: string,
  entityId: string,
  variables: unknown,
  dependency?: {
    readonly dependsOnIntentId: string;
    readonly compensationForIntentId: string;
  },
): OutboxAppendInput {
  return {
    intentId,
    mutationKey: ['activity', name],
    variables,
    entityId,
    orderingKey: `activity:${entityId}`,
    ...(dependency === undefined ? {} : dependency),
  };
}

function updateAgendaActivity(data: AgendaData, activity: Activity): AgendaData {
  const update = (item: AgendaItem): AgendaItem => {
    if (item.activityId !== activity.activityId) return item;
    const noteExcerpt = activity.notes?.split(/\r?\n/, 1)[0]?.slice(0, 200);
    const { locationLabel: _locationLabel, noteExcerpt: _noteExcerpt, ...rest } = item;
    return {
      ...rest,
      title: activity.title,
      type: activity.type,
      ...(activity.location?.label === undefined
        ? {}
        : { locationLabel: activity.location.label }),
      ...(noteExcerpt === undefined ? {} : { noteExcerpt }),
    };
  };
  return {
    ...data,
    days: data.days.map((day) => ({
      ...day,
      schedule: day.schedule.map(update),
      anytime: day.anytime.map(update),
      earlier: day.earlier.map(update),
      ...(day.upNext === undefined ? {} : { upNext: update(day.upNext) }),
    })),
  };
}

interface RecurrenceTiming {
  readonly time: string | undefined;
  readonly endTime: string | undefined;
}

function segmentAt(
  recurrence: Recurrence,
  occurrenceDate: string,
): RecurrenceSegment | undefined {
  return [...recurrence.segments]
    .reverse()
    .find((segment) => segment.effectiveFrom <= occurrenceDate);
}

function cadenceKey(segment: RecurrenceSegment | undefined): string | undefined {
  if (segment === undefined) return undefined;
  return JSON.stringify({
    freq: segment.freq,
    interval: segment.interval,
    byWeekday: segment.byWeekday,
    byMonthDay: segment.byMonthDay,
    byMonth: segment.byMonth,
    rrule: segment.rrule,
  });
}

function timingAt(
  recurrence: Recurrence,
  occurrenceDate: string,
  fallback: RecurrenceTiming,
): RecurrenceTiming {
  const segment = segmentAt(recurrence, occurrenceDate);
  return {
    time: segment?.time ?? fallback.time,
    endTime: segment?.endTime ?? fallback.endTime,
  };
}

function sameTiming(left: RecurrenceTiming, right: RecurrenceTiming): boolean {
  return left.time === right.time && left.endTime === right.endTime;
}

/**
 * Optimistically projects only the safe subset of a recurrence edit: timing changes whose
 * cadence is unchanged. Existing occurrence overrides and snoozes remain authoritative, while
 * frequency/date topology still waits for the server's canonical reconciliation response.
 */
function applyRecurrenceTiming(
  data: AgendaData,
  activityId: string,
  previous: Recurrence,
  next: Recurrence,
  fallback: RecurrenceTiming,
  clock: ProjectionClock,
): { readonly data: AgendaData; readonly changed: boolean } {
  let changed = false;
  const days = data.days.map((day) => {
    let changedDay = false;
    const items = uniqueItems(day).map((item) => {
      if (
        item.activityId !== activityId ||
        item.occurrenceDate === undefined ||
        item.isSnoozed
      ) {
        return item;
      }
      const previousSegment = segmentAt(previous, item.occurrenceDate);
      const nextSegment = segmentAt(next, item.occurrenceDate);
      if (cadenceKey(previousSegment) !== cadenceKey(nextSegment)) return item;
      const previousTiming = timingAt(previous, item.occurrenceDate, fallback);
      const nextTiming = timingAt(next, item.occurrenceDate, fallback);
      if (
        sameTiming(previousTiming, nextTiming) ||
        item.time !== previousTiming.time ||
        item.endTime !== previousTiming.endTime
      ) {
        return item;
      }
      const projected: AgendaItem = {
        ...item,
        ...(nextTiming.time === undefined ? {} : { time: nextTiming.time }),
        ...(nextTiming.endTime === undefined ? {} : { endTime: nextTiming.endTime }),
        isPast:
          day.date < clock.today ||
          (day.date === clock.today &&
            nextTiming.time !== undefined &&
            (nextTiming.endTime ?? nextTiming.time) <= clock.currentMinute),
      };
      if (nextTiming.time === undefined) delete projected.time;
      if (nextTiming.endTime === undefined) delete projected.endTime;
      changed = true;
      changedDay = true;
      return projected;
    });
    return changedDay ? projectDay(day, items, clock) : day;
  });
  return { data: changed ? { ...data, days } : data, changed };
}

function parsedRecurrence(value: unknown): Recurrence | undefined {
  try {
    const candidate = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    const parsed = recurrenceSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function storedTiming(row: Record<string, unknown> | undefined): RecurrenceTiming {
  return {
    time: typeof row?.schedule_time === 'string' ? row.schedule_time : undefined,
    endTime:
      typeof row?.schedule_end_time === 'string' ? row.schedule_end_time : undefined,
  };
}

export class ActivityTransactionService {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
  ) {}

  async create(
    transaction: TransactionContext,
    ownerUserId: string,
    variables: ActivityCreateVariables,
    clock: ProjectionClock,
    mintedAt: string = systemClock.now(),
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const activityId = variables.input.activityId;
    if (activityId === undefined)
      throw new Error('A stable local activity id is required.');
    const appended = await this.outbox.append(
      transaction.database,
      mutation('create', variables.idempotencyKey, activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    const pending = pendingActivityFromInput(variables.input, activityId, mintedAt);
    const { pending: _pending, ...pendingFields } = pending;
    const activity = activitySchema.parse({
      ...pendingFields,
      ownerId: ownerUserId,
    }) as Activity;
    const reminders: Reminder[] = (variables.input.reminders ?? []).map((reminder) => {
      if (reminder.reminderId === undefined) {
        throw new Error('Offline reminder creation requires a stable reminder id.');
      }
      return {
        reminderId: reminder.reminderId,
        activityId,
        userId: ownerUserId,
        offsetMinutes: reminder.offsetMinutes,
        channel: 'push',
      };
    });
    await this.activities.putLocal(transaction, activity, reminders);
    const current = await this.agenda.readMaterializedWindow(transaction.database);
    const projected = applyCreate(current, {
      activity,
      ...clock,
      undatedDestinationDate: clock.today,
    });
    await this.agenda.replaceLocalActivityRows(transaction, activityId, projected);
    transaction.changed('outbox');
    return appended;
  }

  async appendOnly(
    transaction: TransactionContext,
    name: 'duplicate' | 'convert-recurrence',
    variables: ActivityIdentityVariables & Record<string, unknown>,
  ): Promise<TransactionalIntentResult> {
    const intentId = variables.idempotencyKey ?? variables.intentId;
    if (intentId === undefined) throw new Error('A stable mutation id is required.');
    const appended = await this.outbox.append(
      transaction.database,
      mutation(name, intentId, variables.activityId, variables),
    );
    if (appended.kind === 'inserted') transaction.changed('outbox');
    return appended;
  }

  async duplicate(
    transaction: TransactionContext,
    ownerUserId: string,
    sourceActivityId: string,
    copyActivityId: string,
    idempotencyKey: string,
    clock: ProjectionClock,
  ): Promise<TransactionalIntentResult> {
    const source = await this.activities.read({
      kind: 'activity',
      activityId: sourceActivityId,
    });
    if (source === undefined) throw new Error('No activity loaded to duplicate.');
    const suffix = ' (copy)';
    const room = MAX_TITLE_LEN - suffix.length;
    const shared = {
      activityId: copyActivityId,
      title: `${source.activity.title.slice(0, room).trimEnd()}${suffix}`,
      ...(source.activity.notes === undefined ? {} : { notes: source.activity.notes }),
      ...(source.activity.location === undefined
        ? {}
        : { location: source.activity.location }),
      details: source.activity.details,
    };
    const input: CreateActivityInput =
      source.activity.objectKind === 'task'
        ? { ...shared, objectKind: 'task', type: 'task' }
        : { ...shared, objectKind: 'plan', type: source.activity.type };
    return this.create(transaction, ownerUserId, { input, idempotencyKey }, clock);
  }

  async remove(
    transaction: TransactionContext,
    variables: { readonly activityId: string; readonly intentId: string },
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('delete', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    await transaction.database.run(
      'DELETE FROM activity_reminders WHERE activity_id = ?;',
      [variables.activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_occurrences WHERE activity_id = ?;',
      [variables.activityId],
    );
    await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
      variables.activityId,
    ]);
    await this.agenda.clearProjectionFence(transaction, variables.activityId);
    await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
      variables.activityId,
    ]);
    transaction.changed(this.activities.scope(variables.activityId));
    transaction.changed('agenda');
    transaction.changed('reminders');
    transaction.changed('outbox');
    return appended;
  }

  async patch(
    transaction: TransactionContext,
    variables: ActivityPatchVariables,
    clock?: ProjectionClock,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('patch', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    const current = await transaction.database.first(
      `SELECT activity.recurrence_json, activity.schedule_time,
        activity.schedule_end_time,
        EXISTS (
          SELECT 1 FROM outbox_intents create_intent
          WHERE create_intent.entity_id = activity.activity_id
            AND create_intent.mutation_key_json = '["activity","create"]'
            AND create_intent.status IN ('queued', 'in_flight')
        ) AS has_pending_create
       FROM activities activity WHERE activity.activity_id = ?;`,
      [variables.activityId],
    );
    const recurrenceEdit =
      current?.has_pending_create === 0 && Object.hasOwn(variables.input, 'recurrence');
    if (recurrenceEdit) {
      await this.activities.setLocalState(transaction, variables.activityId, 'updating');
      const previous = parsedRecurrence(current?.recurrence_json);
      const next = variables.input.recurrence;
      if (previous !== undefined && next != null && clock !== undefined) {
        const projected = applyRecurrenceTiming(
          await this.agenda.readMaterializedWindow(transaction.database),
          variables.activityId,
          previous,
          next,
          storedTiming(current),
          clock,
        );
        if (projected.changed) {
          await this.agenda.replaceLocalActivityRows(
            transaction,
            variables.activityId,
            projected.data,
            'updating',
          );
        } else {
          await this.agenda.markActivityRows(
            transaction,
            variables.activityId,
            'updating',
          );
        }
      } else {
        await this.agenda.markActivityRows(transaction, variables.activityId, 'updating');
      }
    } else {
      const activity = await this.activities.patchLocal(
        transaction,
        variables.activityId,
        variables.input,
        'queued',
      );
      const projected = updateAgendaActivity(
        await this.agenda.readMaterializedWindow(transaction.database),
        activity,
      );
      await this.agenda.replaceLocalActivityRows(
        transaction,
        variables.activityId,
        projected,
      );
    }
    transaction.changed('outbox');
    return appended;
  }

  async schedule(
    transaction: TransactionContext,
    variables: ActivityScheduleVariables,
    clock: ProjectionClock,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('schedule', variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    const occurrenceDate = variables.input.occurrenceDate;
    let scheduledDetail: ActivityDetail | undefined;
    if (occurrenceDate === undefined) {
      scheduledDetail = await this.activities.scheduleLocal(
        transaction,
        variables.activityId,
        variables.input,
      );
    } else {
      await transaction.database.run(
        `INSERT INTO activity_occurrences (
          activity_id, nominal_date, viewer_date, time, end_time, status,
          is_snoozed, local_state
        ) VALUES (?, ?, ?, ?, ?, 'scheduled', 0, 'queued')
        ON CONFLICT(activity_id, nominal_date) DO UPDATE SET
          viewer_date=excluded.viewer_date, time=excluded.time, end_time=excluded.end_time,
          status='scheduled', is_snoozed=0, local_state='queued';`,
        [
          variables.activityId,
          occurrenceDate,
          variables.input.date ?? occurrenceDate,
          variables.input.time ?? null,
          variables.input.endTime ?? null,
        ],
      );
      transaction.changed(this.activities.scope(variables.activityId));
    }
    const current = await this.agenda.readMaterializedWindow(transaction.database);
    const activity = scheduledDetail?.activity;
    const noteExcerpt = activity?.notes?.split(/\r?\n/, 1)[0]?.slice(0, 200);
    const fallbackItem: AgendaItem | undefined =
      activity === undefined || activity.recurrence !== undefined
        ? undefined
        : {
            activityId: activity.activityId,
            type: activity.type,
            title: activity.title,
            status: activity.status,
            ...(activity.schedule?.time === undefined
              ? {}
              : { time: activity.schedule.time }),
            ...(activity.schedule?.endTime === undefined
              ? {}
              : { endTime: activity.schedule.endTime }),
            isRecurring: false,
            isSnoozed: false,
            hasCheckbox: activity.type === 'task',
            capabilities: scheduledDetail?.capabilities ?? {
              complete: false,
              skip: false,
              snooze: false,
            },
            participantAvatars: [],
            participantCount: activity.participantCount,
            ...(activity.location?.label === undefined
              ? {}
              : { locationLabel: activity.location.label }),
            ...(noteExcerpt === undefined || noteExcerpt === '' ? {} : { noteExcerpt }),
            ...(activity.parentActivityId === undefined
              ? {}
              : { parentActivityId: activity.parentActivityId }),
            isPast:
              activity.schedule !== undefined &&
              (activity.schedule.date < clock.today ||
                (activity.schedule.date === clock.today &&
                  activity.schedule.time !== undefined &&
                  (activity.schedule.endTime ?? activity.schedule.time) <=
                    clock.currentMinute)),
          };
    const projected = applyReschedule(current, {
      activityId: variables.activityId,
      ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
      date: variables.input.date,
      ...(variables.input.time === undefined ? {} : { time: variables.input.time }),
      ...(variables.input.endTime === undefined
        ? {}
        : { endTime: variables.input.endTime }),
      ...(fallbackItem === undefined ? {} : { fallbackItem }),
      ...clock,
    });
    await this.agenda.replaceLocalActivityRows(
      transaction,
      variables.activityId,
      projected,
    );
    transaction.changed('outbox');
    return appended;
  }

  async complete(
    transaction: TransactionContext,
    variables: ActivityCompletionVariables,
    completed: boolean,
    restoredStatus: 'saved' | 'scheduled',
    clock: ProjectionClock,
    dependency?: { readonly originalIntentId: string },
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const name = completed ? 'complete' : 'uncomplete';
    const appended = await this.outbox.append(
      transaction.database,
      mutation(
        name,
        variables.idempotencyKey,
        variables.activityId,
        variables,
        dependency === undefined
          ? undefined
          : {
              dependsOnIntentId: dependency.originalIntentId,
              compensationForIntentId: dependency.originalIntentId,
            },
      ),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    await this.projectCompletion(
      transaction,
      variables,
      completed,
      restoredStatus,
      clock,
    );
    transaction.changed('outbox');
    return appended;
  }

  async projectCompletion(
    transaction: TransactionContext,
    variables: ActivityCompletionVariables,
    completed: boolean,
    restoredStatus: 'saved' | 'scheduled',
    clock: ProjectionClock,
  ): Promise<void> {
    const occurrenceDate = variables.input.occurrenceDate;
    const negative =
      completed &&
      (variables.input.outcome === 'didnt_happen' ||
        variables.input.outcome === 'didnt_go');
    if (occurrenceDate === undefined) {
      await this.activities.setStatusLocal(
        transaction,
        variables.activityId,
        negative ? 'skipped' : completed ? 'completed' : restoredStatus,
        completed ? variables.input.outcome : undefined,
        completed && !negative ? systemClock.now() : undefined,
      );
    } else {
      await transaction.database.run(
        `INSERT INTO activity_occurrences (
          activity_id, nominal_date, viewer_date, status, is_snoozed,
          completed_at, local_state
        ) VALUES (?, ?, ?, ?, 0, ?, 'queued')
        ON CONFLICT(activity_id, nominal_date) DO UPDATE SET
          status=excluded.status, completed_at=excluded.completed_at, local_state='queued';`,
        [
          variables.activityId,
          occurrenceDate,
          occurrenceDate,
          negative
            ? 'skipped_occurrence'
            : completed
              ? 'completed_occurrence'
              : restoredStatus,
          completed && !negative ? systemClock.now() : null,
        ],
      );
      transaction.changed(this.activities.scope(variables.activityId));
    }
    const current = await this.agenda.readMaterializedTargetDay(
      transaction.database,
      variables.activityId,
      occurrenceDate,
      clock.today,
    );
    const projected = negative
      ? applySkip(current, {
          activityId: variables.activityId,
          ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
          ...clock,
          skipped: true,
        })
      : applyCompletion(current, {
          activityId: variables.activityId,
          ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
          ...clock,
          ...(completed ? { completed: true } : { completed: false, restoredStatus }),
        });
    await this.agenda.replaceLocalTargetRows(
      transaction,
      variables.activityId,
      occurrenceDate,
      projected,
    );
  }

  async skip(
    transaction: TransactionContext,
    variables: ActivityCompletionVariables,
    skipped: boolean,
    clock: ProjectionClock,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const name = skipped ? 'skip' : 'uncomplete';
    const appended = await this.outbox.append(
      transaction.database,
      mutation(name, variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    const occurrenceDate = variables.input.occurrenceDate;
    if (occurrenceDate === undefined) {
      await this.activities.setStatusLocal(
        transaction,
        variables.activityId,
        skipped ? 'skipped' : 'scheduled',
      );
    } else {
      await transaction.database.run(
        `INSERT INTO activity_occurrences (
          activity_id, nominal_date, viewer_date, status, is_snoozed, local_state
        ) VALUES (?, ?, ?, ?, 0, 'queued')
        ON CONFLICT(activity_id, nominal_date) DO UPDATE SET
          status=excluded.status, local_state='queued';`,
        [
          variables.activityId,
          occurrenceDate,
          occurrenceDate,
          skipped ? 'skipped_occurrence' : 'scheduled',
        ],
      );
      transaction.changed(this.activities.scope(variables.activityId));
    }
    const current = await this.agenda.readMaterializedTargetDay(
      transaction.database,
      variables.activityId,
      occurrenceDate,
      clock.today,
    );
    const projected = applySkip(current, {
      activityId: variables.activityId,
      ...(variables.input.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: variables.input.occurrenceDate }),
      ...clock,
      skipped,
    });
    await this.agenda.replaceLocalTargetRows(
      transaction,
      variables.activityId,
      occurrenceDate,
      projected,
    );
    transaction.changed('outbox');
    return appended;
  }

  async snooze(
    transaction: TransactionContext,
    variables: ActivitySnoozeVariables,
    snoozed: boolean,
    renderedDate: string,
    clock: ProjectionClock,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const name = snoozed ? 'snooze' : 'unsnooze';
    const appended = await this.outbox.append(
      transaction.database,
      mutation(name, variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    const occurrenceDate = variables.input.occurrenceDate;
    if (occurrenceDate === undefined) {
      await transaction.database.run(
        "UPDATE activities SET snoozed_until = ?, local_state = 'queued' WHERE activity_id = ?;",
        [snoozed ? variables.input.until : null, variables.activityId],
      );
    } else {
      await transaction.database.run(
        `INSERT INTO activity_occurrences (
          activity_id, nominal_date, viewer_date, time, status, is_snoozed, local_state
        ) VALUES (?, ?, ?, ?, 'scheduled', ?, 'queued')
        ON CONFLICT(activity_id, nominal_date) DO UPDATE SET
          time=excluded.time, is_snoozed=excluded.is_snoozed, local_state='queued';`,
        [
          variables.activityId,
          occurrenceDate,
          renderedDate,
          variables.input.until,
          snoozed ? 1 : 0,
        ],
      );
    }
    transaction.changed(this.activities.scope(variables.activityId));
    const current = await this.agenda.readMaterializedWindow(transaction.database);
    const target = {
      activityId: variables.activityId,
      ...(variables.input.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: variables.input.occurrenceDate }),
      date: renderedDate,
      ...clock,
    };
    const projected = snoozed
      ? applySnooze(current, { ...target, time: variables.input.until, snoozed: true })
      : applySnooze(current, { ...target, snoozed: false });
    await this.agenda.replaceLocalActivityRows(
      transaction,
      variables.activityId,
      projected,
    );
    transaction.changed('outbox');
    return appended;
  }

  async addReminder(
    transaction: TransactionContext,
    ownerUserId: string,
    variables: ActivityReminderVariables,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation(
        'reminder-create',
        variables.idempotencyKey,
        variables.activityId,
        variables,
      ),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    await transaction.database.run(
      `INSERT INTO activity_reminders (
        reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state
      ) VALUES (?, ?, ?, ?, 'push', 'queued')
      ON CONFLICT(reminder_id) DO UPDATE SET offset_minutes=excluded.offset_minutes,
        local_state='queued';`,
      [
        variables.input.reminderId,
        variables.activityId,
        ownerUserId,
        variables.input.offsetMinutes,
      ],
    );
    transaction.changed(this.activities.scope(variables.activityId));
    transaction.changed('reminders');
    transaction.changed('outbox');
    return appended;
  }

  /** Remaps persisted local projections; the coordinator remaps the outbox in the same write. */
  async remapPendingCreateIdentity(
    transaction: TransactionContext,
    previousActivityId: string,
    freshActivityId: string,
  ): Promise<void> {
    await this.activities.remapPendingCreateIdentity(
      transaction,
      previousActivityId,
      freshActivityId,
    );
    await this.agenda.remapPendingCreateIdentity(
      transaction,
      previousActivityId,
      freshActivityId,
    );
  }

  async removeReminder(
    transaction: TransactionContext,
    variables: ActivityReminderDeleteVariables,
    projectExisting = false,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('reminder-delete', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing' && !projectExisting) return appended;
    await transaction.database.run(
      'DELETE FROM activity_reminders WHERE reminder_id = ?;',
      [variables.reminderId],
    );
    transaction.changed(this.activities.scope(variables.activityId));
    transaction.changed('reminders');
    transaction.changed('outbox');
    return appended;
  }

  /** Re-applies the accepted local projection after a user-directed attention retry. */
  async reprojectRetry(
    transaction: TransactionContext,
    ownerUserId: string,
    intent: OutboxIntent,
    clock: ProjectionClock,
  ): Promise<void> {
    const name = intent.mutationKey[1];
    const variables = variablesObject(intent.variables);
    if (name === 'create') {
      const existing = await this.activities.read({
        kind: 'activity',
        activityId: intent.entityId,
      });
      // Response-loss recovery may already have installed the server-created entity. Keep
      // that canonical version; the same durable create is merely being requeued for replay.
      if (existing !== undefined) return;
      await this.create(
        transaction,
        ownerUserId,
        variables as unknown as ActivityCreateVariables,
        clock,
        systemClock.now(),
        true,
      );
      return;
    }
    if (name === 'duplicate' || name === 'convert-recurrence') return;
    const detail = await this.activities.read({
      kind: 'activity',
      activityId: intent.entityId,
    });
    /*
     * Imported legacy work may not have a native projection to rebuild. The durable retry
     * still has to be dispatchable; its acknowledgement will install canonical server truth.
     */
    if (detail === undefined) return;
    if (name === 'delete') {
      await this.remove(
        transaction,
        variables as unknown as {
          readonly activityId: string;
          readonly intentId: string;
        },
        true,
      );
      return;
    }
    if (name === 'patch') {
      const rebased = await this.outbox.rebaseActivityPatchIntent(
        transaction.database,
        intent.intentId,
        detail.activity.updatedAt,
      );
      await this.patch(
        transaction,
        variablesObject(rebased.variables) as unknown as ActivityPatchVariables,
        clock,
        true,
      );
      return;
    }
    if (name === 'schedule') {
      await this.schedule(
        transaction,
        variables as unknown as ActivityScheduleVariables,
        clock,
        true,
      );
      return;
    }
    const restoredStatus =
      detail?.activity.schedule === undefined ? 'saved' : 'scheduled';
    if (name === 'complete' || name === 'uncomplete') {
      await this.complete(
        transaction,
        variables as unknown as ActivityCompletionVariables,
        name === 'complete',
        restoredStatus,
        clock,
        undefined,
        true,
      );
      return;
    }
    if (name === 'skip') {
      await this.skip(
        transaction,
        variables as unknown as ActivityCompletionVariables,
        true,
        clock,
        true,
      );
      return;
    }
    if (name === 'snooze' || name === 'unsnooze') {
      const snoozeVariables = variables as unknown as ActivitySnoozeVariables;
      await this.snooze(
        transaction,
        snoozeVariables,
        name === 'snooze',
        snoozeVariables.input.occurrenceDate ??
          detail?.activity.schedule?.date ??
          clock.today,
        clock,
        true,
      );
      return;
    }
    if (name === 'reminder-create') {
      await this.addReminder(
        transaction,
        ownerUserId,
        variables as unknown as ActivityReminderVariables,
        true,
      );
      return;
    }
    if (name === 'reminder-delete') {
      await this.removeReminder(
        transaction,
        variables as unknown as ActivityReminderDeleteVariables,
        true,
      );
      return;
    }
    throw new Error(`Unsupported blocked activity mutation: ${name ?? 'unknown'}.`);
  }

  /** Restores canonical row state and reverses any safe timing projection owned by this patch. */
  async restoreCancelledRecurrenceEdit(
    transaction: TransactionContext,
    intent: OutboxIntent,
    clock: ProjectionClock,
  ): Promise<void> {
    const activityId = intent.entityId;
    const row = await transaction.database.first(
      `SELECT recurrence_json, schedule_time, schedule_end_time
       FROM activities WHERE activity_id = ?;`,
      [activityId],
    );
    const canonical = parsedRecurrence(row?.recurrence_json);
    const variables = variablesObject(intent.variables);
    const input = variables.input;
    const pending =
      typeof input === 'object' && input !== null
        ? (input as { readonly recurrence?: unknown }).recurrence
        : undefined;
    const queued = parsedRecurrence(pending);
    if (canonical !== undefined && queued !== undefined) {
      const restored = applyRecurrenceTiming(
        await this.agenda.readMaterializedWindow(transaction.database),
        activityId,
        queued,
        canonical,
        storedTiming(row),
        clock,
      );
      if (restored.changed) {
        await this.agenda.replaceLocalActivityRows(
          transaction,
          activityId,
          restored.data,
          'canonical',
        );
      } else {
        await transaction.database.run(
          "UPDATE agenda_rows SET local_state = 'canonical' WHERE activity_id = ? AND local_state = 'updating';",
          [activityId],
        );
        transaction.changed('agenda');
      }
    } else {
      await transaction.database.run(
        "UPDATE agenda_rows SET local_state = 'canonical' WHERE activity_id = ? AND local_state = 'updating';",
        [activityId],
      );
      transaction.changed('agenda');
    }
    await this.activities.setLocalState(transaction, activityId, 'canonical');
  }

  async cancelQueuedAndProjectInverse(
    transaction: TransactionContext,
    originalIntentId: string,
    projectInverse: () => Promise<void>,
  ): Promise<boolean> {
    const original = await this.outbox.get(transaction.database, originalIntentId);
    if (original?.status !== 'queued') return false;
    const cancelled = await this.outbox.cancelQueued(
      transaction.database,
      originalIntentId,
    );
    if (!cancelled) return false;
    await projectInverse();
    transaction.changed('outbox');
    return true;
  }
}
