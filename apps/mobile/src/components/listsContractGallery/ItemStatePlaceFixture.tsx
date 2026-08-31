import type { List, ListItemView } from '@od/shared/types';
import { View } from 'react-native';
import { ItemSheet } from '@/features/lists/components/ItemSheet';
import { ListDetailSurface } from '@/features/lists/components/ListDetailSurface';
import { CHECKLIST_ITEMS, checklistItem, preset } from './fixtures';

/** Binding State-and-Place target rendered over its real open-List surface. */
export function ItemStatePlaceFixture() {
  const list: List = {
    ...preset(5),
    title: 'Places to visit',
    itemCount: CHECKLIST_ITEMS.length,
    doneCount: 0,
  };
  const item: ListItemView = {
    ...checklistItem(0),
    title: 'Try the neighborhood pizza place',
    note: 'Everyone keeps recommending the roasted mushroom pie.',
    state: 'open',
    features: {
      place: { label: 'Ember & Grain', address: '48 Cedar Lane' },
    },
  };
  const items: readonly ListItemView[] = [
    item,
    { ...checklistItem(1), state: 'open' },
    { ...checklistItem(2), state: 'open' },
  ];

  return (
    <View style={{ flex: 1 }}>
      <ListDetailSurface
        list={list}
        items={items}
        itemCount={items.length}
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
