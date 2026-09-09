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

vi.mock('./authz.js', () => ({
  assertListAccess: vi.fn(),
  assertActivityAccess: vi.fn(),
}));
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
const PLAN_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
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
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({
    activity: { activityId: PLAN_ID, ownerId: USER, objectKind: 'plan' },
    isOwner: true,
    viaParent: false,
  } as never);
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

  it('attaches an owned unlinked List to one owned Plan without inventing an Undo', async () => {
    const result = await patchListSettings(
      USER,
      LIST_ID,
      { sourceActivityId: PLAN_ID },
      NOW,
      LATER,
    );

    expect(authz.assertActivityAccess).toHaveBeenCalledWith(USER, PLAN_ID, 'owner');
    expect(result).toEqual({
      list: { ...list(), sourceActivityId: PLAN_ID, updatedAt: LATER },
    });
    expect(repository.patchListMeta).toHaveBeenCalledWith(
      USER,
      LIST_ID,
      GRANT,
      { sourceActivityId: PLAN_ID },
      NOW,
      LATER,
      expect.objectContaining({ sourceActivityId: PLAN_ID }),
    );
    expect(
      vi.mocked(repository.patchListMeta).mock.calls[0]?.[6]?.undoFor,
    ).toBeUndefined();
  });

  it.each([
    ['title', { title: 'Watch later' }],
    ['itemStateMode', { itemStateMode: list().itemStateMode }],
    [
      'featureConfig',
      { featureConfig: { progress: { enabled: true, kind: 'episode' } } },
    ],
    ['slot', { slot: null }],
    ['archived', { archived: false }],
  ] as const)(
    'returns current truth without a write or Undo when %s is unchanged',
    async (_field, input) => {
      const result = await patchListSettings(USER, LIST_ID, input, NOW, LATER);

      expect(result).toEqual({ list: list() });
      expect(result.undo).toBeUndefined();
      expect(repository.patchListMeta).not.toHaveBeenCalled();
    },
  );

  it('refuses to move a List that is already connected to another Plan', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4' }),
    );

    await expect(
      patchListSettings(USER, LIST_ID, { sourceActivityId: PLAN_ID }, NOW, LATER),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(repository.patchListMeta).not.toHaveBeenCalled();
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
