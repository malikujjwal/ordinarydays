import type { List } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import { profileDefaultToClear } from './listSlotService.js';

/**
 * The one decision this module owns so far, with the profile repository mocked
 * (`definition-of-done.md` §3): which profile default a write to this list may clear.
 */
vi.mock('../repositories/userRepository.js', () => ({ getProfile: vi.fn() }));

const userRepository = await import('../repositories/userRepository.js');

const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PACKING = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';

const list = (listId: string, slot: List['slot']): List => ({
  listId,
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'A list',
  icon: 'cart',
  emptyStateCopy: 'Nothing here',
  capabilities: { checkable: true, supportsLocation: false },
  slot,
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 1,
  archived: false,
  updatedAt: '2026-08-24T12:00:00.000Z',
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
