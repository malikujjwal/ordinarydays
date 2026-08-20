import { readCommitRevision } from '@/lib/sqlite/commitRevision';
import type {
  SqliteDatabase,
  SqliteDatabaseFactory,
  SqliteReader,
  SqliteSnapshotConnection,
} from '@/lib/sqlite/database';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

export interface RevisionedProjectionSnapshot<T> {
  readonly data: T;
  readonly commitRevision: number;
  readonly source: 'reader' | 'writer-fallback';
}

export interface RevisionedProjectionReader {
  snapshot<T>(
    task: (reader: SqliteReader) => Promise<T>,
  ): Promise<RevisionedProjectionSnapshot<T>>;
}

function isBusyOrLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:error code (?:5|6)|sqlite_busy|sqlite_locked|database is (?:busy|locked))/i.test(
    message,
  );
}

/** Owns the account's sole concurrent reader and a correctness-first writer fallback. */
export class AccountProjectionReader implements RevisionedProjectionReader {
  private reader: SqliteSnapshotConnection | undefined;
  private recreation: Promise<void> | undefined;
  private closing = false;

  constructor(
    private readonly filename: string,
    private readonly database: SqliteDatabase,
    private readonly transactions: SerializedTransactionRunner,
    private readonly factory: SqliteDatabaseFactory,
    initialReader?: SqliteSnapshotConnection,
  ) {
    this.reader = initialReader;
  }

  async snapshot<T>(
    task: (reader: SqliteReader) => Promise<T>,
  ): Promise<RevisionedProjectionSnapshot<T>> {
    if (this.closing) throw new Error('SQLite projection reader is closed.');
    const dedicated = this.reader;
    if (dedicated !== undefined) {
      try {
        const snapshot = await dedicated.snapshot((reader) =>
          this.readRevisioned(reader, task),
        );
        return { ...snapshot, source: 'reader' };
      } catch (error) {
        if (this.closing) throw error;
        if (!isBusyOrLocked(error)) {
          await this.detach(dedicated);
          void this.ensureReader();
        }
        if (__DEV__) {
          console.warn('native_projection_reader_fallback', {
            filename: this.filename,
            retained: isBusyOrLocked(error),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      void this.ensureReader();
    }
    return this.transactions.read(() =>
      this.database.readTransaction(async (reader) => ({
        ...(await this.readRevisioned(reader, task)),
        source: 'writer-fallback' as const,
      })),
    );
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.recreation;
      return;
    }
    this.closing = true;
    await this.recreation;
    const reader = this.reader;
    this.reader = undefined;
    await reader?.close();
  }

  private async readRevisioned<T>(
    reader: SqliteReader,
    task: (reader: SqliteReader) => Promise<T>,
  ): Promise<Omit<RevisionedProjectionSnapshot<T>, 'source'>> {
    /* Reading the revision first establishes the WAL snapshot fenced around all rows below. */
    const commitRevision = await readCommitRevision(reader);
    const data = await task(reader);
    return { data, commitRevision };
  }

  private async detach(reader: SqliteSnapshotConnection): Promise<void> {
    if (this.reader !== reader) return;
    this.reader = undefined;
    await reader.close().catch(() => undefined);
  }

  private ensureReader(): Promise<void> {
    if (this.closing || this.reader !== undefined) return Promise.resolve();
    if (this.recreation !== undefined) return this.recreation;
    const recreation = this.factory
      .openReader(this.filename)
      .then(async (reader) => {
        if (this.closing || this.reader !== undefined) {
          await reader.close();
          return;
        }
        this.reader = reader;
        if (__DEV__) console.info('native_projection_reader_recreated');
      })
      .catch((error) => {
        if (__DEV__) {
          console.warn('native_projection_reader_recreate_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (this.recreation === recreation) this.recreation = undefined;
      });
    this.recreation = recreation;
    return recreation;
  }
}
