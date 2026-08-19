import { ApiError } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import {
  type AgendaQuery,
  activityCompletionResult,
  activity as activitySchema,
  scheduleActivityResult,
  timeZone,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  AgendaData,
  Occurrence,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import {
  agendaCoverageForQuery,
  agendaQueryForCoverage,
  agendaQueryKey,
} from '@/lib/sqlite/agendaCoverage';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import {
  type ActivityPullAdapter,
  sharedActivityPullAdapter,
} from '@/lib/sync/pullAdapter';
import { ActivityPushAdapter, type ActivityPushTransport } from '@/lib/sync/pushAdapter';
import {
  RecurrenceReconciler,
  type TargetedAgendaTransport,
} from '@/lib/sync/reconciliation';
import { field } from '@/lib/unknown';

export type NativeSyncReason =
  | 'accepted-action'
  | 'foreground'
  | 'connectivity'
  | 'manual'
  | 'retry';

export interface NativeSyncEngine {
  request(reason: NativeSyncReason): void;
  syncNow(): Promise<void>;
  pullActivity(target: ActivityDetailTarget): Promise<ActivityDetail>;
  pullAgenda(request: AgendaQuery): Promise<AgendaData>;
  pullReminderCoverage(): Promise<void>;
  stop(): void;
}

const MAX_INTENTS_PER_PASS = 20;
const RETRY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000] as const;

