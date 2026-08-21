import { getActivityAgenda } from '@od/shared/client';
import { type AgendaQuery, timeZone } from '@od/shared/schemas';
import { systemClock, toWallTime } from '@od/shared/time';
import type { ActivityAgendaData } from '@od/shared/types';
import { apiClient } from '@/lib/apiClient';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import {
  agendaQueryForCoverage,
  latestNativeAgendaCoverage,
} from '@/lib/sqlite/agendaCoverage';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

export interface TargetedAgendaTransport {
  load(activityId: string, request: AgendaQuery): Promise<ActivityAgendaData>;
}

const sharedTargetedAgendaTransport: TargetedAgendaTransport = {
  load: (activityId, request) => getActivityAgenda(apiClient, activityId, request),
};

export interface ReconciliationResult {
  readonly reconciled: number;
  readonly failed: number;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the version-proven strong read required after recurrence topology changes. */
export class RecurrenceReconciler {
  constructor(
    private readonly transactions: SerializedTransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
    private readonly transport: TargetedAgendaTransport = sharedTargetedAgendaTransport,
    private readonly network: <T>(operation: () => Promise<T>) => Promise<T> = (
      operation,
    ) => operation(),
  ) {}

  async reconcilePending(): Promise<ReconciliationResult> {
    let reconciled = 0;
    let failed = 0;
    for (const intent of await this.outbox.pendingReconciliations()) {
      if (await this.reconcile(intent)) reconciled += 1;
      else failed += 1;
    }
    return { reconciled, failed };
  }

  private async reconcile(intent: OutboxIntent): Promise<boolean> {
    const expectedVersion = intent.reconciliationVersion;
    if (expectedVersion === undefined) return true;
    const coverages = latestNativeAgendaCoverage(await this.agenda.coverage());
    try {
      const responses: Array<{
        readonly request: AgendaQuery;
        readonly data: ActivityAgendaData;
      }> = [];
      for (const coverage of coverages) {
        const request = agendaQueryForCoverage(coverage);
        const data = await this.network(() =>
          this.transport.load(intent.entityId, request),
        );
        if (
          data.activityId !== intent.entityId ||
          data.activityVersion < expectedVersion
        ) {
          throw new Error(
            'Targeted agenda response did not prove the acknowledged version.',
          );
        }
        responses.push({ request, data });
      }
      const now = systemClock.now();
      const installed = await this.transactions.run(async (transaction) => {
        const current = await this.outbox.get(transaction.database, intent.intentId);
        if (
          current?.status !== 'acknowledged' ||
          current.reconciliationVersion !== expectedVersion
        ) {
          return false;
        }
        const later = await transaction.database.first(
          `SELECT 1 AS found FROM outbox_intents
           WHERE ordering_key = ? AND seq > ?
             AND status IN ('queued', 'in_flight', 'needs_attention') LIMIT 1;`,
          [intent.orderingKey, intent.seq],
        );
        if (later !== undefined) return false;
        for (const response of responses) {
          await this.agenda.replaceCanonicalActivityRows(
            transaction,
            response.request,
            response.data,
            {
              today: systemClock.todayIn(timeZone.parse(response.request.tz)),
              currentMinute: toWallTime(now, timeZone.parse(response.request.tz)),
            },
          );
          await transaction.database.run(
            'DELETE FROM native_sync_errors WHERE scope = ?;',
            [
              this.agenda.scope({
                from: response.request.from,
                to: response.request.to,
                timezone: response.request.tz,
                ...(response.request.include === undefined
                  ? {}
                  : { include: response.request.include }),
              }),
            ],
          );
        }
        await this.activities.setLocalState(transaction, intent.entityId, 'canonical');
        await this.outbox.completeReconciliation(transaction.database, intent.intentId);
        transaction.changed('outbox');
        return true;
      });
      return installed;
    } catch (error) {
      const message = failureMessage(error);
      await this.transactions.run(async (transaction) => {
        await this.outbox.failReconciliation(
          transaction.database,
          intent.intentId,
          message,
        );
        await transaction.database.run(
          `INSERT INTO native_sync_errors (scope, message, retryable, recorded_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(scope) DO UPDATE SET message=excluded.message,
             retryable=1, recorded_at=excluded.recorded_at;`,
          [`reconciliation:${intent.entityId}`, message, systemClock.now()],
        );
        for (const coverage of coverages) {
          await this.agenda.recordSyncError(transaction, coverage, message);
        }
        transaction.changed('outbox');
        transaction.changed('agenda');
      });
      return false;
    }
  }
}
