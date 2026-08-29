import { listView } from '@od/shared/schemas';
import type { List, ListFeatureConfig } from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import type {
  RepositoryInvalidationMetadata,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function number(row: SqliteRow, column: string): number {
  const value = row[column];
  return typeof value === 'number' ? value : 0;
}

function json(row: SqliteRow, column: string): unknown {
  const value = text(row, column);
  return value === undefined ? undefined : (JSON.parse(value) as unknown);
}

function fromRow(row: SqliteRow): List {
  const sourceActivityId = text(row, 'source_activity_id');
  return listView.parse({
    schemaVersion: number(row, 'schema_version'),
    listId: text(row, 'list_id'),
    ownerId: text(row, 'owner_id'),
    templateKey: text(row, 'template_key'),
    title: text(row, 'title'),
    icon: text(row, 'icon'),
    emptyStateCopy: text(row, 'empty_state_copy'),
    itemStateMode: json(row, 'item_state_mode_json'),
    featureConfig: json(row, 'feature_config_json'),
    slot: text(row, 'slot') ?? null,
    ...(sourceActivityId === undefined ? {} : { sourceActivityId }),
    itemCount: number(row, 'item_count'),
    doneCount: number(row, 'done_count'),
    memberCount: number(row, 'member_count'),
    rankVersion: number(row, 'rank_version'),
    archived: number(row, 'archived') === 1,
    updatedAt: text(row, 'updated_at'),
    lastItemActivityAt: text(row, 'last_item_activity_at'),
  }) as List;
}

async function readListRows(reader: SqliteReader): Promise<readonly List[]> {
  return (await reader.all('SELECT * FROM list_rows ORDER BY position, list_id;')).map(
    fromRow,
  );
}

async function writeListRow(
  database: SqliteExecutor,
  list: List,
  position: number,
): Promise<void> {
  await database.run(
    `INSERT INTO list_rows (
      list_id, position, schema_version, owner_id, template_key, title, icon,
      empty_state_copy, item_state_mode_json, feature_config_json, slot,
      source_activity_id, item_count, done_count, member_count, rank_version,
      archived, updated_at, last_item_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(list_id) DO UPDATE SET
      position=excluded.position, schema_version=excluded.schema_version,
      owner_id=excluded.owner_id, template_key=excluded.template_key,
      title=excluded.title, icon=excluded.icon,
      empty_state_copy=excluded.empty_state_copy,
      item_state_mode_json=excluded.item_state_mode_json,
      feature_config_json=excluded.feature_config_json, slot=excluded.slot,
      source_activity_id=excluded.source_activity_id, item_count=excluded.item_count,
      done_count=excluded.done_count, member_count=excluded.member_count,
      rank_version=excluded.rank_version, archived=excluded.archived,
      updated_at=excluded.updated_at,
      last_item_activity_at=excluded.last_item_activity_at;`,
    [
      list.listId,
      position,
      list.schemaVersion,
      list.ownerId,
      list.templateKey,
      list.title,
      list.icon,
      list.emptyStateCopy,
      JSON.stringify(list.itemStateMode),
      JSON.stringify(list.featureConfig),
      list.slot,
      list.sourceActivityId ?? null,
      list.itemCount,
      list.doneCount,
      list.memberCount,
      list.rankVersion,
      list.archived ? 1 : 0,
      list.updatedAt,
      list.lastItemActivityAt,
    ],
  );
}

async function nextPosition(reader: SqliteReader): Promise<number> {
  const last = (await reader.first('SELECT MAX(position) AS last FROM list_rows;'))?.last;
  return typeof last === 'number' ? last + 1 : 0;
}

export interface ListsCommittedSnapshot {
  readonly lists: readonly List[];
  readonly commitRevision: number;
}

export interface LocalListSettings {
  readonly title?: string;
  readonly itemStateMode?: List['itemStateMode'];
  readonly featureConfig?: ListFeatureConfig;
  readonly slot?: List['slot'];
  readonly archived?: boolean;
}

export interface LocalListItemDelta {
  readonly itemCount: number;
  readonly doneCount: number;
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

  async getLocal(reader: SqliteReader, listId: string): Promise<List | undefined> {
    const row = await reader.first('SELECT * FROM list_rows WHERE list_id = ?;', [
      listId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  }

  async read(): Promise<readonly List[]> {
    return readListRows(this.reader);
  }

  async readSnapshot(): Promise<ListsCommittedSnapshot> {
    if (this.projections === undefined)
      return { lists: await this.read(), commitRevision: 0 };
    const snapshot = await this.projections.snapshot(readListRows);
    return { lists: snapshot.data, commitRevision: snapshot.commitRevision };
  }

  async replaceCanonical(
    transaction: TransactionContext,
    lists: readonly List[],
    protectedListIds: ReadonlySet<string> = new Set(),
    protectedAggregateIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const retainedIds = new Set([...protectedListIds, ...protectedAggregateIds]);
    if (retainedIds.size === 0) await transaction.database.run('DELETE FROM list_rows;');
    else {
      const ids = [...retainedIds];
      await transaction.database.run(
        `DELETE FROM list_rows WHERE list_id NOT IN (${ids.map(() => '?').join(', ')});`,
        ids,
      );
    }
    for (const [position, list] of lists.entries()) {
      if (protectedListIds.has(list.listId)) {
        await transaction.database.run(
          'UPDATE list_rows SET position = ? WHERE list_id = ?;',
          [position, list.listId],
        );
      } else if (protectedAggregateIds.has(list.listId)) {
        const current = await this.getLocal(transaction.database, list.listId);
        await writeListRow(
          transaction.database,
          current === undefined
            ? list
            : {
                ...list,
                itemCount: current.itemCount,
                doneCount: current.doneCount,
              },
          position,
        );
      } else await writeListRow(transaction.database, list, position);
    }
    transaction.changed(this.scope);
  }

  async applySettings(transaction: TransactionContext, list: List): Promise<void> {
    const current = await this.getLocal(transaction.database, list.listId);
    if (current === undefined) return;
    const position = await this.positionOf(transaction.database, list.listId);
    await writeListRow(transaction.database, list, position);
    transaction.changed(this.scope);
  }

  async upsertCanonical(
    transaction: TransactionContext,
    list: List,
    position: number,
  ): Promise<void> {
    await writeListRow(transaction.database, list, position);
    transaction.changed(this.scope);
  }

  async insertPendingCreate(transaction: TransactionContext, list: List): Promise<void> {
    const existing = await this.getLocal(transaction.database, list.listId);
    await writeListRow(
      transaction.database,
      list,
      existing === undefined
        ? await nextPosition(transaction.database)
        : await this.positionOf(transaction.database, list.listId),
    );
    transaction.changed(this.scope);
  }

  async installCanonicalRow(
    transaction: TransactionContext,
    list: List,
    preserveLocalAggregates = false,
  ): Promise<void> {
    const current = preserveLocalAggregates
      ? await this.getLocal(transaction.database, list.listId)
      : undefined;
    await writeListRow(
      transaction.database,
      current === undefined
        ? list
        : {
            ...list,
            itemCount: current.itemCount,
            doneCount: current.doneCount,
          },
      await this.positionOf(transaction.database, list.listId),
    );
    transaction.changed(this.scope);
  }

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

  async applyLocalSettings(
    transaction: TransactionContext,
    listId: string,
    settings: LocalListSettings,
  ): Promise<void> {
    const current = await this.getLocal(transaction.database, listId);
    if (current === undefined) return;
    const next: List = {
      ...current,
      ...(settings.title === undefined ? {} : { title: settings.title }),
      ...(settings.itemStateMode === undefined
        ? {}
        : { itemStateMode: settings.itemStateMode }),
      ...(settings.featureConfig === undefined
        ? {}
        : { featureConfig: { ...current.featureConfig, ...settings.featureConfig } }),
      ...(settings.slot === undefined ? {} : { slot: settings.slot }),
      ...(settings.archived === undefined ? {} : { archived: settings.archived }),
    };
    await writeListRow(
      transaction.database,
      next,
      await this.positionOf(transaction.database, listId),
    );
    transaction.changed(this.scope);
  }

  async applyLocalItemDelta(
    transaction: TransactionContext,
    listId: string,
    delta: LocalListItemDelta,
  ): Promise<void> {
    const current = await this.getLocal(transaction.database, listId);
    if (current === undefined) return;
    const itemCount = Math.max(0, current.itemCount + delta.itemCount);
    const doneCount = Math.max(
      0,
      Math.min(itemCount, current.doneCount + delta.doneCount),
    );
    await writeListRow(
      transaction.database,
      { ...current, itemCount, doneCount },
      await this.positionOf(transaction.database, listId),
    );
    transaction.changed(this.scope);
  }

  async removeCanonical(transaction: TransactionContext, listId: string): Promise<void> {
    await transaction.database.run('DELETE FROM list_rows WHERE list_id = ?;', [listId]);
    transaction.changed(this.scope);
  }

  private async positionOf(reader: SqliteReader, listId: string): Promise<number> {
    const position = (
      await reader.first('SELECT position FROM list_rows WHERE list_id = ?;', [listId])
    )?.position;
    return typeof position === 'number' ? position : nextPosition(reader);
  }
}
