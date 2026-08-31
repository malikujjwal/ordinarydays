import type { List, ListItemView } from '@od/shared/types';
import { useState } from 'react';
import { View } from 'react-native';
import { ContextualListItemComposer } from '@/features/lists/components/ContextualListItemComposer';
import { ListDetailSurface } from '@/features/lists/components/ListDetailSurface';
import { CHECKLIST_ITEMS, checklistItem, preset, STAGED_LIST } from './fixtures';

export interface OpenListFixtureProps {
  state:
    | 'empty'
    | 'checklist'
    | 'stages'
    | 'context-add'
    | 'context-add-long'
    | 'short-header'
    | 'long-header';
}

/** Production open-List states, including repeatable contextual rapid entry. */
export function OpenListFixture({ state }: OpenListFixtureProps) {
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
        {...(state !== 'context-add' && state !== 'context-add-long'
          ? {}
          : {
              addEditor: (
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
              ),
            })}
        onOpenItem={() => {}}
        onToggleChecked={() => undefined}
        onDrop={() => {}}
      />
    </View>
  );
}
