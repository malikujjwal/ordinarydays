import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  groupDropIndex,
  WATCH_SECTION_ORDER,
  watchSections,
  watchStatusOf,
} from './watchSections';

/**
 * §5.2's grouping, as a projection (§P3-31).
 *
 * The two rules that could be got wrong quietly are here: the order is the product's and not
 * the data's, and a row whose status cannot be read is never filed under one.
 */

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const item = (
  suffix: string,
  rank: string,
  status?: 'want' | 'watching' | 'watched',
): ListItemView => ({
  itemId: `itm_01J0000000000000000000${suffix}`,
  listId: LIST_ID,
  rank,
  title: suffix,
  checked: false,
  ...(status === undefined
    ? {}
    : { details: { behaviour: 'watch', watchStatus: status } }),
});

const id = (suffix: string) => `itm_01J0000000000000000000${suffix}`;

/** Ranks interleave the groups on purpose: that is what a real watch list looks like. */
const WANT_EARLY = item('AA', 'a', 'want');
const WATCHED_MID = item('BB', 'b', 'watched');
const WATCHING_MID = item('CC', 'c', 'watching');
const WANT_LATE = item('DD', 'd', 'want');
const WATCHING_LATE = item('EE', 'e', 'watching');
const LIST = [WANT_EARLY, WATCHED_MID, WATCHING_MID, WANT_LATE, WATCHING_LATE];

const headings = (items: readonly ListItemView[]) =>
  watchSections(items).sections.map((section) => section.heading);

const titlesIn = (items: readonly ListItemView[], status: string) =>
  watchSections(items)
    .sections.find((section) => section.status === status)
    ?.items.map((row) => row.title);

describe('the fixed order', () => {
  it('is §5.2 order, and not the order the rows arrived in', () => {
    expect(WATCH_SECTION_ORDER).toEqual(['watching', 'want', 'watched']);
    expect(headings(LIST)).toEqual(['Watching', 'Want to watch', 'Watched']);
  });

  /** A shuffled response is the same three sections in the same three places. */
  it('is the same from a shuffled fixture', () => {
    const shuffled = [WATCHING_LATE, WANT_EARLY, WATCHED_MID, WANT_LATE, WATCHING_MID];

    expect(headings(shuffled)).toEqual(headings(LIST));
    expect(titlesIn(shuffled, 'watching')).toEqual(titlesIn(LIST, 'watching'));
  });

  /** Within a section, `(rank, itemId)` — the one comparator, not arrival order. */
  it('sorts each section by rank within the group', () => {
    expect(titlesIn(LIST, 'watching')).toEqual(['CC', 'EE']);
    expect(titlesIn(LIST, 'want')).toEqual(['AA', 'DD']);
    expect(titlesIn([...LIST].reverse(), 'want')).toEqual(['AA', 'DD']);
  });

  /** Equal ranks are the restored-or-legacy case; the tie-break decides, in both shuffles. */
  it('orders duplicate ranks identically whichever way they arrive', () => {
    const first = item('AA', 'm', 'want');
    const second = item('BB', 'm', 'want');

    expect(titlesIn([first, second], 'want')).toEqual(['AA', 'BB']);
    expect(titlesIn([second, first], 'want')).toEqual(['AA', 'BB']);
  });
});

/**
 * The recorded decision: §5.2 fixes the order of the three sections but says nothing about
 * rendering an empty one, and the always-render rule that exists is the Plans tab's, about
 * stages rather than list groups.
 */
describe('an empty group', () => {
  it('is omitted rather than returned empty', () => {
    expect(headings([WANT_EARLY, WANT_LATE])).toEqual(['Want to watch']);
    expect(watchSections([WANT_EARLY]).sections).toHaveLength(1);
  });

  it('leaves the surviving sections in the same relative order', () => {
    expect(headings([WATCHED_MID, WATCHING_MID])).toEqual(['Watching', 'Watched']);
  });

  it('is every section on an empty list', () => {
    expect(watchSections([])).toEqual({ sections: [], ungrouped: [] });
  });
});

/**
 * §P3-31: a committed `watch` row with missing details is rejected by the response schema
 * rather than silently placed in `Want to watch`. If one arrives anyway it is kept, and kept
 * unclassified — P3-28's rule for the same data one level down.
 */
describe('a row with no readable status', () => {
  it('is never filed under a status it does not have', () => {
    const broken = item('ZZ', 'z');

    const projection = watchSections([WANT_EARLY, broken]);

    expect(projection.ungrouped.map((row) => row.itemId)).toEqual([broken.itemId]);
    expect(titlesIn([WANT_EARLY, broken], 'want')).toEqual(['AA']);
    expect(watchStatusOf(broken)).toBeUndefined();
  });

  it('is kept rather than dropped', () => {
    const broken = item('ZZ', 'z');
    const projection = watchSections([broken]);

    expect(projection.sections).toEqual([]);
    expect(projection.ungrouped).toHaveLength(1);
  });
});

/**
 * The two index frames. A section is its own draggable list, so a drop arrives as a position
 * among that group's rows; `afterItemId` names a neighbour in the flat `(rank, itemId)` order.
 */
describe('translating a drop back to the flat order', () => {
  // Flat order: AA(want) BB(watched) CC(watching) DD(want) EE(watching)
  // `want` members, in the array without the dragged row, sit at the indices named below.

  it('puts a group head where its first member currently sits', () => {
    // Dragging DD to the top of `want`: without DD the list is AA BB CC EE, and AA is at 0.
    expect(groupDropIndex(LIST, WANT_LATE.itemId, 0)).toBe(0);
  });

  it('puts a later position immediately after that group member', () => {
    // Dragging AA below DD: without AA the list is BB CC DD EE, and DD is at 2.
    expect(groupDropIndex(LIST, WANT_EARLY.itemId, 1)).toBe(3);
  });

  it('clamps past the end of the group rather than escaping it', () => {
    expect(groupDropIndex(LIST, WANT_EARLY.itemId, 9)).toBe(3);
  });

  /** A group of one has one position, and it is the one the row already holds. */
  it('answers the row own position when its group has no other member', () => {
    expect(groupDropIndex(LIST, WATCHED_MID.itemId, 0)).toBe(1);
    expect(groupDropIndex(LIST, WATCHED_MID.itemId, 5)).toBe(1);
  });

  it('has no answer for an unknown row or one with no status', () => {
    expect(groupDropIndex(LIST, id('ZZ'), 0)).toBeUndefined();
    const broken = item('ZZ', 'z');
    expect(groupDropIndex([...LIST, broken], broken.itemId, 0)).toBeUndefined();
  });
});