function isPermanent(error: unknown): boolean {
  const status = field(error, 'status');
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectedAttention(error: unknown) {
  const status = field(error, 'status');
  const code = field(error, 'code');
  const details = field(error, 'details');
  return {
    kind: 'rejected' as const,
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

function activityFromResponse(response: unknown): Activity | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const nested = field(response, 'activity');
  const candidate = nested === undefined ? response : nested;
  const parsed = activitySchema.safeParse(candidate);
  // Zod's optional output uses `T | undefined`; the domain model uses property absence.
  return parsed.success ? (parsed.data as Activity) : undefined;
}

function isRecurrencePatch(intent: OutboxIntent): boolean {
  if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'patch')
    return false;
  const input = field(intent.variables, 'input');
  return (
    typeof input === 'object' && input !== null && Object.hasOwn(input, 'recurrence')
  );
}

const OCCURRENCE_MUTATIONS = new Set([
  'complete',
  'uncomplete',
  'skip',
  'snooze',
  'unsnooze',
  'schedule',
]);

interface CanonicalOccurrenceResponse {
  readonly activity: Activity;
  readonly nominalDate: string;
  readonly occurrence?: Occurrence;
  readonly projection?: OccurrenceDetailProjection;
}

function occurrenceDateFromIntent(intent: OutboxIntent): string | undefined {
  if (!OCCURRENCE_MUTATIONS.has(intent.mutationKey[1] ?? '')) return undefined;
  const input = field(intent.variables, 'input');
  if (typeof input !== 'object' || input === null) return undefined;
  const occurrenceDate = field(input, 'occurrenceDate');
  return typeof occurrenceDate === 'string' ? occurrenceDate : undefined;
}

function canonicalOccurrenceResponse(
  intent: OutboxIntent,
  response: unknown,
): CanonicalOccurrenceResponse | undefined {
  const nominalDate = occurrenceDateFromIntent(intent);
  if (nominalDate === undefined) return undefined;
  if (intent.mutationKey[1] === 'schedule') {
    const parsed = scheduleActivityResult.parse(response);
    if (
      parsed.occurrence === undefined ||
      parsed.occurrence.nominalDate !== nominalDate
    ) {
      throw new Error('Canonical occurrence identity did not match the schedule action.');
    }
    const projection: OccurrenceDetailProjection = {
      nominalDate: parsed.occurrence.nominalDate,
      date: parsed.occurrence.date,
      ...(parsed.occurrence.time === undefined ? {} : { time: parsed.occurrence.time }),
      ...(parsed.occurrence.endTime === undefined
        ? {}
        : { endTime: parsed.occurrence.endTime }),
      status: parsed.occurrence.status,
      isSnoozed: parsed.occurrence.isSnoozed,
      ...(parsed.occurrence.completedAt === undefined
        ? {}
        : { completedAt: parsed.occurrence.completedAt }),
    };
    // Zod's optional output uses `T | undefined`; the domain model uses property absence.
    return { activity: parsed.activity as Activity, nominalDate, projection };
  }
  const parsed = activityCompletionResult.parse(response);
  if (
    parsed.occurrence !== undefined &&
    (parsed.occurrence.activityId !== intent.entityId ||
      parsed.occurrence.date !== nominalDate)
  ) {
    throw new Error('Canonical occurrence identity did not match the durable action.');
  }
  return {
    // Zod's optional output uses `T | undefined`; the domain model uses property absence.
    activity: parsed.activity as Activity,
    nominalDate,
    ...(parsed.occurrence === undefined
      ? {}
      : {
          // Zod's optional output uses `T | undefined`; the domain model uses absence.
          occurrence: parsed.occurrence as Occurrence,
        }),
  };
}

export class PendingActivityDeletionError extends Error {
  constructor(readonly activityId: string) {
    super('This activity is pending deletion.');
    this.name = 'PendingActivityDeletionError';
  }
}

export class SerializedNativeSyncEngine implements NativeSyncEngine {
  private running: Promise<Error | undefined> | undefined;
  private requested = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  private stopped = false;
  private networkTail: Promise<void> = Promise.resolve();
  private pullRequested = false;
  private pulling = false;
  private readonly requestedCoverages = new Map<string, AgendaQuery>();
  private cycleError: Error | undefined;
  private readonly push: ActivityPushAdapter;
  private readonly reconciler: RecurrenceReconciler;

  constructor(
    private readonly transactions: SerializedTransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
    pushTransport?: ActivityPushTransport,
    private readonly pull: ActivityPullAdapter = sharedActivityPullAdapter,
    targetedTransport?: TargetedAgendaTransport,
  ) {
    this.push = new ActivityPushAdapter(pushTransport);
    this.reconciler = new RecurrenceReconciler(
      transactions,
      outbox,
      activities,
      agenda,
      targetedTransport,
      (operation) => this.serialNetwork(operation),
    );
  }

  request(reason: NativeSyncReason): void {
    if (this.stopped) return;
    if (reason !== 'accepted-action' && !this.pulling) this.pullRequested = true;
    if (reason !== 'retry') {
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryIndex = 0;
    }
    if (this.running !== undefined) {
      if (reason === 'accepted-action' || !this.pulling) this.requested = true;
      return;
    }
    this.cycleError = undefined;
    this.requested = true;
    this.running = this.drain()
      .then(() => this.cycleError)
      .finally(() => {
        this.running = undefined;
        if (this.requested) this.request('retry');
      });
  }

  async syncNow(): Promise<void> {
    this.request('manual');
    const error = await this.running;
    if (error !== undefined) throw error;
  }

  async pullAgenda(request: AgendaQuery): Promise<AgendaData> {
    this.queueCoverage(request);
    await this.syncNow();
    return this.agenda.read({
      from: request.from,
      to: request.to,
      timezone: request.tz,
      ...(request.include === undefined ? {} : { include: request.include }),
    });
  }

  async pullActivity(target: ActivityDetailTarget): Promise<ActivityDetail> {
    await this.syncNow();
    return this.serialNetwork(async () => {
      let detail: ActivityDetail;
      try {
        detail = await this.pull.activity(target);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          await this.transactions.run((transaction) =>
            this.activities.acceptCanonicalDeletion(transaction, target.activityId),
          );
        }
        throw error;
      }
      await this.transactions.run((transaction) =>
        this.activities.putCanonical(transaction, detail),
      );
      const installed = await this.activities.read(target);
      if (installed === undefined)
        throw new PendingActivityDeletionError(target.activityId);
      return installed;
    });
  }

  async pullReminderCoverage(): Promise<void> {
    await this.serialNetwork(async () => {
      const user = await this.pull.profile();
      const today = systemClock.todayIn(timeZone.parse(user.timezone));
      const request = {
        from: today,
        to: addWallDays(today, 7),
        tz: user.timezone,
        include: 'reminders' as const,
      };
      this.queueCoverage(request);
      await this.transactions.run(async (transaction) => {
        await transaction.database.run(
          `INSERT INTO native_reminder_profile (
            singleton, timezone, all_day_reminder_hour, quiet_hours_json, refreshed_at
          ) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET timezone=excluded.timezone,
            all_day_reminder_hour=excluded.all_day_reminder_hour,
            quiet_hours_json=excluded.quiet_hours_json, refreshed_at=excluded.refreshed_at;`,
          [
            user.timezone,
            user.allDayReminderHour ?? null,
            user.quietHours === undefined ? null : JSON.stringify(user.quietHours),
            systemClock.now(),
          ],
        );
        transaction.changed('reminders');
      });
    });
    await this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    this.requested = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async drain(): Promise<void> {
    do {
      this.requested = false;
      const blockedOrderingKeys = new Set<string>();
      for (let count = 0; count < MAX_INTENTS_PER_PASS; count += 1) {
        const claimed = await this.transactions.run(async (transaction) => {
          const intent = await this.outbox.claimNext(
            transaction.database,
            Date.now(),
            blockedOrderingKeys,
          );
          if (intent !== undefined) transaction.changed('outbox');
          return intent;
        });
        if (claimed === undefined) break;
        const outcome = await this.execute(claimed);
        if (outcome === 'blocked') blockedOrderingKeys.add(claimed.orderingKey);
      }
      const reconciliation = await this.reconciler.reconcilePending();
      if (reconciliation.failed > 0) {
        this.cycleError ??= new Error("Couldn't refresh schedule · Retry");
        this.scheduleRetry();
      }
      if (this.pullRequested) {
        this.pullRequested = false;
        this.pulling = true;
        const pullError = await this.pullKnownCoverage().finally(() => {
          this.pulling = false;
        });
        if (pullError !== undefined) {
          this.cycleError = pullError;
          this.scheduleRetry();
        }
      }
    } while (this.requested);
  }

  private async execute(intent: OutboxIntent): Promise<'continue' | 'blocked'> {
    try {
      const response = await this.serialNetwork(() => this.push.execute(intent));
      await this.transactions.run(async (transaction) => {
        const later = await transaction.database.first(
          `SELECT intent_id FROM outbox_intents
           WHERE ordering_key = ? AND seq > ?
             AND status IN ('queued', 'in_flight', 'needs_attention')
           LIMIT 1;`,
          [intent.orderingKey, intent.seq],
        );
        const recurrencePatch = isRecurrencePatch(intent);
        const activity = activityFromResponse(response);
        let canonicalOccurrence: CanonicalOccurrenceResponse | undefined;
        let occurrenceContractBroken = false;
        if (later === undefined) {
          try {
            canonicalOccurrence = canonicalOccurrenceResponse(intent, response);
          } catch (contractError) {
            /*
             * The server already accepted this durable action, so redispatching cannot
             * repair a response that violates the occurrence contract — it only loops
             * the claim. Acknowledge, install at most the matching activity-level
             * result, and leave that occurrence's presentation to the next pull.
             */
            occurrenceContractBroken = true;
            console.warn(
              'outbox_response_contract_mismatch',
              intent.mutationKey.join('.'),
              message(contractError),
            );
          }
        }
        const installable =
          occurrenceContractBroken && activity?.activityId !== intent.entityId
            ? undefined
            : activity;
        if (canonicalOccurrence !== undefined) {
          const projection = await this.activities.acceptCanonicalOccurrence(
            transaction,
            canonicalOccurrence.activity,
            canonicalOccurrence.nominalDate,
            canonicalOccurrence.occurrence,
            canonicalOccurrence.projection,
          );
          await this.agenda.acceptCanonicalOccurrence(
            transaction,
            canonicalOccurrence.activity,
            projection,
          );
        } else if (later === undefined && installable !== undefined && !recurrencePatch) {
          await this.activities.acceptCanonicalResponse(transaction, installable);
          await transaction.database.run(
            `UPDATE agenda_rows SET title = ?, type = ?,
              status = CASE WHEN occurrence_date IS NULL THEN ? ELSE status END,
              local_state = 'canonical', canonical_version = ?
             WHERE activity_id = ?;`,
            [
              installable.title,
              installable.type,
              installable.status,
              installable.updatedAt,
              installable.activityId,
            ],
          );
          transaction.changed('agenda');
        }
        if (recurrencePatch) {
          if (activity === undefined) {
            throw new Error('Recurrence PATCH acknowledgement omitted its Activity.');
          }
          await this.activities.acceptCanonicalResponse(transaction, activity);
          await this.activities.setLocalState(transaction, intent.entityId, 'updating');
          await this.agenda.markActivityRows(transaction, intent.entityId, 'updating');
        }
        if (
          intent.mutationKey[0] === 'activity' &&
          intent.mutationKey[1] === 'reminder-create'
        ) {
          const reminderId = field(field(intent.variables, 'input'), 'reminderId');
          if (typeof reminderId === 'string') {
            await transaction.database.run(
              "UPDATE activity_reminders SET local_state = 'canonical' WHERE reminder_id = ?;",
              [reminderId],
            );
            transaction.changed(this.activities.scope(intent.entityId));
            transaction.changed('reminders');
          }
        }
        if (intent.mutationKey[1] === 'delete') {
          await this.activities.recordTombstone(
            transaction.database,
            intent.entityId,
            systemClock.now(),
          );
        }
        if (intent.mutationKey[1] === 'reminder-delete') {
          const reminderId = field(intent.variables, 'reminderId');
          if (typeof reminderId !== 'string') {
            throw new Error(
              'Reminder delete acknowledgement omitted its durable identity.',
            );
          }
          await transaction.database.run(
            `INSERT OR IGNORE INTO reminder_tombstones
              (reminder_id, activity_id, acknowledged_at) VALUES (?, ?, ?);`,
            [reminderId, intent.entityId, systemClock.now()],
          );
        }
        await this.outbox.acknowledge(
          transaction.database,
          intent.intentId,
          recurrencePatch ? activity?.updatedAt : undefined,
        );
        transaction.changed('outbox');
      });
      this.retryIndex = 0;
      return 'continue';
    } catch (error) {
      const collision = await this.recoverCreateCollision(intent, error);
      if (collision === 'recovered' || collision === 'parked') return 'continue';
      if (collision === 'retry') return 'blocked';
      this.cycleError ??= error instanceof Error ? error : new Error(String(error));
      await this.transactions.run(async (transaction) => {
        if (isPermanent(error)) {
          await this.outbox.needsAttention(
            transaction.database,
            intent.intentId,
            rejectedAttention(error),
            message(error),
          );
          await this.activities.setLocalState(
            transaction,
            intent.entityId,
            'needs_attention',
          );
          await this.agenda.markActivityRows(
            transaction,
            intent.entityId,
            'needs_attention',
          );
        } else {
          await this.outbox.requeue(
            transaction.database,
            intent.intentId,
            message(error),
          );
        }
        transaction.changed('outbox');
      });
      if (!isPermanent(error)) this.scheduleRetry();
      return isPermanent(error) ? 'continue' : 'blocked';
    }
  }

  private async pullKnownCoverage(): Promise<Error | undefined> {
    const requests = new Map<string, AgendaQuery>();
    for (const coverage of await this.agenda.coverage()) {
      const request = agendaQueryForCoverage(coverage);
      requests.set(agendaQueryKey(request), request);
    }
    for (const [key, request] of this.requestedCoverages) requests.set(key, request);
    this.requestedCoverages.clear();
    let firstError: Error | undefined;
    for (const request of requests.values()) {
      const coverage = agendaCoverageForQuery(request);
      try {
        const data = await this.serialNetwork(() => this.pull.agenda(request));
        await this.transactions.run((transaction) =>
          this.agenda.installCanonical(transaction, request, data),
        );
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        firstError ??= failure;
        await this.transactions.run((transaction) =>
          this.agenda.recordSyncError(transaction, coverage, failure.message),
        );
      }
    }
    return firstError;
  }

  /** A coverage registered after the active pull snapshot must cause one more bounded pass. */
  private queueCoverage(request: AgendaQuery): void {
    this.requestedCoverages.set(agendaQueryKey(request), request);
    if (this.pulling) {
      this.pullRequested = true;
      this.requested = true;
    }
  }

  private async recoverCreateCollision(
    intent: OutboxIntent,
    error: unknown,
  ): Promise<'not_applicable' | 'recovered' | 'parked' | 'retry'> {
    if (
      intent.mutationKey[1] !== 'create' ||
      !(error instanceof ApiError) ||
      error.status !== 409
    ) {
      return 'not_applicable';
    }
    try {
      const detail = await this.serialNetwork(() =>
        this.pull.activity({ kind: 'activity', activityId: intent.entityId }),
      );
      await this.transactions.run(async (transaction) => {
        await this.activities.acceptCanonicalResponse(transaction, detail.activity);
        await this.activities.putCanonical(transaction, detail);
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        transaction.changed('outbox');
      });
      return 'recovered';
    } catch (recoveryError) {
      if (!(recoveryError instanceof ApiError) || recoveryError.status !== 404) {
        const failure =
          recoveryError instanceof Error
            ? recoveryError
            : new Error(String(recoveryError));
        this.cycleError ??= failure;
        await this.transactions.run(async (transaction) => {
          await this.outbox.requeue(
            transaction.database,
            intent.intentId,
            failure.message,
          );
          transaction.changed('outbox');
        });
        this.scheduleRetry();
        return 'retry';
      }
      await this.transactions.run(async (transaction) => {
        await this.outbox.needsAttention(
          transaction.database,
          intent.intentId,
          { kind: 'parked', reason: 'ambiguous_collision' },
          'This never synced.',
        );
        await this.activities.setLocalState(
          transaction,
          intent.entityId,
          'needs_attention',
        );
        await this.agenda.markActivityRows(
          transaction,
          intent.entityId,
          'needs_attention',
        );
        transaction.changed('outbox');
      });
      return 'parked';
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    const delay =
      RETRY_BACKOFF_MS[Math.min(this.retryIndex, RETRY_BACKOFF_MS.length - 1)];
    this.retryIndex = Math.min(this.retryIndex + 1, RETRY_BACKOFF_MS.length - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.request('retry');
    }, delay);
  }

  private serialNetwork<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.networkTail.then(operation, operation);
    this.networkTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
