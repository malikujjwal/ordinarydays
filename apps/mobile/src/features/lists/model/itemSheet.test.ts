import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  ingredientRows,
  ingredientsPatch,
  itemProvenance,
  itemSheetFields,
  notePatch,
  placePatch,
  provenanceLine,
  type RowList,
  titlePatch,
  watchNumber,
  watchPatch,
} from './itemSheet';

/**
 * §5.7's field set and the per-field patches (§P3-29).
 *
 * The matrix here is the pure half of the required render matrix: `ItemSheet.test.tsx` proves
 * the component draws what this returns, and this proves what it returns for every
 * behaviour-and-capability pair. Splitting it that way is what makes "absent, not disabled"
 * assertable at both ends.
 */

const ITEM_ID = 'itm_01J000000000000000000000AA';
const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const SOURCE = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const item = (overrides: Partial<ListItemView> = {}): ListItemView => ({
  itemId: ITEM_ID,
  listId: LIST_ID,
  rank: 'm',
  title: 'Chicken',
  checked: false,
  ...overrides,
});

const collection = (supportsLocation: boolean, checkable = true): RowList => ({
  behaviour: 'collection',
  capabilities: { checkable, supportsLocation },
});

const WATCH: RowList = {
  behaviour: 'watch',
  // A stale `checkable` a behaviour change left behind. It changes nothing here.
  capabilities: { checkable: true, supportsLocation: true },
};

const MEALS: RowList = {
  behaviour: 'meals',
  capabilities: { checkable: false, supportsLocation: false },
};

describe('the §5.7 field set', () => {
  it('gives a plain collection nothing beyond title and note', () => {
    expect(itemSheetFields(collection(false), item())).toEqual({
      place: false,
      watch: false,
      progress: false,
      ingredients: false,
    });
  });

  /** The capability, not the item: the sheet is where a place is added. */
  it('offers the place editor on a locating collection with no place stored yet', () => {
    expect(itemSheetFields(collection(true), item()).place).toBe(true);
  });

  /**
   * The line between a capability and a behaviour, from the other side: a `watch` list carrying
   * a stale `supportsLocation: true` still gets no place editor, and the stored `location`
   * underneath is retained rather than cleared (§5.5, §5.7).
   */
  it('offers no place editor on a watch list, whatever its stale capabilities say', () => {
    const stored = item({
      location: { label: 'Zahav' },
      details: { behaviour: 'watch', watchStatus: 'want' },
    });

    expect(itemSheetFields(WATCH, stored)).toEqual({
      place: false,
      watch: true,
      progress: false,
      ingredients: false,
    });
    expect(stored.location).toEqual({ label: 'Zahav' });
  });

  it('shows season and episode for a show and not for a movie', () => {
    const show = item({
      details: { behaviour: 'watch', mediaKind: 'show', watchStatus: 'watching' },
    });
    const movie = item({
      details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'want' },
    });

    expect(itemSheetFields(WATCH, show).progress).toBe(true);
    expect(itemSheetFields(WATCH, movie).progress).toBe(false);
    // A kind nobody has chosen yet is not a show either.
    expect(
      itemSheetFields(
        WATCH,
        item({ details: { behaviour: 'watch', watchStatus: 'want' } }),
      ).progress,
    ).toBe(false);
  });

  /** Invalid data stays invalid: no control may invent the `watchStatus` the schema requires. */
  it('draws no watch controls over an item that carries no typed details', () => {
    expect(itemSheetFields(WATCH, item())).toEqual({
      place: false,
      watch: false,
      progress: false,
      ingredients: false,
    });
  });

  /** Unlike `watch`, an empty meal is a real empty state and the editor's whole purpose. */
  it('offers the ingredient editor on a meals list with no ingredients yet', () => {
    expect(itemSheetFields(MEALS, item()).ingredients).toBe(true);
    expect(ingredientRows(item())).toEqual([]);
  });
});

describe('provenance (§7.5)', () => {
  it('renders the stored label verbatim, middle dots and all', () => {
    const provenance = itemProvenance(
      item({ sourceLabel: 'Sunday dinner · Chicken tacos', sourceActivityId: SOURCE }),
    );

    expect(provenance).toEqual({
      label: 'Sunday dinner · Chicken tacos',
      sourceActivityId: SOURCE,
    });
    expect(provenanceLine(provenance as { label: string })).toBe(
      'From Sunday dinner · Chicken tacos',
    );
  });

  it('is absent on a manually added item', () => {
    expect(itemProvenance(item())).toBeUndefined();
  });

  /** A label with no Activity behind it is text from the start — there is nothing to open. */
  it('offers no Activity when the label names none', () => {
    expect(itemProvenance(item({ sourceLabel: 'Chicken tacos' }))).toEqual({
      label: 'Chicken tacos',
    });
  });
});

