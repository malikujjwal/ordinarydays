import { instant } from '@od/shared/schemas';
import type { List, User } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileDefaultToClear, resolveListSlot } from './listSlotService.js';

/**
 * The service's own rules, with both repositories mocked (`definition-of-done.md` §3).
 *
 * The four-step rule itself is proved once, pure, in
 * `packages/shared/src/lists/__tests__/resolveSlot.test.ts`. What is left here is what this
 * layer adds: it drains every page before deciding, it hands the rule the caller's order, it
 * writes nothing, and it answers the delete and slot-change paths' one shared question.
 */
vi.mock('../repositories/listRepository.js', () => ({
  listListsForUser: vi.fn(),
}));
vi.mock('../repositories/userRepository.js', () => ({
  getProfile: vi.fn(),
  patchProfile: vi.fn(),
  putProfile: vi.fn(),
}));

const listRepository = await import('../repositories/listRepository.js');
const userRepository = await import('../repositories/userRepository.js');

const USER = 'usr_local_dev';
const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CORNER_SHOP = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const PACKING = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';

const list = (listId: string, slot: List['slot'], archived = false): List => ({
  listId,
  ownerId: USER,
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'A list',
  icon: '🛒',
  emptyStateCopy: 'Nothing here',
  capabilities: { checkable: true, supportsLocation: false },
  slot,
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 1,
  archived,
  updatedAt: instant.parse('2026-08-24T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-24T12:00:00.000Z'),
});

