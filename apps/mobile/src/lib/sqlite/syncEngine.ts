import {
  ApiError,
  NetworkError,
  type PlansData,
  type PlansRequest,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import {
  type AgendaQuery,
  activityCompletionResult,
  activity as activitySchema,
  deletedActivityUpdate,
  listItemActivityLink,
  listItemView,
  listView,
  postActivityUpdateResult,
  scheduleActivityResult,
  timeZone,
} from '@od/shared/schemas';
import { systemClock, toWallTime } from '@od/shared/time';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  ActivityListItem,
  ActivityUpdatePage,
  AgendaData,
  List,
  Occurrence,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import {
  activityUpdateMutationKeys,
  changesRecurrenceTopology,
  isListItemProjectionMutation,
  isListMutation,
} from '@/lib/mutationKeys';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import {
  agendaCoverageForQuery,
  agendaQueryForCoverage,
  agendaQueryKey,
  latestNativeAgendaCoverage,
  nativeVisibleAgendaQuery,
} from '@/lib/sqlite/agendaCoverage';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { AnytimeRepository } from '@/lib/sqlite/anytimeRepository';
import type {
  ListItemPageState,
  ListItemRow,
  ListItemsRepository,
} from '@/lib/sqlite/listItemsRepository';
import type { ListsRepository } from '@/lib/sqlite/listsRepository';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import {
  type OutboxIntent,
  type OutboxRepository,
  undoOfferInverseIntentId,
} from '@/lib/sqlite/outbox';
import type { PlansRepository } from '@/lib/sqlite/plansRepository';
import type {
  SerializedTransactionRunner,
  TransactionContext,
} from '@/lib/sqlite/transaction';
import {
  type ActivityPullAdapter,
  sharedActivityPullAdapter,
} from '@/lib/sync/pullAdapter';
import {
  ActivityPushAdapter,
  type ActivityPushTransport,
  type ListPushTransport,
} from '@/lib/sync/pushAdapter';
import {
  RecurrenceReconciler,
  sharedTargetedAgendaTransport,
  type TargetedAgendaTransport,
} from '@/lib/sync/reconciliation';
import { field } from '@/lib/unknown';

export type NativeSyncReason =
  | 'accepted-action'
  | 'foreground'
  | 'connectivity'
  | 'manual'
  | 'retry';

export interface PreparedRejectedIntentRecovery {
  readonly targetState: 'present' | 'absent' | 'unchanged';
  install(transaction: TransactionContext): Promise<boolean>;
}

export interface NativeSyncEngine {
  request(reason: NativeSyncReason): void;
  syncNow(): Promise<void>;
  pullActivity(target: ActivityDetailTarget): Promise<ActivityDetail>;
  pullActivityUpdates?(activityId: string): Promise<ActivityUpdatePage>;
  pullPlans?(request: PlansRequest): Promise<PlansData>;
  pullAgenda(request: AgendaQuery): Promise<AgendaData>;
  pullReminderCoverage(): Promise<void>;
  prepareRejectedIntentRecovery(
    intentId: string,
  ): Promise<PreparedRejectedIntentRecovery | undefined>;
  recoverRejectedIntent(intentId: string): Promise<boolean>;
  pullAnytime?(): Promise<readonly ActivityListItem[]>;
  /** Drains every List pointer page and replaces the materialized index (P3-25). */
  pullLists?(): Promise<readonly List[]>;
  /** META plus the fenced first item page, replacing this list's projection (P3-27). */
  pullListDetail?(listId: string): Promise<void>;
  /** The next item page, merged into the projection page one installed. */
  pullListItemPage?(listId: string): Promise<void>;
  stop(): void;
}

const MAX_INTENTS_PER_PASS = 20;
const RETRY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000] as const;

/** Consecutive local failures before an intent parks for recovery instead of looping. */
const MAX_LOCAL_FAILURE_STREAK = 3;
const RETRY_EXHAUSTED_MESSAGE =
  "This change couldn't finish syncing. Retry it or discard it.";

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

/**
 * A failure that is neither transport loss nor a server answer.
 *
 * Transport loss (`NetworkError`) is queue state that must survive any amount of offline
 * time, and a server response — permanent or transient — is the server's to own. What is
 * left is local: a settlement invariant, a response-contract mismatch, a thrown string.
 * Those tend to repeat identically on every claim, and the 2026-08-31 poison-pill incident
 * is what an unbounded loop of them does to an ordering domain: it blocks it forever while
 * presenting as "Syncing…". Only an unbroken streak of these counts toward parking —
 * `attempts` alone cannot distinguish two offline claims from two identical local faults.
 */
function isLocalFailure(error: unknown): boolean {
  return !(error instanceof NetworkError) && !(error instanceof ApiError);
}

function localFailureFingerprint(error: Error, phase: 'push' | 'settlement'): string {
  return JSON.stringify([phase, error.name, error.message]);
}

function isRetryExhausted(intent: OutboxIntent): boolean {
  return (
    intent.attention?.kind === 'parked' && intent.attention.reason === 'retry_exhausted'
  );
}

