import type { List } from './list.js';

/**
 * The List an API response carries (P3-05): the stored shape minus `rankRepairId` and
 * `behaviourMigrationId`, the two storage-only work markers `data-model.md` §4.6 says are
 * never serialised. `rankVersion` remains — item-page cursors are bound to it.
 *
 * Derived rather than re-declared so a field added to {@link List} cannot silently fork the
 * two shapes; the schema twin is `listView` in `../schemas/list.ts`.
 */
export type ListView = Omit<
  List,
  'itemVersion' | 'rankRepairId' | 'behaviourMigrationId'
>;
