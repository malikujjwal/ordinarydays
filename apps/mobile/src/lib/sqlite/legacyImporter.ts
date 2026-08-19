import { systemClock } from '@od/shared/time';
import { textColumn } from '@/lib/sqlite/database';
import type { RepositoryScope } from '@/lib/sqlite/subscriptions';
import type {
  SerializedTransactionRunner,
  TransactionContext,
} from '@/lib/sqlite/transaction';

export interface VerifiedLegacyServerBase {
  readonly provenance: 'verified_server_base';
  readonly recordKey: string;
  readonly domain: string;
  readonly serverVersion: string;
  readonly value: unknown;
}

export interface AmbiguousLegacyBase {
  readonly provenance: 'ambiguous';
  readonly recordKey: string;
}

export interface OverlayLegacyBase {
  readonly provenance: 'p2_60_materialized_overlay';
  readonly recordKey: string;
}

export type LegacyBaseCandidate =
  | VerifiedLegacyServerBase
  | AmbiguousLegacyBase
  | OverlayLegacyBase;

export interface LegacyIntentImport {
  /** Source-record identity. Conflicting legacy mutation ids therefore remain distinct. */
  readonly recordKey: string;
  readonly intentId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly orderingKey: string;
  readonly status: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
}

export interface LegacyImportSource {
  readonly sourceId: string;
  readonly baseCandidates: readonly LegacyBaseCandidate[];
  readonly intents: readonly LegacyIntentImport[];
}

export interface LegacyImportVerification {
  readonly bases: readonly {
    readonly recordKey: string;
    readonly serverVersion: string;
  }[];
  readonly intents: readonly {
    readonly recordKey: string;
    readonly intentId: string;
    readonly orderingKey: string;
    readonly status: string;
    readonly dependsOnIntentId?: string;
    readonly compensationForIntentId?: string;
  }[];
  readonly dependencyEdges: readonly string[];
}

export interface LegacyImportTarget {
  importVerifiedBase(
    transaction: TransactionContext,
    sourceId: string,
    record: VerifiedLegacyServerBase,
  ): Promise<void>;
  importIntent(
    transaction: TransactionContext,
    sourceId: string,
    intent: LegacyIntentImport,
  ): Promise<void>;
  verify(
    transaction: TransactionContext,
    sourceId: string,
  ): Promise<LegacyImportVerification>;
  scopesAfterCommit(source: LegacyImportSource): ReadonlySet<RepositoryScope>;
}

export interface LegacyImportReceipt {
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly importedBaseCount: number;
  readonly importedIntentCount: number;
  readonly importedDependencyCount: number;
  readonly requiresSync: boolean;
  readonly importedAt: string;
}

export type LegacyImportOutcome =
  | {
      readonly kind: 'imported';
      readonly receipt: LegacyImportReceipt;
      readonly canRetireLegacy: true;
    }
  | {
      readonly kind: 'already_imported';
      readonly receipt: LegacyImportReceipt;
      readonly canRetireLegacy: true;
    };

export type LegacyImportFingerprint = (canonicalSource: string) => Promise<string>;

export async function sha256LegacySource(canonicalSource: string): Promise<string> {
  const Crypto = await import('expo-crypto');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonicalSource);
}

export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function uniqueByRecordKey<T extends { readonly recordKey: string }>(
  records: readonly T[],
): T[] {
  const unique = new Map<string, T>();
  for (const record of records) {
    const previous = unique.get(record.recordKey);
    if (previous === undefined) {
      unique.set(record.recordKey, record);
      continue;
    }
    if (
      JSON.stringify(canonicalValue(previous)) !== JSON.stringify(canonicalValue(record))
    ) {
      throw new LegacyImportError(
        `Legacy record ${record.recordKey} has conflicting values.`,
      );
    }
  }
  return [...unique.values()];
}

