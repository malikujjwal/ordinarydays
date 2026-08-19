import type { SqliteDatabaseFactory } from '@/lib/sqlite/database';

/**
 * The base/web module is intentionally unavailable. Metro resolves `expoDatabase.native.ts`
 * on iOS; web therefore gains no SQLite state or persistence through this task.
 */
export const expoSqliteDatabaseFactory: SqliteDatabaseFactory = {
  open: () => Promise.reject(new Error('Native SQLite is unavailable on web.')),
  delete: () => Promise.reject(new Error('Native SQLite is unavailable on web.')),
};
