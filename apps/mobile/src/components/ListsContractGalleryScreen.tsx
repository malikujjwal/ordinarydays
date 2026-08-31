import { instant, timeZone } from '@od/shared/schemas';
import type {
  DefaultSlot,
  ItemStateMode,
  List,
  ListFeatureConfig,
  ListItemView,
  ProgressFeatureConfig,
  SubItemsFeatureConfig,
} from '@od/shared/types';
import {
  EmptyState,
  IconButton,
  MoreHorizontal,
  ScreenShell,
  SectionHeader,
  Skeleton,
  Text,
  ThemeProvider,
  Touchable,
  useTheme,
} from '@od/ui';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TabScreen } from '@/components/TabScreen';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { ContextualListItemComposer } from '@/features/lists/components/ContextualListItemComposer';
import { ItemSheet } from '@/features/lists/components/ItemSheet';
import { ListCardGrid } from '@/features/lists/components/ListCardGrid';
import { ListDetailSurface } from '@/features/lists/components/ListDetailSurface';
import { ListHeaderMenu } from '@/features/lists/components/ListHeaderMenu';
import { ListIndexMenu } from '@/features/lists/components/ListIndexMenu';
import { ListIndexRow } from '@/features/lists/components/ListIndexRow';
import { ListItemRow } from '@/features/lists/components/ListItemRow';
import { ListSettingsSheet } from '@/features/lists/components/ListSettingsSheet';
import { ListsIndexScroll } from '@/features/lists/components/ListsIndexScroll';
import { NewListSheet } from '@/features/lists/components/NewListSheet';
import { SwipeableListCard } from '@/features/lists/components/SwipeableListCard';
import type { ListSettings } from '@/features/lists/hooks/useListSettings';
import { deleteListConfirmation } from '@/features/lists/model/deleteConfirmation';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * Production-component contract gallery for P3-33.
 *
 * The route renders only in development or an explicit screenshot-harness build. It
 * duplicates no product markup: every frame below is a production List component receiving a
 * deterministic fixture. Query parameters select one bounded contract frame so Playwright and
 * native capture can pin the same state without timing-dependent navigation.
 */

const OWNER = 'usr_contract_gallery';
const NOW = instant.parse('2026-08-28T16:00:00.000Z');
const TIMEZONE = timeZone.parse('America/New_York');
const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

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
    ownerId: OWNER,
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

