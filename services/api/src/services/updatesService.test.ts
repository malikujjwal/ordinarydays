import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { deleteUpdate, listUpdates, postUpdate } from './updatesService.js';

vi.mock('../repositories/activityRepository.js', () => ({
  getActivityMeta: vi.fn(),
  touchLastActivity: vi.fn(
    (
      activity: Activity,
      at: string,
      _indexedUserIds: readonly string[],
      items: Array<Record<string, unknown>>,
    ) => {
      items.push({ Update: { Key: { pk: 'ACT#plan', sk: 'META' } } });
      return { ...activity, lastActivityAt: at };
    },
  ),
}));

vi.mock('./authz.js', () => ({ assertActivityAccess: vi.fn() }));

vi.mock('../repositories/activityUpdateRepository.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../repositories/activityUpdateRepository.js')
  >()),
  deleteActivityUpdate: vi.fn(),
  getActivityUpdate: vi.fn(),
  listActivityUpdates: vi.fn(),
}));

vi.mock('../repositories/tx.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repositories/tx.js')>()),
  transactWrite: vi.fn(),
}));

const activityRepository = await import('../repositories/activityRepository.js');
const updateRepository = await import('../repositories/activityUpdateRepository.js');
const authz = await import('./authz.js');
const tx = await import('../repositories/tx.js');

const USER = 'usr_owner';
const ACTIVITY = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-26T12:00:00.000Z';

const plan = (objectKind: 'plan' | 'task' = 'plan'): Activity =>
  ({
    activityId: ACTIVITY,
    ownerId: USER,
    objectKind,
    type: objectKind === 'plan' ? 'custom' : 'task',
    status: 'saved',
    title: 'Conference',
    details: { kind: objectKind === 'plan' ? 'custom' : 'task' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-25T12:00:00.000Z',
    updatedAt: '2026-08-25T12:00:00.000Z',
    schemaVersion: 1,
  }) as Activity;

beforeEach(() => {
  vi.mocked(authz.assertActivityAccess).mockReset();
  vi.mocked(activityRepository.getActivityMeta).mockReset();
  vi.mocked(updateRepository.deleteActivityUpdate).mockReset();
  vi.mocked(updateRepository.getActivityUpdate).mockReset();
  vi.mocked(updateRepository.listActivityUpdates).mockReset();
  vi.mocked(tx.transactWrite).mockReset();
});

describe('authoritative feed authorization', () => {
  it('uses a strong access read before listing history', async () => {
    vi.mocked(authz.assertActivityAccess).mockResolvedValue({
      activity: plan('task'),
      isOwner: true,
      viaParent: false,
    });
    vi.mocked(updateRepository.listActivityUpdates).mockResolvedValue({ updates: [] });

    await listUpdates(USER, ACTIVITY);

    expect(authz.assertActivityAccess).toHaveBeenCalledWith(USER, ACTIVITY, 'read', {
      consistentRead: true,
    });
  });

  it('uses a strong access read before resolving a delete', async () => {
    vi.mocked(authz.assertActivityAccess).mockResolvedValue({
      activity: plan('task'),
      isOwner: true,
      viaParent: false,
    });
    vi.mocked(updateRepository.getActivityUpdate).mockResolvedValue(undefined);

    await expect(deleteUpdate(USER, ACTIVITY, 'upd_missing')).rejects.toMatchObject({
      code: 'not_found',
    });

    expect(authz.assertActivityAccess).toHaveBeenCalledWith(USER, ACTIVITY, 'read', {
      consistentRead: true,
    });
  });
});

describe('postUpdate concurrency', () => {
  it('reasserts Plan-only writes after a lost transaction race', async () => {
    vi.mocked(authz.assertActivityAccess).mockResolvedValue({
      activity: plan(),
      isOwner: true,
      viaParent: false,
    });
    vi.mocked(tx.transactWrite).mockRejectedValueOnce(
      new AppError('conflict', 'The activity changed.'),
    );
    vi.mocked(activityRepository.getActivityMeta).mockResolvedValue(plan('task'));

    await expect(
      postUpdate(USER, ACTIVITY, 'Packing list is ready.', NOW),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Only a plan has an updates feed.',
    });

    expect(tx.transactWrite).toHaveBeenCalledTimes(1);
    expect(activityRepository.getActivityMeta).toHaveBeenCalledWith(ACTIVITY, {
      consistentRead: true,
    });
  });

  it('authorises the initial write from authoritative META', async () => {
    vi.mocked(authz.assertActivityAccess).mockResolvedValue({
      activity: plan(),
      isOwner: true,
      viaParent: false,
    });
    vi.mocked(tx.transactWrite).mockResolvedValue(undefined);

    await postUpdate(USER, ACTIVITY, 'Packing list is ready.', NOW);

    expect(authz.assertActivityAccess).toHaveBeenCalledWith(USER, ACTIVITY, 'write', {
      consistentRead: true,
    });
  });
});
