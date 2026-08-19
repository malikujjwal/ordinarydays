export type SqliteValue = string | number | null | boolean | Uint8Array;
export type SqliteParameters = readonly SqliteValue[];
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
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
  close(): Promise<void>;
}

export interface SqliteDatabaseFactory {
  open(filename: string): Promise<SqliteDatabase>;
  delete(filename: string): Promise<void>;
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