/** One page of the list index, in pointer order. */
const page = (lists: readonly List[], nextCursor?: string) => ({
  items: lists.map((entry) => ({
    list: entry,
    index: {
      listId: entry.listId,
      userId: USER,
      role: 'owner' as const,
      addedAt: '2026-08-24T12:00:00.000Z',
    },
  })),
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

const profile = (defaultLists?: User['defaultLists']): User => ({
  userId: USER,
  displayName: 'Dev',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  ...(defaultLists === undefined ? {} : { defaultLists }),
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
});

beforeEach(() => {
  vi.mocked(listRepository.listListsForUser).mockReset();
  vi.mocked(userRepository.getProfile).mockReset();
  vi.mocked(userRepository.getProfile).mockResolvedValue(profile());
});

describe('resolveListSlot', () => {
  it('uses the only eligible list without consulting a default', async () => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(
      page([list(TRADER_JOES, 'groceries'), list(PACKING, null)]),
    );

    expect(await resolveListSlot(USER, 'groceries')).toEqual({
      kind: 'use',
      listId: TRADER_JOES,
      wasDefault: false,
    });
  });

  it('uses the stored default when several lists are eligible', async () => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(
      page([list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')]),
    );
    vi.mocked(userRepository.getProfile).mockResolvedValue(
      profile({ groceries: CORNER_SHOP }),
    );

    expect(await resolveListSlot(USER, 'groceries')).toEqual({
      kind: 'use',
      listId: CORNER_SHOP,
      wasDefault: true,
    });
  });

  it('asks, in index order, when several are eligible and no default is stored', async () => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(
      page([list(CORNER_SHOP, 'groceries'), list(TRADER_JOES, 'groceries')]),
    );

    const result = await resolveListSlot(USER, 'groceries');

    expect(result.kind === 'ask' && result.candidates.map((row) => row.listId)).toEqual([
      CORNER_SHOP,
      TRADER_JOES,
    ]);
  });

  it('returns none, and nothing else, when no list holds the slot', async () => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(
      page([list(PACKING, null)]),
    );

    const result = await resolveListSlot(USER, 'groceries');

    expect(result).toEqual({ kind: 'none', slot: 'groceries' });
  });

  /**
   * "Exactly one" and "several" are different answers, so a candidate on the second page
   * changes the first page's verdict. Resolving against page one alone would tell a user
   * with fifty-one lists that their only grocery list is the one it happened to see.
   */
  it('drains every page before deciding', async () => {
    vi.mocked(listRepository.listListsForUser)
      .mockResolvedValueOnce(page([list(TRADER_JOES, 'groceries')], 'cursor-2'))
      .mockResolvedValueOnce(page([list(CORNER_SHOP, 'groceries')]));

    const result = await resolveListSlot(USER, 'groceries');

    expect(vi.mocked(listRepository.listListsForUser).mock.calls[1]?.[1]).toBe(
      'cursor-2',
    );
    expect(result.kind).toBe('ask');
  });

  /**
   * Eligibility is a destination decision, not a rendering one, and this resolve follows the
   * `PATCH /v1/me` that stored the user's answer. An eventually consistent read can hold the
   * map from before that answer, keep an archived list looking eligible, or yield a pointer
   * to a membership just revoked — the dead end §P3-12's read-side guard exists to prevent
   * (ADR-033).
   */
  it('reads both the profile and every list page strongly', async () => {
    vi.mocked(listRepository.listListsForUser)
      .mockResolvedValueOnce(page([list(TRADER_JOES, 'groceries')], 'cursor-2'))
      .mockResolvedValueOnce(page([list(CORNER_SHOP, 'groceries')]));

    await resolveListSlot(USER, 'groceries');

    expect(vi.mocked(userRepository.getProfile).mock.calls[0]?.[1]).toEqual({
      consistentRead: true,
    });
    for (const call of vi.mocked(listRepository.listListsForUser).mock.calls) {
      expect(call[2]).toEqual({ consistentRead: true });
    }
  });

  it('resolves against an absent profile map without failing', async () => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(
      page([list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')]),
    );
    vi.mocked(userRepository.getProfile).mockResolvedValue(undefined);

    expect((await resolveListSlot(USER, 'groceries')).kind).toBe('ask');
  });

  /**
   * The read-side guard: a pointer at a list that has been deleted, archived, or re-slotted
   * is treated as unset. It must produce the question, never a destination that no longer
   * exists (§P3-12 edge cases).
   */
  it.each([
    ['a deleted list', [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')]],
    [
      'an archived list',
      [
        list(TRADER_JOES, 'groceries'),
        list(CORNER_SHOP, 'groceries'),
        list(PACKING, 'groceries', true),
      ],
    ],
  ])('asks when the stored default names %s', async (_why, lists) => {
    vi.mocked(listRepository.listListsForUser).mockResolvedValue(page(lists));
    vi.mocked(userRepository.getProfile).mockResolvedValue(
      profile({ groceries: PACKING }),
    );

    expect((await resolveListSlot(USER, 'groceries')).kind).toBe('ask');
  });

  /**
   * Most-recently-used is rejected outright, and resolving is a read (ADR-033). If this ever
   * writes, browsing quietly starts deciding where tomorrow's ingredients go.
   */
  it('writes nothing to the profile, in any of the four cases', async () => {
    vi.mocked(listRepository.listListsForUser)
      .mockResolvedValueOnce(page([list(TRADER_JOES, 'groceries')]))
      .mockResolvedValueOnce(
        page([list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')]),
      )
      .mockResolvedValueOnce(
        page([list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')]),
      )
      .mockResolvedValueOnce(page([]));
    vi.mocked(userRepository.getProfile)
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(profile({ groceries: CORNER_SHOP }))
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(profile());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await resolveListSlot(USER, 'groceries');
    }

    expect(vi.mocked(userRepository.patchProfile)).not.toHaveBeenCalled();
    expect(vi.mocked(userRepository.putProfile)).not.toHaveBeenCalled();
  });
});

describe('profileDefaultToClear', () => {
  it('names the slot the list currently holds', () => {
    expect(profileDefaultToClear(list(TRADER_JOES, 'groceries'))).toEqual({
      slot: 'groceries',
    });
  });

  it('names nothing for a list that holds no slot', () => {
    expect(profileDefaultToClear(list(PACKING, null))).toBeUndefined();
  });

  /**
   * No profile read decides this. One that missed a selection made concurrently on another
   * device would wrongly skip the cleanup; the transaction item is conditional on the exact
   * `(slot, listId)` pair instead.
   */
  it('reads no profile to decide', () => {
    profileDefaultToClear(list(TRADER_JOES, 'groceries'));

    expect(vi.mocked(userRepository.getProfile)).not.toHaveBeenCalled();
  });
});
