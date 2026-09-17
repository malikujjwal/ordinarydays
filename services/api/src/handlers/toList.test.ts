import type { ListItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { toListItem } from './toList.js';

/**
 * `toListItem`'s `origins` derivation (Option B, 2026-09-16;
 * `docs/reports/destination-flow-simplification-20260916.md`): the response mapper is the
 * one place `sourceProvenance` \u2014 storage, never serialised as itself \u2014 is flattened into
 * the label-free `{ activityId, ingredientId }` pairs a client's presence check reads.
 */
const base: ListItem = {
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B1',
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  rank: 'n',
  itemRevision: 0,
  title: 'Chicken',
  state: 'open',
};

describe('toListItem', () => {
  it('exposes origins for an item recorded by the ingredients-to-list action', () => {
    const item: ListItem = {
      ...base,
      sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      sourceLabel: 'Chicken tacos',
      sourceProvenance: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          label: 'Chicken tacos',
          ingredientIds: ['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1'],
        },
      ],
    };

    expect(toListItem(item)).toMatchObject({
      origins: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1',
        },
      ],
    });
  });

  it('flattens every segment that names an ingredient, across meals', () => {
    const item: ListItem = {
      ...base,
      sourceProvenance: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          label: 'Chicken tacos',
          ingredientIds: ['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1'],
        },
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
          label: 'Burgers',
          ingredientIds: [
            'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
            'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3',
          ],
        },
      ],
    };

    expect(toListItem(item)).toMatchObject({
      origins: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1',
        },
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
        },
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3',
        },
      ],
    });
  });

  it('omits origins for an ordinary item with no provenance', () => {
    expect(toListItem(base)).not.toHaveProperty('origins');
  });

  /**
   * A row written before 2026-09-11 (P3-17) carries only `sourceActivityId`/`sourceLabel`.
   * It cannot name which ingredient produced it, so it must not claim presence for one \u2014
   * `provenanceOf`'s legacy fallback in `ingredientsToListService.ts` makes the same call.
   */
  it('omits origins for a legacy row with sourceActivityId/sourceLabel but no sourceProvenance', () => {
    const item: ListItem = {
      ...base,
      sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      sourceLabel: 'Chicken tacos',
    };

    expect(toListItem(item)).not.toHaveProperty('origins');
  });

  /** A segment written before Option B has no `ingredientIds` and contributes nothing. */
  it('omits origins from a segment that predates ingredient tracking', () => {
    const item: ListItem = {
      ...base,
      sourceProvenance: [
        { activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2', label: 'Chicken tacos' },
      ],
    };

    expect(toListItem(item)).not.toHaveProperty('origins');
  });

  it('never leaks the rendered label through origins', () => {
    const item: ListItem = {
      ...base,
      sourceProvenance: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          label: 'A label that must not appear on an origin',
          ingredientIds: ['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1'],
        },
      ],
    };

    const origins = toListItem(item).origins as readonly Record<string, unknown>[];
    expect(origins[0]).toEqual({
      activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1',
    });
  });
});
