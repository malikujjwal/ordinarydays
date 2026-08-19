import { getActivity, getAgenda, getMe } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import {
  type AgendaQuery,
  activityCompletionResult,
  activity as activitySchema,
  scheduleActivityResult,
} from '@od/shared/schemas';
import { systemClock, type TimeZone } from '@od/shared/time';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  AgendaData,
  Occurrence,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { runIntent } from '@/lib/intentReplay';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

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
  const status = (error as { status?: unknown } | undefined)?.status;
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
  const candidate = error as
    | { status?: unknown; code?: unknown; details?: unknown }
    | undefined;
  return {
    kind: 'rejected' as const,
    ...(typeof candidate?.status === 'number' ? { status: candidate.status } : {}),
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(candidate?.details === undefined ? {} : { details: candidate.details }),
  };
}

function activityFromResponse(response: unknown): Activity | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const candidate =
    'activity' in response ? (response as { activity: unknown }).activity : response;
  const parsed = activitySchema.safeParse(candidate);
  return parsed.success ? (parsed.data as Activity) : undefined;
}

function isRecurrencePatch(intent: OutboxIntent): boolean {
  if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'patch')
    return false;
  const input = (intent.variables as { input?: unknown } | undefined)?.input;
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
  const input = (intent.variables as { input?: unknown } | undefined)?.input;
  if (typeof input !== 'object' || input === null) return undefined;
  const occurrenceDate = (input as { occurrenceDate?: unknown }).occurrenceDate;
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
    activity: parsed.activity as Activity,
    nominalDate,
    ...(parsed.occurrence === undefined
      ? {}
      : { occurrence: parsed.occurrence as Occurrence }),
  };
}

export class PendingActivityDeletionError extends Error {
  constructor(readonly activityId: string) {
    super('This activity is pending deletion.');
    this.name = 'PendingActivityDeletionError';
  }
}

export class SerializedNativeSyncEngine implements NativeSyncEngine {
  private running: Promise<void> | undefined;
  private requested = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  private stopped = false;
  private networkTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ownerUserId: string,
    private readonly queryClient: QueryClient,
    private readonly transactions: SerializedTransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
  ) {}

  request(reason: NativeSyncReason): void {
    if (this.stopped) return;
    if (reason !== 'retry') {
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryIndex = 0;
    }
    this.requested = true;
    if (this.running !== undefined) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.requested) this.request('retry');
    });
  }

  async syncNow(): Promise<void> {
    this.request('manual');
    await this.running;
  }

  async pullAgenda(request: AgendaQuery): Promise<AgendaData> {
    await this.syncNow();
    return this.serialNetwork(async () => {
      const data = await getAgenda(apiClient, request);
      await this.transactions.run((transaction) =>
        this.agenda.installCanonical(transaction, request, data),
      );
      return this.agenda.read({
        from: request.from,
        to: request.to,
        timezone: request.tz,
        ...(request.include === undefined ? {} : { include: request.include }),
      });
    });
  }

  async pullActivity(target: ActivityDetailTarget): Promise<ActivityDetail> {
    await this.syncNow();
    return this.serialNetwork(async () => {
      const detail = await getActivity(apiClient, target);
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
    await this.syncNow();
    await this.serialNetwork(async () => {
      const user = await getMe(apiClient);
      const today = systemClock.todayIn(user.timezone as TimeZone);
      const request = {
        from: today,
        to: addWallDays(today, 7),
        tz: user.timezone,
        include: 'reminders' as const,
      };
      const data = await getAgenda(apiClient, request);
      await this.transactions.run(async (transaction) => {
        await this.agenda.installCanonical(transaction, request, data);
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
      for (let count = 0; count < MAX_INTENTS_PER_PASS; count += 1) {
        const claimed = await this.transactions.run(async (transaction) => {
          const intent = await this.outbox.claimNext(transaction.database);
          if (intent !== undefined) transaction.changed('outbox');
          return intent;
        });
        if (claimed === undefined) break;
        const shouldContinue = await this.execute(claimed);
        if (!shouldContinue) break;
      }
    } while (this.requested);
  }

  private async execute(intent: OutboxIntent): Promise<boolean> {
    try {
      const response = await this.serialNetwork(() =>
        runIntent(this.queryClient, {
          ...intent,
          ownerUserId: this.ownerUserId,
        }),
      );
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
        const canonicalOccurrence =
          later === undefined ? canonicalOccurrenceResponse(intent, response) : undefined;
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
        } else if (later === undefined && activity !== undefined && !recurrencePatch) {
          await this.activities.acceptCanonicalResponse(transaction, activity);
          await transaction.database.run(
            `UPDATE agenda_rows SET title = ?, type = ?,
              status = CASE WHEN occurrence_date IS NULL THEN ? ELSE status END,
              local_state = 'canonical', canonical_version = ?
             WHERE activity_id = ?;`,
            [
              activity.title,
              activity.type,
              activity.status,
              activity.updatedAt,
              activity.activityId,
            ],
          );
          transaction.changed('agenda');
        }
        if (recurrencePatch) {
          await this.activities.setLocalState(transaction, intent.entityId, 'updating');
          await this.agenda.markActivityRows(transaction, intent.entityId, 'updating');
        }
        if (
          intent.mutationKey[0] === 'activity' &&
          intent.mutationKey[1] === 'reminder-create'
        ) {
          const input = (
            intent.variables as { input?: { reminderId?: unknown } } | undefined
          )?.input;
          if (typeof input?.reminderId === 'string') {
            await transaction.database.run(
              "UPDATE activity_reminders SET local_state = 'canonical' WHERE reminder_id = ?;",
              [input.reminderId],
            );
            transaction.changed(this.activities.scope(intent.entityId));
            transaction.changed('reminders');
          }
        }
        await this.outbox.acknowledge(
          transaction.database,
          intent.intentId,
          recurrencePatch ? activity?.updatedAt : undefined,
        );
        transaction.changed('outbox');
      });
      this.retryIndex = 0;
      return true;
    } catch (error) {
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
      return isPermanent(error);
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
