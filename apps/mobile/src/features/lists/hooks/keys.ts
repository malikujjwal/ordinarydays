/**
 * The Lists index's query key.
 *
 * In the feature rather than in `lib/queryKeys.ts` because it has a single owner:
 * `repo-structure.md` §7 puts a key with its feature's hooks, and the neutral module exists
 * only for the roots two features share. P3-26's creation sheet lives in this same slice, so
 * the writer and the reader are already on the same side of the boundary.
 *
 * Web only, in practice. Native reads SQLite and never consults a query cache for this domain
 * (ADR-057) — the key exists there only because the module is shared, not because anything
 * native invalidates it.
 */
export const LISTS_KEY = ['lists'] as const;
