import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { MAX_LIST_ITEMS } from '../constants.js';
import type { DeletedList } from '../types/deletedList.js';
import type {
  List,
  ListBehaviour,
  ListCapabilities,
  ListIndex,
  ListItem,
  ListItemActivityLink,
  ListItemDetails,
  ListMember,
  ListTemplate,
} from '../types/list.js';
import type { ListDetail } from '../types/listDetail.js';
import type { ListDetailItem } from '../types/listDetailItem.js';
import type { ListItemView } from '../types/listItemView.js';
import type { ListSettingsMutation } from '../types/listSettingsMutation.js';
import type { ListView } from '../types/listView.js';
import {
  bulkCreateListItemsInput,
  bulkCreateListItemsInputFor,
  changeListBehaviourInput,
  changeListBehaviourQuery,
  checkDetailsMatchBehaviour,
  createListInput,
  createListItemInput,
  createListItemInputFor,
  DATA_LOSS_DETAIL_PATHS,
  type deletedList,
  list,
  listBehaviour,
  type listCapabilities,
  listDetail,
  type listDetailItem,
  listDetailQuery,
  listIndex,
  listItem,
  listItemActivityLink,
  listItemDetails,
  listItemDetailsInput,
  listItemView,
  listListQuery,
  listMember,
  listSettingsMutation,
  listTemplate,
  listView,
  patchListInput,
} from './list.js';

/**
 * The schema and the interface describe one shape, in both directions — a one-way
 * assertion passes happily when one side gains a field the other lacks. Checked by
 * `tsconfig.test.json`; see `activity.test.ts` for why that matters.
 */
describe('the schema and the interface are the same shape', () => {
  it('ListBehaviour is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listBehaviour>>().toEqualTypeOf<ListBehaviour>();
  });

  it('ListCapabilities is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listCapabilities>>().toEqualTypeOf<ListCapabilities>();
  });

  it('List is assignable both ways', () => {
    expectTypeOf<z.infer<typeof list>>().toEqualTypeOf<List>();
  });

  it('ListIndex is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listIndex>>().toEqualTypeOf<ListIndex>();
  });

  it('ListMember is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listMember>>().toEqualTypeOf<ListMember>();
  });

  it('ListItemDetails is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listItemDetails>>().toEqualTypeOf<ListItemDetails>();
  });

  it('ListItem is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listItem>>().toEqualTypeOf<ListItem>();
  });

  it('ListItemActivityLink is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof listItemActivityLink>
    >().toEqualTypeOf<ListItemActivityLink>();
  });

  it('ListTemplate is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listTemplate>>().toEqualTypeOf<ListTemplate>();
  });
});

/**
 * `ListBehaviour` is a closed set of exactly three (ADR-031). A `Record` keyed by it must
 * name every member, so a fourth behaviour — or a dropped one — fails to compile at every
 * exhaustive map in the codebase rather than falling through at runtime.
 */
describe('ListBehaviour is exhaustive', () => {
  const labels: Record<ListBehaviour, string> = {
    collection: 'An ordered list of items',
    watch: 'Grouped under status headings',
    meals: 'Typed ingredients',
  };

  it('a Record over the three behaviours compiles and matches the runtime enum', () => {
    expect(Object.keys(labels).sort()).toEqual([...listBehaviour.options].sort());
    expect(listBehaviour.options).toHaveLength(3);
  });

  it('a Record missing a behaviour does not compile', () => {
    // @ts-expect-error — `meals` is missing; this is the type-level test §P3-01 requires,
    // and it must keep failing to compile for as long as `meals` is a behaviour.
    const incomplete: Record<ListBehaviour, string> = { collection: '', watch: '' };
    expect(incomplete).toBeDefined();
  });

  it.each(['groceries', 'checklist', 'general', 'watchlist', 'simple-list', ''])(
    'rejects the template-key-shaped behaviour %j',
    (value) => {
      expect(listBehaviour.safeParse(value).success).toBe(false);
    },
  );
});

const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PSN = 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ING = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const storedList = {
  listId: LST,
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-23T00:00:00.000Z',
} as const;

