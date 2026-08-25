import type { Activity, ListItem, ListItemActivityLink } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { scheduleListItem } from './listScheduleService.js';

/**
 * The bridge's own rules, with the repositories mocked (`definition-of-done.md` §3).
 *
 * The rules that belong to the schema are proved in
 * `packages/shared/src/schemas/list.test.ts`; the transaction's shape is proved against a
 * real table in `test/integration/listSchedule.int.test.ts`. What is left here is what this
 * service decides: what it refuses and in which order, what it copies once, what it never
 * infers, and what it does when the id is already taken.
 */
vi.mock('../repositories/activityRepository.js', () => ({
  ActivityIdUnavailableError: class extends Error {},
  activityFromPartition: vi.fn(),
  createActivity: vi.fn(),
  getActivityPartitionStrong: vi.fn(),
}));
vi.mock('../repositories/listRepository.js', () => ({
  batchGetViewerLinks: vi.fn(),
  getListItem: vi.fn(),
}));
vi.mock('./authz.js', () => ({ assertListAccess: vi.fn() }));

const activityRepository = await import('../repositories/activityRepository.js');
const listRepository = await import('../repositories/listRepository.js');
const authz = await import('./authz.js');

const USER = 'usr_local_dev';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const REM = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X5';
const NOW = '2026-08-25T09:00:00.000Z';

const item: ListItem = {
  itemId: ITEM,
  listId: LIST,
  rank: 'n',
  itemRevision: 3,
  title: 'Zahav',
  checked: false,
};

const input = {
  activityId: ACT,
  creationTarget: { objectKind: 'plan', type: 'event' },
  audience: { mode: 'just_me' },
} as never;

const withInput = (overrides: Record<string, unknown>) =>
  ({ ...(input as object), ...overrides }) as never;

/** What `createActivity` was handed, which is what the transaction will write. */
const written = () => vi.mocked(activityRepository.createActivity).mock.calls[0];

beforeEach(() => {
  vi.mocked(authz.assertListAccess).mockReset();
  vi.mocked(authz.assertListAccess).mockResolvedValue({
    index: { grant: true },
  } as never);
  vi.mocked(listRepository.getListItem).mockReset();
  vi.mocked(listRepository.getListItem).mockResolvedValue(item);
  vi.mocked(listRepository.batchGetViewerLinks).mockReset();
  vi.mocked(activityRepository.createActivity).mockReset();
  vi.mocked(activityRepository.createActivity).mockResolvedValue(undefined);
  vi.mocked(activityRepository.getActivityPartitionStrong).mockReset();
  vi.mocked(activityRepository.activityFromPartition).mockReset();
});

describe('what the bridge writes', () => {
  it('creates one Plan carrying provenance back to the item', async () => {
    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW);

    const [ownerId, activity] = written() ?? [];
    expect(ownerId).toBe(USER);
    expect(activity).toMatchObject({
      activityId: ACT,
      ownerId: USER,
      objectKind: 'plan',
      type: 'event',
      listId: LIST,
      listItemId: ITEM,
    });
    expect(result.activity.activityId).toBe(ACT);
  });

  /** ADR-034: same key per viewer, so scheduling again replaces only this caller's pointer. */
  it('links the caller and nobody else', async () => {
    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW);

    expect(written()?.[2]?.listItemLink).toEqual({
      listId: LIST,
      itemId: ITEM,
      viewerUserId: USER,
      activityId: ACT,
      linkedAt: NOW,
    });
    expect(result.viewerLink.viewerUserId).toBe(USER);
  });

  /**
   * `agent-playbook.md` §6.8, and the whole reason this endpoint exists as a link rather
   * than a create-and-delete. The service reads the item and returns it; nothing it hands
   * the repository can write an `ITEM#` row.
   */
  it('returns the item unchanged and writes nothing to it', async () => {
    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW);

    expect(result.item).toEqual(item);
    expect(written()?.[2]).not.toHaveProperty('listItem');
  });

  it('writes one caller reminder per supplied id, under that id', async () => {
    await scheduleListItem(
      USER,
      LIST,
      ITEM,
      withInput({
        schedule: { date: '2026-09-01', time: '19:30', timezone: 'America/New_York' },
        reminders: [{ reminderId: REM, offsetMinutes: -30 }],
      }),
      NOW,
    );

    expect(written()?.[2]?.reminders).toEqual([{ reminderId: REM, offsetMinutes: -30 }]);
  });

  it('passes the receipt through so it commits with the domain rows', async () => {
    const receipt = { key: 'k' } as never;

    await scheduleListItem(USER, LIST, ITEM, input, NOW, () => receipt);

    expect(written()?.[2]?.idempotencyReceipt).toBe(receipt);
  });

  /**
   * The receipt is built from the committed result, not before it: P3-08's lesson was a
   * prebuilt receipt naming an item that was never written.
   */
  it('builds the receipt from the result it is about to return', async () => {
    const receiptFor = vi.fn(() => ({ key: 'k' }) as never);

    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW, receiptFor);

    expect(receiptFor).toHaveBeenCalledWith(result);
  });
});

