import type { ListBehaviourConfirmation } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { behaviourChangeConfirmation } from './behaviourConfirmation';

const preview = (
  overrides: Partial<ListBehaviourConfirmation> = {},
): ListBehaviourConfirmation => ({
  fromBehaviour: 'watch',
  toBehaviour: 'collection',
  itemVersion: 12,
  itemCount: 7,
  fields: ['Watch status', 'Season', 'Episode'],
  ...overrides,
});

/**
 * `interaction-contract.md` §1a.1 and `plans-and-lists.md` §5.5's mock, which is the exact
 * dialog this composes.
 */
describe('the downgrade confirmation', () => {
  it('is §5.5 verbatim', () => {
    const confirmation = behaviourChangeConfirmation({ title: 'Watchlist' }, preview());

    expect(confirmation.heading).toBe('Turn "Watchlist" into a plain list?');
    expect(confirmation.removesLead).toBe('This will remove:');
    expect(confirmation.removes).toEqual([
      'Watch status, season and episode from 7 items',
    ]);
    expect(confirmation.keeps).toBe('every item, its title, its note, and its order.');
    expect(confirmation.confirmLabel).toBe('Turn into a plain list');
  });

  /**
   * §1a.1 rule 1: the destructive button repeats the verb. `OK` and `Continue` are named as
   * defects, so the assertion is on their absence as much as on what is there.
   */
  it('never labels the destructive button OK or Continue', () => {
    for (const toBehaviour of ['collection', 'watch', 'meals'] as const) {
      const { confirmLabel } = behaviourChangeConfirmation(
        { title: 'Watchlist' },
        preview({ toBehaviour }),
      );
      expect(confirmLabel).not.toMatch(/^(OK|Continue)$/);
      expect(confirmLabel).toMatch(/^Turn into a /);
    }
  });

  /**
   * The count and the fields are the server's, used exactly as they came (§P3-32's decision).
   * A different count and a different field order produce a different sentence, with nothing
   * re-derived or re-sorted here.
   */
  it('renders whatever count and fields the server sent', () => {
    const { removes } = behaviourChangeConfirmation(
      { title: 'Meals' },
      preview({ fromBehaviour: 'meals', itemCount: 1, fields: ['Ingredients'] }),
    );

    expect(removes).toEqual(['Ingredients from 1 item']);
  });

  it('keeps the field order the server sent rather than a local one', () => {
    const { removes } = behaviourChangeConfirmation(
      { title: 'Watchlist' },
      preview({ fields: ['Episode', 'Season', 'Watch status'] }),
    );

    expect(removes).toEqual(['Episode, season and watch status from 7 items']);
  });

  /** The labels arrive capitalised for standalone use; a sentence lowers all but the first. */
  it('runs two labels together with "and", and one on its own', () => {
    expect(
      behaviourChangeConfirmation(
        { title: 'Watchlist' },
        preview({ fields: ['Watch status', 'Movie or show'] }),
      ).removes,
    ).toEqual(['Watch status and movie or show from 7 items']);
  });

  it('names a meals target by its own words', () => {
    const confirmation = behaviourChangeConfirmation(
      { title: 'Watchlist' },
      preview({ toBehaviour: 'meals' }),
    );

    expect(confirmation.heading).toBe('Turn "Watchlist" into a meals list?');
    expect(confirmation.confirmLabel).toBe('Turn into a meals list');
  });
});