describe('the stored List', () => {
  it('accepts a collection seeded from a template', () => {
    expect(list.safeParse(storedList).success).toBe(true);
  });

  it('accepts an unknown templateKey — the catalogue is data and old clients must not break', () => {
    expect(list.safeParse({ ...storedList, templateKey: 'bars-to-try' }).success).toBe(
      true,
    );
    expect(
      list.safeParse({ ...storedList, templateKey: 'a-style-shipped-next-year' }).success,
    ).toBe(true);
  });

  it('rejects an empty templateKey', () => {
    expect(list.safeParse({ ...storedList, templateKey: '' }).success).toBe(false);
    expect(list.safeParse({ ...storedList, templateKey: '   ' }).success).toBe(false);
  });

  it('accepts a slot on any behaviour — a destination marker, unrelated to behaviour', () => {
    expect(
      list.safeParse({ ...storedList, behaviour: 'watch', slot: null }).success,
    ).toBe(true);
    expect(
      list.safeParse({ ...storedList, behaviour: 'collection', slot: 'groceries' })
        .success,
    ).toBe(true);
  });

  it('rejects a missing or unknown slot — null is the explicit "none"', () => {
    const { slot: _slot, ...withoutSlot } = storedList;
    expect(list.safeParse(withoutSlot).success).toBe(false);
    expect(list.safeParse({ ...storedList, slot: 'packing' }).success).toBe(false);
  });

  it('rejects a fourth behaviour', () => {
    expect(list.safeParse({ ...storedList, behaviour: 'groceries' }).success).toBe(false);
  });

  it('carries the storage-only concurrency markers', () => {
    expect(
      list.safeParse({
        ...storedList,
        rankRepairId: 'op_1',
        behaviourMigrationId: 'op_2',
        sourceActivityId: ACT,
      }).success,
    ).toBe(true);
  });

  it('is not strict: a row read back from storage carries key attributes', () => {
    expect(list.safeParse({ ...storedList, entity: 'List' }).success).toBe(true);
  });

  it('requires memberCount to count the owner', () => {
    expect(list.safeParse({ ...storedList, memberCount: 0 }).success).toBe(false);
  });
});

