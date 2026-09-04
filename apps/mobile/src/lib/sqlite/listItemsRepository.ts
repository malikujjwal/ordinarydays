import type { PatchListItemInput } from '@od/shared/client';
import { compareListItems } from '@od/shared/rank';
import {
  listItemActivityLink,
  listItemPlanState,
  listItemView,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  ListItemActivityLink,
  ListItemPlanState,
  ListItemView,
} from '@od/shared/types';
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
 * `ListItemView` plus the caller's viewer pair — the widened type P3-27's alias comment said
 * a new column would need. P3-35 added exactly that: `viewer_link_json` / `viewer_plan_json`
 * store the caller-scoped `viewerLink` / `viewerPlan` the list-detail response joins beside
 * the item (`api-contract.md` §2.7), so the Plan state line renders offline.
 *
 * The pair is a **projection of somebody else's truth**, which is why it is optional and why
 * its writes are separated below: item writes preserve it, and only the reads that carry
 * authoritative page truth — a detail page install, or the bridge settlement that created the
 * link — may set or clear it. `fromRow` still parses the item through `listItemView`; the
 * pair parses through its own schemas, and a corrupt stored pair degrades to absence rather
 * than failing the row, because a list must open even when a stale projection cannot.
 */
export type ListItemRow = ListItemView & {
  readonly viewerLink?: ListItemActivityLink;
  readonly viewerPlan?: ListItemPlanState;
};

