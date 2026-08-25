import { describe, expect, it } from 'vitest';
import type { DefaultSlot } from '../../types/user.js';
import { resolveSlot, type SlotEligibleList } from '../resolveSlot.js';

/**
 * The four-step rule (`data-model.md` §4.6 "Default slots", ADR-033, `phase-03` §P3-12),
 * plus the stale-default case and the exact shape of the empty answer.
 *
 * Every case here is pure input to pure output. That is the point of the function living in
 * `packages/shared` rather than in whichever service needed it first: the API and the app
 * get the same answer from the same rule, and neither needs a table to prove it.
 */

const list = (
  listId: string,
  slot: DefaultSlot | null,
  archived = false,
): SlotEligibleList => ({ listId, slot, archived });

const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CORNER_SHOP = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const PACKING = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const WATCHLIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X5';
const GONE = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X9';

describe('step 1 — exactly one eligible list is used silently', () => {
  it('uses it, and says the default was not what chose it', () => {
    const result = resolveSlot('groceries', [list(TRADER_JOES, 'groceries')], undefined);

    expect(result).toEqual({ kind: 'use', listId: TRADER_JOES, wasDefault: false });
  });

  /**
   * `wasDefault` separates "your only groceries list" from "the one you chose", and with a
   * single candidate no default was consulted to answer. A `true` here would make the sheet
   * claim a preference the user may never have expressed.
   */
  it('still reports wasDefault false when the profile happens to name that same list', () => {
    const result = resolveSlot('groceries', [list(TRADER_JOES, 'groceries')], {
      groceries: TRADER_JOES,
    });

    expect(result).toEqual({ kind: 'use', listId: TRADER_JOES, wasDefault: false });
  });

  /** Eligibility is the slot, never the behaviour: `Packing` is checkable and irrelevant. */
  it('ignores lists holding another slot or none at all', () => {
    const result = resolveSlot(
      'groceries',
      [list(PACKING, null), list(WATCHLIST, 'watch'), list(TRADER_JOES, 'groceries')],
      undefined,
    );

    expect(result).toEqual({ kind: 'use', listId: TRADER_JOES, wasDefault: false });
  });
});

describe('step 2 — several eligible lists and a still-valid default', () => {
  it('uses the default and says so', () => {
    const result = resolveSlot(
      'groceries',
      [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')],
      { groceries: CORNER_SHOP },
    );

    expect(result).toEqual({ kind: 'use', listId: CORNER_SHOP, wasDefault: true });
  });

  it('reads only the requested slot, not another slot that happens to be set', () => {
    const result = resolveSlot(
      'groceries',
      [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')],
      { watch: WATCHLIST },
    );

    expect(result.kind).toBe('ask');
  });
});

describe('step 3 — several eligible lists and no usable default', () => {
  it('asks, and hands back every candidate', () => {
    const candidates = [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')];

    const result = resolveSlot('groceries', candidates, undefined);

    expect(result).toEqual({ kind: 'ask', candidates });
  });

  /**
   * The caller is what knows the order the user sees. Re-sorting here would silently
   * disagree with the list index the sheet is rendered from.
   */
  it('never re-sorts: candidates come back in the order they were supplied', () => {
    const result = resolveSlot(
      'groceries',
      [
        list(CORNER_SHOP, 'groceries'),
        list(PACKING, null),
        list(TRADER_JOES, 'groceries'),
      ],
      undefined,
    );

    expect(result.kind === 'ask' && result.candidates.map((row) => row.listId)).toEqual([
      CORNER_SHOP,
      TRADER_JOES,
    ]);
  });

  /**
   * The read-side guard. P3-05's delete and P3-09's slot change clear the profile entry in
   * the same transaction as the list write, so a stale pointer should not exist — and if one
   * ever does, it must produce the question rather than a dead end (§P3-12 edge cases).
   */
  it.each([
    ['a list that no longer exists', [], GONE],
    ['an archived list', [list(PACKING, 'groceries', true)], PACKING],
    ['a list whose slot has since changed', [list(WATCHLIST, 'watch')], WATCHLIST],
  ])('treats a default pointing at %s as unset and asks', (_why, extra, stale) => {
    const lists = [
      list(TRADER_JOES, 'groceries'),
      list(CORNER_SHOP, 'groceries'),
      ...extra,
    ];

    const result = resolveSlot('groceries', lists, { groceries: stale });

    expect(result.kind).toBe('ask');
    expect(result.kind === 'ask' && result.candidates.map((row) => row.listId)).toEqual([
      TRADER_JOES,
      CORNER_SHOP,
    ]);
  });
});

describe('step 4 — no eligible list', () => {
  /**
   * Exactly this shape and nothing else on it. The slot explains why a destination is
   * needed; it does not decide what new list to create, and a `templateKey` or title here
   * would be the app choosing on the user's behalf (`plans-and-lists.md` §5.8).
   */
  it('returns exactly { kind, slot } — no templateKey, title or recommendation', () => {
    const result = resolveSlot('groceries', [list(PACKING, null)], undefined);

    expect(result).toEqual({ kind: 'none', slot: 'groceries' });
    expect(Object.keys(result).sort()).toEqual(['kind', 'slot']);
  });

  it('names the slot that was asked for', () => {
    expect(resolveSlot('watch', [], undefined)).toEqual({ kind: 'none', slot: 'watch' });
  });

  /** A stale default with nothing eligible is still nothing eligible. */
  it('returns none even when the profile still names a list that is gone', () => {
    const result = resolveSlot('groceries', [], { groceries: TRADER_JOES });

    expect(result).toEqual({ kind: 'none', slot: 'groceries' });
  });

  it('does not count an archived list as a candidate', () => {
    const result = resolveSlot(
      'groceries',
      [list(TRADER_JOES, 'groceries', true)],
      undefined,
    );

    expect(result).toEqual({ kind: 'none', slot: 'groceries' });
  });
});

describe('what resolving never does', () => {
  /** Opening a list, or resolving twice, must not change where future items go (ADR-033). */
  it('mutates neither the lists it was given nor the profile map', () => {
    const lists = [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')];
    const defaults = { groceries: TRADER_JOES };
    const before = structuredClone({ lists, defaults });

    resolveSlot('groceries', lists, defaults);
    resolveSlot('groceries', lists, defaults);

    expect({ lists, defaults }).toEqual(before);
  });

  it('is deterministic — the same inputs give the same answer every time', () => {
    const lists = [list(TRADER_JOES, 'groceries'), list(CORNER_SHOP, 'groceries')];

    expect(resolveSlot('groceries', lists, undefined)).toEqual(
      resolveSlot('groceries', lists, undefined),
    );
  });
});
