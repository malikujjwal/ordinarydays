/**
 * The Lists index's query key.
 *
 * Re-exported from `lib/queryKeys.ts` since P3-34: the `Plan this item` bridge in
 * `features/compose` writes to the same cache these hooks read, which is exactly the
 * two-owner condition that moves a root into the neutral module. Existing imports in this
 * feature keep their path; the literal now lives in one place.
 *
 * Web only, in practice. Native reads SQLite and never consults a query cache for this domain
 * (ADR-057) — the key exists there only because the module is shared, not because anything
 * native invalidates it.
 */
export { LISTS_KEY } from '@/lib/queryKeys';
