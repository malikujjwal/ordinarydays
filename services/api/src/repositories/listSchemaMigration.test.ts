import type { List } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./base.js', () => ({
  getItem: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./tx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tx.js')>();
  return { ...actual, transactWrite: vi.fn() };
});

const base = await import('./base.js');
const tx = await import('./tx.js');
const migration = await import('./listSchemaMigration.js');

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-23T14:00:00.000Z';

const legacyMeta = {
  pk: `LIST#${LIST_ID}`,
  sk: 'META',
  entity: 'List',
  createdAt: NOW,
  schemaVersion: 1,
  listId: LIST_ID,
  ownerId: 'usr_list_migration_alice',
  behaviour: 'watch',
  templateKey: 'watch-list',
  title: 'Watch later',
  icon: 'play',
  emptyStateCopy: 'Nothing queued.',
  capabilities: { checkable: false, supportsLocation: false },
  slot: null,
  itemCount: 1,
  uncheckedCount: 1,
  memberCount: 1,
  rankVersion: 7,
  itemVersion: 4,
  archived: false,
  updatedAt: NOW,
  lastItemActivityAt: NOW,
};

const legacyItem = {
  pk: `LIST#${LIST_ID}`,
  sk: 'ITEM#V#itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  entity: 'ListItem',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  listId: LIST_ID,
  rank: 'V',
  itemRevision: 2,
  title: 'Severance',
  checked: false,
  details: {
    behaviour: 'watch',
    mediaKind: 'show',
    watchStatus: 'watching',
    season: 2,
    episode: 4,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(base.getItem).mockResolvedValue(undefined);
  vi.mocked(base.query).mockResolvedValue({ items: [legacyItem] });
  vi.mocked(tx.transactWrite).mockResolvedValue(undefined);
});

describe('migrateListAggregateOnRead', () => {
  it('fences, converts a bounded item page, and installs exact canonical meta', async () => {
    const result = await migration.migrateListAggregateOnRead(LIST_ID, legacyMeta);

    expect(result).toMatchObject({
      schemaVersion: 2,
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
        groupByState: true,
      },
      featureConfig: { progress: { enabled: true, kind: 'episode' } },
      doneCount: 0,
      rankVersion: 8,
    } satisfies Partial<List>);
    expect(result).not.toHaveProperty('behaviour');
    expect(result).not.toHaveProperty('capabilities');
    expect(result).not.toHaveProperty('uncheckedCount');

    const transactions = vi.mocked(tx.transactWrite).mock.calls.map(([items]) => items);
    expect(transactions).toHaveLength(3);
    expect(
      transactions[0]?.some((entry) => entry.Put?.Item?.entity === 'ListSchemaMigration'),
    ).toBe(true);
    const migratedItem = transactions[1]?.find(
      (entry) => entry.Put?.Item?.entity === 'ListItem',
    )?.Put?.Item;
    expect(migratedItem).toMatchObject({
      state: 'active',
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
      },
    });
    expect(migratedItem).not.toHaveProperty('checked');
    expect(migratedItem).not.toHaveProperty('details');
  });

  it('resumes from the persisted cursor after an interrupted first attempt', async () => {
    vi.mocked(base.query).mockRejectedValueOnce(new Error('interrupted'));
    await expect(
      migration.migrateListAggregateOnRead(LIST_ID, legacyMeta),
    ).rejects.toThrow('interrupted');

    vi.clearAllMocks();
    vi.mocked(base.getItem).mockResolvedValue({
      pk: `LIST#${LIST_ID}`,
      sk: 'SCHEMA_MIGRATION#schema_v2',
      entity: 'ListSchemaMigration',
      schemaVersion: 2,
      createdAt: NOW,
      updatedAt: NOW,
      listId: LIST_ID,
      operationId: 'schema_v2',
      legacyList: legacyMeta,
      cursor: 'persisted-cursor',
      doneCount: 0,
      complete: false,
    });
    vi.mocked(base.query).mockResolvedValue({ items: [legacyItem] });
    vi.mocked(tx.transactWrite).mockResolvedValue(undefined);

    await migration.migrateListAggregateOnRead(LIST_ID, {
      ...legacyMeta,
      schemaMigrationId: 'schema_v2',
    });

    expect(base.query).toHaveBeenCalledWith(
      { pk: `LIST#${LIST_ID}` },
      expect.objectContaining({ cursor: 'persisted-cursor', limit: 40 }),
    );
    expect(vi.mocked(tx.transactWrite)).toHaveBeenCalledTimes(2);
  });
});
