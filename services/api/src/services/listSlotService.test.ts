import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileDefaultToClear } from './listSlotService.js';

/**
 * `profileDefaultToClear` is what remains of this service after Option B1 removed
 * `resolveListSlot` as dead code (`docs/reports/
 * destination-flow-simplification-20260916.md` — resolving a destination is client-only now,
 * and the server-side mirror had no caller outside its own test, which this file was).
 */
vi.mock('../repositories/userRepository.js', () => ({
  getProfile: vi.fn(),
  patchProfile: vi.fn(),
  putProfile: vi.fn(),
}));

const userRepository = await import('../repositories/userRepository.js');

const USER = 'usr_local_dev';
const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PACKING = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';

const list = (listId: string, slot: List['slot'], archived = false): List => ({
  listId,
  ownerId: USER,
  schemaVersion: 2,
  templateKey: 'groceries',
  title: 'A list',
  icon: '🛒',
  emptyStateCopy: 'Nothing here',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 1,
  archived,
  updatedAt: instant.parse('2026-08-24T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-24T12:00:00.000Z'),
});

beforeEach(() => {
  vi.mocked(userRepository.getProfile).mockReset();
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
