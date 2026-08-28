import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOUR_CHOICE_LABELS,
  BEHAVIOUR_CONFIRM_LABELS,
  BEHAVIOUR_GAINS,
  BEHAVIOUR_PRESENTATION_NOTE,
  behaviourChangeKind,
  CAPABILITY_LABELS,
  SLOT_MEANINGS,
  settlePendingSettings,
  showsCapabilityControls,
  withoutPendingSettings,
  withPendingSettings,
} from './listSettings';

const list = (overrides: Partial<List> = {}): List => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 3,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
  ...overrides,
});

/**
 * P3-09's change-rules table, read from the row rather than guessed
 * (`plans-and-lists.md` §5.5).
 */
describe('which protocol a behaviour change runs under', () => {
  it.each([
    ['collection', 'watch'],
    ['collection', 'meals'],
  ] as const)('treats %s → %s as an upgrade', (from, to) => {
    expect(behaviourChangeKind(from, to)).toBe('upgrade');
  });

  /**
   * `watch → meals` is destructive in the same way as `watch → collection`; §P3-09 says it in
   * as many words: "it is not a sideways move".
   */
  it.each([
    ['watch', 'collection'],
    ['meals', 'collection'],
    ['watch', 'meals'],
    ['meals', 'watch'],
  ] as const)('treats %s → %s as a downgrade', (from, to) => {
    expect(behaviourChangeKind(from, to)).toBe('downgrade');
  });

  it('is not a change at all when the behaviour is already the target', () => {
    expect(behaviourChangeKind('watch', 'watch')).toBeUndefined();
  });
});

describe('the words the sheet is allowed to say', () => {
  /** §5.5's labels, and §5.5's rule that neither is presented as a type control. */
  it('names the two capabilities as display settings', () => {
    expect(CAPABILITY_LABELS.checkable).toBe('Show checkboxes');
    expect(CAPABILITY_LABELS.supportsLocation).toBe('Add a place to items');
    expect(Object.values(CAPABILITY_LABELS).join(' ')).not.toMatch(/type|kind/i);
  });

  it('repeats the verb on the confirmation button, and never says OK', () => {
    for (const behaviour of ['collection', 'watch', 'meals'] as const) {
      expect(BEHAVIOUR_CONFIRM_LABELS[behaviour]).toMatch(/^Turn into a /);
      expect(BEHAVIOUR_CHOICE_LABELS[behaviour]).toMatch(/^Turn this into a /);
    }
  });

  /** §P3-32: the slot is invisible until it changes where something lands, so it says so. */
  it('says what a slot means in plain words', () => {
    expect(SLOT_MEANINGS.groceries).toBe('Send ingredients here by default');
    expect(SLOT_MEANINGS.watch).toBe('Send things to watch here by default');
    expect(SLOT_MEANINGS.meals).toBe('Send meal ideas here by default');
  });

  /** Only the additive direction previews a gain; arriving at `collection` is the server's. */
  it('previews what an upgrade gains and nothing else', () => {
    expect(BEHAVIOUR_GAINS.watch).toContain('watch status');
    expect(BEHAVIOUR_GAINS.meals).toContain('ingredients');
    expect(BEHAVIOUR_GAINS.collection).toBeUndefined();
  });

  /** ADR-032: presentation is frozen at creation, and the copy promises that (§P3-32). */
  it('promises the name, icon and empty-state words stay as they are', () => {
    expect(BEHAVIOUR_PRESENTATION_NOTE).toBe(
      'The name, icon and empty-list words stay exactly as they are.',
    );
  });
});

describe('the capability controls belong to a collection', () => {
  it('shows them on a collection', () => {
    expect(showsCapabilityControls(list())).toBe(true);
  });

  /**
   * §5.5: switching to `watch` or `meals` retains the flags and the hidden item values, but
   * they drive no control until the list is a collection again.
   */
  it.each(['watch', 'meals'] as const)('hides them on %s, flags and all', (behaviour) => {
    const changed = list({
      behaviour,
      capabilities: { checkable: true, supportsLocation: true },
    });
    expect(showsCapabilityControls(changed)).toBe(false);
    // The stored flags are untouched — hiding a control is not clearing a setting.
    expect(changed.capabilities).toEqual({ checkable: true, supportsLocation: true });
  });
});

describe('the optimistic overlay', () => {
  it('draws the change the user just asked for', () => {
    const drawn = withPendingSettings(list(), {
      title: 'Shopping',
      capabilities: { checkable: false },
      slot: null,
      behaviour: 'watch',
    });

    expect(drawn.title).toBe('Shopping');
    expect(drawn.behaviour).toBe('watch');
    expect(drawn.slot).toBeNull();
    // Merged onto the pair, not replacing it: one switch does not restate the other.
    expect(drawn.capabilities).toEqual({ checkable: false, supportsLocation: false });
  });

  it('leaves every field the change did not name', () => {
    const drawn = withPendingSettings(list(), { title: 'Shopping' });

    expect(drawn.behaviour).toBe('collection');
    expect(drawn.capabilities).toEqual({ checkable: true, supportsLocation: false });
    expect(drawn.slot).toBe('groceries');
  });

  /** `null` is a cleared slot and `undefined` is an untouched one; they cannot be conflated. */
  it('tells a cleared slot from an untouched one', () => {
    expect(withPendingSettings(list(), { slot: null }).slot).toBeNull();
    expect(withPendingSettings(list(), {}).slot).toBe('groceries');
  });

  it('retires each field as the committed row catches up', () => {
    const pending = { title: 'Shopping', behaviour: 'watch' } as const;
    const halfway = settlePendingSettings(pending, list({ title: 'Shopping' }));

    expect(halfway).toEqual({ behaviour: 'watch' });
    expect(
      settlePendingSettings(pending, list({ title: 'Shopping', behaviour: 'watch' })),
    ).toBeUndefined();
  });

  /** Identity is preserved when nothing settled, so a projection effect cannot loop. */
  it('returns the same object when nothing has settled yet', () => {
    const pending = { title: 'Shopping' } as const;
    expect(settlePendingSettings(pending, list())).toBe(pending);
  });

  it('settles a capability only once the committed pair carries it', () => {
    const pending = { capabilities: { checkable: false } } as const;

    expect(settlePendingSettings(pending, list())).toBe(pending);
    expect(
      settlePendingSettings(
        pending,
        list({ capabilities: { checkable: false, supportsLocation: false } }),
      ),
    ).toBeUndefined();
  });

  /**
   * A rejected toggle must not also revert a rename made a second earlier: every control here
   * writes independently, so a rollback is per-field too.
   */
  it('rolls back only the field that failed', () => {
    const current = { title: 'Shopping', capabilities: { checkable: false } } as const;

    expect(
      withoutPendingSettings(current, { capabilities: { checkable: false } }),
    ).toEqual({
      title: 'Shopping',
    });
    expect(withoutPendingSettings(current, { title: 'Shopping' })).toEqual({
      capabilities: { checkable: false },
    });
  });

  it('drops the overlay entirely when its last field is rolled back', () => {
    expect(withoutPendingSettings({ slot: null }, { slot: null })).toBeUndefined();
    expect(withoutPendingSettings(undefined, { slot: null })).toBeUndefined();
  });
});