/** The caller's link and the trimmed Plan it names; always stored and cleared together. */
export interface ViewerPlanPair {
  readonly viewerLink: ListItemActivityLink;
  readonly viewerPlan: ListItemPlanState;
}

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
  const features = json(row, 'features_json');

  const item = listItemView.parse({
    itemId: text(row, 'item_id'),
    listId: text(row, 'list_id'),
    rank: text(row, 'rank'),
    title: text(row, 'title'),
    state: text(row, 'state'),
    ...(note === undefined ? {} : { note }),
    ...(sourceActivityId === undefined ? {} : { sourceActivityId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    ...(features === undefined ? {} : { features }),
  }) as ListItemView;

  /*
   * The pair degrades to absence rather than failing the row: a list has to open even when a
   * stale viewer projection cannot be read, and the line's own eligibility rules already
   * treat absence as "no line". The `undefined` guard is the hot path — most rows carry no
   * pair, and validating `undefined` just to fail allocates two ZodErrors per row read.
   */
  const linkJson = json(row, 'viewer_link_json');
  const planJson = json(row, 'viewer_plan_json');
  if (linkJson === undefined || planJson === undefined) return item;
  const link = listItemActivityLink.safeParse(linkJson);
  const plan = listItemPlanState.safeParse(planJson);
  if (!link.success || !plan.success) return item;
  return {
    ...item,
    viewerLink: link.data as ListItemActivityLink,
    viewerPlan: plan.data as ListItemPlanState,
  };
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

/**
 * Writes the **item's own** columns and preserves the viewer pair on an existing row.
 *
 * Deliberate asymmetry (P3-35): an acknowledged create, a field patch or an Undo restore is
 * item truth and says nothing about the caller's link — overwriting the pair from a bare item
 * would clear a line the server still holds. On a fresh insert the row's own optional pair is
 * written (a page install's rows carry it); on conflict the stored pair stands until
 * {@link ListItemsRepository.setViewerPair} carries authoritative page or settlement truth.
 *
 * `pairAuthority` is the page-merge exception: a page entry carries the caller's **current**
 * pair, absence included, so its conflict arm installs that truth in the same statement — one
 * write per item instead of an upsert-then-update pair on the sync hot path.
 */
/** Two complete, greppable statements — never assembled by concatenating SQL fragments. */
const ITEM_UPSERT_SQL = `INSERT INTO list_items (
  item_id, list_id, rank, title, note, state, features_json,
  source_activity_id, source_label, viewer_link_json, viewer_plan_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(item_id) DO UPDATE SET
  list_id=excluded.list_id, rank=excluded.rank, title=excluded.title,
  note=excluded.note, state=excluded.state,
  features_json=excluded.features_json,
  source_activity_id=excluded.source_activity_id,
  source_label=excluded.source_label;`;

const ITEM_UPSERT_WITH_PAIR_SQL = `INSERT INTO list_items (
  item_id, list_id, rank, title, note, state, features_json,
  source_activity_id, source_label, viewer_link_json, viewer_plan_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(item_id) DO UPDATE SET
  list_id=excluded.list_id, rank=excluded.rank, title=excluded.title,
  note=excluded.note, state=excluded.state,
  features_json=excluded.features_json,
  source_activity_id=excluded.source_activity_id,
  source_label=excluded.source_label,
  viewer_link_json=excluded.viewer_link_json,
  viewer_plan_json=excluded.viewer_plan_json;`;

async function writeItemRow(
  database: SqliteExecutor,
  item: ListItemRow,
  pairAuthority = false,
): Promise<void> {
  await database.run(pairAuthority ? ITEM_UPSERT_WITH_PAIR_SQL : ITEM_UPSERT_SQL, [
    item.itemId,
    item.listId,
    item.rank,
    item.title,
    item.note ?? null,
    item.state,
    item.features === undefined ? null : JSON.stringify(item.features),
    item.sourceActivityId ?? null,
    item.sourceLabel ?? null,
    // Pointer and state travel together or not at all (§3): a half-pair stores as absence.
    ...(item.viewerLink === undefined || item.viewerPlan === undefined
      ? [null, null]
      : [JSON.stringify(item.viewerLink), JSON.stringify(item.viewerPlan)]),
  ]);
}

/**
 * Installs authoritative viewer-pair truth for one row, absence included.
 *
 * Only two callers have that authority: a list-detail page (the server joined the caller's
 * current pair, so a bare entry **is** a cleared pointer) and the bridge settlement that just
 * created the link (P3-34). `undefined` clears; a row that no longer exists is a no-op.
 */
async function writeViewerPair(
  database: SqliteExecutor,
  itemId: string,
  pair: ViewerPlanPair | undefined,
): Promise<void> {
  await database.run(
    'UPDATE list_items SET viewer_link_json = ?, viewer_plan_json = ? WHERE item_id = ?;',
    [
      pair === undefined ? null : JSON.stringify(pair.viewerLink),
      pair === undefined ? null : JSON.stringify(pair.viewerPlan),
      itemId,
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
  const { note: currentNote, features: currentFeatures, ...rest } = item;
  const note = changes.note === undefined ? currentNote : (changes.note ?? undefined);
  const features = (() => {
    if (changes.features === undefined) return currentFeatures;
    const next = { ...(currentFeatures ?? {}) };
    for (const key of ['progress', 'place', 'subItems'] as const) {
      const value = changes.features[key];
      if (value === null) delete next[key];
      else if (value !== undefined) Object.assign(next, { [key]: value });
    }
    return Object.keys(next).length === 0 ? undefined : next;
  })();
  return listItemView.parse({
    ...rest,
    title: changes.title ?? rest.title,
    state: changes.state ?? rest.state,
    ...(note === undefined ? {} : { note }),
    ...(features === undefined ? {} : { features }),
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

/** Shared by repositories that change whether a List-detail projection is reachable. */
export function listItemsSubscriptionScope(listId: string): string {
  return `listItems:${listId}`;
}

export class ListItemsRepository {
  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections?: RevisionedProjectionReader,
  ) {}

  /** Scoped per list: opening one list must not wake a subscriber reading another. */
  scope(listId: string): string {
    return listItemsSubscriptionScope(listId);
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
      if (!protectedItemIds.has(item.itemId)) {
        /*
         * A page's entries carry the caller's **current** pair, absence included, so a merge
         * over an existing row installs that truth in the same upsert (P3-35).
         */
        await writeItemRow(transaction.database, item, true);
      }
    }
    await this.writePageState(transaction.database, listId, page);
    transaction.changed(this.scope(listId));
  }

  /**
   * Installs the caller's viewer pair for one row (P3-34's settlement, or a targeted repair).
   * `undefined` clears both halves; pointer and state travel together or not at all (§3).
   */
  async setViewerPair(
    transaction: TransactionContext,
    listId: string,
    itemId: string,
    pair: ViewerPlanPair | undefined,
  ): Promise<void> {
    await writeViewerPair(transaction.database, itemId, pair);
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

  /**
   * Puts one row at a rank, and touches nothing else (§P3-30, criterion 16).
   *
   * An `UPDATE` of one column on one row, three times over a drag: the optimistic drop, the
   * rank the server allocated, and — if the request is refused — the rank it came from. A
   * whole-row write would be wrong for all three, because a drag says nothing about a title
   * another member may have changed while the finger was down.
   *
   * The rank it is given is never one this device authored for the server's benefit. The
   * optimistic value is provisional and local, exactly as `pendingListItem.ts` records for an
   * appended create, and the request that accompanies it carries `afterItemId` alone.
   */
  async setRankLocal(
    transaction: TransactionContext,
    listId: string,
    itemId: string,
    rank: string,
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE list_items SET rank = ? WHERE item_id = ? AND list_id = ?;',
      [rank, itemId, listId],
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
