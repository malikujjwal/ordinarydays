import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListAccessGrant } from '../repositories/listRepository.js';

vi.mock('../repositories/listRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/listRepository.js')
  >('../repositories/listRepository.js');
  return { ...actual, getListMeta: vi.fn(), patchListMeta: vi.fn() };
});

vi.mock('./authz.js', () => ({ assertListAccess: vi.fn() }));
vi.mock('./listRankRepairService.js', () => ({
  drainRankRepair: vi.fn(() => Promise.resolve(true)),
}));

const repository = await import('../repositories/listRepository.js');
const authz = await import('./authz.js');
const repair = await import('./listRankRepairService.js');
const { drainListWork, patchListSettings, withListWorkDrain } = await import(
  './listMutationService.js'
);

const USER = 'usr_local_dev';
const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = instant.parse('2026-08-24T09:00:00.000Z');
const LATER = instant.parse('2026-08-24T09:01:00.000Z');
const GRANT = {
  listId: LIST_ID,
  userId: USER,
  role: 'owner',
} as unknown as ListAccessGrant;

const list = (overrides: Partial<List> = {}): List => ({
  schemaVersion: 2,
  listId: LIST_ID,
  ownerId: USER,
  templateKey: 'watch-later',
  title: 'Watch later',
  icon: 'play',
  emptyStateCopy: 'Add something to watch.',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Want', active: 'Watching', done: 'Watched' },
    groupByState: true,
  },
  featureConfig: {
    progress: { enabled: true, kind: 'episode' },
    place: { enabled: false },
  },
  slot: null,
  itemCount: 2,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 3,
  itemVersion: 4,
  archived: false,
  updatedAt: NOW,
  lastItemActivityAt: NOW,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authz.assertListAccess).mockResolvedValue({ index: GRANT, isOwner: true });
  vi.mocked(repository.getListMeta).mockResolvedValue(list());
  vi.mocked(repository.patchListMeta).mockResolvedValue(undefined);
  vi.mocked(repair.drainRankRepair).mockResolvedValue(true);
});

describe('patchListSettings', () => {
  it('merges feature keys and stores a six-second undo without touching item values', async () => {
    const result = await patchListSettings(
      USER,
      LIST_ID,
      { featureConfig: { place: { enabled: true } } },
      NOW,
      LATER,
    );

    expect(result.list.featureConfig).toEqual({
      progress: { enabled: true, kind: 'episode' },
      place: { enabled: true },
    });
    expect(Date.parse(result.undo?.expiresAt ?? '') - Date.parse(LATER)).toBe(6_000);
    const options = vi.mocked(repository.patchListMeta).mock.calls[0]?.[6];
    expect(options?.undoFor?.()).toMatchObject({
      inverse: { featureConfig: list().featureConfig },
      preconditions: { featureConfig: result.list.featureConfig },
    });
  });

  it('lets a member rename but rejects owner-only presentation and feature settings', async () => {
    vi.mocked(authz.assertListAccess).mockResolvedValue({ index: GRANT, isOwner: false });
    await expect(
      patchListSettings(USER, LIST_ID, { itemStateMode: { mode: 'none' } }, NOW, LATER),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      patchListSettings(USER, LIST_ID, { title: 'Shared queue' }, NOW, LATER),
    ).resolves.toMatchObject({ list: { title: 'Shared queue' } });
  });
});

describe('work draining', () => {
  it('drains rank repair work', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ rankRepairId: 'op_rank' }),
    );
    await expect(drainListWork(USER, LIST_ID, GRANT, NOW)).resolves.toBe(true);
    expect(repair.drainRankRepair).toHaveBeenCalledWith(USER, LIST_ID, GRANT, NOW);
  });

  it('retries a fenced read once after work drains', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ rankRepairId: 'op_rank' }),
    );
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new repository.ListReadFenceError())
      .mockResolvedValue('page');
    await expect(withListWorkDrain(USER, LIST_ID, GRANT, read, NOW)).resolves.toBe(
      'page',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});
