import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type Upgrade,
  upgradeAll,
  upgradeItem,
  upgradeOnRead,
} from './migrate.js';

const v1 = { pk: 'ACT#act_1', sk: 'META', title: 'Gym', schemaVersion: 1 };

describe('an item already at the current version', () => {
  it('comes back identical', () => {
    expect(upgradeOnRead(v1)).toEqual(v1);
  });

  /**
   * The **same object**, not a copy. The agenda query runs this over every row it returns,
   * and cloning each one to achieve nothing would be a cost paid on the hottest read in the
   * product for no benefit.
   */
  it('comes back as the same object, so a hot read allocates nothing', () => {
    expect(upgradeOnRead(v1)).toBe(v1);
  });

  it('treats a missing schemaVersion as version 1, which is all pre-Phase-1 scratch data', () => {
    const legacy = { pk: 'ACT#act_1', sk: 'META', title: 'Gym' };
    expect(upgradeOnRead(legacy)).toBe(legacy);
  });
});

/**
 * The registry is exercised with a synthetic step rather than left unexercised until the day
 * it first matters — which is exactly the day nobody wants to discover the loop was wrong.
 *
 * `upgradeItem` takes its registry and target as arguments, so these tests mutate nothing
 * and cannot leak a step into another test.
 */
describe('a synthetic 1 → 2 upgrade', () => {
  const addSubtitle: Upgrade = (item) => ({ ...item, subtitle: `about ${item.title}` });
  const registry = new Map<number, Upgrade>([[1, addSubtitle]]);

  it('applies the step and stamps the new version', () => {
    expect(upgradeItem(v1, 2, registry)).toEqual({
      ...v1,
      subtitle: 'about Gym',
      schemaVersion: 2,
    });
  });

  it('leaves the stored item untouched — the upgrade is in memory', () => {
    upgradeItem(v1, 2, registry);
    expect(v1).toEqual({ pk: 'ACT#act_1', sk: 'META', title: 'Gym', schemaVersion: 1 });
  });

  it('is a no-op for an item already at 2', () => {
    const at2 = { ...v1, schemaVersion: 2 };
    expect(upgradeItem(at2, 2, registry)).toBe(at2);
  });
});

describe('a chain of upgrades', () => {
  const registry = new Map<number, Upgrade>([
    [1, (item) => ({ ...item, one: true })],
    [2, (item) => ({ ...item, two: true })],
    [3, (item) => ({ ...item, three: true })],
  ]);

  it('runs every step in order, not just the first and last', () => {
    expect(upgradeItem(v1, 4, registry)).toEqual({
      ...v1,
      one: true,
      two: true,
      three: true,
      schemaVersion: 4,
    });
  });

  it('starts from the item’s own version, skipping steps it has had', () => {
    const at3 = { ...v1, schemaVersion: 3 };
    const result = upgradeItem(at3, 4, registry);

    expect(result).toHaveProperty('three', true);
    expect(result).not.toHaveProperty('one');
    expect(result).not.toHaveProperty('two');
  });

  it('fails loudly on a gap rather than silently skipping a version', () => {
    const gapped = new Map<number, Upgrade>([[1, (item) => item]]);
    expect(() => upgradeItem(v1, 3, gapped)).toThrow(/schemaVersion 2 → 3/);
  });
});

/**
 * An item written by a newer deploy and read by an older one, which happens during every
 * rolling deployment. Downgrading is impossible and guessing is worse than failing, so the
 * item is returned untouched and the caller's schema validation decides — rather than this
 * layer silently dropping fields it does not recognise.
 */
describe('an item from the future', () => {
  it('is returned untouched rather than mangled', () => {
    const fromFuture = {
      ...v1,
      schemaVersion: 99,
      unknownField: 'set by a newer deploy',
    };
    expect(upgradeOnRead(fromFuture)).toBe(fromFuture);
  });
});

describe('upgradeAll', () => {
  it('maps across a query result', () => {
    expect(upgradeAll([v1, { ...v1, sk: 'IDX#act_1' }])).toHaveLength(2);
  });

  it('returns an empty array unchanged', () => {
    expect(upgradeAll([])).toEqual([]);
  });
});

describe('the current version', () => {
  /**
   * Version 1 is what the product writes today. When this changes, the registry must gain
   * the step that gets there — the gap test above is what makes a bump without a step fail
   * rather than silently produce items nothing can read.
   */
  it('is 1, and every item written carries it', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
