export type SqliteValue = string | number | null | boolean | Uint8Array;
export type SqliteParameters = readonly SqliteValue[];
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
}

export interface SqliteExecutionMetrics {
  readonly callCount: number;
  readonly durationMs: number;
}

/** The deliberately small SQL surface repositories may use. */
export interface SqliteReader {
  first(sql: string, parameters?: SqliteParameters): Promise<SqliteRow | undefined>;
  all(sql: string, parameters?: SqliteParameters): Promise<readonly SqliteRow[]>;
}

export interface SqliteExecutor extends SqliteReader {
  exec(sql: string): Promise<void>;
  run(sql: string, parameters?: SqliteParameters): Promise<SqliteRunResult>;
}

export interface SqliteDatabase extends SqliteExecutor {
  transaction<T>(task: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
  readTransaction<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** One private connection whose only public operation is a short explicit read snapshot. */
export interface SqliteSnapshotConnection {
  snapshot<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqliteDatabaseFactory {
  open(filename: string): Promise<SqliteDatabase>;
  openReader(filename: string): Promise<SqliteSnapshotConnection>;
  delete(filename: string): Promise<void>;
}

interface MutableSqliteExecutionMetrics {
  callCount: number;
  durationMs: number;
}

/** Measures time spent awaiting SQLite calls, separate from repository transformation work. */
export function measureSqliteReader(reader: SqliteReader): {
  readonly reader: SqliteReader;
  metrics(): SqliteExecutionMetrics;
} {
  const metrics: MutableSqliteExecutionMetrics = { callCount: 0, durationMs: 0 };
  const measure = async <T>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    metrics.callCount += 1;
    try {
      return await operation();
    } finally {
      metrics.durationMs += Date.now() - startedAt;
    }
  };
  return {
    reader: {
      first: (sql, parameters) => measure(() => reader.first(sql, parameters)),
      all: (sql, parameters) => measure(() => reader.all(sql, parameters)),
    },
    metrics: () => ({ ...metrics }),
  };
}

/** Extends read measurement to the mutation methods used inside writer transactions. */
export function measureSqliteExecutor(executor: SqliteExecutor): {
  readonly executor: SqliteExecutor;
  metrics(): SqliteExecutionMetrics;
} {
  const measured = measureSqliteReader(executor);
  const metrics = measured.metrics;
  const additional: MutableSqliteExecutionMetrics = { callCount: 0, durationMs: 0 };
  const measure = async <T>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    additional.callCount += 1;
    try {
      return await operation();
    } finally {
      additional.durationMs += Date.now() - startedAt;
    }
  };
  return {
    executor: {
      ...measured.reader,
      exec: (sql) => measure(() => executor.exec(sql)),
      run: (sql, parameters) => measure(() => executor.run(sql, parameters)),
    },
    metrics: () => {
      const reads = metrics();
      return {
        callCount: reads.callCount + additional.callCount,
        durationMs: reads.durationMs + additional.durationMs,
      };
    },
  };
}

export function textColumn(
  row: SqliteRow | undefined,
  column: string,
): string | undefined {
  const value = row?.[column];
  return typeof value === 'string' ? value : undefined;
}

export function numberColumn(
  row: SqliteRow | undefined,
  column: string,
): number | undefined {
  const value = row?.[column];
  return typeof value === 'number' ? value : undefined;
}