function dependencyEdges(intents: readonly LegacyIntentImport[]): string[] {
  return intents.flatMap((intent) =>
    intent.dependsOnIntentId === undefined
      ? []
      : [`${intent.recordKey}->${intent.dependsOnIntentId}`],
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRecords(left: readonly unknown[], right: readonly unknown[]): boolean {
  const canonical = (records: readonly unknown[]): string[] =>
    records.map((record) => JSON.stringify(canonicalValue(record))).sort();
  return sameStrings(canonical(left), canonical(right));
}

function requireValidSource(source: LegacyImportSource): void {
  if (source.sourceId.length === 0)
    throw new LegacyImportError('Legacy source id is required.');
  for (const base of source.baseCandidates) {
    if (base.recordKey.length === 0)
      throw new LegacyImportError('Legacy base record key is required.');
    if (
      base.provenance === 'verified_server_base' &&
      (base.domain.length === 0 || base.serverVersion.length === 0)
    ) {
      throw new LegacyImportError(
        'Verified server bases require domain and version provenance.',
      );
    }
  }
  for (const intent of source.intents) {
    if (
      intent.recordKey.length === 0 ||
      intent.intentId.length === 0 ||
      intent.entityId.length === 0 ||
      intent.orderingKey.length === 0 ||
      intent.status.length === 0 ||
      intent.mutationKey.length === 0
    ) {
      throw new LegacyImportError(
        'Legacy intent identity, ordering, status and mutation are required.',
      );
    }
  }
}

function receiptFromRow(
  row: Record<string, string | number | null | boolean | Uint8Array>,
): LegacyImportReceipt {
  const sourceId = textColumn(row, 'source_id');
  const sourceFingerprint = textColumn(row, 'source_fingerprint');
  const importedAt = textColumn(row, 'imported_at');
  const importedBaseCount = row.imported_base_count;
  const importedIntentCount = row.imported_intent_count;
  const importedDependencyCount = row.imported_dependency_count;
  const requiresSync = row.requires_sync;
  if (
    sourceId === undefined ||
    sourceFingerprint === undefined ||
    importedAt === undefined ||
    typeof importedBaseCount !== 'number' ||
    typeof importedIntentCount !== 'number' ||
    typeof importedDependencyCount !== 'number' ||
    typeof requiresSync !== 'number'
  ) {
    throw new LegacyImportError('Stored legacy import receipt is malformed.');
  }
  return {
    sourceId,
    sourceFingerprint,
    importedBaseCount,
    importedIntentCount,
    importedDependencyCount,
    requiresSync: requiresSync === 1,
    importedAt,
  };
}

export class LegacyImporter {
  constructor(
    private readonly transactions: SerializedTransactionRunner,
    private readonly target: LegacyImportTarget,
    private readonly fingerprint: LegacyImportFingerprint = sha256LegacySource,
    private readonly now: () => string = () => systemClock.now(),
  ) {}

  async import(source: LegacyImportSource): Promise<LegacyImportOutcome> {
    requireValidSource(source);
    const baseCandidates = uniqueByRecordKey(source.baseCandidates);
    const intents = uniqueByRecordKey(source.intents);
    const verifiedBases = baseCandidates.filter(
      (candidate): candidate is VerifiedLegacyServerBase =>
        candidate.provenance === 'verified_server_base',
    );
    const requiresSync = baseCandidates.some(
      (candidate) => candidate.provenance !== 'verified_server_base',
    );
    const canonicalSource = JSON.stringify(
      canonicalValue({ ...source, baseCandidates, intents }),
    );
    const sourceFingerprint = await this.fingerprint(canonicalSource);
    return this.transactions.run(async (transaction) => {
      const receiptRow = await transaction.database.first(
        'SELECT * FROM legacy_import_receipts WHERE source_id = ?;',
        [source.sourceId],
      );
      if (receiptRow !== undefined) {
        const receipt = receiptFromRow(receiptRow);
        if (receipt.sourceFingerprint !== sourceFingerprint) {
          throw new LegacyImportError(
            'Legacy source changed after its migration receipt was written.',
          );
        }
        return { kind: 'already_imported', receipt, canRetireLegacy: true };
      }

      for (const base of verifiedBases) {
        await this.target.importVerifiedBase(transaction, source.sourceId, base);
      }
      for (const intent of intents) {
        await this.target.importIntent(transaction, source.sourceId, intent);
      }

      const verification = await this.target.verify(transaction, source.sourceId);
      const expectedDependencies = dependencyEdges(intents);
      if (
        !sameRecords(
          verification.bases,
          verifiedBases.map((base) => ({
            recordKey: base.recordKey,
            serverVersion: base.serverVersion,
          })),
        ) ||
        !sameRecords(
          verification.intents,
          intents.map((intent) => ({
            recordKey: intent.recordKey,
            intentId: intent.intentId,
            orderingKey: intent.orderingKey,
            status: intent.status,
            ...(intent.dependsOnIntentId === undefined
              ? {}
              : { dependsOnIntentId: intent.dependsOnIntentId }),
            ...(intent.compensationForIntentId === undefined
              ? {}
              : { compensationForIntentId: intent.compensationForIntentId }),
          })),
        ) ||
        !sameStrings(verification.dependencyEdges, expectedDependencies)
      ) {
        throw new LegacyImportError('Legacy import read-back verification failed.');
      }

      const receipt: LegacyImportReceipt = {
        sourceId: source.sourceId,
        sourceFingerprint,
        importedBaseCount: verifiedBases.length,
        importedIntentCount: intents.length,
        importedDependencyCount: expectedDependencies.length,
        requiresSync,
        importedAt: this.now(),
      };
      await transaction.database.run(
        `INSERT INTO legacy_import_receipts (
          source_id, source_fingerprint, imported_base_count, imported_intent_count,
          imported_dependency_count, requires_sync, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          receipt.sourceId,
          receipt.sourceFingerprint,
          receipt.importedBaseCount,
          receipt.importedIntentCount,
          receipt.importedDependencyCount,
          receipt.requiresSync ? 1 : 0,
          receipt.importedAt,
        ],
      );
      for (const scope of this.target.scopesAfterCommit(source))
        transaction.changed(scope);
      return { kind: 'imported', receipt, canRetireLegacy: true };
    });
  }
}
