import { activityDetail, agendaData, agendaQuery } from '@od/shared/schemas';
import type { ActivityDetail, AgendaData } from '@od/shared/types';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import { textColumn } from '@/lib/sqlite/database';
import type {
  LegacyImportSource,
  LegacyImportTarget,
  LegacyImportVerification,
  LegacyIntentImport,
  VerifiedLegacyServerBase,
} from '@/lib/sqlite/legacyImporter';
import type { OutboxRepository } from '@/lib/sqlite/outbox';
import type { TransactionContext } from '@/lib/sqlite/transaction';

interface VerifiedActivityEnvelope {
  readonly detail: ActivityDetail;
}

interface VerifiedAgendaEnvelope {
  readonly request: unknown;
  readonly data: AgendaData;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null)
    throw new Error('Legacy base is malformed.');
  return value as Record<string, unknown>;
}

/** Installs only explicitly verified server bases; overlays never reach this target. */
export class ActivityAgendaLegacyImportTarget implements LegacyImportTarget {
  constructor(
    private readonly activities: ActivityRepository,
    private readonly agenda: AgendaRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async importVerifiedBase(
    transaction: TransactionContext,
    sourceId: string,
    record: VerifiedLegacyServerBase,
  ): Promise<void> {
    const value = object(record.value);
    if (record.domain === 'activity') {
      const envelope: VerifiedActivityEnvelope = {
        detail: activityDetail.parse(value.detail) as ActivityDetail,
      };
      await this.activities.putCanonical(transaction, envelope.detail);
    } else if (record.domain === 'agenda') {
      const envelope: VerifiedAgendaEnvelope = {
        request: agendaQuery.parse(value.request),
        data: agendaData.parse(value.data) as AgendaData,
      };
      await this.agenda.installCanonical(
        transaction,
        envelope.request as Parameters<AgendaRepository['installCanonical']>[1],
        envelope.data,
      );
    } else {
      throw new Error(`Unsupported verified legacy domain: ${record.domain}`);
    }
    await transaction.database.run(
      `INSERT INTO legacy_domain_imports
        (source_id, record_key, domain, server_version) VALUES (?, ?, ?, ?);`,
      [sourceId, record.recordKey, record.domain, record.serverVersion],
    );
  }

  async importIntent(
    transaction: TransactionContext,
    sourceId: string,
    intent: LegacyIntentImport,
  ): Promise<void> {
    const appended = await this.outbox.append(
      transaction.database,
      {
        intentId: intent.intentId,
        mutationKey: intent.mutationKey,
        variables: intent.variables,
        entityId: intent.entityId,
        orderingKey: intent.orderingKey,
        ...(intent.dependsOnIntentId === undefined
          ? {}
          : { dependsOnIntentId: intent.dependsOnIntentId }),
        ...(intent.compensationForIntentId === undefined
          ? {}
          : { compensationForIntentId: intent.compensationForIntentId }),
      },
      intent.createdAt,
    );
    if (intent.attempts !== undefined) {
      await transaction.database.run(
        'UPDATE outbox_intents SET attempts = ? WHERE intent_id = ?;',
        [intent.attempts, intent.intentId],
      );
    }
    const restoredStatus = intent.status === 'in_flight' ? 'queued' : intent.status;
    if (restoredStatus === 'needs_attention') {
      await this.outbox.needsAttention(
        transaction.database,
        appended.intent.intentId,
        intent.attention ?? { kind: 'parked', reason: 'legacy_unknown' },
      );
    } else if (restoredStatus === 'acknowledged') {
      await transaction.database.run(
        "UPDATE outbox_intents SET status = 'acknowledged' WHERE intent_id = ?;",
        [intent.intentId],
      );
    } else if (restoredStatus !== 'queued') {
      throw new Error(`Unsupported legacy intent status: ${intent.status}`);
    }
    if (intent.clockWitness !== undefined) {
      await transaction.database.run(
        `UPDATE outbox_meta SET clock_witness = MAX(clock_witness, ?)
         WHERE singleton = 1;`,
        [intent.clockWitness],
      );
    }
    await transaction.database.run(
      `INSERT INTO legacy_intent_imports (
        source_id, record_key, intent_id, ordering_key, imported_status,
        depends_on_intent_id, compensation_for_intent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        sourceId,
        intent.recordKey,
        intent.intentId,
        intent.orderingKey,
        intent.status,
        intent.dependsOnIntentId ?? null,
        intent.compensationForIntentId ?? null,
      ],
    );
  }

  async verify(
    transaction: TransactionContext,
    sourceId: string,
  ): Promise<LegacyImportVerification> {
    const bases = await transaction.database.all(
      'SELECT record_key, server_version FROM legacy_domain_imports WHERE source_id = ?;',
      [sourceId],
    );
    const intents = await transaction.database.all(
      `SELECT record_key, intent_id, ordering_key, imported_status,
              depends_on_intent_id, compensation_for_intent_id
       FROM legacy_intent_imports WHERE source_id = ?;`,
      [sourceId],
    );
    return {
      bases: bases.map((row) => ({
        recordKey: textColumn(row, 'record_key') ?? '',
        serverVersion: textColumn(row, 'server_version') ?? '',
      })),
      intents: intents.map((row) => {
        const dependsOnIntentId = textColumn(row, 'depends_on_intent_id');
        const compensationForIntentId = textColumn(row, 'compensation_for_intent_id');
        return {
          recordKey: textColumn(row, 'record_key') ?? '',
          intentId: textColumn(row, 'intent_id') ?? '',
          orderingKey: textColumn(row, 'ordering_key') ?? '',
          status: textColumn(row, 'imported_status') ?? '',
          ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
          ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
        };
      }),
      dependencyEdges: intents.flatMap((row) => {
        const recordKey = textColumn(row, 'record_key');
        const dependency = textColumn(row, 'depends_on_intent_id');
        return recordKey === undefined || dependency === undefined
          ? []
          : [`${recordKey}->${dependency}`];
      }),
    };
  }

  scopesAfterCommit(_source: LegacyImportSource): ReadonlySet<string> {
    return new Set(['agenda', 'outbox', 'reminders']);
  }
}
