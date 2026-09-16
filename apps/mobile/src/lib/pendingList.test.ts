import { listTemplateSeed } from '@od/shared/lists';
import { instant } from '@od/shared/schemas';
import { describe, expect, it } from 'vitest';
import { pendingListFromInput } from '@/lib/pendingList';

/**
 * The optimistic List row's §P3-05/§P3-39 slot rule: a list created for one Plan is forced
 * to `slot: null` exactly as the server will force it, so the row never briefly claims to be
 * a standing destination the acknowledgement would then demote.
 */

const NOW = instant.parse('2026-09-01T08:00:00.000Z');
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

function seedOf(templateKey: string) {
  const seed = listTemplateSeed(templateKey);
  if (seed === undefined) throw new Error(`Missing template ${templateKey}`);
  return seed;
}

describe('pendingListFromInput', () => {
  it('copies the chosen style’s slot for an ordinary create', () => {
    const seed = seedOf('groceries');
    const row = pendingListFromInput(
      { listId: LIST, title: 'Groceries', templateKey: 'groceries' },
      seed,
      LIST,
      'usr_local_dev',
      NOW,
    );
    expect(row.slot).toBe(seed.slot);
    expect(row).not.toHaveProperty('sourceActivityId');
  });

  it('forces slot null and carries the source for a Plan-created list', () => {
    const seed = seedOf('groceries');
    // The groceries seed is the interesting case precisely because it carries a slot.
    expect(seed.slot).not.toBeNull();
    const row = pendingListFromInput(
      {
        listId: LIST,
        title: 'Groceries · New York Trip',
        templateKey: 'groceries',
        sourceActivityId: PLAN,
      },
      seed,
      LIST,
      'usr_local_dev',
      NOW,
    );
    expect(row.slot).toBeNull();
    expect(row.sourceActivityId).toBe(PLAN);
  });

  /**
   * The one shared capability rule (`listCapabilities`, `@od/shared/lists`), applied at the
   * moment a native create commits — never left unset until the next sync (`useDestination`'s
   * flat picker reads this row before any acknowledgement can arrive).
   */
  it('derives capabilities from the seeded item state mode, the one shared way', () => {
    const checkbox = pendingListFromInput(
      { listId: LIST, title: 'Groceries', templateKey: 'groceries' },
      seedOf('groceries'),
      LIST,
      'usr_local_dev',
      NOW,
    );
    expect(checkbox.capabilities).toEqual({ ingredients: true });

    const blank = pendingListFromInput(
      { listId: LIST, title: 'Untitled list', templateKey: 'blank' },
      seedOf('blank'),
      LIST,
      'usr_local_dev',
      NOW,
    );
    expect(blank.capabilities).toEqual({ ingredients: false });
  });
});
