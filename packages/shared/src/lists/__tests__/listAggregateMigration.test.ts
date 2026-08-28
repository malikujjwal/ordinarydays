import { describe, expect, it } from 'vitest';
import {
  type LegacyListAggregate,
  migrateLegacyListAggregate,
} from '../migrateLegacyListAggregate.js';

const baseList = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'watchlist',
  title: 'Things to watch',
  icon: 'play-rect',
  emptyStateCopy: 'Add a movie or show.',
  capabilities: { checkable: false, supportsLocation: false },
  slot: 'watch' as const,
  itemCount: 1,
  uncheckedCount: 1,
  memberCount: 1,
  rankVersion: 7,
  itemVersion: 4,
  archived: false,
  updatedAt: '2026-08-28T12:00:00.000Z',
  lastItemActivityAt: '2026-08-28T12:30:00.000Z',
};

describe('migrateLegacyListAggregate', () => {
  it('maps Watch state and structured progress without losing identity or provenance', () => {
    const result = migrateLegacyListAggregate({
      list: { ...baseList, behaviour: 'watch' },
      items: [
        {
          itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          listId: baseList.listId,
          rank: 'V',
          itemRevision: 3,
          title: 'Severance',
          note: 'Finish before Friday',
          checked: false,
          sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          sourceLabel: 'TV night',
          sourceProvenance: [
            {
              activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
              label: 'TV night',
            },
          ],
          details: {
            behaviour: 'watch',
            mediaKind: 'show',
            watchStatus: 'watching',
            season: 2,
            episode: 4,
          },
        },
      ],
    });

    expect(result.list).toMatchObject({
      listId: baseList.listId,
      templateKey: 'watchlist',
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
        groupByState: true,
      },
      featureConfig: { progress: { enabled: true, kind: 'episode' } },
      doneCount: 0,
      rankVersion: 8,
    });
    expect(result.items[0]).toEqual({
      itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      listId: baseList.listId,
      rank: 'V',
      itemRevision: 3,
      title: 'Severance',
      note: 'Finish before Friday',
      state: 'active',
      sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      sourceLabel: 'TV night',
      sourceProvenance: [
        {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          label: 'TV night',
        },
      ],
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
      },
    });
  });

  it('turns ingredients into deterministic ranked sub-items and is idempotent', () => {
    const legacy = {
      list: {
        ...baseList,
        behaviour: 'meals',
        templateKey: 'meals-to-try',
        slot: 'meals' as const,
      },
      items: [
        {
          itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          listId: baseList.listId,
          rank: 'V',
          itemRevision: 2,
          title: 'Curry',
          checked: false,
          details: {
            behaviour: 'meals' as const,
            ingredients: [
              {
                ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2',
                name: 'Yogurt',
                quantity: '1 cup',
              },
            ],
          },
        },
      ],
    } satisfies LegacyListAggregate;

    const first = migrateLegacyListAggregate(legacy);
    const second = migrateLegacyListAggregate(first);

    expect(first.list.featureConfig.subItems).toEqual({
      enabled: true,
      sectionLabel: 'Ingredients',
      singularLabel: 'Ingredient',
      secondaryLabel: 'Quantity',
      integration: 'mealIngredients',
    });
    expect(first.items[0]?.features?.subItems?.entries).toEqual([
      {
        id: expect.stringMatching(/^sub_/),
        title: 'Yogurt',
        secondary: '1 cup',
        rank: 'V',
      },
    ]);
    expect(second).toEqual(first);
  });

  it('retains empty Watch media kind and converts collection place/state exactly', () => {
    const watch = migrateLegacyListAggregate({
      list: { ...baseList, behaviour: 'watch' },
      items: [
        {
          itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          listId: baseList.listId,
          rank: 'V',
          itemRevision: 0,
          title: 'Dune',
          checked: false,
          details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'want' },
        },
      ],
    });
    expect(watch.items[0]?.features?.progress).toEqual({
      kind: 'episode',
      mediaKind: 'movie',
    });

    const collection = migrateLegacyListAggregate({
      list: {
        ...baseList,
        behaviour: 'collection',
        capabilities: { checkable: true, supportsLocation: true },
      },
      items: [
        {
          itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2',
          listId: baseList.listId,
          rank: 'V',
          itemRevision: 0,
          title: 'Museum',
          checked: true,
          location: { label: 'The Met', address: '1000 Fifth Ave' },
        },
      ],
    });
    expect(collection.list.itemStateMode).toEqual({ mode: 'checkbox' });
    expect(collection.list.featureConfig.place).toEqual({ enabled: true });
    expect(collection.list.doneCount).toBe(1);
    expect(collection.items[0]).toMatchObject({
      state: 'done',
      features: { place: { label: 'The Met', address: '1000 Fifth Ave' } },
    });
  });
});
