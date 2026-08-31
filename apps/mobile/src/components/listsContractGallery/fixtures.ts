import { instant, timeZone } from '@od/shared/schemas';
import type { List, ListItemView } from '@od/shared/types';

export const NOW = instant.parse('2026-08-28T16:00:00.000Z');
export const TIMEZONE = timeZone.parse('America/New_York');
export const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

type ListFixtureSeed = Pick<
  List,
  | 'templateKey'
  | 'title'
  | 'icon'
  | 'emptyStateCopy'
  | 'itemStateMode'
  | 'featureConfig'
  | 'slot'
>;

function listFixture(seed: ListFixtureSeed, index: number): List {
  return {
    schemaVersion: 2,
    listId: `${LIST_ID.slice(0, -1)}${String(index)}`,
    ownerId: 'usr_contract_gallery',
    ...seed,
    itemCount: index + 2,
    doneCount: seed.itemStateMode.mode === 'checkbox' ? 1 : 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: NOW,
    lastItemActivityAt: NOW,
  };
}

// Copied List records, deliberately independent of the creation catalogue. Catalogue changes
// never rewrite this approved rendering fixture implicitly.
export const PRESET_LISTS: readonly List[] = [
  listFixture(
    {
      templateKey: 'blank',
      title: 'Untitled list',
      icon: 'list',
      emptyStateCopy: 'Add the first item.',
      itemStateMode: { mode: 'none' },
      featureConfig: {},
      slot: null,
    },
    0,
  ),
  listFixture(
    {
      templateKey: 'checklist',
      title: 'Checklist',
      icon: 'check-square',
      emptyStateCopy: 'Add something to check off.',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {},
      slot: null,
    },
    1,
  ),
  listFixture(
    {
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {},
      slot: 'groceries',
    },
    2,
  ),
  listFixture(
    {
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
    },
    3,
  ),
  listFixture(
    {
      templateKey: 'books-to-read',
      title: 'Books to Read',
      icon: 'book',
      emptyStateCopy: 'Add a book to read.',
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Want to read', active: 'Reading', done: 'Read' },
        groupByState: true,
      },
      featureConfig: { progress: { enabled: true, kind: 'text' } },
      slot: null,
    },
    4,
  ),
  listFixture(
    {
      templateKey: 'places-to-visit',
      title: 'Places to Visit',
      icon: 'map-pin',
      emptyStateCopy: 'Add a place to visit.',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: { place: { enabled: true } },
      slot: null,
    },
    5,
  ),
  listFixture(
    {
      templateKey: 'meal-ideas',
      title: 'Meal Ideas',
      icon: 'bowl',
      emptyStateCopy: 'Add a meal idea.',
      itemStateMode: { mode: 'none' },
      featureConfig: {
        subItems: {
          enabled: true,
          sectionLabel: 'Ingredients',
          singularLabel: 'Ingredient',
          secondaryLabel: 'Quantity',
          integration: 'mealIngredients',
        },
      },
      slot: 'meals',
    },
    6,
  ),
];

export function preset(index: number): List {
  const list = PRESET_LISTS[index];
  if (list === undefined) throw new Error(`Missing List preset fixture ${String(index)}`);
  return list;
}

export const STAGED_LIST: List & {
  itemStateMode: Extract<List['itemStateMode'], { mode: 'stages' }>;
} = {
  ...preset(0),
  title: 'Workshop supplies',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
    groupByState: true,
  },
  featureConfig: {
    subItems: {
      enabled: true,
      sectionLabel: 'Materials',
      singularLabel: 'Material',
      secondaryLabel: 'Quantity',
    },
  },
  slot: null,
};

export const SETTINGS_LIST: List = {
  ...preset(3),
  title: 'Things to enjoy',
  featureConfig: {
    progress: { enabled: true, kind: 'episode' },
    place: { enabled: false },
    subItems: {
      enabled: true,
      sectionLabel: 'Ingredients',
      singularLabel: 'Ingredient',
      secondaryLabel: 'Quantity',
      integration: 'mealIngredients',
    },
  },
};

const ITEMS: readonly ListItemView[] = [
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A1',
    listId: LIST_ID,
    rank: 'a0',
    title: 'The Bear',
    state: 'active',
    features: { progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 } },
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A2',
    listId: LIST_ID,
    rank: 'a1',
    title: 'Tomorrow, and Tomorrow, and Tomorrow',
    state: 'active',
    features: { progress: { kind: 'text', value: 'Page 143' } },
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A3',
    listId: LIST_ID,
    rank: 'a2',
    title: 'Morris Arboretum',
    state: 'open',
    features: { place: { label: 'Morris Arboretum', address: '100 E Northwestern Ave' } },
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A4',
    listId: LIST_ID,
    rank: 'a3',
    title: 'Chicken and rice',
    state: 'open',
    features: {
      subItems: {
        entries: Array.from({ length: 8 }, (_, index) => ({
          id: `sub_${String(index)}`,
          title: `Ingredient ${String(index + 1)}`,
          secondary: '1 cup',
          rank: `a${String(index)}`,
        })),
      },
    },
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A5',
    listId: LIST_ID,
    rank: 'a4',
    title: 'A quiet empty-feature row',
    state: 'open',
  },
];

export function itemFixture(index: number): ListItemView {
  const item = ITEMS[index];
  if (item === undefined) throw new Error(`Missing typed item fixture ${String(index)}`);
  return item;
}

export const CHECKLIST_ITEMS: readonly ListItemView[] = [
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B1',
    listId: LIST_ID,
    rank: 'a0',
    title: 'Paper towels',
    note: 'Large pack',
    state: 'open',
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B2',
    listId: LIST_ID,
    rank: 'a1',
    title: 'Yogurt',
    note: '1 cup',
    state: 'done',
  },
  {
    itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B3',
    listId: LIST_ID,
    rank: 'a2',
    title: 'Coffee filters',
    state: 'open',
  },
];

export function checklistItem(index: number): ListItemView {
  const item = CHECKLIST_ITEMS[index];
  if (item === undefined) throw new Error(`Missing checklist fixture ${String(index)}`);
  return item;
}