describe('one patch per field', () => {
  it('trims a title and refuses an empty one', () => {
    expect(titlePatch('  Tortillas  ')).toEqual({ title: 'Tortillas' });
    expect(titlePatch('   ')).toBeUndefined();
  });

  /** `null` clears; `''` would be a note whose content is nothing. */
  it('clears a note with null rather than an empty string', () => {
    expect(notePatch('  eight  ')).toEqual({ note: 'eight' });
    expect(notePatch('  ')).toEqual({ note: null });
  });

  it('sends the place as one field and clears it when the label goes', () => {
    expect(placePatch(item(), ' Zahav ', ' 237 St James Place ')).toEqual({
      location: { label: 'Zahav', address: '237 St James Place' },
    });
    expect(placePatch(item(), 'Zahav', '  ')).toEqual({ location: { label: 'Zahav' } });
    expect(placePatch(item(), '  ', '237 St James Place')).toEqual({ location: null });
  });

  /** Coordinates no surface collects are still not this field's to remove. */
  it('carries stored coordinates through a place edit', () => {
    const stored = item({ location: { label: 'Zahav', lat: 39.94, lng: -75.15 } });

    expect(placePatch(stored, 'Zahav', 'New address')).toEqual({
      location: { label: 'Zahav', address: 'New address', lat: 39.94, lng: -75.15 },
    });
  });

  it('sends the whole typed details for one watch change', () => {
    const show = item({
      details: {
        behaviour: 'watch',
        mediaKind: 'show',
        watchStatus: 'watching',
        season: 2,
      },
    });

    expect(watchPatch(show, { watchStatus: 'watched' })).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watched',
        mediaKind: 'show',
        season: 2,
      },
    });
  });

  /** Hiding the progress fields is §5.7's; losing the numbers under them is not. */
  it('keeps stored progress when a show is retyped as a movie', () => {
    const show = item({
      details: {
        behaviour: 'watch',
        mediaKind: 'show',
        watchStatus: 'watching',
        season: 2,
        episode: 4,
      },
    });

    expect(watchPatch(show, { mediaKind: 'movie' })).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watching',
        mediaKind: 'movie',
        season: 2,
        episode: 4,
      },
    });
  });

  it('clears an emptied episode box and never the required status', () => {
    const show = item({
      details: {
        behaviour: 'watch',
        mediaKind: 'show',
        watchStatus: 'watching',
        season: 2,
        episode: 4,
      },
    });

    expect(watchPatch(show, { episode: undefined })).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watching',
        mediaKind: 'show',
        season: 2,
      },
    });
    expect(watchPatch(show, { watchStatus: undefined })).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watching',
        mediaKind: 'show',
        season: 2,
        episode: 4,
      },
    });
  });

  it('has no watch patch to send for an item with no typed details', () => {
    expect(watchPatch(item(), { watchStatus: 'watched' })).toBeUndefined();
  });

  it('reads a season box and refuses anything that is not a whole number', () => {
    expect(watchNumber(' 12 ')).toBe(12);
    expect(watchNumber('')).toBeUndefined();
    expect(watchNumber('2.5')).toBeUndefined();
    expect(watchNumber('-1')).toBeUndefined();
    expect(watchNumber('two')).toBeUndefined();
  });
});

describe('the ingredient rows', () => {
  /**
   * The server-owned "Added" state is dropped on the way in, because the meals input arm is
   * strict and rejects it. A round trip that carried it back would be a client fabricating an
   * authorised action's receipt.
   */
  it('drops addedToListId and sends only what a client may say', () => {
    const meal = item({
      details: {
        behaviour: 'meals',
        ingredients: [
          {
            ingredientId: 'ing_01J000000000000000000000AA',
            name: 'Chicken',
            quantity: '500g',
            addedToListId: LIST_ID,
          },
        ],
      },
    });

    expect(ingredientRows(meal)).toEqual([
      {
        ingredientId: 'ing_01J000000000000000000000AA',
        name: 'Chicken',
        quantity: '500g',
      },
    ]);
    expect(ingredientsPatch(ingredientRows(meal))).toEqual({
      details: {
        behaviour: 'meals',
        ingredients: [
          {
            ingredientId: 'ing_01J000000000000000000000AA',
            name: 'Chicken',
            quantity: '500g',
          },
        ],
      },
    });
  });

  it('drops a row nobody named and omits an emptied quantity', () => {
    expect(
      ingredientsPatch([
        {
          ingredientId: 'ing_01J000000000000000000000AA',
          name: ' Chicken ',
          quantity: '  ',
        },
        { ingredientId: 'ing_01J000000000000000000000BB', name: '   ', quantity: '2' },
      ]),
    ).toEqual({
      details: {
        behaviour: 'meals',
        ingredients: [
          { ingredientId: 'ing_01J000000000000000000000AA', name: 'Chicken' },
        ],
      },
    });
  });
});