describe('the near-pure pointer and the member row', () => {
  it('ListIndex carries role and addedAt', () => {
    expect(
      listIndex.safeParse({
        listId: LST,
        userId: 'usr_local_dev',
        role: 'owner',
        addedAt: '2026-08-23T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('ListMember is always a non-owner', () => {
    const member = {
      listId: LST,
      personId: PSN,
      displayName: 'Ben',
      role: 'member',
      status: 'invited',
      invitedBy: 'usr_local_dev',
      addedAt: '2026-08-23T00:00:00.000Z',
    };
    expect(listMember.safeParse(member).success).toBe(true);
    expect(listMember.safeParse({ ...member, role: 'owner' }).success).toBe(false);
  });
});

const storedItem = {
  itemId: ITM,
  listId: LST,
  rank: 'a0',
  itemRevision: 0,
  title: 'Chicken',
  checked: false,
} as const;

describe('the stored ListItem', () => {
  it('accepts a collection item with no details', () => {
    expect(listItem.safeParse(storedItem).success).toBe(true);
  });

  it('accepts a watch item', () => {
    expect(
      listItem.safeParse({
        ...storedItem,
        details: { behaviour: 'watch', watchStatus: 'watching', season: 2, episode: 4 },
      }).success,
    ).toBe(true);
  });

  it('accepts a meals item with stable ingredient ids', () => {
    expect(
      listItem.safeParse({
        ...storedItem,
        details: {
          behaviour: 'meals',
          ingredients: [{ ingredientId: ING, name: 'Chicken', quantity: '500g' }],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an ingredient without its ing_ identity', () => {
    expect(
      listItem.safeParse({
        ...storedItem,
        details: { behaviour: 'meals', ingredients: [{ name: 'Chicken' }] },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown behaviour string in details', () => {
    expect(
      listItem.safeParse({ ...storedItem, details: { behaviour: 'collection' } }).success,
    ).toBe(false);
    expect(
      listItem.safeParse({ ...storedItem, details: { behaviour: 'groceries' } }).success,
    ).toBe(false);
  });

  it('requires watchStatus on a watch item', () => {
    expect(
      listItem.safeParse({ ...storedItem, details: { behaviour: 'watch' } }).success,
    ).toBe(false);
  });

  it('accepts a location without mapUrl and provenance fields', () => {
    expect(
      listItem.safeParse({
        ...storedItem,
        location: { label: 'Zahav', address: '237 St James Pl' },
        sourceActivityId: ACT,
        sourceLabel: 'Sunday dinner',
      }).success,
    ).toBe(true);
  });

  it('ListItemActivityLink is keyed viewer-first and names one Activity', () => {
    expect(
      listItemActivityLink.safeParse({
        listId: LST,
        itemId: ITM,
        viewerUserId: 'usr_local_dev',
        activityId: ACT,
        linkedAt: '2026-08-23T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('the template shape', () => {
  it('accepts a catalogue record', () => {
    expect(
      listTemplate.safeParse({
        templateKey: 'bars-to-try',
        chooserLabel: 'Bars to try',
        summary: 'Places and checkboxes',
        defaultTitle: 'Bars to try',
        icon: 'glass',
        behaviour: 'collection',
        capabilities: { checkable: true, supportsLocation: true },
        slot: null,
        emptyStateCopy: 'Add a bar to try.',
      }).success,
    ).toBe(true);
  });
});

describe('createListInput', () => {
  it('accepts a title and the selected template, with or without a client-minted id', () => {
    expect(
      createListInput.safeParse({ title: 'Groceries', templateKey: 'groceries' }).success,
    ).toBe(true);
    expect(
      createListInput.safeParse({
        listId: LST,
        title: 'Packing',
        templateKey: 'packing',
        sourceActivityId: ACT,
      }).success,
    ).toBe(true);
  });

  it('requires both the title and the template — neither is inferred', () => {
    expect(createListInput.safeParse({ templateKey: 'groceries' }).success).toBe(false);
    expect(createListInput.safeParse({ title: 'Costco run' }).success).toBe(false);
    expect(
      createListInput.safeParse({ title: 'Costco run', templateKey: '' }).success,
    ).toBe(false);
  });

  it.each([
    ['behaviour', 'collection'],
    ['capabilities', { checkable: true, supportsLocation: false }],
    ['slot', 'groceries'],
    ['icon', 'cart'],
    ['emptyStateCopy', 'Add something.'],
    ['ownerId', 'usr_local_dev'],
    ['updatedAt', '2026-08-23T00:00:00.000Z'],
    ['rankVersion', 0],
    ['itemCount', 0],
    ['memberCount', 1],
    ['archived', false],
  ])('rejects the copied or server-derived field %s', (field, value) => {
    expect(
      createListInput.safeParse({
        title: 'Groceries',
        templateKey: 'groceries',
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed client-minted id', () => {
    expect(
      createListInput.safeParse({
        listId: 'lst_nope',
        title: 'x',
        templateKey: 'groceries',
      }).success,
    ).toBe(false);
    expect(
      createListInput.safeParse({ listId: ITM, title: 'x', templateKey: 'groceries' })
        .success,
    ).toBe(false);
  });
});

describe('createListItemInput', () => {
  it('accepts a bare title, and every optional field', () => {
    expect(createListItemInput.safeParse({ title: 'Eggs' }).success).toBe(true);
    expect(
      createListItemInput.safeParse({
        itemId: ITM,
        title: 'Severance',
        note: 'Apple TV+',
        location: { label: 'Home' },
        details: { behaviour: 'watch', watchStatus: 'want', mediaKind: 'show' },
        afterItemId: ITM,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['checked', true],
    ['rank', 'a0'],
    ['itemRevision', 1],
    ['sourceActivityId', ACT],
    ['sourceLabel', 'Sunday dinner'],
    ['listId', LST],
    ['createdAt', '2026-08-23T00:00:00.000Z'],
  ])('rejects the server-derived or provenance field %s', (field, value) => {
    expect(createListItemInput.safeParse({ title: 'Eggs', [field]: value }).success).toBe(
      false,
    );
  });

  it('rejects the server-owned addedToListId on an ingredient — single and bulk', () => {
    const details = {
      behaviour: 'meals',
      ingredients: [{ ingredientId: ING, name: 'Chicken', addedToListId: LST }],
    };
    const single = createListItemInput.safeParse({ title: 'Tacos', details });
    expect(single.success).toBe(false);
    expect(single.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['addedToListId'],
      path: ['details', 'ingredients', 0],
    });
    expect(
      bulkCreateListItemsInput.safeParse({ items: [{ title: 'Tacos', details }] })
        .success,
    ).toBe(false);
    // The same ingredient without the field is the ordinary, accepted shape.
    expect(
      createListItemInput.safeParse({
        title: 'Tacos',
        details: {
          behaviour: 'meals',
          ingredients: [{ ingredientId: ING, name: 'Chicken' }],
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'watch details carrying ingredients',
      { behaviour: 'watch', watchStatus: 'want', ingredients: [] },
    ],
    ['meals details carrying watchStatus', { behaviour: 'meals', watchStatus: 'want' }],
    ['meals details carrying season', { behaviour: 'meals', season: 2 }],
    [
      'an unknown ingredient field',
      {
        behaviour: 'meals',
        ingredients: [{ ingredientId: ING, name: 'x', checked: true }],
      },
    ],
  ])('rejects rather than strips %s', (_label, details) => {
    expect(createListItemInput.safeParse({ title: 'x', details }).success).toBe(false);
    expect(listItemDetailsInput.safeParse(details).success).toBe(false);
    // The stored union is strict too: nothing nested carries key attributes.
    expect(listItemDetails.safeParse(details).success).toBe(false);
  });

  it('rejects an unknown behaviour string', () => {
    expect(
      createListItemInput.safeParse({
        title: 'Eggs',
        details: { behaviour: 'groceries' },
      }).success,
    ).toBe(false);
  });
});

describe('bulkCreateListItemsInput', () => {
  it('accepts between 1 and MAX_LIST_ITEMS members, each the single-item shape', () => {
    expect(bulkCreateListItemsInput.safeParse({ items: [] }).success).toBe(false);
    expect(
      bulkCreateListItemsInput.safeParse({
        items: [{ title: 'Eggs' }, { itemId: ITM, title: 'Milk' }],
      }).success,
    ).toBe(true);
    const items = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => ({
      title: `Item ${i}`,
    }));
    expect(bulkCreateListItemsInput.safeParse({ items }).success).toBe(false);
  });

  it('rejects a member carrying a provenance field', () => {
    expect(
      bulkCreateListItemsInput.safeParse({
        items: [{ title: 'Eggs', sourceActivityId: ACT }],
      }).success,
    ).toBe(false);
  });

  it('rejects anything beside items', () => {
    expect(
      bulkCreateListItemsInput.safeParse({ items: [{ title: 'Eggs' }], listId: LST })
        .success,
    ).toBe(false);
  });
});

/**
 * The rule `Activity.details.kind === type` follows, applied with the loaded List because
 * the item body does not carry its list's behaviour (§P3-01 "Edge cases").
 */
describe('details.behaviour must match the list behaviour', () => {
  it('rejects details.behaviour "watch" on a collection list', () => {
    const result = createListItemInputFor('collection').safeParse({
      title: 'Severance',
      details: { behaviour: 'watch', watchStatus: 'want' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toEqual([['details', 'behaviour']]);
  });

  it('accepts a collection item with no details', () => {
    expect(
      createListItemInputFor('collection').safeParse({ title: 'Eggs' }).success,
    ).toBe(true);
  });

  it('accepts matching details on a watch list and on a meals list', () => {
    expect(
      createListItemInputFor('watch').safeParse({
        title: 'Severance',
        details: { behaviour: 'watch', watchStatus: 'want' },
      }).success,
    ).toBe(true);
    expect(
      createListItemInputFor('meals').safeParse({
        title: 'Chicken tacos',
        details: {
          behaviour: 'meals',
          ingredients: [{ ingredientId: ING, name: 'Chicken' }],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects meals details on a watch list', () => {
    expect(
      createListItemInputFor('watch').safeParse({
        title: 'Chicken tacos',
        details: { behaviour: 'meals' },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown behaviour string before the match is even considered', () => {
    expect(
      createListItemInputFor('collection').safeParse({
        title: 'Eggs',
        details: { behaviour: 'collection' },
      }).success,
    ).toBe(false);
  });

  it('applies to every bulk member and names the offending index', () => {
    const result = bulkCreateListItemsInputFor('collection').safeParse({
      items: [
        { title: 'Eggs' },
        { title: 'Severance', details: { behaviour: 'watch', watchStatus: 'want' } },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toEqual([
      ['items', 1, 'details', 'behaviour'],
    ]);
  });

  it('is the same check the service applies to a stored item against its loaded List', () => {
    const mismatch = z
      .object({ behaviour: listBehaviour, details: listItemDetails.optional() })
      .superRefine(checkDetailsMatchBehaviour)
      .safeParse({ behaviour: 'collection', details: { behaviour: 'meals' } });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.message).toBe(
      'details.behaviour must be "collection" to match the list',
    );
  });
});

/** The P3-05 response shapes, pinned to their interfaces like everything above. */
describe('the response projections', () => {
  it('ListView is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listView>>().toEqualTypeOf<ListView>();
  });

  it('ListItemView is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listItemView>>().toEqualTypeOf<ListItemView>();
  });

  it('ListDetailItem is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listDetailItem>>().toEqualTypeOf<ListDetailItem>();
  });

  it('ListDetail is assignable both ways', () => {
    expectTypeOf<z.infer<typeof listDetail>>().toEqualTypeOf<ListDetail>();
  });

  it('DeletedList is assignable both ways', () => {
    expectTypeOf<z.infer<typeof deletedList>>().toEqualTypeOf<DeletedList>();
  });

  it('ListView drops the two storage-only work markers and keeps rankVersion', () => {
    const parsed = listView.parse({
      ...storedList,
      rankRepairId: 'op_1',
      behaviourMigrationId: 'op_2',
    });
    expect(parsed).not.toHaveProperty('rankRepairId');
    expect(parsed).not.toHaveProperty('behaviourMigrationId');
    expect(parsed.rankVersion).toBe(0);
  });

  it('ListItemView drops the storage-only revision fence and keeps the rank', () => {
    const parsed = listItemView.parse(storedItem);
    expect(parsed).not.toHaveProperty('itemRevision');
    expect(parsed.rank).toBe('a0');
  });

  it('ListDetail carries META alone, or the item page with per-item viewer links', () => {
    const view = listView.parse(storedList);
    expect(listDetail.safeParse({ list: view }).success).toBe(true);
    expect(
      listDetail.safeParse({
        list: view,
        items: [
          { item: listItemView.parse(storedItem) },
          {
            item: listItemView.parse({ ...storedItem, itemId: ITM }),
            viewerLink: {
              listId: LST,
              itemId: ITM,
              viewerUserId: 'usr_local_dev',
              activityId: ACT,
              linkedAt: '2026-08-23T00:00:00.000Z',
            },
          },
        ],
        nextCursor: 'eyJwayI6ImEifQ',
      }).success,
    ).toBe(true);
  });
});

describe('the list query schemas', () => {
  it('listListQuery accepts a cursor and nothing else', () => {
    expect(listListQuery.safeParse({}).success).toBe(true);
    expect(listListQuery.safeParse({ cursor: 'eyJwayI6ImEifQ' }).success).toBe(true);
    expect(listListQuery.safeParse({ limit: '50' }).success).toBe(false);
  });

  it('listDetailQuery accepts only the includeItems flag', () => {
    expect(listDetailQuery.safeParse({}).success).toBe(true);
    expect(listDetailQuery.safeParse({ includeItems: 'true' }).success).toBe(true);
    expect(listDetailQuery.safeParse({ includeItems: 'yes' }).success).toBe(false);
    expect(listDetailQuery.safeParse({ cursor: 'x' }).success).toBe(false);
  });
});

/**
 * The two settings inputs (P3-09).
 *
 * They are the change-rules table expressed on the wire: what a `PATCH` may carry, what only
 * the replay-protected action may change, and what neither may touch.
 */
describe('the list settings inputs', () => {
  it('accepts every field PATCH owns, and a partial capabilities pair', () => {
    expect(
      patchListInput.safeParse({
        title: 'Favourite restaurants',
        capabilities: { supportsLocation: true },
        slot: 'meals',
        archived: true,
      }).success,
    ).toBe(true);
  });

  /** `null` clears the slot; absent leaves it alone. The two are different intentions. */
  it('accepts a null slot and an empty patch, and rejects an empty capabilities patch', () => {
    expect(patchListInput.safeParse({ slot: null }).success).toBe(true);
    expect(patchListInput.safeParse({}).success).toBe(true);
    expect(patchListInput.safeParse({ capabilities: {} }).success).toBe(false);
  });

  /**
   * `behaviour` is the replay-protected action's, and `templateKey` is immutable provenance.
   * Strict, so either one is a `400` naming it rather than a save that quietly drops it.
   */
  it.each(['behaviour', 'templateKey', 'icon', 'emptyStateCopy', 'itemCount'])(
    'rejects %s, naming it',
    (field) => {
      const result = patchListInput.safeParse({ [field]: 'watch' });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(field);
    },
  );

  it('takes one behaviour and nothing else', () => {
    expect(changeListBehaviourInput.safeParse({ behaviour: 'meals' }).success).toBe(true);
    expect(changeListBehaviourInput.safeParse({ behaviour: 'shopping' }).success).toBe(
      false,
    );
    // The confirmation is a query parameter on a separately keyed action, not a body field.
    expect(
      changeListBehaviourInput.safeParse({ behaviour: 'meals', confirmDataLoss: true })
        .success,
    ).toBe(false);
    expect(changeListBehaviourQuery.safeParse({ confirmDataLoss: 'true' }).success).toBe(
      true,
    );
    expect(changeListBehaviourQuery.safeParse({ confirm: 'true' }).success).toBe(false);
  });

  it('ListSettingsMutation is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof listSettingsMutation>
    >().toEqualTypeOf<ListSettingsMutation>();
  });

  /** The offer is optional: a rename, and a change that lost data, both answer without it. */
  it('carries the Undo offer only when there is one', () => {
    const view = listView.parse(storedList);
    expect(listSettingsMutation.safeParse({ list: view }).success).toBe(true);
    expect(
      listSettingsMutation.safeParse({
        list: view,
        undoToken: 'tok',
        undoExpiresAt: '2026-08-24T09:00:06.000Z',
      }).success,
    ).toBe(true);
  });

  /**
   * **Both fields or neither.** A token without the deadline it is offered until is an offer
   * no client can time, and a deadline without a token names nothing to take back. Two
   * independent optionals would admit either; a union of two strict shapes admits neither.
   */
  it.each([
    ['a token with no deadline', { undoToken: 'tok' }],
    ['a deadline with no token', { undoExpiresAt: '2026-08-24T09:00:06.000Z' }],
  ])('rejects %s', (_case, half) => {
    const view = listView.parse(storedList);

    expect(listSettingsMutation.safeParse({ list: view, ...half }).success).toBe(false);
  });

  /**
   * The `409` preview's paths are exported rather than described, so the service that emits
   * them and the client that maps them back (P3-24) cannot drift. Pinned as literals here
   * because changing one is a wire change, not a rename.
   */
  it('names the data-loss preview paths the client maps', () => {
    expect(DATA_LOSS_DETAIL_PATHS.itemCount).toBe('confirmDataLoss.itemCount');
    expect(DATA_LOSS_DETAIL_PATHS.field(0)).toBe('confirmDataLoss.fields.0');
    expect(DATA_LOSS_DETAIL_PATHS.field(2)).toBe('confirmDataLoss.fields.2');
  });
});
