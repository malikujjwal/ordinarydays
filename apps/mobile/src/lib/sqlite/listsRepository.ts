import { listView } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import type {
  RepositoryInvalidationMetadata,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

/**
 * The SQLite-owned Lists index (P3-25, ADR-057).
 *
 * The sync engine installs canonical pages, while user-visible archive/restore/delete actions
 * project through this repository in the same SQLite transaction as their outbox intent.
 * Canonical pulls preserve those protected rows until acknowledgement or rejection settles.
 *
 * ## TanStack is not the native domain authority
 *
 * The native hook reads these rows and nothing else. That is the whole of ADR-057's pivot: a
 * screen that fell back to a query cache would be reading a second copy of the truth, and the
 * two would disagree exactly when it mattered — offline, or mid-sync.
 */

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function number(row: SqliteRow, column: string): number {
  const value = row[column];
  return typeof value === 'number' ? value : 0;
}

/**
 * Parsed through `listView`, not cast.
 *
 * The rows came from the network once, but they came back out of SQLite, where a migration or a
 * partial write could have changed their shape. Parsing at the boundary is what makes the
 * repository's return type true rather than asserted — the same choice `anytimeRepository`
 * makes, for the same reason.
 */
function fromRow(row: SqliteRow): List {
  const slot = text(row, 'slot');
  const sourceActivityId = text(row, 'source_activity_id');

  return listView.parse({
    listId: text(row, 'list_id'),
    ownerId: text(row, 'owner_id'),
    behaviour: text(row, 'behaviour'),
    templateKey: text(row, 'template_key'),
    title: text(row, 'title'),
    icon: text(row, 'icon'),
    emptyStateCopy: text(row, 'empty_state_copy'),
    capabilities: {
      checkable: number(row, 'checkable') === 1,
      supportsLocation: number(row, 'supports_location') === 1,
    },
    // Nullable, not optional: `null` is a list with no slot, which is different from a column
    // this build did not write.
    slot: slot ?? null,
    ...(sourceActivityId === undefined ? {} : { sourceActivityId }),
    itemCount: number(row, 'item_count'),
    uncheckedCount: number(row, 'unchecked_count'),
    memberCount: number(row, 'member_count'),
    rankVersion: number(row, 'rank_version'),
    archived: number(row, 'archived') === 1,
    updatedAt: text(row, 'updated_at'),
    lastItemActivityAt: text(row, 'last_item_activity_at'),
  }) as List;
}

/**
 * **Server pointer order**, restored from the stored ordinal.
 *
 * `ORDER BY position` and nothing else. The index renders in the order the server paged its
 * pointers and never re-sorts (ADR-042): `ListIndex` holds `role` and `addedAt` only, so a
 * client sort would be inventing an order rather than reproducing one. `list_id` breaks ties
 * only so the read is deterministic if two rows ever share an ordinal.
 */
async function readListRows(reader: SqliteReader): Promise<readonly List[]> {
  const rows = await reader.all('SELECT * FROM list_rows ORDER BY position, list_id;');
  return rows.map(fromRow);
}

async function writeListRow(
  database: SqliteExecutor,
  list: List,
  position: number,
): Promise<void> {
  await database.run(
    `INSERT INTO list_rows (
      list_id, position, owner_id, behaviour, template_key, title, icon,
      empty_state_copy, checkable, supports_location, slot, source_activity_id,
      item_count, unchecked_count, member_count, rank_version, archived,
      updated_at, last_item_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(list_id) DO UPDATE SET
      position=excluded.position, owner_id=excluded.owner_id,
      behaviour=excluded.behaviour, template_key=excluded.template_key,
      title=excluded.title, icon=excluded.icon,
      empty_state_copy=excluded.empty_state_copy,
      checkable=excluded.checkable, supports_location=excluded.supports_location,
      slot=excluded.slot, source_activity_id=excluded.source_activity_id,
      item_count=excluded.item_count, unchecked_count=excluded.unchecked_count,
      member_count=excluded.member_count, rank_version=excluded.rank_version,
      archived=excluded.archived, updated_at=excluded.updated_at,
      last_item_activity_at=excluded.last_item_activity_at;`,
    [
      list.listId,
      position,
      list.ownerId,
      list.behaviour,
      list.templateKey,
      list.title,
      list.icon,
      list.emptyStateCopy,
      list.capabilities.checkable ? 1 : 0,
      list.capabilities.supportsLocation ? 1 : 0,
      list.slot ?? null,
      list.sourceActivityId ?? null,
      list.itemCount,
      list.uncheckedCount,
      list.memberCount,
      list.rankVersion,
      list.archived ? 1 : 0,
      list.updatedAt,
      list.lastItemActivityAt,
    ],
  );
}

/**
 * The ordinal a locally-created list takes until the server places it.
 *
 * The end of the current order, because that is the only honest answer: `position` reproduces
 * the server's pointer order across drained pages, and this row is in no page yet. The next
 * drain assigns the real one — `replaceCanonical` updates the ordinal of a protected row
 * without touching the optimistic fields it is protecting.
 */
async function nextPosition(reader: SqliteReader): Promise<number> {
  const row = await reader.first('SELECT MAX(position) AS last FROM list_rows;');
  const last = row?.last;
  return typeof last === 'number' ? last + 1 : 0;
}

export interface ListsCommittedSnapshot {
  readonly lists: readonly List[];
  readonly commitRevision: number;
}

export class ListsRepository {
  private readonly scope = 'lists';

  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections?: RevisionedProjectionReader,
  ) {}

  subscribe(listener: (metadata: RepositoryInvalidationMetadata) => void): () => void {
    return this.subscriptions.subscribe(this.scope, listener);
  }

  /** Exact committed row for a transaction that needs the current server precondition. */
  async getLocal(reader: SqliteReader, listId: string): Promise<List | undefined> {
    const row = await reader.first('SELECT * FROM list_rows WHERE list_id = ?;', [
      listId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  }

  async read(): Promise<readonly List[]> {
    return readListRows(this.reader);
  }

  /** Presentation rows and their revision from one WAL snapshot, as Anytime does. */
  async readSnapshot(): Promise<ListsCommittedSnapshot> {
    if (this.projections === undefined) {
      return { lists: await this.read(), commitRevision: 0 };
    }
    const snapshot = await this.projections.snapshot(readListRows);
    return { lists: snapshot.data, commitRevision: snapshot.commitRevision };
  }

  /**
   * Replaces the whole index with a fully-drained set of pages.
   *
   * **Whole-set replacement, not an upsert per page**, and the difference is the reason the
   * sync engine drains every cursor before calling this. An upsert cannot express a deletion:
   * a list removed on another device would survive for ever as a row nothing ever revisits.
   * Replacing inside one transaction also means a subscriber never observes a half-written
   * index — it sees the previous set or the next one.
   *
   * `position` is the ordinal within the drained sequence, which is the server's pointer order
   * across every page. It is assigned here rather than sent, because it is a property of the
   * sequence rather than of any row.
   */
  async replaceCanonical(
    transaction: TransactionContext,
    lists: readonly List[],
    protectedListIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (protectedListIds.size === 0) {
      await transaction.database.run('DELETE FROM list_rows;');
    } else {
      const protectedIds = [...protectedListIds];
      await transaction.database.run(
        `DELETE FROM list_rows WHERE list_id NOT IN (${protectedIds.map(() => '?').join(', ')});`,
        protectedIds,
      );
    }
    for (const [position, list] of lists.entries()) {
      if (protectedListIds.has(list.listId)) {
        // The server still owns ordering while this device owns the optimistic fields. A
        // remote insertion/deletion may shift the ordinal even though this row is protected.
        await transaction.database.run(
          'UPDATE list_rows SET position = ? WHERE list_id = ?;',
          [position, list.listId],
        );
      } else {
        await writeListRow(transaction.database, list, position);
      }
    }
    transaction.changed(this.scope);
  }

  /**
   * Applies one server-confirmed settings write — the archive/restore path.
   *
   * Keeps the row's existing `position`, because archiving does not move a list in the server's
   * pointer order; it changes whether the active filter shows it. Re-ordering here would make a
   * restore land somewhere other than where it left, which reads as the list having moved.
   *
   * A list this device has never materialized is ignored rather than inserted: without a page
   * it has no ordinal, and guessing one would put it at an arbitrary place in an order the
   * server owns. The next drain places it correctly.
   */
  async applySettings(transaction: TransactionContext, list: List): Promise<void> {
    await transaction.database.run(
      `UPDATE list_rows SET
         title = ?, checkable = ?, supports_location = ?, slot = ?,
         item_count = ?, unchecked_count = ?, member_count = ?, rank_version = ?,
         archived = ?, updated_at = ?, last_item_activity_at = ?
       WHERE list_id = ?;`,
      [
        list.title,
        list.capabilities.checkable ? 1 : 0,
        list.capabilities.supportsLocation ? 1 : 0,
        list.slot ?? null,
        list.itemCount,
        list.uncheckedCount,
        list.memberCount,
        list.rankVersion,
        list.archived ? 1 : 0,
        list.updatedAt,
        list.lastItemActivityAt,
        list.listId,
      ],
    );
    transaction.changed(this.scope);
  }

  /** Installs one authoritative row at its server-page ordinal after a rejected intent. */
  async upsertCanonical(
    transaction: TransactionContext,
    list: List,
    position: number,
  ): Promise<void> {
    await writeListRow(transaction.database, list, position);
    transaction.changed(this.scope);
  }

  /**
   * The visible row for a durable create, committed in the same transaction as its intent.
   *
   * An upsert rather than an insert, so a user-directed Retry can re-project the same list
   * after an authoritative rollback removed it, and so replaying an intent that is already
   * projected is a no-op rather than a constraint failure.
   */
  async insertPendingCreate(transaction: TransactionContext, list: List): Promise<void> {
    const existing = await this.getLocal(transaction.database, list.listId);
    await writeListRow(
      transaction.database,
      list,
      existing === undefined
        ? await nextPosition(transaction.database)
        : /*
           * Keep the ordinal it already has. A re-projection is the same row appearing again,
           * and moving it to the end would make a Retry look like the list had been recreated
           * somewhere else in the index.
           */
          await this.positionOf(transaction.database, list.listId),
    );
    transaction.changed(this.scope);
  }

  /**
   * Installs one authoritative List row, keeping wherever it currently sits in the index.
   *
   * The **whole** row, not the settings subset: the two callers are a create's acknowledgement
   * — where the server owns `ownerId`, the real timestamps and the values it resolved from the
   * catalogue itself — and a detail pull, which may be the first time this device has seen the
   * list at all. The ordinal is kept rather than recomputed, because the row is already sitting
   * somewhere in the user's index and only the next pointer drain may move it.
   */
  async installCanonicalRow(transaction: TransactionContext, list: List): Promise<void> {
    await writeListRow(
      transaction.database,
      list,
      await this.positionOf(transaction.database, list.listId),
    );
    transaction.changed(this.scope);
  }

  /**
   * Renames one unsynced row after an explicit collision Retry (§P3-05).
   *
   * An `UPDATE`, not a delete and re-insert: the list keeps its ordinal, so it stays where the
   * user last saw it instead of jumping to the end of their index for a reason they were never
   * shown. A no-op when the row is already gone — a rollback may have removed it first.
   */
  async remapPendingCreate(
    transaction: TransactionContext,
    previousListId: string,
    freshListId: string,
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE list_rows SET list_id = ? WHERE list_id = ?;',
      [freshListId, previousListId],
    );
    transaction.changed(this.scope);
  }

  private async positionOf(reader: SqliteReader, listId: string): Promise<number> {
    const row = await reader.first('SELECT position FROM list_rows WHERE list_id = ?;', [
      listId,
    ]);
    const position = row?.position;
    return typeof position === 'number' ? position : await nextPosition(reader);
  }

  /** Optimistic archive/restore projection committed with its outbox intent. */
  async setArchivedLocal(
    transaction: TransactionContext,
    listId: string,
    archived: boolean,
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE list_rows SET archived = ? WHERE list_id = ?;',
      [archived ? 1 : 0, listId],
    );
    transaction.changed(this.scope);
  }

  /** Removes one list the server has confirmed deleted. */
  async removeCanonical(transaction: TransactionContext, listId: string): Promise<void> {
    await transaction.database.run('DELETE FROM list_rows WHERE list_id = ?;', [listId]);
    transaction.changed(this.scope);
  }
}
