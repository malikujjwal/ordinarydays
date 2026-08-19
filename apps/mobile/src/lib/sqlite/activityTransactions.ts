import type {
  CreateActivityInput,
  PatchActivityInput,
  ScheduleActivityInput,
} from '@od/shared/schemas';
import { activity as activitySchema } from '@od/shared/schemas';
import type {
  Activity,
  ActivityOutcome,
  AgendaData,
  AgendaItem,
  Reminder,
} from '@od/shared/types';
import { applyCompletion } from '@/features/agenda/model/applyCompletion';
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
    mintedAt = new Date().toISOString(),
  ): Promise<TransactionalIntentResult> {
    const activityId = variables.input.activityId;
    if (activityId === undefined)
      throw new Error('A stable local activity id is required.');
    const appended = await this.outbox.append(
      transaction.database,
      mutation('create', variables.idempotencyKey, activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
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
    const projected = applyCreate(current, { activity, ...clock });
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

  async remove(
    transaction: TransactionContext,
    variables: { readonly activityId: string; readonly intentId: string },
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('delete', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
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
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('patch', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
    const current = await transaction.database.first(
      `SELECT activity.recurrence_json,
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
      await this.agenda.markActivityRows(transaction, variables.activityId, 'updating');
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
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('schedule', variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
    const occurrenceDate = variables.input.occurrenceDate;
    if (occurrenceDate === undefined) {
      await this.activities.scheduleLocal(
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
    const projected = applyReschedule(current, {
      activityId: variables.activityId,
      ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
      date: variables.input.date,
      ...(variables.input.time === undefined ? {} : { time: variables.input.time }),
      ...(variables.input.endTime === undefined
        ? {}
        : { endTime: variables.input.endTime }),
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
    if (appended.kind === 'existing') return appended;
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
        completed && !negative ? new Date().toISOString() : undefined,
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
          completed && !negative ? new Date().toISOString() : null,
        ],
      );
      transaction.changed(this.activities.scope(variables.activityId));
    }
    const current = await this.agenda.readMaterializedWindow(transaction.database);
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
    await this.agenda.replaceLocalActivityRows(
      transaction,
      variables.activityId,
      projected,
    );
  }

  async skip(
    transaction: TransactionContext,
    variables: ActivityCompletionVariables,
    skipped: boolean,
    clock: ProjectionClock,
  ): Promise<TransactionalIntentResult> {
    const name = skipped ? 'skip' : 'uncomplete';
    const appended = await this.outbox.append(
      transaction.database,
      mutation(name, variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
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
    const current = await this.agenda.readMaterializedWindow(transaction.database);
    const projected = applySkip(current, {
      activityId: variables.activityId,
      ...(variables.input.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: variables.input.occurrenceDate }),
      ...clock,
      skipped,
    });
    await this.agenda.replaceLocalActivityRows(
      transaction,
      variables.activityId,
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
  ): Promise<TransactionalIntentResult> {
    const name = snoozed ? 'snooze' : 'unsnooze';
    const appended = await this.outbox.append(
      transaction.database,
      mutation(name, variables.idempotencyKey, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
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
    if (appended.kind === 'existing') return appended;
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

  async removeReminder(
    transaction: TransactionContext,
    variables: ActivityReminderDeleteVariables,
  ): Promise<TransactionalIntentResult> {
    const appended = await this.outbox.append(
      transaction.database,
      mutation('reminder-delete', variables.intentId, variables.activityId, variables),
    );
    if (appended.kind === 'existing') return appended;
    await transaction.database.run(
      'DELETE FROM activity_reminders WHERE reminder_id = ?;',
      [variables.reminderId],
    );
    transaction.changed(this.activities.scope(variables.activityId));
    transaction.changed('reminders');
    transaction.changed('outbox');
    return appended;
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
