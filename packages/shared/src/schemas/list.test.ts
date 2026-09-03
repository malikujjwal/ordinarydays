import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type {
  List,
  ListIndex,
  ListItem,
  ListItemActivityLink,
  ListMember,
  ListTemplate,
} from '../types/list.js';
import type { ListDetail } from '../types/listDetail.js';
import type { ListDetailItem } from '../types/listDetailItem.js';
import type { ListItemView } from '../types/listItemView.js';
import type { ListView } from '../types/listView.js';
import {
  addIngredientsToListInput,
  bulkCreateListItemsInput,
  createListInput,
  createListItemInput,
  list,
  type listDetail,
  type listDetailItem,
  type listIndex,
  listItem,
  type listItemActivityLink,
  type listItemView,
  type listMember,
  type listTemplate,
  listView,
  patchListInput,
  patchListItemInput,
  scheduleListItemInput,
} from './list.js';

const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const storedList = {
  schemaVersion: 2,
  listId: LST,
  ownerId: 'usr_local_dev',
  templateKey: 'watch-later',
  title: 'Watch Later',
  icon: 'play-rect',
  emptyStateCopy: 'Add a movie or show.',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
    groupByState: true,
  },
  featureConfig: { progress: { enabled: true, kind: 'episode' } },
  slot: 'watch',
  itemCount: 1,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-28T12:00:00.000Z',
  lastItemActivityAt: '2026-08-28T12:00:00.000Z',
} as const;

const storedItem = {
  itemId: ITM,
  listId: LST,
  rank: 'V',
  itemRevision: 0,
  title: 'Severance',
  state: 'active',
  features: { progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 } },
} as const;

describe('List schema/type parity', () => {
  it('pins stored and public shapes both ways', () => {
    expectTypeOf<z.infer<typeof list>>().toEqualTypeOf<List>();
    expectTypeOf<z.infer<typeof listItem>>().toEqualTypeOf<ListItem>();
    expectTypeOf<z.infer<typeof listIndex>>().toEqualTypeOf<ListIndex>();
    expectTypeOf<z.infer<typeof listMember>>().toEqualTypeOf<ListMember>();
    expectTypeOf<
      z.infer<typeof listItemActivityLink>
    >().toEqualTypeOf<ListItemActivityLink>();
    expectTypeOf<z.infer<typeof listTemplate>>().toEqualTypeOf<ListTemplate>();
    expectTypeOf<z.infer<typeof listView>>().toEqualTypeOf<ListView>();
    expectTypeOf<z.infer<typeof listItemView>>().toEqualTypeOf<ListItemView>();
    expectTypeOf<z.infer<typeof listDetailItem>>().toEqualTypeOf<ListDetailItem>();
    expectTypeOf<z.infer<typeof listDetail>>().toEqualTypeOf<ListDetail>();
  });
});

describe('stored aggregate', () => {
  it('accepts the canonical generation and DynamoDB key attributes', () => {
    expect(list.safeParse({ ...storedList, pk: 'LIST#x', sk: 'META' }).success).toBe(
      true,
    );
    expect(
      listItem.safeParse({ ...storedItem, pk: 'LIST#x', sk: 'ITEM#V#x' }).success,
    ).toBe(true);
  });

  it.each(['schemaVersion', 'itemStateMode', 'featureConfig', 'doneCount'] as const)(
    'requires %s',
    (field) => {
      const copy: Record<string, unknown> = { ...storedList };
      delete copy[field];
      expect(list.safeParse(copy).success).toBe(false);
    },
  );

  it('retains storage fences but removes them from public views', () => {
    const parsed = listView.parse({
      ...storedList,
      itemVersion: 2,
      rankRepairId: 'rr',
      schemaMigrationId: 'sm',
    });
    expect(parsed).not.toHaveProperty('itemVersion');
    expect(parsed).not.toHaveProperty('rankRepairId');
    expect(parsed).not.toHaveProperty('schemaMigrationId');
  });
});

describe('strict public inputs', () => {
  it('requires an explicit template and rejects structural overrides on create', () => {
    expect(createListInput.safeParse({ title: 'A', templateKey: 'blank' }).success).toBe(
      true,
    );
    expect(createListInput.safeParse({ title: 'A' }).success).toBe(false);
    expect(
      createListInput.safeParse({
        title: 'A',
        templateKey: 'blank',
        itemStateMode: { mode: 'none' },
      }).success,
    ).toBe(false);
  });

  it('starts items open server-side and rejects authored rank/state', () => {
    expect(createListItemInput.safeParse({ title: 'A' }).success).toBe(true);
    expect(createListItemInput.safeParse({ title: 'A', state: 'done' }).success).toBe(
      false,
    );
    expect(createListItemInput.safeParse({ title: 'A', rank: 'V' }).success).toBe(false);
  });

  it('bounds bulk items and sub-items', () => {
    expect(bulkCreateListItemsInput.safeParse({ items: [] }).success).toBe(false);
    expect(
      createListItemInput.safeParse({
        title: 'Kit',
        features: { subItems: { entries: [{ id: 'sub_1', title: 'Paint', rank: 'V' }] } },
      }).success,
    ).toBe(true);
  });

  it('patches state/features without accepting legacy fields', () => {
    expect(
      patchListInput.safeParse({ itemStateMode: { mode: 'checkbox' } }).success,
    ).toBe(true);
    expect(patchListInput.safeParse({ capabilities: { checkable: true } }).success).toBe(
      false,
    );
    expect(patchListItemInput.safeParse({ state: 'done' }).success).toBe(true);
    expect(patchListItemInput.safeParse({ checked: true }).success).toBe(false);
  });

  it('accepts one Plan attachment as its own settings operation', () => {
    expect(patchListInput.safeParse({ sourceActivityId: ACT }).success).toBe(true);
    expect(
      patchListInput.safeParse({ sourceActivityId: ACT, title: 'Packing' }).success,
    ).toBe(false);
  });
});

describe('Plan bridge and ingredient destination contracts', () => {
  it('requires explicit Plan kind and audience', () => {
    const base = {
      activityId: ACT,
      creationTarget: { objectKind: 'plan', type: 'watch' },
    };
    expect(scheduleListItemInput.safeParse(base).success).toBe(false);
    expect(
      scheduleListItemInput.safeParse({ ...base, audience: { mode: 'just_me' } }).success,
    ).toBe(true);
    expect(
      scheduleListItemInput.safeParse({
        ...base,
        audience: { mode: 'selected_people', participants: [] },
      }).success,
    ).toBe(false);
  });

  it('does not accept a destination or Plan kind inferred outside creationTarget', () => {
    expect(
      scheduleListItemInput.safeParse({
        activityId: ACT,
        creationTarget: { objectKind: 'plan', type: 'custom' },
        audience: { mode: 'just_me' },
        templateKey: 'watch-later',
      }).success,
    ).toBe(false);
  });

  it('keeps the ingredient destination explicit and strict', () => {
    const input = {
      listId: LST,
      ingredients: [{ ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2' }],
    };
    expect(addIngredientsToListInput.safeParse(input).success).toBe(true);
    expect(
      addIngredientsToListInput.safeParse({ ...input, slot: 'groceries' }).success,
    ).toBe(false);
  });
});