describe('what the bridge never infers', () => {
  /**
   * `CLAUDE.md` rule 2. The stored type follows the request even when it contradicts the
   * list it came from — the server does not read `behaviour` and there is nothing here that
   * could.
   */
  it.each(['meal', 'watch', 'event', 'custom'])(
    'stores the requested Plan kind %s whatever the list is',
    async (type) => {
      await scheduleListItem(
        USER,
        LIST,
        ITEM,
        withInput({ creationTarget: { objectKind: 'plan', type } }),
        NOW,
      );

      expect(written()?.[1]).toMatchObject({ objectKind: 'plan', type });
    },
  );

  it('derives details from the chosen kind when the request omits them', async () => {
    await scheduleListItem(
      USER,
      LIST,
      ITEM,
      withInput({ creationTarget: { objectKind: 'plan', type: 'custom' } }),
      NOW,
    );

    expect(written()?.[1]?.details).toEqual({ kind: 'custom' });
  });

  it('takes ownership from the caller, never from the request', async () => {
    await scheduleListItem('usr_someone_else', LIST, ITEM, input, NOW);

    expect(written()?.[1]?.ownerId).toBe('usr_someone_else');
  });
});

describe('the one-time title seed (P3-14)', () => {
  it('copies the item title when the request omits one', async () => {
    await scheduleListItem(USER, LIST, ITEM, input, NOW);

    expect(written()?.[1]?.title).toBe('Zahav');
  });

  it('uses the supplied title instead when there is one', async () => {
    await scheduleListItem(
      USER,
      LIST,
      ITEM,
      withInput({ title: 'Dinner at Zahav' }),
      NOW,
    );

    expect(written()?.[1]?.title).toBe('Dinner at Zahav');
  });
});

