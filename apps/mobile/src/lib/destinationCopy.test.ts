import { describe, expect, it } from 'vitest';
import {
  addSelectedLabel,
  addSelectedPendingLabel,
  destinationLead,
  destinationRememberedMessage,
  savePlanAndAddItemsLabel,
  savePlanAndAddTitleLabel,
} from './destinationCopy';

/** Every commit button names the exact write and its destination (`CLAUDE.md` rule 2). */
describe('the add-to copy', () => {
  it('names the count and the list on the ingredient action', () => {
    expect(addSelectedLabel(3, 'Groceries')).toBe('Add 3 to Groceries');
    expect(addSelectedPendingLabel(3)).toBe('Add 3 selected');
  });

  it('names both writes on the creation form (§9.2 step 4)', () => {
    expect(savePlanAndAddItemsLabel(3, 'Groceries')).toBe(
      'Save plan and add 3 items to Groceries',
    );
    expect(savePlanAndAddItemsLabel(1, 'Groceries')).toBe(
      'Save plan and add 1 item to Groceries',
    );
    expect(savePlanAndAddTitleLabel('Severance', 'Watch Later')).toBe(
      'Save plan and add Severance to Watch Later',
    );
  });

  it('leads per flow, persistently, and never names a list on its own', () => {
    expect(destinationLead('groceries')).toBe('Add ingredients to:');
    expect(destinationLead('watch')).toBe('Also add a list item to:');
  });

  /** Option B1's one confirmation: named, non-blocking, no ceremony (`DestinationSheet.tsx`). */
  it('names the list and the capability when a default is silently set', () => {
    expect(destinationRememberedMessage('groceries', 'Groceries')).toBe(
      'Groceries is now your default list for ingredients.',
    );
    expect(destinationRememberedMessage('watch', 'Watch Later')).toBe(
      'Watch Later is now your default list for watch items.',
    );
  });
});