// These are copied List records, deliberately independent of the creation catalogue. If a
// catalogue edit should change the approved gallery, update this fixture and its baselines in the
// same reviewed change.
const PRESET_LISTS: readonly List[] = [
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

function preset(index: number): List {
  const list = PRESET_LISTS[index];
  if (list === undefined) throw new Error(`Missing List preset fixture ${index}`);
  return list;
}
const STAGED_LIST: List & {
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

const SETTINGS_LIST: List = {
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
          id: `sub_${index}`,
          title: `Ingredient ${index + 1}`,
          secondary: '1 cup',
          rank: `a${index}`,
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

function SettingsFixture() {
  const [list, setList] = useState(SETTINGS_LIST);
  const settings = useMemo<ListSettings>(
    () => ({
      view: list,
      rename: (title: string) => setList((current) => ({ ...current, title })),
      setStateMode: (itemStateMode: ItemStateMode) =>
        setList((current) => ({ ...current, itemStateMode })),
      setFeatureEnabled: (feature: keyof ListFeatureConfig, enabled: boolean) =>
        setList((current) => {
          const previous = current.featureConfig[feature];
          const next =
            feature === 'progress'
              ? { ...(previous ?? { kind: 'text' }), enabled }
              : feature === 'place'
                ? { enabled }
                : {
                    ...(previous ?? {
                      sectionLabel: 'Sub-items',
                      singularLabel: 'Sub-item',
                    }),
                    enabled,
                  };
          return {
            ...current,
            featureConfig: { ...current.featureConfig, [feature]: next },
          };
        }),
      setProgressKind: (kind: ProgressFeatureConfig['kind']) =>
        setList((current) => ({
          ...current,
          featureConfig: { ...current.featureConfig, progress: { enabled: true, kind } },
        })),
      setSubItemLabels: (
        labels: Pick<
          SubItemsFeatureConfig,
          'sectionLabel' | 'singularLabel' | 'secondaryLabel'
        >,
      ) =>
        setList((current) => ({
          ...current,
          featureConfig: {
            ...current.featureConfig,
            subItems: {
              ...(current.featureConfig.subItems ?? {
                enabled: true,
                sectionLabel: 'Sub-items',
                singularLabel: 'Sub-item',
              }),
              ...labels,
            },
          },
        })),
      setSlot: (slot: DefaultSlot | null) => setList((current) => ({ ...current, slot })),
      busy: false,
    }),
    [list],
  );

  return (
    <View style={{ flex: 1 }}>
      <ListSettingsSheet open onClose={() => {}} list={list} settings={settings} />
    </View>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[3] }}>
      <Text variant="sectionLabel" color="textSecondary">
        {title}
      </Text>
      {children}
    </View>
  );
}

function OverviewFixture() {
  const theme = useTheme();
  const generic = [
    {
      ...STAGED_LIST,
      listId: `${LIST_ID.slice(0, -1)}7`,
      title: 'Workshop materials',
    },
    {
      ...STAGED_LIST,
      title: 'Road trip stops',
      featureConfig: {
        subItems: {
          enabled: true,
          sectionLabel: 'Stops',
          singularLabel: 'Stop',
          secondaryLabel: 'Duration',
        },
      },
    },
  ];
  return (
    <ScreenShell measure="standard">
      <ScrollView
        contentContainerStyle={{ gap: theme.space[6], paddingBottom: theme.space[10] }}
      >
        <Text variant="title">Lists contract gallery</Text>
        <ListCardGrid>
          {[...PRESET_LISTS, ...generic].map((list) => (
            <View key={list.title}>
              <ListIndexRow
                list={list}
                now={NOW}
                timezone={TIMEZONE}
                onPress={() => {}}
              />
            </View>
          ))}
        </ListCardGrid>
      </ScrollView>
    </ScreenShell>
  );
}

function IndexChromeFixture({ state }: { state: 'populated' | 'empty' | 'loading' }) {
  const theme = useTheme();
  const active = [
    ...PRESET_LISTS,
    { ...STAGED_LIST, title: 'Workshop materials' },
    { ...STAGED_LIST, listId: `${LIST_ID.slice(0, -1)}8`, title: 'Road trip stops' },
  ];
  const archived = {
    ...preset(2),
    listId: `${LIST_ID.slice(0, -1)}9`,
    title: 'Archived reading list',
    archived: true,
  };

  return (
    <TabScreen
      title="Lists"
      testID="lists-contract-tab"
      bleedBody
      headerAction={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="New list"
            onPress={() => {}}
          >
            <Text variant="footnoteStrong" color="textAction">
              + New list
            </Text>
          </Touchable>
          <IconButton icon={MoreHorizontal} label="More" onPress={() => {}} />
        </View>
      }
    >
      <ListsIndexScroll testID="lists-contract-index-scroll">
        {state === 'loading' ? (
          <View testID="lists-contract-loading" style={{ paddingTop: theme.space[5] }}>
            <Skeleton shape="row" count={5} />
          </View>
        ) : state === 'empty' ? (
          <EmptyState
            heading="No lists yet"
            body="Keep things you want to remember, track, or organise together."
            action={{ label: 'New list', onPress: () => {} }}
          />
        ) : (
          <View style={{ gap: theme.space[6] }}>
            <ListCardGrid>
              {active.map((list) => (
                <SwipeableListCard
                  key={list.listId}
                  list={list}
                  now={NOW}
                  timezone={TIMEZONE}
                  onPress={() => {}}
                  actions={[]}
                  onAction={() => {}}
                />
              ))}
            </ListCardGrid>
            <View style={{ gap: theme.space[2] }}>
              <SectionHeader title="Archived" count={1} />
              <ListCardGrid>
                <View>
                  <SwipeableListCard
                    list={archived}
                    now={NOW}
                    timezone={TIMEZONE}
                    onPress={() => {}}
                    dimmed
                    actions={[]}
                    onAction={() => {}}
                  />
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel="Restore Archived reading list"
                    onPress={() => {}}
                    style={{ paddingHorizontal: theme.space[4] }}
                  >
                    <Text variant="footnoteStrong" color="textAction">
                      Restore
                    </Text>
                  </Touchable>
                </View>
              </ListCardGrid>
            </View>
          </View>
        )}
      </ListsIndexScroll>
    </TabScreen>
  );
}

function ItemsFixture() {
  const theme = useTheme();
  const watch = preset(3);
  const books = preset(4);
  const places = preset(5);
  const meals = preset(6);
  const emptyFeatureList = preset(5);
  return (
    <ScreenShell measure="reading">
      <ScrollView
        contentContainerStyle={{ gap: theme.space[6], paddingBottom: theme.space[10] }}
      >
        <Text variant="title">Typed item summaries</Text>
        <Frame title="Watch">
          <ListItemRow list={watch} item={itemFixture(0)} onOpen={() => {}} />
        </Frame>
        <Frame title="Books">
          <ListItemRow list={books} item={itemFixture(1)} onOpen={() => {}} />
        </Frame>
        <Frame title="Places">
          <ListItemRow list={places} item={itemFixture(2)} onOpen={() => {}} />
        </Frame>
        <Frame title="Meals">
          <ListItemRow list={meals} item={itemFixture(3)} onOpen={() => {}} />
        </Frame>
        <Frame title="Empty configured feature">
          <ListItemRow list={emptyFeatureList} item={itemFixture(4)} onOpen={() => {}} />
        </Frame>
      </ScrollView>
    </ScreenShell>
  );
}

function itemFixture(index: number): ListItemView {
  const item = ITEMS[index];
  if (item === undefined) throw new Error(`Missing typed item fixture ${String(index)}`);
  return item;
}

const CHECKLIST_ITEMS: readonly ListItemView[] = [
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

function checklistItem(index: number): ListItemView {
  const item = CHECKLIST_ITEMS[index];
  if (item === undefined) throw new Error(`Missing checklist fixture ${String(index)}`);
  return item;
}

function OpenListFixture({
  state,
}: {
  state:
    | 'empty'
    | 'checklist'
    | 'stages'
    | 'context-add'
    | 'context-add-long'
    | 'short-header'
    | 'long-header';
}) {
  const checklist: List = {
    ...preset(1),
    title: 'Weekend packing',
    itemCount: CHECKLIST_ITEMS.length,
    doneCount: 1,
  };
  const title =
    state === 'short-header'
      ? 'Errands'
      : state === 'long-header'
        ? 'Everything to remember before the long weekend away'
        : checklist.title;
  const list =
    state === 'stages' ? { ...STAGED_LIST, itemCount: 3 } : { ...checklist, title };
  const empty = state === 'empty';
  const stagedItems: readonly ListItemView[] = [
    { ...checklistItem(0), state: 'open', title: 'Sketch the frame' },
    { ...checklistItem(1), state: 'active', title: 'Build the switch' },
    { ...checklistItem(2), state: 'done', title: 'Review the spacing' },
  ];

  const [longItems, setLongItems] = useState<readonly ListItemView[]>(() =>
    Array.from({ length: 14 }, (_, index) => ({
      ...checklistItem(index % CHECKLIST_ITEMS.length),
      itemId: `itm_01J8XKQ2M4N5P6R7S8T9V${String(index).padStart(4, '0')}`,
      rank: `a${String(index).padStart(2, '0')}`,
      title: `Packing item ${String(index + 1)}`,
      state: index % 4 === 0 ? ('done' as const) : ('open' as const),
    })),
  );
  const visibleItems = empty
    ? []
    : state === 'stages'
      ? stagedItems
      : state === 'context-add-long'
        ? longItems
        : CHECKLIST_ITEMS;
  const visibleList = empty
    ? { ...list, itemCount: 0, doneCount: 0 }
    : { ...list, itemCount: visibleItems.length };

  return (
    <View style={{ flex: 1 }}>
      <ListDetailSurface
        list={visibleList}
        items={visibleItems}
        itemCount={visibleList.itemCount}
        complete
        status="success"
        isOffline={false}
        onBack={() => {}}
        onOpenMenu={() => {}}
        onRename={() => {}}
        onRetry={() => {}}
        onLoadMore={() => {}}
        onAdd={() => {}}
        onOpenItem={() => {}}
        onToggleChecked={() => undefined}
        onDrop={() => {}}
      />
      {state === 'context-add' || state === 'context-add-long' ? (
        <ContextualListItemComposer
          open
          listName={list.title}
          isAdding={false}
          onClose={() => {}}
          onAdd={async ({ title: itemTitle }) => {
            const itemId = `itm_contract_gallery_${String(longItems.length + 1)}`;
            if (state === 'context-add-long') {
              setLongItems((current) => [
                ...current,
                {
                  ...checklistItem(0),
                  itemId,
                  rank: `z${String(current.length).padStart(2, '0')}`,
                  title: itemTitle,
                  state: 'open',
                },
              ]);
            }
            return itemId;
          }}
        />
      ) : null}
    </View>
  );
}

function GlobalComposerFixture() {
  const destinations = [
    { listId: 'lst_gallery_groceries', title: 'Groceries' },
    { listId: 'lst_gallery_restaurants', title: 'Restaurants to try' },
  ];
  const openDraft = useComposeDraft((state) => state.open);
  const chooseObject = useComposeDraft((state) => state.chooseObject);
  const setTitle = useComposeDraft((state) => state.setTitle);
  const setNotes = useComposeDraft((state) => state.setNotes);

  useEffect(() => {
    openDraft();
    chooseObject('listItem');
    setTitle('Try Zahav');
    setNotes('Ask about the tasting menu');
  }, [chooseObject, openDraft, setNotes, setTitle]);

  return (
    <ComposeScreen
      onClose={() => {}}
      today="2026-08-28"
      timezone="America/New_York"
      listDestinations={{
        lists: destinations,
        status: 'success',
        refetch: () => {},
      }}
      onCreateList={() => {}}
    />
  );
}

function ItemDetailsFixture() {
  const list: List = {
    ...STAGED_LIST,
    title: 'Meal ideas',
    featureConfig: {
      place: { enabled: true },
      subItems: {
        enabled: true,
        sectionLabel: 'Ingredients',
        singularLabel: 'Ingredient',
        secondaryLabel: 'Quantity',
      },
    },
  };
  const item: ListItemView = {
    ...itemFixture(3),
    state: 'active',
    note: 'Easy weekday dinner with enough leftovers for lunch.',
    features: {
      place: { label: 'Home', address: 'Kitchen' },
      subItems: {
        entries: itemFixture(3).features?.subItems?.entries ?? [],
      },
    },
  };
  return (
    <View style={{ flex: 1 }}>
      <ItemSheet
        open
        list={list}
        item={item}
        onClose={() => {}}
        onChanged={() => {}}
        onRemoved={() => {}}
      />
    </View>
  );
}

function ListIndexMenuFixture() {
  return (
    <>
      <OverviewFixture />
      <ListIndexMenu
        open
        onClose={() => {}}
        showingArchived
        archivedCount={3}
        onToggleArchived={() => {}}
      />
    </>
  );
}

function ListHeaderMenuFixture({ checked }: { checked: boolean }) {
  const list = { ...preset(1), title: 'Weekend packing', itemCount: 14, doneCount: 4 };
  return (
    <>
      <OpenListFixture state="checklist" />
      <ListHeaderMenu
        open
        onClose={() => {}}
        list={list}
        checkedCount={checked ? 4 : 0}
        onClearDone={() => {}}
        onUncheckAll={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onOpenSettings={() => {}}
      />
    </>
  );
}

function DeleteFixture() {
  const list: List = {
    ...preset(1),
    title: 'Weekend packing',
    itemCount: 18,
    doneCount: 7,
    memberCount: 3,
  };

  return (
    <>
      <OpenListFixture state="checklist" />
      <ConfirmDialog
        open
        centred
        confirmation={deleteListConfirmation(list)}
        onCancel={() => {}}
        onConfirm={() => {}}
        testID="list-delete-confirm"
      />
    </>
  );
}

function ContractFrame({ frame }: { frame: string }) {
  if (frame === 'index-chrome') return <IndexChromeFixture state="populated" />;
  if (frame === 'index-chrome-empty') return <IndexChromeFixture state="empty" />;
  if (frame === 'index-chrome-loading') return <IndexChromeFixture state="loading" />;
  if (frame === 'settings') return <SettingsFixture />;
  if (frame === 'create') return <NewListSheet open onClose={() => {}} />;
  if (frame === 'items') return <ItemsFixture />;
  if (frame === 'stages') return <OpenListFixture state="stages" />;
  if (frame === 'empty') return <OpenListFixture state="empty" />;
  if (frame === 'checklist') return <OpenListFixture state="checklist" />;
  if (frame === 'context-add') return <OpenListFixture state="context-add" />;
  if (frame === 'context-add-long') return <OpenListFixture state="context-add-long" />;
  if (frame === 'short-header') return <OpenListFixture state="short-header" />;
  if (frame === 'long-header') return <OpenListFixture state="long-header" />;
  if (frame === 'global-add') return <GlobalComposerFixture />;
  if (frame === 'item-details') return <ItemDetailsFixture />;
  if (frame === 'index-menu') return <ListIndexMenuFixture />;
  if (frame === 'detail-menu') return <ListHeaderMenuFixture checked />;
  if (frame === 'detail-menu-empty') return <ListHeaderMenuFixture checked={false} />;
  if (frame === 'delete') return <DeleteFixture />;
  return <OverviewFixture />;
}

export interface ListsContractGalleryScreenProps {
  frame?: string;
  scheme?: string;
}

export function ListsContractGalleryScreen({
  frame = 'overview',
  scheme = 'light',
}: ListsContractGalleryScreenProps) {
  const enabled = __DEV__ || process.env.EXPO_PUBLIC_CONTRACT_GALLERY === '1';
  if (!enabled) return null;
  return (
    <ThemeProvider scheme={scheme === 'dark' ? 'dark' : 'light'}>
      <ContractFrame frame={frame} />
    </ThemeProvider>
  );
}