describe('what the bridge refuses, before it writes anything', () => {
  /**
   * Refused ahead of the item read, so the rejection does not depend on whether the item
   * happened to exist — a caller asking for a Plan this phase cannot make gets one answer.
   */
  it('refuses selected_people with the shared copy, without reading the item', async () => {
    await expect(
      scheduleListItem(
        USER,
        LIST,
        ITEM,
        withInput({
          audience: { mode: 'selected_people', participants: [{ displayName: 'Sam' }] },
        }),
        NOW,
      ),
    ).rejects.toThrow('Sharing is coming soon.');

    expect(vi.mocked(listRepository.getListItem)).not.toHaveBeenCalled();
    expect(vi.mocked(activityRepository.createActivity)).not.toHaveBeenCalled();
  });

  /** Temporary, and removed by P3-22. Dropping them silently is the failure being avoided. */
  it('refuses a non-empty attachmentIds and writes nothing', async () => {
    await expect(
      scheduleListItem(
        USER,
        LIST,
        ITEM,
        withInput({ attachmentIds: ['att_01J8XKQ2M4N5P6R7S8T9V0W1X6'] }),
        NOW,
      ),
    ).rejects.toThrow('Attachments are coming soon.');

    expect(vi.mocked(activityRepository.createActivity)).not.toHaveBeenCalled();
  });

  it('accepts an empty attachmentIds, which asks for nothing', async () => {
    await scheduleListItem(USER, LIST, ITEM, withInput({ attachmentIds: [] }), NOW);

    expect(vi.mocked(activityRepository.createActivity)).toHaveBeenCalled();
  });

  it('404s a missing or tombstoned item and writes nothing', async () => {
    vi.mocked(listRepository.getListItem).mockResolvedValue(undefined);

    await expect(scheduleListItem(USER, LIST, ITEM, input, NOW)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(vi.mocked(activityRepository.createActivity)).not.toHaveBeenCalled();
  });

  /** A rank repair or behaviour migration must surface as P3-04's retryable 503, not a 404. */
  it('lets a read-fence failure propagate', async () => {
    vi.mocked(listRepository.getListItem).mockRejectedValue(
      new AppError('internal', 'An unexpected error occurred.'),
    );

    await expect(scheduleListItem(USER, LIST, ITEM, input, NOW)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('requires membership before anything else', async () => {
    vi.mocked(authz.assertListAccess).mockRejectedValue(
      new AppError('not_found', 'List not found.'),
    );

    await expect(scheduleListItem(USER, LIST, ITEM, input, NOW)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(vi.mocked(listRepository.getListItem)).not.toHaveBeenCalled();
  });
});

describe('replay after the receipt has expired', () => {
  const existing = {
    activityId: ACT,
    ownerId: USER,
    listId: LIST,
    listItemId: ITEM,
    title: 'Zahav',
  } as Activity;

  const newerLink: ListItemActivityLink = {
    listId: LIST,
    itemId: ITEM,
    viewerUserId: USER,
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9',
    linkedAt: '2026-08-26T09:00:00.000Z',
  };

  const collide = () => {
    vi.mocked(activityRepository.createActivity).mockRejectedValue(
      new activityRepository.ActivityIdUnavailableError(),
    );
  };

  /**
   * The earlier successful action, whose response was lost. It is returned as it stands and
   * **the current pointer is not rewritten** — it may name a newer confirmed Plan, and
   * rolling it back to this older one is the bug this path exists to avoid (§P3-13).
   */
  it('adopts a matching Activity and rewrites nothing', async () => {
    collide();
    vi.mocked(activityRepository.activityFromPartition).mockReturnValue(existing);
    vi.mocked(listRepository.batchGetViewerLinks).mockResolvedValue([newerLink]);

    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW);

    expect(result.activity).toBe(existing);
    expect(result.viewerLink).toBe(newerLink);
    expect(vi.mocked(activityRepository.createActivity)).toHaveBeenCalledTimes(1);
  });

  /**
   * The response has to describe what stands, not what this request proposed. `receiptFor`
   * is called while the transaction options are built — before the collision is known — so
   * without a second call the client receives the older Plan and a `linkedAt` minted moments
   * ago, describing a write that never happened. Caught by the integration test for this
   * exact case; pinned here at the seam that owns it.
   */
  it('re-stamps the response body with the adopted result', async () => {
    collide();
    vi.mocked(activityRepository.activityFromPartition).mockReturnValue(existing);
    vi.mocked(listRepository.batchGetViewerLinks).mockResolvedValue([newerLink]);
    const receiptFor = vi.fn((_result: unknown) => ({ key: 'k' }) as never);

    const result = await scheduleListItem(USER, LIST, ITEM, input, NOW, receiptFor);

    expect(receiptFor).toHaveBeenCalledTimes(2);
    expect(receiptFor).toHaveBeenLastCalledWith(result);
    expect(receiptFor.mock.lastCall?.[0]).toMatchObject({ viewerLink: newerLink });
  });

  it('reads the existing Activity strongly, not from a replica', async () => {
    collide();
    vi.mocked(activityRepository.activityFromPartition).mockReturnValue(existing);
    vi.mocked(listRepository.batchGetViewerLinks).mockResolvedValue([newerLink]);

    await scheduleListItem(USER, LIST, ITEM, input, NOW);

    expect(vi.mocked(activityRepository.getActivityPartitionStrong)).toHaveBeenCalledWith(
      ACT,
    );
  });

  /**
   * Anything that is not this caller's earlier action is an id that is simply unavailable,
   * answered with copy that says nothing about whose it is or what became of it
   * (`data-model.md` §8).
   */
  it.each([
    ['nothing stands at that id', undefined],
    ['it belongs to another user', { ...existing, ownerId: 'usr_other' } as Activity],
    ['it came from another list', { ...existing, listId: 'lst_other' } as Activity],
    ['it came from another item', { ...existing, listItemId: 'itm_other' } as Activity],
  ])('conflicts with metadata-free copy when %s', async (_why, found) => {
    collide();
    vi.mocked(activityRepository.activityFromPartition).mockReturnValue(found);

    await expect(scheduleListItem(USER, LIST, ITEM, input, NOW)).rejects.toMatchObject({
      code: 'conflict',
      message: 'That id is already in use. Try again.',
    });
  });

  it('propagates a failure that is not an id collision', async () => {
    vi.mocked(activityRepository.createActivity).mockRejectedValue(
      new Error('ProvisionedThroughputExceeded'),
    );

    await expect(scheduleListItem(USER, LIST, ITEM, input, NOW)).rejects.toThrow(
      'ProvisionedThroughputExceeded',
    );
  });
});