function requiresAuthoritativeRecovery(intent: OutboxIntent): boolean {
  return intent.recoveryRequired === true || isRetryExhausted(intent);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Expected loss of transport is queue state, not a user-recoverable rejection. */
function queuedError(error: Error): string | undefined {
  return error instanceof NetworkError ? undefined : error.message;
}

function agendaRowCount(data: AgendaData): number {
  return data.days.reduce(
    (count, day) => count + day.schedule.length + day.anytime.length + day.earlier.length,
    0,
  );
}

function rejectedAttention(error: unknown, recoveryRequired: boolean) {
  const status = field(error, 'status');
  const code = field(error, 'code');
  const details = field(error, 'details');
  return {
    kind: 'rejected' as const,
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(details === undefined ? {} : { details }),
    ...(recoveryRequired ? { recoveryRequired: true as const } : {}),
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

/**
 * The canonical List out of an acknowledgement, whichever envelope it arrived in.
 *
 * A settings write answers `{ list, undoToken? }`; `POST /v1/lists` answers the List itself.
 * Falling back to the response — the shape `activityFromResponse` has always used — keeps one
 * reader for both rather than a per-mutation unwrapper, and a response that is neither still
 * fails to parse, which every caller already treats as a missing acknowledgement.
 */
function listFromResponse(response: unknown): List | undefined {
  const nested = field(response, 'list');
  const parsed = listView.safeParse(nested === undefined ? response : nested);
  return parsed.success ? (parsed.data as List) : undefined;
}

function listItemFromResponse(response: unknown): ListItemRow | undefined {
  const nested = field(response, 'item');
  const parsed = listItemView.safeParse(nested === undefined ? response : nested);
  return parsed.success ? (parsed.data as ListItemRow) : undefined;
}

/**
 * A fence, not a failure: repair, behaviour migration or a `rankVersion` change between the
 * cursor's issue and its use (§P3-27, criterion 36).
 *
 * The distinction is the whole of the recovery contract. A `409` is an edit conflict the user
 * has to resolve; this is the server saying the pages it was handing out belong to a
 * generation that no longer exists, and the answer is to keep what is committed, drop every
 * cursor and start again.
 */
function isItemPageFence(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 503;
}

/** The fence's own default, for a `503` that arrives without a `Retry-After` header. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
      parsed.activity.activityId !== intent.entityId ||
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
    parsed.activity.activityId !== intent.entityId ||
    (parsed.occurrence !== undefined &&
      (parsed.occurrence.activityId !== intent.entityId ||
        parsed.occurrence.date !== nominalDate))
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

/** A valid detail response that could not cross canonical freshness/local-write guards. */
export class CanonicalActivityInstallDeferredError extends Error {
  constructor(readonly activityId: string) {
    super("Latest details are still syncing. We'll retry automatically.");
    this.name = 'CanonicalActivityInstallDeferredError';
  }
}

export class SerializedNativeSyncEngine implements NativeSyncEngine {
  private running: Promise<Error | undefined> | undefined;
  private requested = false;
  private resetOrderingBlocks = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  private stopped = false;
  private networkTail: Promise<void> = Promise.resolve();
  private pullRequested = false;
  private pulling = false;
  private coverageSnapshotActive = false;
  private readonly activeCoverageKeys = new Set<string>();
  private readonly requestedCoverages = new Map<string, AgendaQuery>();
  private cycleError: Error | undefined;
  private anytimeRunning: Promise<readonly ActivityListItem[]> | undefined;
  private listsRunning: Promise<readonly List[]> | undefined;
  private readonly itemsRunning = new Map<string, Promise<void>>();
  private readonly push: ActivityPushAdapter;
  private readonly reconciler: RecurrenceReconciler;

  constructor(
    private readonly transactions: SerializedTransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
    pushTransport?: ActivityPushTransport,
    private readonly pull: ActivityPullAdapter = sharedActivityPullAdapter,
    private readonly targeted: TargetedAgendaTransport = sharedTargetedAgendaTransport,
    private readonly anytime?: AnytimeRepository,
    private readonly lists?: ListsRepository,
    listPushTransport?: ListPushTransport,
    private readonly listItems?: ListItemsRepository,
    private readonly plans?: PlansRepository,
  ) {
    this.push = new ActivityPushAdapter(pushTransport, listPushTransport);
    this.reconciler = new RecurrenceReconciler(
      transactions,
      outbox,
      activities,
      agenda,
      this.targeted,
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
      /*
       * An external wake is a new opportunity to retry ordering domains that failed earlier in
       * this drain. Keep that distinct from the internal MAX_INTENTS_PER_PASS continuation,
       * which must retain its blocked keys to avoid a hot loop.
       *
       * This signal is also load-bearing while a pull is running: reconnect may clear the only
       * retry timer, so dropping the wake here would leave durable queued writes asleep until
       * the next foreground or user action.
       */
      this.resetOrderingBlocks = true;
      this.requested = true;
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
    const nativeRequest = this.queueCoverage(request);
    await this.syncNow();
    return this.agenda.read(agendaCoverageForQuery(nativeRequest));
  }

  async pullActivity(target: ActivityDetailTarget): Promise<ActivityDetail> {
    /*
     * A targeted detail read must not wait for every remembered agenda window. The network
     * lane still orders it behind the request already on the wire, while enqueueing it here
     * lets it run before the next coverage pull. Repository guards prevent its response from
     * overwriting unresolved local work for this Activity.
     */
    const updatesVersion = this.activities.updatesVersion(target.activityId);
    let detail: ActivityDetail;
    try {
      detail = await this.serialNetwork((signal) => this.pull.activity(target, signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await this.transactions.run((transaction) =>
          this.activities.acceptCanonicalDeletion(transaction, target.activityId),
        );
      }
      throw error;
    }
    const accepted = await this.transactions.run((transaction) =>
      this.activities.putCanonical(transaction, detail, { updatesVersion }),
    );
    if (!accepted) {
      throw new CanonicalActivityInstallDeferredError(target.activityId);
    }
    const installed = await this.activities.read(target);
    if (installed === undefined)
      throw new PendingActivityDeletionError(target.activityId);
    return installed;
  }

  async pullActivityUpdates(activityId: string): Promise<ActivityUpdatePage> {
    const pullUpdates = this.pull.activityUpdates;
    if (pullUpdates === undefined)
      throw new Error('Native Updates transport is not ready.');
    const current = await this.activities.readUpdates(activityId);
    const cursor = current.cursor;
    if (cursor === undefined) return current;
    const page = await this.serialNetwork((signal) =>
      pullUpdates(activityId, cursor, signal),
    );
    await this.transactions.run((transaction) =>
      this.activities.installUpdatePage(transaction, activityId, cursor, page),
    );
    return this.activities.readUpdates(activityId);
  }

  async pullPlans(request: PlansRequest): Promise<PlansData> {
    const plans = this.plans;
    const pullPlans = this.pull.plans;
    if (plans === undefined || pullPlans === undefined) {
      throw new Error('Native Plans state is not ready.');
    }
    const data = await this.serialNetwork((signal) => pullPlans(request, signal));
    if (data.mode !== request.mode) {
      throw new Error('Native Plans response did not match its requested stage.');
    }
    await this.transactions.run((transaction) =>
      plans.install(transaction, request.tz, data),
    );
    return data;
  }

  /**
   * Restores one blocked write from the exact durable target before Retry or Discard may
   * retire it. Permanent rejection and locally exhausted ambiguous settlement share the same
   * authoritative read, but retain their distinct persisted attention reasons.
   * Activity detail and every retained Agenda coverage are fetched first, then installed with
   * the receipt transition in one writer transaction. A version mismatch or partial read leaves
   * recoveryRequired intact so neither restart nor another pull can bless stale local data.
   */
  async recoverRejectedIntent(intentId: string): Promise<boolean> {
    const prepared = await this.prepareRejectedIntentRecovery(intentId);
    if (prepared === undefined) return false;
    return this.transactions.run((transaction) => prepared.install(transaction));
  }

  /**
   * Fetches authoritative recovery outside SQLite, then returns a guarded installer. The action
   * coordinator runs that installer in the same writer transaction as Retry/Discard and FIFO
   * reprojection, so subscribers never observe canonical truth with later local writes missing.
   */
  async prepareRejectedIntentRecovery(
    intentId: string,
  ): Promise<PreparedRejectedIntentRecovery | undefined> {
    const intent = await this.transactions.run((transaction) =>
      this.outbox.get(transaction.database, intentId),
    );
    if (intent?.status !== 'needs_attention') {
      return undefined;
    }
    if (intent.mutationKey[0] === 'list') {
      if (isRetryExhausted(intent) && intent.mutationKey[1].startsWith('item-')) {
        return this.prepareListItemAttention(intent);
      }
      // A rejected item create rolled its own row back already, with no read to repeat and
      // no List index to refresh. A rejected edit may still owe one (P3-29).
      if (intent.mutationKey[1] === 'item-create') {
        return this.noopPreparedRecovery(intent, 'absent');
      }
      if (isListMutation(intent, 'itemUndo')) {
        return this.noopPreparedRecovery(intent, 'unchanged');
      }
      if (intent.mutationKey[1] === 'item-patch') {
        return this.prepareListItemAttention(intent);
      }
      return this.prepareRejectedListIntent(intent);
    }
    if (!requiresAuthoritativeRecovery(intent)) return undefined;
    const occurrenceDate = occurrenceDateFromIntent(intent);
    const target: ActivityDetailTarget =
      occurrenceDate === undefined
        ? { kind: 'activity', activityId: intent.entityId }
        : { kind: 'occurrence', activityId: intent.entityId, date: occurrenceDate };
    try {
      let detail: ActivityDetail | undefined;
      let activityMissing = false;
      let occurrenceMissing = false;
      try {
        detail = await this.serialNetwork((signal) => this.pull.activity(target, signal));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        if (occurrenceDate === undefined) {
          activityMissing = true;
        } else {
          try {
            detail = await this.serialNetwork((signal) =>
              this.pull.activity(
                { kind: 'activity', activityId: intent.entityId },
                signal,
              ),
            );
            occurrenceMissing = true;
          } catch (parentError) {
            if (!(parentError instanceof ApiError) || parentError.status !== 404) {
              throw parentError;
            }
            activityMissing = true;
          }
        }
      }

      if (activityMissing) {
        return {
          targetState: 'absent',
          install: async (transaction) => {
            const current = await this.outbox.get(transaction.database, intentId);
            if (
              current?.status !== 'needs_attention' ||
              !requiresAuthoritativeRecovery(current) ||
              current.entityId !== intent.entityId ||
              occurrenceDateFromIntent(current) !== occurrenceDate
            ) {
              return false;
            }
            await this.activities.restoreCanonicalAbsenceAfterRejection(
              transaction,
              intent.entityId,
            );
            if (
              current.recoveryRequired === true &&
              !(await this.outbox.completeAuthoritativeRecovery(
                transaction.database,
                intentId,
              ))
            ) {
              throw new Error(
                'The authoritative recovery receipt changed during installation.',
              );
            }
            transaction.changed('outbox');
            return true;
          },
        };
      }

      if (detail === undefined) return undefined;
      if (
        detail.activity.activityId !== intent.entityId ||
        (occurrenceDate !== undefined &&
          !occurrenceMissing &&
          detail.occurrence?.nominalDate !== occurrenceDate)
      ) {
        return undefined;
      }
      const coverages = latestNativeAgendaCoverage(await this.agenda.coverage());
      const coverageKeys = new Set(
        coverages.map((coverage) => agendaQueryKey(agendaQueryForCoverage(coverage))),
      );
      const responses: Array<{
        readonly request: AgendaQuery;
        readonly data: Awaited<ReturnType<TargetedAgendaTransport['load']>>;
      }> = [];
      for (const coverage of coverages) {
        const request = agendaQueryForCoverage(coverage);
        const data = await this.serialNetwork((signal) =>
          this.targeted.load(intent.entityId, request, signal),
        );
        if (
          data.activityId !== intent.entityId ||
          data.activityVersion !== detail.activity.updatedAt
        ) {
          return undefined;
        }
        responses.push({ request, data });
      }
      const now = systemClock.now();
      return {
        targetState: 'present',
        install: async (transaction) => {
          const current = await this.outbox.get(transaction.database, intentId);
          if (
            current?.status !== 'needs_attention' ||
            !requiresAuthoritativeRecovery(current) ||
            current.entityId !== intent.entityId ||
            occurrenceDateFromIntent(current) !== occurrenceDate
          ) {
            return false;
          }
          const currentCoverageKeys = new Set(
            latestNativeAgendaCoverage(
              await this.agenda.coverage(transaction.database),
            ).map((coverage) => agendaQueryKey(agendaQueryForCoverage(coverage))),
          );
          if (
            currentCoverageKeys.size !== coverageKeys.size ||
            [...currentCoverageKeys].some((key) => !coverageKeys.has(key))
          ) {
            return false;
          }
          if (
            !(await this.activities.restoreCanonicalAfterRejection(transaction, detail))
          ) {
            return false;
          }
          if (occurrenceMissing && occurrenceDate !== undefined) {
            await this.activities.restoreCanonicalOccurrenceAbsenceAfterRejection(
              transaction,
              intent.entityId,
              occurrenceDate,
            );
            await this.agenda.removeCanonicalOccurrenceAfterRejection(
              transaction,
              intent.entityId,
              occurrenceDate,
            );
          }
          for (const response of responses) {
            const zone = timeZone.parse(response.request.tz);
            await this.agenda.replaceCanonicalActivityRows(
              transaction,
              response.request,
              response.data,
              {
                today: systemClock.todayIn(zone),
                currentMinute: toWallTime(now, zone),
              },
            );
          }
          await this.anytime?.acceptCanonicalActivity(transaction, detail.activity);
          if (
            current.recoveryRequired === true &&
            !(await this.outbox.completeAuthoritativeRecovery(
              transaction.database,
              intentId,
            ))
          ) {
            throw new Error(
              'The authoritative recovery receipt changed during installation.',
            );
          }
          transaction.changed('outbox');
          return true;
        },
      };
    } catch (error) {
      if (__DEV__) {
        console.warn('native_rejected_intent_recovery_failed', {
          intentId,
          message: message(error),
        });
      }
      return undefined;
    }
  }

  async pullReminderCoverage(): Promise<void> {
    const user = await this.serialNetwork((signal) => this.pull.profile(signal));
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
    await this.syncNow();
  }

  async pullAnytime(): Promise<readonly ActivityListItem[]> {
    if (this.anytimeRunning !== undefined) return this.anytimeRunning;
    const running = this.loadAnytime();
    this.anytimeRunning = running;
    try {
      return await running;
    } finally {
      if (this.anytimeRunning === running) this.anytimeRunning = undefined;
    }
  }

  private async loadAnytime(): Promise<readonly ActivityListItem[]> {
    const anytime = this.anytime;
    const pullAnytimePage = this.pull.anytimePage;
    if (anytime === undefined || pullAnytimePage === undefined) {
      throw new Error('Native Anytime state is not ready.');
    }
    const items: ActivityListItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.serialNetwork((signal) => pullAnytimePage(cursor, signal));
      items.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error('Anytime pagination returned a repeated cursor.');
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    await this.transactions.run((transaction) =>
      anytime.replaceCanonical(transaction, items),
    );
    return anytime.read();
  }

  /**
   * The Lists index (P3-25). Single-flighted exactly as {@link pullAnytime} is, so a focus
   * effect and a pull-to-refresh arriving together share one drain rather than racing two.
   */
  async pullLists(): Promise<readonly List[]> {
    if (this.listsRunning !== undefined) return this.listsRunning;
    const running = this.loadLists();
    this.listsRunning = running;
    try {
      return await running;
    } finally {
      if (this.listsRunning === running) this.listsRunning = undefined;
    }
  }

  /**
   * Drains **every** pointer page before writing anything.
   *
   * The endpoint pages access pointers without filtering by `archived`, so a partial drain
   * cannot be materialized honestly: the index would hold a prefix of an order it presents as
   * complete, and the screen's `No lists yet` rule — legal only after cursor exhaustion — would
   * be deciding on a set that was still arriving. One transaction at the end also means a
   * subscriber sees the previous index or the next one, never a half-written one.
   */
  private async loadLists(): Promise<readonly List[]> {
    const lists = this.lists;
    const pullListsPage = this.pull.listsPage;
    if (lists === undefined || pullListsPage === undefined) {
      throw new Error('Native Lists state is not ready.');
    }
    const rows = await this.pullAllLists();
    await this.transactions.run(async (transaction) => {
      const protectedListIds = await this.outbox.protectedListIds(transaction.database);
      const protectedAggregateIds = await this.outbox.protectedListAggregateIds(
        transaction.database,
      );
      await lists.replaceCanonical(
        transaction,
        rows,
        protectedListIds,
        protectedAggregateIds,
      );
    });
    return lists.read();
  }

  /**
   * Installs page one, replacing whatever this device held for the list (§P3-27).
   *
   * Page one is the only page whose arrival proves the projection it belongs to is current,
   * which is why it replaces and every later page merges. A fence answers by keeping the
   * committed rows, discarding every cursor, waiting the server's `Retry-After` and asking
   * once more — and installing nothing at all until that succeeds.
   */
  async pullListDetail(listId: string): Promise<void> {
    return this.singleFlightItems(listId, async () => {
      try {
        await this.installFirstItemPage(listId);
      } catch (error) {
        if (!isItemPageFence(error)) throw error;
        await this.discardItemCursors(listId);
        await sleep(
          error.retryAfterSeconds === undefined
            ? DEFAULT_RETRY_AFTER_MS
            : error.retryAfterSeconds * 1000,
        );
        await this.installFirstItemPage(listId);
      }
    });
  }

  /**
   * The next page, merged by `itemId`.
   *
   * A fence here is the same contract from further in: the pages already committed stay, the
   * cursor that produced this failure is discarded along with every other, and recovery
   * restarts at page one rather than splicing a post-repair page into pre-repair ones.
   */
  async pullListItemPage(listId: string): Promise<void> {
    return this.singleFlightItems(listId, async () => {
      const items = this.requireItems();
      const page = await items.pageState(listId);
      const cursor = page?.nextCursor;
      if (cursor === undefined) return;
      try {
        await this.mergeNextItemPage(listId, cursor);
      } catch (error) {
        if (!isItemPageFence(error)) throw error;
        await this.discardItemCursors(listId);
        await sleep(
          error.retryAfterSeconds === undefined
            ? DEFAULT_RETRY_AFTER_MS
            : error.retryAfterSeconds * 1000,
        );
        await this.installFirstItemPage(listId);
      }
    });
  }

  private async installFirstItemPage(listId: string): Promise<void> {
    const items = this.requireItems();
    const lists = this.lists;
    const pullDetail = this.pull.listDetail;
    if (lists === undefined || pullDetail === undefined) {
      throw new Error('Native list item state is not ready.');
    }
    const detail = await this.serialNetwork((signal) => pullDetail(listId, signal));
    const page: ListItemPageState = {
      rankVersion: detail.list.rankVersion,
      ...(detail.nextCursor === undefined ? {} : { nextCursor: detail.nextCursor }),
      complete: detail.nextCursor === undefined,
    };
    await this.transactions.run(async (transaction) => {
      const protectedItemIds = await this.outbox.protectedListItemIds(
        listId,
        transaction.database,
      );
      const protectedListIds = await this.outbox.protectedListIds(transaction.database);
      const protectedAggregateIds = await this.outbox.protectedListAggregateIds(
        transaction.database,
      );
      if (!protectedListIds.has(listId)) {
        await lists.installCanonicalRow(
          transaction,
          detail.list,
          protectedAggregateIds.has(listId),
        );
      }
      await items.replaceFirstPage(
        transaction,
        listId,
        detail.items,
        page,
        protectedItemIds,
      );
    });
  }

  private async mergeNextItemPage(listId: string, cursor: string): Promise<void> {
    const items = this.requireItems();
    const pullPage = this.pull.listItemsPage;
    if (pullPage === undefined) throw new Error('Native list item state is not ready.');
    const next = await this.serialNetwork((signal) => pullPage(listId, cursor, signal));
    await this.transactions.run(async (transaction) => {
      /*
       * Re-read inside the writer: the cursor may have been discarded by a fence recovery
       * while this page was in flight, and merging into a projection that no longer expects
       * it is precisely the splice the contract forbids.
       */
      const current = await items.pageState(listId, transaction.database);
      if (current?.nextCursor !== cursor) return;
      const protectedItemIds = await this.outbox.protectedListItemIds(
        listId,
        transaction.database,
      );
      await items.mergePage(
        transaction,
        listId,
        next.items,
        {
          rankVersion: current.rankVersion,
          ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }),
          complete: next.nextCursor === undefined,
        },
        protectedItemIds,
      );
    });
  }

  private async discardItemCursors(listId: string): Promise<void> {
    const items = this.requireItems();
    await this.transactions.run((transaction) =>
      items.invalidatePages(transaction, listId),
    );
  }

  /** One drain per list at a time, so a focus effect and a scroll cannot race two pages in. */
  private singleFlightItems(listId: string, task: () => Promise<void>): Promise<void> {
    const running = this.itemsRunning.get(listId);
    if (running !== undefined) return running;
    const started = task().finally(() => {
      if (this.itemsRunning.get(listId) === started) this.itemsRunning.delete(listId);
    });
    this.itemsRunning.set(listId, started);
    return started;
  }

  private requireItems(): ListItemsRepository {
    if (this.listItems === undefined) {
      throw new Error('Native list item state is not ready.');
    }
    return this.listItems;
  }

  private requireListTransactions(): ListTransactionService {
    if (this.lists === undefined) {
      throw new Error('Native Lists state is not ready.');
    }
    return new ListTransactionService(this.outbox, this.lists, this.requireItems());
  }

  private async pullAllLists(): Promise<readonly List[]> {
    const pullListsPage = this.pull.listsPage;
    if (pullListsPage === undefined)
      throw new Error('Native Lists transport is not ready.');
    const rows: List[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.serialNetwork((signal) => pullListsPage(cursor, signal));
      rows.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        // A server that repeats a cursor would page for ever; the Anytime drain guards the
        // same way, and an unbounded loop here would hold the serialized network queue open.
        if (seenCursors.has(cursor)) {
          throw new Error('Lists pagination returned a repeated cursor.');
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return rows;
  }

  stop(): void {
    this.stopped = true;
    this.requested = false;
    this.resetOrderingBlocks = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async drain(): Promise<void> {
    /* A transient failure blocks its ordering domain for this cycle, including cap continuations. */
    const blockedOrderingKeys = new Set<string>();
    do {
      this.requested = false;
      if (this.resetOrderingBlocks) {
        blockedOrderingKeys.clear();
        this.resetOrderingBlocks = false;
      }
      let claimedCount = 0;
      for (let count = 0; count < MAX_INTENTS_PER_PASS; count += 1) {
        const claimed = await this.transactions.run(async (transaction) => {
          const intent = await this.outbox.claimNext(
            transaction.database,
            Date.now(),
            blockedOrderingKeys,
          );
          /* claimNext also advances durable clock/expiry state when no intent is claimable. */
          transaction.changed('outbox');
          return intent;
        });
        if (claimed === undefined) break;
        claimedCount += 1;
        const outcome = await this.execute(claimed);
        if (outcome === 'blocked') blockedOrderingKeys.add(claimed.orderingKey);
      }
      /*
       * Consuming the bound is a level signal: more work may already be durable. Continue with
       * another bounded pass without waiting for a lifecycle edge. If the cap landed exactly on
       * the tail, the next claim returns empty once and exits; blocked keys remain excluded, so
       * this cannot spin on transient/backoff work.
       */
      if (claimedCount === MAX_INTENTS_PER_PASS) this.requested = true;
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
          this.coverageSnapshotActive = false;
          this.activeCoverageKeys.clear();
        });
        if (pullError !== undefined) {
          this.cycleError = pullError;
          this.scheduleRetry();
        }
      }
    } while (this.requested);
  }

  private async execute(intent: OutboxIntent): Promise<'continue' | 'blocked'> {
    const startedAt = Date.now();
    let phase: 'push' | 'settlement' = 'push';
    try {
      const response = await this.serialNetwork((signal) =>
        this.push.execute(intent, signal),
      );
      if (
        intent.mutationKey[0] === 'activity' &&
        (intent.mutationKey[1] === activityUpdateMutationKeys.post[1] ||
          intent.mutationKey[1] === activityUpdateMutationKeys.delete[1])
      ) {
        phase = 'settlement';
        await this.transactions.run(async (transaction) => {
          if (intent.mutationKey[1] === activityUpdateMutationKeys.post[1]) {
            const parsed = postActivityUpdateResult.parse(response);
            await this.activities.settlePostedUpdate(
              transaction,
              intent.intentId,
              parsed,
            );
          } else {
            const parsed = deletedActivityUpdate.parse(response);
            const expected = field(intent.variables, 'updateId');
            if (parsed.updateId !== expected) {
              throw new Error('Update deletion acknowledged a different entry.');
            }
            await this.activities.settleDeletedUpdate(
              transaction,
              intent.intentId,
              intent.entityId,
              parsed.updateId,
            );
          }
          await this.outbox.acknowledge(transaction.database, intent.intentId);
          transaction.changed('outbox');
        });
        this.retryIndex = 0;
        return 'continue';
      }
      if (isListMutation(intent, 'itemSchedule')) {
        /*
         * The bridge settles like an Activity create wearing a list key (P3-34): the response
         * carries the created Plan, the item is byte-identical by contract, and the caller's
         * `viewerLink` is joined into later list-detail reads rather than stored here. The
         * detail pull is the create path's best-effort enrichment, reminders included.
         */
        const pushedPlan = activityFromResponse(response);
        if (pushedPlan?.activityId !== intent.entityId) {
          throw new Error('The bridge acknowledged a different Activity.');
        }
        let planDetail: ActivityDetail | undefined;
        try {
          const detail = await this.serialNetwork((signal) =>
            this.pull.activity({ kind: 'activity', activityId: intent.entityId }, signal),
          );
          if (detail.activity.activityId === intent.entityId) planDetail = detail;
        } catch (error) {
          if (__DEV__) {
            console.info('native_bridge_detail_prefetch_failed', {
              activityId: intent.entityId,
              message: message(error),
            });
          }
        }
        phase = 'settlement';
        await this.transactions.run(async (transaction) => {
          await this.activities.installAcknowledgedActivity(
            transaction,
            pushedPlan,
            planDetail,
            { preserveLocalReminders: false },
          );
          await this.agenda.acceptCanonicalActivitySummary(transaction, pushedPlan);
          await this.anytime?.acceptCanonicalActivity(transaction, pushedPlan);
          /*
           * The transaction that created the Plan also wrote the caller's `LNK#`, and the
           * response carries it back. Installing the pair here is what lets the row's state
           * line render before the next detail pull (P3-35); the trimmed `viewerPlan` is the
           * projection contract's exact three fields, derived from the Plan just installed.
           */
          const link = listItemActivityLink.safeParse(field(response, 'viewerLink'));
          if (
            link.success &&
            pushedPlan.objectKind === 'plan' &&
            this.listItems !== undefined
          ) {
            await this.listItems.setViewerPair(
              transaction,
              link.data.listId,
              link.data.itemId,
              {
                viewerLink: link.data,
                viewerPlan: {
                  type: pushedPlan.type,
                  status: pushedPlan.status,
                  ...(pushedPlan.schedule === undefined
                    ? {}
                    : { schedule: pushedPlan.schedule }),
                },
              },
            );
          }
          await this.outbox.acknowledge(transaction.database, intent.intentId);
          transaction.changed('outbox');
        });
        this.retryIndex = 0;
        return 'continue';
      }
      if (intent.mutationKey[0] === 'list') {
        phase = 'settlement';
        const canonicalRows =
          intent.mutationKey[1] === 'undo' ? await this.pullAllLists() : undefined;
        let canonicalItem: ListItemRow | undefined;
        if (
          isListMutation(intent, 'itemUndo') &&
          field(response, 'outcome') === 'applied'
        ) {
          const listId = field(intent.variables, 'listId');
          const pullItem = this.pull.listItem;
          if (typeof listId !== 'string' || pullItem === undefined) {
            throw new Error('Native list item state is not ready.');
          }
          canonicalItem = await this.serialNetwork((signal) =>
            pullItem(listId, intent.entityId, signal),
          );
          if (canonicalItem.itemId !== intent.entityId) {
            throw new Error('List item Undo restored a different item.');
          }
        }
        await this.settleListIntent(intent, response, canonicalRows, canonicalItem);
        this.retryIndex = 0;
        return 'continue';
      }
      const pushedActivity = activityFromResponse(response);
      let createdDetail: ActivityDetail | undefined;
      if (
        intent.mutationKey[0] === 'activity' &&
        intent.mutationKey[1] === 'create' &&
        pushedActivity?.activityId === intent.entityId
      ) {
        try {
          const detail = await this.serialNetwork((signal) =>
            this.pull.activity({ kind: 'activity', activityId: intent.entityId }, signal),
          );
          if (detail.activity.activityId === intent.entityId) createdDetail = detail;
          else if (__DEV__) {
            console.warn('native_create_detail_identity_mismatch', {
              expectedActivityId: intent.entityId,
              returnedActivityId: detail.activity.activityId,
            });
          }
        } catch (error) {
          /*
           * The create has already succeeded. Detail enrichment is deliberately best-effort:
           * a briefly stale or unavailable read must not redispatch or permanently reject the
           * durable create. The detail hook retains its existing targeted-read fallback.
           */
          if (__DEV__) {
            console.info('native_create_detail_prefetch_failed', {
              activityId: intent.entityId,
              message: message(error),
            });
          }
        }
      }
      phase = 'settlement';
      await this.transactions.run(async (transaction) => {
        const later = await this.outbox.laterInOrdering(
          transaction.database,
          intent.orderingKey,
          intent.seq,
        );
        const hasLater = later.length > 0;
        const recurrenceMutation = changesRecurrenceTopology(intent);
        const activity = pushedActivity;
        if (recurrenceMutation && activity === undefined) {
          throw new Error('Recurrence acknowledgement omitted its Activity.');
        }
        const laterOnlyTouchesReminders = later.every(
          (candidate) =>
            candidate.mutationKey[1] === 'reminder-create' ||
            candidate.mutationKey[1] === 'reminder-delete',
        );
        const canInstallThroughLaterIntents = !hasLater || laterOnlyTouchesReminders;
        let canonicalOccurrence: CanonicalOccurrenceResponse | undefined;
        if (canInstallThroughLaterIntents) {
          try {
            canonicalOccurrence = canonicalOccurrenceResponse(intent, response);
          } catch (contractError) {
            /*
             * The server already accepted this durable action, so redispatching cannot
             * repair a response that violates the occurrence contract — it only loops
             * the claim. Acknowledge, install at most the matching activity-level
             * result, and leave that occurrence's presentation to the next pull.
             */
            console.warn(
              'outbox_response_contract_mismatch',
              intent.mutationKey.join('.'),
              message(contractError),
            );
          }
        }
        const installable =
          activity?.activityId === intent.entityId ? activity : undefined;
        const agendaTopologyMutation =
          recurrenceMutation ||
          intent.mutationKey[1] === 'create' ||
          intent.mutationKey[1] === 'schedule';
        if (canonicalOccurrence !== undefined && canInstallThroughLaterIntents) {
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
        } else if (
          canInstallThroughLaterIntents &&
          installable !== undefined &&
          !recurrenceMutation
        ) {
          await this.activities.installAcknowledgedActivity(
            transaction,
            installable,
            createdDetail,
            { preserveLocalReminders: hasLater },
          );
          await this.agenda.acceptCanonicalActivitySummary(transaction, installable);
        }
        // The parent's Prep projection follows the child on the same terms as the child
        // itself: a later queued intent for this child owns its status until it settles.
        if (
          canInstallThroughLaterIntents &&
          installable !== undefined &&
          (intent.mutationKey[1] === 'complete' || intent.mutationKey[1] === 'uncomplete')
        ) {
          await this.activities.acceptCanonicalChildStatus(transaction, installable);
        }
        if (recurrenceMutation && activity !== undefined && laterOnlyTouchesReminders) {
          await this.activities.installAcknowledgedActivity(
            transaction,
            activity,
            undefined,
            {
              preserveLocalReminders: hasLater,
            },
          );
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
        if (canInstallThroughLaterIntents && this.anytime !== undefined) {
          if (intent.mutationKey[1] === 'delete') {
            await this.anytime.removeCanonical(transaction, intent.entityId);
          } else if (installable !== undefined) {
            await this.anytime.acceptCanonicalActivity(transaction, installable);
          }
        }
        if (installable !== undefined) {
          await this.outbox.rebaseNextQueuedPatch(
            transaction.database,
            intent.orderingKey,
            intent.seq,
            installable.updatedAt,
          );
          if (agendaTopologyMutation) {
            await this.agenda.recordProjectionFence(
              transaction,
              intent.entityId,
              installable.updatedAt,
            );
          }
        }
        await this.outbox.acknowledge(
          transaction.database,
          intent.intentId,
          recurrenceMutation ? activity?.updatedAt : undefined,
        );
        transaction.changed('outbox');
      });
      if (__DEV__) {
        console.info('native_outbox_intent_settled', {
          intentId: intent.intentId,
          mutation: intent.mutationKey.join('.'),
          activityId: intent.entityId,
          durationMs: Date.now() - startedAt,
        });
      }
      this.retryIndex = 0;
      return 'continue';
    } catch (error) {
      /*
       * Metro's Hermes transform does not reliably retain a catch binding inside the nested
       * async transaction below. Copy it into the generator's function scope before crossing
       * that boundary; otherwise an offline request leaves the intent in-flight and raises
       * `ReferenceError: Property 'error' doesn't exist`.
       */
      const failure = error instanceof Error ? error : new Error(String(error));
      const permanent = isPermanent(failure);
      const localStreak = await this.transactions.run(async (transaction) => {
        const count =
          !permanent && isLocalFailure(failure)
            ? await this.outbox.recordLocalFailure(
                transaction.database,
                intent.intentId,
                localFailureFingerprint(failure, phase),
              )
            : 0;
        if (count === 0) {
          await this.outbox.clearLocalFailure(transaction.database, intent.intentId);
        }
        transaction.changed('outbox');
        return count;
      });
      if (__DEV__) {
        console.warn('native_outbox_intent_failed', {
          intentId: intent.intentId,
          mutation: intent.mutationKey.join('.'),
          activityId: intent.entityId,
          phase,
          permanent,
          attempts: intent.attempts,
          localStreak,
          durationMs: Date.now() - startedAt,
          message: failure.message,
        });
      }
      const collision = await this.recoverCreateCollision(intent, failure);
      if (collision === 'recovered' || collision === 'parked') return 'continue';
      if (collision === 'retry') return 'blocked';
      /*
       * An unbroken streak of local failures parks, and only parks. It is not a server
       * verdict — the request may even have succeeded remotely before settlement threw —
       * so nothing here rolls local state back or labels the intent `rejected`; the
       * optimistic projection stays, the recovery banner offers Retry and Discard, and
       * `claimNext` keeps the rest of this ordering domain waiting behind it exactly as
       * it would behind any other `needs_attention` predecessor.
       */
      if (localStreak >= MAX_LOCAL_FAILURE_STREAK) {
        this.cycleError ??= failure;
        await this.transactions.run(async (transaction) => {
          await this.outbox.needsAttention(
            transaction.database,
            intent.intentId,
            { kind: 'parked', reason: 'retry_exhausted' },
            RETRY_EXHAUSTED_MESSAGE,
          );
          transaction.changed('outbox');
        });
        return 'continue';
      }
      const supersededByDelete =
        permanent &&
        intent.mutationKey[0] === 'list' &&
        intent.mutationKey[1] === 'item-patch' &&
        (await this.transactions.run(async (transaction) =>
          (
            await this.outbox.laterInOrdering(
              transaction.database,
              intent.orderingKey,
              intent.seq,
            )
          ).some(
            (candidate) =>
              candidate.entityId === intent.entityId &&
              isListMutation(candidate, 'itemDelete'),
          ),
        ));
      const compensatedDelete =
        permanent &&
        isListMutation(intent, 'itemDelete') &&
        (await this.transactions.run(async (transaction) => {
          const offer = await this.outbox.listItemDeleteUndoOffer(
            transaction.database,
            intent.intentId,
          );
          return offer !== undefined && undoOfferInverseIntentId(offer) !== undefined;
        }));
      if (permanent) {
        const resolvedByDelete = supersededByDelete
          ? await this.rollbackPermanentItemPatchRejection(intent, failure, true)
          : false;
        if (!supersededByDelete) {
          await this.rollbackPermanentRejection(intent, failure);
        }
        if (!resolvedByDelete && !compensatedDelete) this.cycleError ??= failure;
      } else {
        this.cycleError ??= failure;
        await this.transactions.run(async (transaction) => {
          await this.outbox.requeue(
            transaction.database,
            intent.intentId,
            queuedError(failure),
          );
          transaction.changed('outbox');
        });
      }
      if (!permanent) this.scheduleRetry();
      return permanent ? 'continue' : 'blocked';
    }
  }

  private async settleListIntent(
    intent: OutboxIntent,
    response: unknown,
    canonicalRows?: readonly List[],
    canonicalItem?: ListItemRow,
  ): Promise<void> {
    const lists = this.lists;
    if (lists === undefined) throw new Error('Native Lists state is not ready.');
    await this.transactions.run(async (transaction) => {
      const later = await this.outbox.laterInOrdering(
        transaction.database,
        intent.orderingKey,
        intent.seq,
      );
      if (
        intent.mutationKey[1] === 'item-create' ||
        intent.mutationKey[1] === 'item-patch'
      ) {
        const item = listItemFromResponse(response);
        if (item?.itemId !== intent.entityId) {
          throw new Error('A list item write acknowledged a different item.');
        }
        /*
         * Server truth over the optimistic row, for both writes and for the same reason: the
         * create's allocated rank and resolved provenance, and the patch's server-decided
         * result — including whatever a concurrent member changed in the fields this edit did
         * not touch. Later queued work for this list owns the row afterwards through its own
         * settlement, exactly as the List branches below arrange.
         */
        const laterOwnsItem = later.some(
          (candidate) =>
            candidate.entityId === intent.entityId &&
            isListItemProjectionMutation(candidate),
        );
        if (!laterOwnsItem) {
          await this.requireListTransactions().installCanonicalItem(transaction, item);
        }
        if (intent.mutationKey[1] === 'item-patch') {
          await this.outbox.rebaseNextListItemDeleteSnapshot(
            transaction.database,
            intent.orderingKey,
            intent.seq,
            intent.entityId,
            item,
          );
        }
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        transaction.changed('outbox');
        return;
      }
      if (isListMutation(intent, 'itemDelete')) {
        const offer = await this.outbox.listItemDeleteUndoOffer(
          transaction.database,
          intent.intentId,
        );
        const affectedCount = field(response, 'affectedCount');
        if (affectedCount === 0) {
          const inverseIntentId =
            offer === undefined ? undefined : undoOfferInverseIntentId(offer);
          if (offer !== undefined && inverseIntentId !== undefined) {
            await this.requireListTransactions().removeItem(
              transaction,
              offer.listId,
              offer.itemId,
            );
            await this.outbox.acknowledge(transaction.database, inverseIntentId);
          }
          if (offer !== undefined) {
            await this.outbox.clearListItemDeleteUndoOffer(
              transaction.database,
              offer.originalIntentId,
            );
          }
          await this.outbox.acknowledge(transaction.database, intent.intentId);
          transaction.changed('outbox');
          return;
        }
        if (offer !== undefined) {
          const undoToken = field(response, 'undoToken');
          const undoExpiresAt = field(response, 'undoExpiresAt');
          if (typeof undoToken !== 'string' || typeof undoExpiresAt !== 'string') {
            throw new Error('List item delete acknowledgement omitted its Undo receipt.');
          }
          await this.outbox.recordListItemDeleteUndoToken(
            transaction.database,
            intent.intentId,
            undoToken,
            undoExpiresAt,
          );
        }
        /* The row left SQLite when the intent was accepted; acknowledgement only retires its
         * resurrection guard and releases an accepted dependent Undo. */
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        transaction.changed('outbox');
        return;
      }
      if (isListMutation(intent, 'itemUndo')) {
        const outcome = field(response, 'outcome');
        const originalIntentId = field(intent.variables, 'originalIntentId');
        const listId = field(intent.variables, 'listId');
        if (
          (outcome !== 'applied' &&
            outcome !== 'expired' &&
            outcome !== 'no_longer_applicable') ||
          typeof originalIntentId !== 'string' ||
          typeof listId !== 'string'
        ) {
          throw new Error('List item Undo acknowledgement is malformed.');
        }
        if (outcome !== 'applied') {
          await this.requireListTransactions().removeItem(
            transaction,
            listId,
            intent.entityId,
          );
        } else {
          if (canonicalItem === undefined) {
            throw new Error('List item Undo omitted its canonical restored item.');
          }
          const laterOwnsItem = later.some(
            (candidate) =>
              candidate.entityId === intent.entityId &&
              isListItemProjectionMutation(candidate),
          );
          if (!laterOwnsItem) {
            await this.requireListTransactions().installCanonicalItem(
              transaction,
              canonicalItem,
            );
          }
        }
        await this.outbox.clearListItemDeleteUndoOffer(
          transaction.database,
          originalIntentId,
        );
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        transaction.changed('outbox');
        return;
      }
      const canonical = listFromResponse(response);
      if (intent.mutationKey[1] === 'create') {
        if (canonical?.listId !== intent.entityId) {
          throw new Error('List creation acknowledged a different list.');
        }
        /*
         * Server truth replaces the optimistic copy — `ownerId`, the real timestamps and the
         * behaviour/capabilities/icon/empty-state values the server resolved from the
         * catalogue itself. A later local write for this list owns the row instead; its own
         * settlement installs what the server made of it.
         */
        if (later.length === 0) await lists.installCanonicalRow(transaction, canonical);
        await this.outbox.rebaseNextQueuedListPatch(
          transaction.database,
          intent.orderingKey,
          intent.seq,
          canonical.updatedAt,
        );
      } else if (intent.mutationKey[1] === 'patch') {
        if (canonical?.listId !== intent.entityId) {
          throw new Error('List settings acknowledgement omitted its canonical List.');
        }
        if (later.length === 0) {
          /*
           * A behaviour change installs the **whole** canonical row, not the settings subset:
           * it moves `behaviour` and advances `rankVersion`, and `applySettings` writes
           * neither. A settings PATCH keeps the subset for its own reason — it must not
           * restate fields it never touched.
           */
          await lists.applySettings(transaction, canonical);
        }
        /*
         * The offer's existence is what says an Undo was promised, not a re-reading of the
         * payload. `patchSettings` and `changeBehaviour` decide that at enqueue time — every
         * additive settings change records one, a rename and a confirmed destructive downgrade
         * do not — so the settlement only has to install the token the offer is waiting for.
         */
        const offer = await this.outbox.listArchiveUndoOffer(
          transaction.database,
          intent.intentId,
        );
        if (offer !== undefined) {
          const undoToken = field(response, 'undoToken');
          const undoExpiresAt = field(response, 'undoExpiresAt');
          if (typeof undoToken !== 'string' || typeof undoExpiresAt !== 'string') {
            throw new Error('List settings acknowledgement omitted its Undo receipt.');
          }
          await this.outbox.recordListArchiveUndoToken(
            transaction.database,
            intent.intentId,
            undoToken,
            undoExpiresAt,
          );
        }
        await this.outbox.rebaseNextQueuedListPatch(
          transaction.database,
          intent.orderingKey,
          intent.seq,
          canonical.updatedAt,
        );
      } else if (intent.mutationKey[1] === 'undo') {
        if (canonicalRows === undefined) {
          throw new Error('List Undo settlement omitted its canonical index.');
        }
        const position = canonicalRows.findIndex(
          (candidate) => candidate.listId === intent.entityId,
        );
        const canonical = position < 0 ? undefined : canonicalRows[position];
        if (later.length === 0) {
          if (canonical === undefined) {
            await lists.removeCanonical(transaction, intent.entityId);
          } else {
            await lists.upsertCanonical(transaction, canonical, position);
          }
        }
        if (canonical !== undefined) {
          await this.outbox.rebaseNextQueuedListPatch(
            transaction.database,
            intent.orderingKey,
            intent.seq,
            canonical.updatedAt,
          );
        }
        const originalIntentId = field(intent.variables, 'originalIntentId');
        if (typeof originalIntentId !== 'string') {
          throw new Error('List Undo intent omitted its original archive identity.');
        }
        await this.outbox.clearListArchiveUndoOffer(
          transaction.database,
          originalIntentId,
        );
      }
      await this.outbox.acknowledge(transaction.database, intent.intentId);
      transaction.changed('outbox');
    });
  }

  /** Restores the last server truth before exposing a permanent rejection for recovery. */
  private async rollbackPermanentRejection(
    intent: OutboxIntent,
    failure: Error,
  ): Promise<void> {
    if (
      intent.mutationKey[0] === 'activity' &&
      (intent.mutationKey[1] === activityUpdateMutationKeys.post[1] ||
        intent.mutationKey[1] === activityUpdateMutationKeys.delete[1])
    ) {
      await this.transactions.run(async (transaction) => {
        await this.activities.rollbackUpdateOperation(
          transaction,
          intent.intentId,
          intent.entityId,
        );
        await this.outbox.needsAttention(
          transaction.database,
          intent.intentId,
          rejectedAttention(failure, false),
          failure.message,
        );
        transaction.changed('outbox');
      });
      return;
    }
    if (intent.mutationKey[0] === 'list') {
      await this.rollbackPermanentListRejection(intent, failure);
      return;
    }
    const occurrenceDate = occurrenceDateFromIntent(intent);
    const target: ActivityDetailTarget =
      occurrenceDate === undefined
        ? { kind: 'activity', activityId: intent.entityId }
        : { kind: 'occurrence', activityId: intent.entityId, date: occurrenceDate };
    let canonical: ActivityDetail | undefined;
    let activityMissing = false;
    let occurrenceMissing = false;
    try {
      canonical = await this.serialNetwork((signal) =>
        this.pull.activity(target, signal),
      );
    } catch (rollbackError) {
      if (rollbackError instanceof ApiError && rollbackError.status === 404) {
        if (occurrenceDate === undefined) {
          activityMissing = true;
        } else {
          try {
            canonical = await this.serialNetwork((signal) =>
              this.pull.activity(
                { kind: 'activity', activityId: intent.entityId },
                signal,
              ),
            );
            occurrenceMissing = true;
          } catch (parentError) {
            if (parentError instanceof ApiError && parentError.status === 404) {
              activityMissing = true;
            } else if (__DEV__) {
              console.warn('native_rejection_parent_rollback_read_failed', {
                intentId: intent.intentId,
                message: message(parentError),
              });
            }
          }
        }
      } else if (__DEV__) {
        console.warn('native_rejection_rollback_read_failed', {
          intentId: intent.intentId,
          message: message(rollbackError),
        });
      }
    }

    let canonicalAgendas:
      | Array<{ readonly request: AgendaQuery; readonly data: AgendaData }>
      | undefined;
    if (canonical !== undefined) {
      try {
        canonicalAgendas = [];
        for (const coverage of latestNativeAgendaCoverage(await this.agenda.coverage())) {
          const request = agendaQueryForCoverage(coverage);
          canonicalAgendas.push({
            request,
            data: await this.serialNetwork((signal) => this.pull.agenda(request, signal)),
          });
        }
      } catch (rollbackError) {
        canonicalAgendas = undefined;
        if (__DEV__) {
          console.warn('native_rejection_agenda_rollback_read_failed', {
            intentId: intent.intentId,
            message: message(rollbackError),
          });
        }
      }
    }

    const recoveryRequired =
      (canonical === undefined && !activityMissing) ||
      (occurrenceMissing && canonicalAgendas === undefined);
    await this.transactions.run(async (transaction) => {
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, recoveryRequired),
        failure.message,
      );
      for (const later of await this.outbox.laterInOrdering(
        transaction.database,
        intent.orderingKey,
        intent.seq,
      )) {
        await this.outbox.needsAttention(
          transaction.database,
          later.intentId,
          { kind: 'parked', reason: 'predecessor_rejected' },
          'An earlier change for this activity was rejected.',
        );
      }
      if (canonical !== undefined) {
        const restored = await this.activities.restoreCanonicalAfterRejection(
          transaction,
          canonical,
        );
        if (restored) {
          if (!occurrenceMissing) {
            await transaction.database.run(
              "UPDATE activity_occurrences SET local_state = 'canonical' WHERE activity_id = ?;",
              [intent.entityId],
            );
            await transaction.database.run(
              "UPDATE agenda_rows SET local_state = 'canonical' WHERE activity_id = ?;",
              [intent.entityId],
            );
          }
          await this.anytime?.acceptCanonicalActivity(transaction, canonical.activity);
        }
        if (canonicalAgendas !== undefined && canonicalAgendas.length > 0) {
          for (const snapshot of canonicalAgendas) {
            await this.agenda.installCanonical(
              transaction,
              snapshot.request,
              snapshot.data,
            );
          }
        } else if (canonical.occurrence !== undefined) {
          await this.agenda.acceptCanonicalOccurrence(
            transaction,
            canonical.activity,
            canonical.occurrence,
          );
        } else if (
          !occurrenceMissing &&
          intent.mutationKey[1] !== 'duplicate' &&
          intent.mutationKey[1] !== 'convert-recurrence' &&
          intent.mutationKey[1] !== 'reminder-create' &&
          intent.mutationKey[1] !== 'reminder-delete'
        ) {
          /* Entity-level schedule/delete projections cannot be reversed row-by-row safely. */
          await transaction.database.run(
            'DELETE FROM agenda_rows WHERE activity_id = ?;',
            [intent.entityId],
          );
          transaction.changed('agenda');
        }
        if (occurrenceMissing && occurrenceDate !== undefined) {
          await this.activities.restoreCanonicalOccurrenceAbsenceAfterRejection(
            transaction,
            intent.entityId,
            occurrenceDate,
          );
          await this.agenda.removeCanonicalOccurrenceAfterRejection(
            transaction,
            intent.entityId,
            occurrenceDate,
          );
        }
      } else if (activityMissing) {
        await this.activities.restoreCanonicalAbsenceAfterRejection(
          transaction,
          intent.entityId,
        );
      } else {
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
      }
      transaction.changed('outbox');
      transaction.changed('anytime');
    });
    if (
      canonical !== undefined &&
      occurrenceDate === undefined &&
      canonicalAgendas === undefined
    ) {
      this.pullRequested = true;
      this.requested = true;
    }
  }

  private async rollbackPermanentListRejection(
    intent: OutboxIntent,
    failure: Error,
  ): Promise<void> {
    if (intent.mutationKey[1] === 'item-create') {
      await this.rollbackPermanentItemRejection(intent, failure);
      return;
    }
    if (intent.mutationKey[1] === 'item-patch') {
      await this.rollbackPermanentItemPatchRejection(intent, failure);
      return;
    }
    if (isListMutation(intent, 'itemDelete')) {
      await this.rollbackPermanentItemDeleteRejection(intent, failure);
      return;
    }
    if (isListMutation(intent, 'itemSchedule')) {
      /*
       * A rejected bridge leaves nothing to reconcile, exactly like a rejected item create
       * (P3-34): the server refused to create the Plan, so the pending local projection is the
       * only copy that ever existed and it goes with the rejection. The ListItem was never
       * touched, so there is nothing to restore on the list side.
       */
      await this.transactions.run(async (transaction) => {
        await this.outbox.needsAttention(
          transaction.database,
          intent.intentId,
          rejectedAttention(failure, false),
          failure.message,
        );
        await this.activities.restoreCanonicalAbsenceAfterRejection(
          transaction,
          intent.entityId,
        );
        transaction.changed('outbox');
      });
      return;
    }
    if (isListMutation(intent, 'itemUndo')) {
      await this.rollbackPermanentItemUndoRejection(intent, failure);
      return;
    }
    let rows: readonly List[] | undefined;
    try {
      rows = await this.pullAllLists();
    } catch (error) {
      if (__DEV__) {
        console.warn('native_list_rejection_rollback_read_failed', {
          intentId: intent.intentId,
          message: message(error),
        });
      }
    }

    const canonical = rows?.find((list) => list.listId === intent.entityId);
    const position = rows?.findIndex((list) => list.listId === intent.entityId) ?? -1;
    await this.transactions.run(async (transaction) => {
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, rows === undefined),
        failure.message,
      );
      for (const later of await this.outbox.laterInOrdering(
        transaction.database,
        intent.orderingKey,
        intent.seq,
      )) {
        await this.outbox.needsAttention(
          transaction.database,
          later.intentId,
          { kind: 'parked', reason: 'predecessor_rejected' },
          'An earlier change for this list was rejected.',
        );
      }
      if (rows !== undefined) {
        if (canonical === undefined) {
          await this.lists?.removeCanonical(transaction, intent.entityId);
        } else {
          await this.lists?.upsertCanonical(transaction, canonical, position);
        }
      }
      transaction.changed('outbox');
    });
  }

  /**
   * A rejected item create leaves nothing to reconcile: the server refused it, so the row it
   * was showing is the only copy that ever existed and it goes with the rejection.
   *
   * No authoritative read is needed or wanted — there is no server item to read — so the
   * receipt carries no `recoveryRequired` and Discard may retire the intent directly. Retry
   * re-projects the row from the durable payload.
   */
  private async rollbackPermanentItemRejection(
    intent: OutboxIntent,
    failure: Error,
  ): Promise<void> {
    const listTransactions = this.requireListTransactions();
    const listId = field(intent.variables, 'listId');
    await this.transactions.run(async (transaction) => {
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, false),
        failure.message,
      );
      if (typeof listId === 'string') {
        await listTransactions.removeItem(transaction, listId, intent.entityId);
      }
      transaction.changed('outbox');
    });
  }

  /**
   * A rejected item **edit** leaves a row that must go back to being the server's (P3-29).
   *
   * The opposite of the create above, and the distinction is the whole reason this is a second
   * method: the create's row was the only copy that ever existed, so it goes with the
   * rejection; the patch's row exists on the server and only the edit was refused. Deleting it
   * would take a real item off the screen because one of its fields was rejected.
   *
   * One targeted read, not a page pull: `GET /v1/lists/:id/items/:itemId` names exactly the row
   * in question, and re-pulling the list would discard every cursor and restart pagination to
   * repair one field. A `404` means the item is genuinely gone — someone deleted it during the
   * window — and removing it locally is then the restore, not a loss.
   *
   * A read that fails for any other reason leaves the optimistic row in place and the receipt
   * `recoveryRequired`, so Retry/Discard still has authoritative truth to install first.
   */
  private async rollbackPermanentItemPatchRejection(
    intent: OutboxIntent,
    failure: Error,
    supersededByDelete = false,
  ): Promise<boolean> {
    const listTransactions = this.requireListTransactions();
    const listId = field(intent.variables, 'listId');
    const pullItem = this.pull.listItem;
    let canonical: ListItemRow | undefined;
    let missing = false;
    if (pullItem !== undefined && typeof listId === 'string') {
      try {
        canonical = await this.serialNetwork((signal) =>
          pullItem(listId, intent.entityId, signal),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          missing = true;
        } else if (__DEV__) {
          console.warn('native_item_patch_rollback_read_failed', {
            intentId: intent.intentId,
            message: message(error),
          });
        }
      }
    }
    const restored = canonical !== undefined || missing;
    await this.transactions.run(async (transaction) => {
      if (supersededByDelete && canonical !== undefined) {
        await this.outbox.rebaseNextListItemDeleteSnapshot(
          transaction.database,
          intent.orderingKey,
          intent.seq,
          intent.entityId,
          canonical,
        );
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        transaction.changed('outbox');
        return;
      }
      if (supersededByDelete && missing && typeof listId === 'string') {
        const successor = (
          await this.outbox.laterInOrdering(
            transaction.database,
            intent.orderingKey,
            intent.seq,
          )
        ).find(
          (candidate) =>
            candidate.entityId === intent.entityId &&
            isListMutation(candidate, 'itemDelete'),
        );
        if (successor !== undefined) {
          const offer = await this.outbox.listItemDeleteUndoOffer(
            transaction.database,
            successor.intentId,
          );
          const inverseIntentId =
            offer === undefined ? undefined : undoOfferInverseIntentId(offer);
          if (inverseIntentId !== undefined) {
            await listTransactions.removeItem(transaction, listId, intent.entityId);
            await this.outbox.acknowledge(transaction.database, inverseIntentId);
          }
          if (offer !== undefined) {
            await this.outbox.clearListItemDeleteUndoOffer(
              transaction.database,
              offer.originalIntentId,
            );
          }
          await this.outbox.acknowledge(transaction.database, successor.intentId);
          await this.outbox.acknowledge(transaction.database, intent.intentId);
          transaction.changed('outbox');
          return;
        }
      }
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, !restored),
        failure.message,
      );
      if (canonical !== undefined) {
        await listTransactions.installCanonicalItem(transaction, canonical);
      } else if (missing && typeof listId === 'string') {
        await listTransactions.removeItem(transaction, listId, intent.entityId);
      }
      transaction.changed('outbox');
    });
    return supersededByDelete && restored;
  }

  /** Restores the exact local snapshot when the server refuses a queued forward delete. */
  private async rollbackPermanentItemDeleteRejection(
    intent: OutboxIntent,
    failure: Error,
  ): Promise<void> {
    const previous = listItemFromResponse(field(intent.variables, 'previous'));
    await this.transactions.run(async (transaction) => {
      const offer = await this.outbox.listItemDeleteUndoOffer(
        transaction.database,
        intent.intentId,
      );
      const inverseIntentId =
        offer === undefined ? undefined : undoOfferInverseIntentId(offer);
      if (offer !== undefined && inverseIntentId !== undefined) {
        if (previous !== undefined) {
          await this.requireListTransactions().installCanonicalItem(
            transaction,
            previous,
          );
        }
        await this.outbox.acknowledge(transaction.database, inverseIntentId);
        await this.outbox.acknowledge(transaction.database, intent.intentId);
        await this.outbox.clearListItemDeleteUndoOffer(
          transaction.database,
          offer.originalIntentId,
        );
        transaction.changed('outbox');
        return;
      }
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, false),
        failure.message,
      );
      if (previous !== undefined) {
        await this.requireListTransactions().installCanonicalItem(transaction, previous);
      }
      transaction.changed('outbox');
    });
  }

  /** A refused compensation cannot leave its optimistic restored row contradicting the server. */
  private async rollbackPermanentItemUndoRejection(
    intent: OutboxIntent,
    failure: Error,
  ): Promise<void> {
    const listId = field(intent.variables, 'listId');
    await this.transactions.run(async (transaction) => {
      await this.outbox.needsAttention(
        transaction.database,
        intent.intentId,
        rejectedAttention(failure, false),
        failure.message,
      );
      if (typeof listId === 'string') {
        await this.requireListTransactions().removeItem(
          transaction,
          listId,
          intent.entityId,
        );
      }
      transaction.changed('outbox');
    });
  }

  /**
   * Restores the exact item before resolving ambiguous local exhaustion or an unfinished
   * rejected-patch recovery (P3-29). A 404 is authoritative absence; any other read failure
   * keeps the receipt blocked instead of promoting an optimistic row to server truth.
   */
  private noopPreparedRecovery(
    intent: OutboxIntent,
    targetState: PreparedRejectedIntentRecovery['targetState'],
  ): PreparedRejectedIntentRecovery {
    return {
      targetState,
      install: async (transaction) => {
        const current = await this.outbox.get(transaction.database, intent.intentId);
        return (
          current?.status === 'needs_attention' &&
          current.entityId === intent.entityId &&
          current.orderingKey === intent.orderingKey
        );
      },
    };
  }

  private async prepareListItemAttention(
    intent: OutboxIntent,
  ): Promise<PreparedRejectedIntentRecovery | undefined> {
    if (!requiresAuthoritativeRecovery(intent)) {
      return this.noopPreparedRecovery(intent, 'unchanged');
    }
    try {
      const listTransactions = this.requireListTransactions();
      const listId = field(intent.variables, 'listId');
      const pullItem = this.pull.listItem;
      if (pullItem === undefined || typeof listId !== 'string') {
        throw new Error('Native list item state is not ready.');
      }
      let canonical: ListItemRow | undefined;
      try {
        canonical = await this.serialNetwork((signal) =>
          pullItem(listId, intent.entityId, signal),
        );
      } catch (error) {
        // `404` is an answer: the item is gone, and removing it locally is the restore.
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      return {
        targetState: canonical === undefined ? 'absent' : 'present',
        install: async (transaction) => {
          const current = await this.outbox.get(transaction.database, intent.intentId);
          if (
            current?.status !== 'needs_attention' ||
            current.mutationKey[0] !== 'list' ||
            current.entityId !== intent.entityId
          ) {
            return false;
          }
          if (canonical === undefined) {
            await listTransactions.removeItem(transaction, listId, intent.entityId);
          } else {
            await listTransactions.installCanonicalItem(transaction, canonical);
          }
          if (
            current.recoveryRequired === true &&
            !(await this.outbox.completeAuthoritativeRecovery(
              transaction.database,
              intent.intentId,
            ))
          ) {
            throw new Error(
              'The authoritative list item recovery receipt changed during installation.',
            );
          }
          transaction.changed('outbox');
          return true;
        },
      };
    } catch (error) {
      if (__DEV__) {
        console.warn('native_list_item_attention_recovery_failed', {
          intentId: intent.intentId,
          message: message(error),
        });
      }
      return undefined;
    }
  }

  /** Restores authoritative List state before a Retry/Discard retires its recovery receipt. */
  private async prepareRejectedListIntent(
    intent: OutboxIntent,
  ): Promise<PreparedRejectedIntentRecovery | undefined> {
    try {
      const lists = this.lists;
      if (lists === undefined) throw new Error('Native Lists state is not ready.');
      const rows = await this.pullAllLists();
      const canonical = rows.find((row) => row.listId === intent.entityId);
      const position = rows.findIndex((row) => row.listId === intent.entityId);
      return {
        targetState: canonical === undefined ? 'absent' : 'present',
        install: async (transaction) => {
          const current = await this.outbox.get(transaction.database, intent.intentId);
          if (
            current?.status !== 'needs_attention' ||
            current.mutationKey[0] !== 'list' ||
            current.entityId !== intent.entityId
          ) {
            return false;
          }
          // Recovery owns only this root. The coordinator replays or retires successors in
          // this same transaction before any repository invalidation is published.
          if (canonical === undefined) {
            await lists.removeCanonical(transaction, intent.entityId);
            await this.listItems?.removeList(transaction, intent.entityId);
          } else {
            await lists.upsertCanonical(transaction, canonical, position);
          }
          if (
            current.recoveryRequired === true &&
            !(await this.outbox.completeAuthoritativeRecovery(
              transaction.database,
              intent.intentId,
            ))
          ) {
            throw new Error(
              'The authoritative List recovery receipt changed during installation.',
            );
          }
          transaction.changed('outbox');
          return true;
        },
      };
    } catch (error) {
      if (__DEV__) {
        console.warn('native_rejected_list_recovery_failed', {
          intentId: intent.intentId,
          message: message(error),
        });
      }
      return undefined;
    }
  }

  private async pullKnownCoverage(): Promise<Error | undefined> {
    const requests = new Map<string, AgendaQuery>();
    /**
     * Coverage receipts are durable offline evidence, not a forever-growing refresh queue.
     * Today and rolling Plans/reminder windows advance each day; replaying every historical
     * receipt makes foreground work grow without bound. Keep the latest stored window in
     * each timezone/include domain, then add every explicitly requested window below.
     */
    for (const coverage of latestNativeAgendaCoverage(await this.agenda.coverage())) {
      const request = agendaQueryForCoverage(coverage);
      requests.set(agendaQueryKey(request), request);
    }
    for (const [key, request] of this.requestedCoverages) requests.set(key, request);
    this.requestedCoverages.clear();
    this.activeCoverageKeys.clear();
    for (const key of requests.keys()) this.activeCoverageKeys.add(key);
    this.coverageSnapshotActive = true;
    let firstError: Error | undefined;
    for (const request of requests.values()) {
      const coverage = agendaCoverageForQuery(request);
      const pullStartedAt = Date.now();
      try {
        if (__DEV__) console.info('native_agenda_pull_started', { request });
        const data = await this.serialNetwork((signal) =>
          this.pull.agenda(request, signal),
        );
        const receivedAt = Date.now();
        if (__DEV__) {
          console.info('native_agenda_pull_received', {
            request,
            rows: agendaRowCount(data),
            projectionVersions: data.projectionVersions?.length ?? 0,
            warnings: data.warnings,
            networkDurationMs: receivedAt - pullStartedAt,
          });
        }
        await this.transactions.run((transaction) =>
          this.agenda.installCanonical(transaction, request, data),
        );
        if (__DEV__) {
          const committed = await this.agenda.read(coverage);
          console.info('native_agenda_pull_committed', {
            request,
            rows: agendaRowCount(committed),
            installDurationMs: Date.now() - receivedAt,
            totalDurationMs: Date.now() - pullStartedAt,
          });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (__DEV__) {
          console.info('native_agenda_pull_failed', {
            request,
            message: failure.message,
          });
        }
        firstError ??= failure;
        await this.transactions.run((transaction) =>
          this.agenda.recordSyncError(transaction, coverage, failure.message),
        );
      }
    }
    return firstError;
  }

  /** A coverage registered after the active pull snapshot must cause one more bounded pass. */
  private queueCoverage(request: AgendaQuery): AgendaQuery {
    const nativeRequest = nativeVisibleAgendaQuery(request);
    const key = agendaQueryKey(nativeRequest);
    /*
     * Mounted native screens can all ask for their committed window on the same foreground
     * transition. If this exact window is already in the active snapshot, its caller can await
     * that pull; scheduling another full pass only repeats canonical installation and delays
     * the next local transaction. A genuinely new window still gets one bounded follow-up.
     */
    if (this.pulling && this.coverageSnapshotActive && this.activeCoverageKeys.has(key)) {
      return nativeRequest;
    }
    this.requestedCoverages.set(key, nativeRequest);
    if (this.pulling) {
      /* Requests arriving while the snapshot is still being collected join that snapshot. */
      if (this.coverageSnapshotActive) {
        this.pullRequested = true;
        this.requested = true;
      }
    }
    return nativeRequest;
  }

  private async recoverCreateCollision(
    intent: OutboxIntent,
    error: unknown,
  ): Promise<'not_applicable' | 'recovered' | 'parked' | 'retry'> {
    const create =
      intent.mutationKey[1] === 'create' || intent.mutationKey[1] === 'item-create';
    if (!create || !(error instanceof ApiError) || error.status !== 409) {
      return 'not_applicable';
    }
    if (intent.mutationKey[1] === 'item-create') {
      return this.recoverListItemCreateCollision(intent);
    }
    if (intent.mutationKey[0] === 'list') {
      return this.recoverListCreateCollision(intent);
    }
    try {
      const detail = await this.serialNetwork((signal) =>
        this.pull.activity({ kind: 'activity', activityId: intent.entityId }, signal),
      );
      await this.transactions.run(async (transaction) => {
        const later = await transaction.database.first(
          `SELECT intent_id FROM outbox_intents
           WHERE ordering_key = ? AND seq > ?
             AND status IN ('queued', 'in_flight', 'needs_attention')
           LIMIT 1;`,
          [intent.orderingKey, intent.seq],
        );
        if (later === undefined) {
          await this.activities.installAcknowledgedActivity(
            transaction,
            detail.activity,
            detail,
          );
        }
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
            queuedError(failure),
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

  /**
   * The List analogue of the Activity create-collision path (§P3-05, ADR-055).
   *
   * A `409` on a create says only that the minted id is taken; it deliberately carries no
   * metadata about what took it. One exact read decides it:
   *
   * - **`200`** — this account already owns that list, so the create landed and its response
   *   was lost. The canonical row is adopted and the intent acknowledged. Nothing is written
   *   twice, because the server did the writing.
   * - **`404`** — the id names something this caller cannot see. That is not resolvable by
   *   waiting, so the intent parks as `ambiguous_collision` and the account banner offers
   *   Retry and Discard. **Nothing re-mints automatically**: a create the user confirmed once
   *   must not silently become a second list on a schedule they never saw.
   * - Anything else is transport, so it requeues and the backoff owns it.
   */
  private async recoverListCreateCollision(
    intent: OutboxIntent,
  ): Promise<'recovered' | 'parked' | 'retry'> {
    const lists = this.lists;
    const pullList = this.pull.list;
    if (lists === undefined || pullList === undefined) {
      throw new Error('Native Lists state is not ready.');
    }
    try {
      const canonical = await this.serialNetwork((signal) =>
        pullList(intent.entityId, signal),
      );
      if (canonical.listId !== intent.entityId) {
        throw new Error('List collision recovery answered for a different list.');
      }
      await this.transactions.run(async (transaction) => {
        const later = await this.outbox.laterInOrdering(
          transaction.database,
          intent.orderingKey,
          intent.seq,
        );
        if (later.length === 0) await lists.installCanonicalRow(transaction, canonical);
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
            queuedError(failure),
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
        transaction.changed('outbox');
      });
      return 'parked';
    }
  }

  /**
   * The item analogue of the List create-collision path (§P3-08, ADR-055).
   *
   * The same three outcomes, decided by one exact read: `200` means this device's minted id
   * already names an item on this list, so the create landed and its canonical row is adopted;
   * `404` is genuinely ambiguous — the create may never have arrived, or may have arrived and
   * been deleted, and a tombstoned id answers identically — so it parks for an explicit Retry
   * or Discard; anything else is transport and requeues.
   *
   * **No automatic re-mint**, which is what stops a deleted row coming back to life.
   */
  private async recoverListItemCreateCollision(
    intent: OutboxIntent,
  ): Promise<'recovered' | 'parked' | 'retry'> {
    const listTransactions = this.requireListTransactions();
    const pullItem = this.pull.listItem;
    const listId = field(intent.variables, 'listId');
    if (pullItem === undefined || typeof listId !== 'string') {
      throw new Error('Native list item state is not ready.');
    }
    try {
      const canonical = await this.serialNetwork((signal) =>
        pullItem(listId, intent.entityId, signal),
      );
      if (canonical.itemId !== intent.entityId) {
        throw new Error('Item collision recovery answered for a different item.');
      }
      await this.transactions.run(async (transaction) => {
        await listTransactions.installCanonicalItem(transaction, canonical);
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
            queuedError(failure),
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

  /**
   * Defence in depth for the serialized lane (the 2026-08-31 freeze post-mortem). The caller
   * gets a bounded answer and the active transport receives a real abort signal. A broken
   * transport cannot leave callers in Syncing, but it retains internal ownership until it
   * settles so no still-side-effecting write is overlapped. Public so fake time can prove both
   * invariants without waiting a minute.
   */
  networkLaneDeadlineMs = 60_000;

  private serialNetwork<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const guarded = () => {
      if (controller.signal.aborted) {
        throw new NetworkError('The network lane timed out.', undefined);
      }
      return operation(controller.signal);
    };
    const underlying = this.networkTail.then(guarded, guarded);
    /*
     * The public caller is bounded below, but ownership remains with the underlying transport
     * until it actually settles. Releasing an abort-ignoring PATCH would let later work overtake
     * a still-side-effecting write and violate the outbox ordering contract. A production fetch
     * honours the propagated signal and settles promptly; a broken injected transport cannot
     * keep the UI in Syncing because both its caller and queued callers retain their deadlines.
     */
    this.networkTail = underlying.then(
      () => undefined,
      () => undefined,
    );
    return this.withNetworkCallerDeadline(underlying, controller);
  }

  /**
   * Bounds one caller. Late settlement is observed but cannot reach caller-side SQLite
   * installation; all lane callbacks are transport-only.
   */
  private withNetworkCallerDeadline<T>(
    underlying: Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOutAt: number | undefined;
      const deadline = setTimeout(() => {
        timedOutAt = Date.now();
        reject(new NetworkError('The network lane timed out.', undefined));
        controller.abort();
      }, this.networkLaneDeadlineMs);
      underlying.then(
        (value) => {
          clearTimeout(deadline);
          if (timedOutAt !== undefined && __DEV__) {
            console.warn('native_network_lane_late_settlement', {
              outcome: 'resolved',
              latenessMs: Date.now() - timedOutAt,
            });
          }
          if (timedOutAt !== undefined) return;
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(deadline);
          if (timedOutAt !== undefined && __DEV__) {
            console.warn('native_network_lane_late_settlement', {
              outcome: 'rejected',
              latenessMs: Date.now() - timedOutAt,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          if (timedOutAt !== undefined) return;
          reject(error);
        },
      );
    });
  }
}
