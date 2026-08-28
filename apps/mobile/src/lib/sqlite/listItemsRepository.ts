import type { PatchListItemInput } from '@od/shared/client';
import { compareListItems } from '@od/shared/rank';
import { listItemView } from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type { ListItemView } from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import type {
  RepositoryInvalidationMetadata,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

/**
 * The SQLite-owned items of one list (P3-27, ADR-057).
 *
 * The `ListsRepository` pattern, with two differences that both come from the same place —
 * items have an authoritative order and lists do not.
 *
 * ## `(rank, itemId)`, never an ordinal
 *
 * The index stores the server's pointer position because nothing else could reproduce it.
 * Items carry a lexo `rank`, so the order is computable and stable, and the tie-break on
 * `itemId` is load-bearing rather than defensive: two people adding at the same position
 * produce equal ranks by design (`plans-and-lists.md` §5.11.5). `compareListItems` is the one
 * comparator, imported rather than re-expressed, so the SQL `ORDER BY` and every in-memory
 * merge agree.
 *
 * ## A page is not a list
 *
 * Rows and page state are separate: `503` projection recovery discards every cursor while
 * **keeping** the committed rows, and a reader must be able to tell a fully drained list from
 * a prefix. `itemCount` is never derived from here — it is META's, on `list_rows` — because a
 * count computed from loaded rows is exactly the mistake acceptance criterion 36 names.
 */

/**
 * The item a client holds.
 *
 * `ListItemView` verbatim — the shared type that already means "the stored shape minus the two
 * storage-only fields". P3-27 restated its `Omit` here; a second declaration of one shape is a
 * second place for it to drift, so this is an alias and the name stays only because the
 * repository's callers read better with a row-shaped one.
 *
 * The alias is only correct while this table carries **nothing the view does not**, and it
 * does not: `list_items`' ten columns are exactly the view's ten fields, `fromRow` parses
 * through `listItemView`, and neither `itemRevision` nor `sourceProvenance` is stored. A
 * storage-only column added later needs its own type again rather than a widened alias.
 */
export type ListItemRow = ListItemView;

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function json(row: SqliteRow, column: string): unknown {
  const value = row[column];
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : undefined;
}

/**
 * Parsed through `listItemView`, not cast — the boundary rule `listsRepository` states: the
 * rows came from the network once, but they came back out of SQLite where a migration or a
 * partial write could have changed their shape.
 */
function fromRow(row: SqliteRow): ListItemRow {
  const note = text(row, 'note');
  const sourceActivityId = text(row, 'source_activity_id');
  const sourceLabel = text(row, 'source_label');
  const location = json(row, 'location_json');
  const details = json(row, 'details_json');

  return listItemView.parse({
    itemId: text(row, 'item_id'),
    listId: text(row, 'list_id'),
    rank: text(row, 'rank'),
    title: text(row, 'title'),
    checked: row.checked === 1,
    ...(note === undefined ? {} : { note }),
    ...(location === undefined ? {} : { location }),
    ...(sourceActivityId === undefined ? {} : { sourceActivityId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    ...(details === undefined ? {} : { details }),
  }) as ListItemRow;
}

/**
 * `ORDER BY rank, item_id` — the SQL half of `compareListItems`.
 *
 * SQLite's default `BINARY` collation on `TEXT` is codepoint order, which is what the lexo
 * rank alphabet is designed for and what the comparator does in JavaScript. The two agree by
 * construction, and `listItemsRepository.test.ts` asserts it against a shuffled fixture rather
 * than trusting the claim.
 */
async function readItemRows(
  reader: SqliteReader,
  listId: string,
): Promise<readonly ListItemRow[]> {
  const rows = await reader.all(
    'SELECT * FROM list_items WHERE list_id = ? ORDER BY rank, item_id;',
    [listId],
  );
  return rows.map(fromRow);
}

/**
 * Guards the one way a page can corrupt the slice: rows that name a different list.
 *
 * The delete is scoped by the caller's `listId` and each insert by the row's own, so a page
 * whose rows disagreed would clear one list and populate another — leaving rows behind that
 * nothing ever revisits, in a table with no way to notice.
 */
function assertBelongsToList(items: readonly ListItemRow[], listId: string): void {
  for (const item of items) {
    if (item.listId !== listId) {
      throw new Error(`Item ${item.itemId} does not belong to this list.`);
    }
  }
}

async function writeItemRow(database: SqliteExecutor, item: ListItemRow): Promise<void> {
  await database.run(
    `INSERT INTO list_items (
      item_id, list_id, rank, title, note, checked, location_json,
      source_activity_id, source_label, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      list_id=excluded.list_id, rank=excluded.rank, title=excluded.title,
      note=excluded.note, checked=excluded.checked,
      location_json=excluded.location_json,
      source_activity_id=excluded.source_activity_id,
      source_label=excluded.source_label, details_json=excluded.details_json;`,
    [
      item.itemId,
      item.listId,
      item.rank,
      item.title,
      item.note ?? null,
      item.checked ? 1 : 0,
      item.location === undefined ? null : JSON.stringify(item.location),
      item.sourceActivityId ?? null,
      item.sourceLabel ?? null,
      item.details === undefined ? null : JSON.stringify(item.details),
    ],
  );
}

/**
 * The local projection of one `PATCH /v1/lists/:id/items/:itemId` (P3-29).
 *
 * Pure, so the one rule that matters can be asserted without a database: **`null` clears and
 * absent leaves alone**. `patchListItemInput` keeps the two distinguishable precisely so a note
 * can be removed at all, and a merge that collapsed them would make an emptied note either
 * unremovable or removed by accident on every unrelated edit.
 *
 * `rank` is not merged: it is server-owned, and `afterItemId` — the only way a client asks for
 * a different one — never reaches a durable intent (P3-30 keeps reorder online-only).
 *
 * The result goes through `listItemView` for `fromRow`'s reason, one step earlier: what is
 * about to be written is half a persisted payload and half a stored row, and a merge that
 * produced something the schema rejects would put it in the table for every later reader to
 * parse instead.
 */
export function mergeListItemPatch(
  item: ListItemRow,
  changes: PatchListItemInput,
): ListItemRow {
  /*
   * The three clearable fields are taken **off** the row before the merge, so a `null` can
   * produce a result that does not have them. Spreading the item and then conditionally
   * spreading the field back would leave the old value in place, which is a clear that silently
   * does nothing.
   */
  const {
    note: currentNote,
    location: currentPlace,
    details: currentDetails,
    ...rest
  } = item;
  const note = changes.note === undefined ? currentNote : (changes.note ?? undefined);
  const location =
    changes.location === undefined ? currentPlace : (changes.location ?? undefined);
  const details =
    changes.details === undefined ? currentDetails : (changes.details ?? undefined);
  return listItemView.parse({
    ...rest,
    title: changes.title ?? rest.title,
    checked: changes.checked ?? rest.checked,
    ...(note === undefined ? {} : { note }),
    ...(location === undefined ? {} : { location }),
    ...(details === undefined ? {} : { details }),
  }) as ListItemRow;
}

/** How far a list's item pages have been drained, and against which rank generation. */
export interface ListItemPageState {
  readonly rankVersion: number;
  readonly nextCursor?: string;
  /** Every page has landed. Only then may an emptiness or bulk decision read these rows. */
  readonly complete: boolean;
}

export interface ListItemsSnapshot {
  readonly items: readonly ListItemRow[];
  readonly page: ListItemPageState | undefined;
  readonly commitRevision: number;
}

export class ListItemsRepository {
  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections?: RevisionedProjectionReader,
  ) {}

  /** Scoped per list: opening one list must not wake a subscriber reading another. */
  scope(listId: string): string {
    return `listItems:${listId}`;
  }

  subscribe(
    listId: string,
    listener: (metadata: RepositoryInvalidationMetadata) => void,
  ): () => void {
    return this.subscriptions.subscribe(this.scope(listId), listener);
  }

  /**
   * The committed rows, in order.
   *
   * `reader` is explicit for the same reason `ListsRepository.getLocal`'s is: a write that
   * derives from current state — the rank an appended item takes — must read inside its own
   * transaction, not from the default connection's snapshot.
   */
  async read(
    listId: string,
    reader: SqliteReader = this.reader,
  ): Promise<readonly ListItemRow[]> {
    return readItemRows(reader, listId);
  }

  /**
   * One committed row by id, or `undefined`.
   *
   * `reader` is explicit for `read`'s reason: a patch derives its next value from the current
   * one, so it must read inside its own writer transaction rather than from the default
   * connection's snapshot, where a write committed a moment ago may not be visible yet.
   */
  async getLocal(
    itemId: string,
    reader: SqliteReader = this.reader,
  ): Promise<ListItemRow | undefined> {
    const row = await reader.first('SELECT * FROM list_items WHERE item_id = ?;', [
      itemId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  }

  /** Projects one accepted field edit onto the visible row, committed with its intent. */
  async applyLocalPatch(
    transaction: TransactionContext,
    item: ListItemRow,
    changes: PatchListItemInput,
  ): Promise<void> {
    await writeItemRow(transaction.database, mergeListItemPatch(item, changes));
    transaction.changed(this.scope(item.listId));
  }

  async pageState(
    listId: string,
    reader: SqliteReader = this.reader,
  ): Promise<ListItemPageState | undefined> {
    const row = await reader.first(
      'SELECT rank_version, next_cursor, complete FROM list_item_pages WHERE list_id = ?;',
      [listId],
    );
    if (row === undefined) return undefined;
    const cursor = text(row, 'next_cursor');
    return {
      rankVersion: typeof row.rank_version === 'number' ? row.rank_version : 0,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
      complete: row.complete === 1,
    };
  }

  /** Rows and their page state from one WAL snapshot, so the two can never disagree. */
  async readSnapshot(listId: string): Promise<ListItemsSnapshot> {
    if (this.projections === undefined) {
      return {
        items: await this.read(listId),
        page: await this.pageState(listId),
        commitRevision: 0,
      };
    }
    const snapshot = await this.projections.snapshot(async (reader) => ({
      items: await readItemRows(reader, listId),
      page: await this.pageState(listId, reader),
    }));
    return { ...snapshot.data, commitRevision: snapshot.commitRevision };
  }

  /**
   * Installs page one, replacing everything this device held for the list.
   *
   * **Replacement, not merge**, and only ever for the first page: it is the only page whose
   * arrival proves the projection it belongs to is current. A later page merges instead. That
   * asymmetry is the `503` contract — "replace the projection only after page one succeeds;
   * never merge a post-repair page into pre-repair pages" — expressed as two methods, so a
   * caller cannot express the merge the contract forbids.
   *
   * Locally-created rows whose intents are unresolved survive: their create has not been
   * acknowledged, so the server could not have included them.
   */
  async replaceFirstPage(
    transaction: TransactionContext,
    listId: string,
    items: readonly ListItemRow[],
    page: ListItemPageState,
    protectedItemIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    assertBelongsToList(items, listId);
    const protectedIds = [...protectedItemIds];
    await transaction.database.run(
      protectedIds.length === 0
        ? 'DELETE FROM list_items WHERE list_id = ?;'
        : `DELETE FROM list_items WHERE list_id = ? AND item_id NOT IN (${protectedIds
            .map(() => '?')
            .join(', ')});`,
      [listId, ...protectedIds],
    );
    for (const item of items) {
      if (!protectedItemIds.has(item.itemId))
        await writeItemRow(transaction.database, item);
    }
    await this.writePageState(transaction.database, listId, page);
    transaction.changed(this.scope(listId));
  }

  /** Merges a subsequent page by `itemId`; the order is the comparator's, never arrival. */
  async mergePage(
    transaction: TransactionContext,
    listId: string,
    items: readonly ListItemRow[],
    page: ListItemPageState,
    protectedItemIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    assertBelongsToList(items, listId);
    for (const item of items) {
      if (!protectedItemIds.has(item.itemId))
        await writeItemRow(transaction.database, item);
    }
    await this.writePageState(transaction.database, listId, page);
    transaction.changed(this.scope(listId));
  }

  /**
   * Discards every cursor for a list while keeping its rows.
   *
   * The `503` contract's first two clauses, together and in one statement, because they are
   * one decision: the projection stays visible and nothing may be added to it until page one
   * lands. `complete` goes to `false` for the same reason — a prefix that has stopped draining
   * must not be mistaken for a whole list.
   */
  async invalidatePages(transaction: TransactionContext, listId: string): Promise<void> {
    await transaction.database.run('DELETE FROM list_item_pages WHERE list_id = ?;', [
      listId,
    ]);
    transaction.changed(this.scope(listId));
  }

  /** The visible row for a durable create, committed with its intent. */
  async insertPendingCreate(
    transaction: TransactionContext,
    item: ListItemRow,
  ): Promise<void> {
    await writeItemRow(transaction.database, item);
    transaction.changed(this.scope(item.listId));
  }

  /**
   * Installs the server's row over whatever this device was showing.
   *
   * One method for every acknowledgement, because they are one operation: a create's real rank
   * and provenance, a field patch's server-resolved result, and a collision recovery's adopted
   * row all replace the optimistic copy with the same authority. Named for what it does rather
   * than for the create that first needed it (renamed in P3-29, when the patch arrived).
   */
  async installAcknowledged(
    transaction: TransactionContext,
    item: ListItemRow,
  ): Promise<void> {
    await writeItemRow(transaction.database, item);
    transaction.changed(this.scope(item.listId));
  }

  /**
   * Renames one unsynced row after an explicit collision Retry.
   *
   * An `UPDATE`, so the row keeps its rank and stays where the user last saw it rather than
   * reappearing somewhere else in the list for a reason they were never shown.
   */
  async remapPendingCreate(
    transaction: TransactionContext,
    listId: string,
    previousItemId: string,
    freshItemId: string,
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE list_items SET item_id = ? WHERE item_id = ?;',
      [freshItemId, previousItemId],
    );
    transaction.changed(this.scope(listId));
  }

  async removeCanonical(
    transaction: TransactionContext,
    listId: string,
    itemId: string,
  ): Promise<void> {
    await transaction.database.run('DELETE FROM list_items WHERE item_id = ?;', [itemId]);
    transaction.changed(this.scope(listId));
  }

  /** Drops a whole list's slice — its list left the index, so its items are not ours to hold. */
  async removeList(transaction: TransactionContext, listId: string): Promise<void> {
    await transaction.database.run('DELETE FROM list_items WHERE list_id = ?;', [listId]);
    await transaction.database.run('DELETE FROM list_item_pages WHERE list_id = ?;', [
      listId,
    ]);
    transaction.changed(this.scope(listId));
  }

  private async writePageState(
    database: SqliteExecutor,
    listId: string,
    page: ListItemPageState,
  ): Promise<void> {
    await database.run(
      `INSERT INTO list_item_pages (list_id, rank_version, next_cursor, complete, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(list_id) DO UPDATE SET
         rank_version=excluded.rank_version, next_cursor=excluded.next_cursor,
         complete=excluded.complete, updated_at=excluded.updated_at;`,
      [
        listId,
        page.rankVersion,
        page.nextCursor ?? null,
        page.complete ? 1 : 0,
        systemClock.now(),
      ],
    );
  }
}

/**
 * Re-exported so a caller merging pages in memory uses the same comparator the SQL does.
 * Two orderings for one list is how the two phones in §5.11.5 start disagreeing.
 */
export { compareListItems };
