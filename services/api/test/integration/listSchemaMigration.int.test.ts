import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let repository: Repository;
let base: Base;
let keys: Keys;

const USER = 'usr_list_schema_migration';
const NOW = '2026-08-24T09:00:00.000Z';

beforeAll(async () => {
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

function legacyList(listId: string) {
  return {
    listId,
    ownerId: USER,
    behaviour: 'watch' as const,
    templateKey: 'watch-list',
    title: 'Watch later',
    icon: 'play',
    emptyStateCopy: 'Nothing queued.',
    capabilities: { checkable: false, supportsLocation: false },
    slot: null,
    itemCount: 2,
    uncheckedCount: 1,
    memberCount: 1,
    rankVersion: 7,
    itemVersion: 4,
    archived: false,
    updatedAt: NOW,
    lastItemActivityAt: NOW,
  };
}

async function seedPointer(listId: string): Promise<void> {
  await base.putItem({
    ...keys.listPointer(USER, listId),
    entity: 'ListIndex',
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    listId,
    userId: USER,
    role: 'owner',
    addedAt: NOW,
  });
}

async function seedLegacyAggregate(listId: string, marker = false): Promise<void> {
  const list = legacyList(listId);
  await seedPointer(listId);
  await base.putItem({
    ...keys.listMeta(listId),
    entity: 'List',
    schemaVersion: 1,
    createdAt: NOW,
    ...list,
    ...(marker ? { schemaMigrationId: 'schema_v2' } : {}),
  });
  const items = [
    {
      itemId: repository.newItemId(),
      rank: 'U',
      title: 'Severance',
      checked: false,
      details: {
        behaviour: 'watch' as const,
        mediaKind: 'show' as const,
        watchStatus: 'watching' as const,
        season: 2,
        episode: 4,
      },
    },
    {
      itemId: repository.newItemId(),
      rank: 'V',
      title: 'Arrival',
      checked: true,
      details: {
        behaviour: 'watch' as const,
        mediaKind: 'movie' as const,
        watchStatus: 'watched' as const,
      },
    },
  ];
  for (const item of items) {
    await base.putItem({
      ...keys.listItem(listId, item.rank, item.itemId),
      entity: 'ListItem',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      listId,
      itemRevision: 0,
      ...item,
    });
    await base.putItem({
      ...keys.listItemLocator(listId, item.itemId),
      entity: 'ListItemLocator',
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      listId,
      itemId: item.itemId,
      rank: item.rank,
      itemRevision: 0,
    });
  }
  if (marker) {
    await base.putItem({
      ...keys.listSchemaMigration(listId, 'schema_v2'),
      entity: 'ListSchemaMigration',
      schemaVersion: 2,
      createdAt: NOW,
      updatedAt: NOW,
      listId,
      operationId: 'schema_v2',
      legacyList: list,
      doneCount: 0,
      complete: false,
    });
  }
}

async function readThroughRepository(listId: string) {
  const access = await repository.getListPointer(USER, listId);
  if (access === undefined) throw new Error('Missing fixture pointer.');
  return repository.getListMeta(USER, listId, access);
}

describe('legacy List aggregate migration', () => {
  it('converts meta and items exactly and removes every legacy discriminant', async () => {
    const listId = repository.newListId();
    await seedLegacyAggregate(listId);

    const list = await readThroughRepository(listId);
    expect(list).toMatchObject({
      schemaVersion: 2,
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
        groupByState: true,
      },
      featureConfig: { progress: { enabled: true, kind: 'episode' } },
      doneCount: 1,
      rankVersion: 8,
    });

    const storedMeta = await base.getItem<Record<string, unknown>>(
      keys.listMeta(listId),
      {
        consistentRead: true,
      },
    );
    expect(storedMeta).not.toHaveProperty('behaviour');
    expect(storedMeta).not.toHaveProperty('capabilities');
    expect(storedMeta).not.toHaveProperty('uncheckedCount');
    expect(storedMeta).not.toHaveProperty('schemaMigrationId');
    // Stored-shape conversion is not item activity (P3-47): the card's timestamp holds.
    expect(storedMeta).toMatchObject({ lastItemActivityAt: NOW, updatedAt: NOW });

    const prefix = keys.listItemPrefix(listId);
    const items = await base.queryAll<Record<string, unknown>>(
      { pk: prefix.pk },
      { skPrefix: prefix.skPrefix, consistentRead: true },
    );
    expect(items.map((item) => item.state).sort()).toEqual(['active', 'done']);
    expect(items[0]).not.toHaveProperty('checked');
    expect(items[0]).not.toHaveProperty('details');
    expect(items.find((item) => item.title === 'Severance')).toMatchObject({
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
      },
    });
    expect(
      await base.getItem(keys.listSchemaMigration(listId, 'schema_v2'), {
        consistentRead: true,
      }),
    ).toBeUndefined();
  });

  it('resumes from a durable begin marker after process interruption', async () => {
    const listId = repository.newListId();
    await seedLegacyAggregate(listId, true);

    await expect(readThroughRepository(listId)).resolves.toMatchObject({
      schemaVersion: 2,
      doneCount: 1,
      rankVersion: 8,
    });
    await expect(readThroughRepository(listId)).resolves.toMatchObject({
      schemaVersion: 2,
      doneCount: 1,
      rankVersion: 8,
    });
  });
});
