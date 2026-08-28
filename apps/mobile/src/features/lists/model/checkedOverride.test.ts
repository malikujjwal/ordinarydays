import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  isChecked,
  NO_OVERRIDES,
  settleOverrides,
  withOverride,
  withoutOverride,
} from './checkedOverride';

/**
 * The optimistic tick's lifetime (§5.11.5, §P3-29).
 *
 * One rule under test: an override outlives the request and is retired only when the
 * projection carries the same value. Retiring it when the request resolves would show the old
 * tick again for as long as the re-read takes, which is the flicker §5.11.5 forbids by name.
 */

const item = (itemId: string, checked: boolean): ListItemView => ({
  itemId,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  rank: 'm',
  title: 'Milk',
  checked,
});

const MILK = 'itm_01J000000000000000000000AA';
const EGGS = 'itm_01J000000000000000000000BB';

describe('the pending tick', () => {
  it('draws the override, and committed truth without one', () => {
    const overrides = withOverride(NO_OVERRIDES, MILK, true);

    expect(isChecked(item(MILK, false), overrides)).toBe(true);
    expect(isChecked(item(EGGS, true), overrides)).toBe(true);
    expect(isChecked(item(EGGS, false), overrides)).toBe(false);
  });

  it('survives a projection that has not caught up yet', () => {
    const overrides = withOverride(NO_OVERRIDES, MILK, true);

    expect(settleOverrides(overrides, [item(MILK, false)])).toBe(overrides);
  });

  it('is retired once the projection agrees', () => {
    const overrides = withOverride(NO_OVERRIDES, MILK, true);

    expect(settleOverrides(overrides, [item(MILK, true)]).size).toBe(0);
  });

  /** The same object back, so a caller may settle on every projection change without looping. */
  it('returns the same map when nothing changed', () => {
    expect(settleOverrides(NO_OVERRIDES, [item(MILK, true)])).toBe(NO_OVERRIDES);
  });

  it('retires one override without disturbing another', () => {
    const overrides = withOverride(withOverride(NO_OVERRIDES, MILK, true), EGGS, false);

    const remaining = withoutOverride(overrides, MILK);

    expect([...remaining]).toEqual([[EGGS, false]]);
    expect(withoutOverride(remaining, MILK)).toBe(remaining);
  });

  /** A set, not a toggle: applying the same value twice is the same state. */
  it('is idempotent under a repeated value', () => {
    const once = withOverride(NO_OVERRIDES, MILK, true);

    expect([...withOverride(once, MILK, true)]).toEqual([...once]);
  });
});
