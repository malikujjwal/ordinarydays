import type { SqliteExecutor, SqliteReader } from '@/lib/sqlite/database';
import { numberColumn } from '@/lib/sqlite/database';

export async function readCommitRevision(database: SqliteReader): Promise<number> {
  const row = await database.first(
    'SELECT commit_revision FROM native_commit_state WHERE singleton = 1;',
  );
  const revision = numberColumn(row, 'commit_revision');
  if (revision === undefined || revision < 0) {
    throw new Error('SQLite commit revision is unavailable.');
  }
  return revision;
}

/** Advances the account fence once inside the observable writer transaction. */
export async function incrementCommitRevision(database: SqliteExecutor): Promise<number> {
  const row = await database.first(
    `UPDATE native_commit_state
     SET commit_revision = commit_revision + 1
     WHERE singleton = 1
     RETURNING commit_revision;`,
  );
  const revision = numberColumn(row, 'commit_revision');
  if (revision === undefined || revision < 1) {
    throw new Error('SQLite commit revision could not be advanced.');
  }
  return revision;
}
