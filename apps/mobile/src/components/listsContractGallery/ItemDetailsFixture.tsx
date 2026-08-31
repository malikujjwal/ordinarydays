import type { List, ListItemView } from '@od/shared/types';
import { View } from 'react-native';
import { ItemSheet } from '@/features/lists/components/ItemSheet';
import { itemFixture, STAGED_LIST } from './fixtures';

/** Fully populated typed-feature item sheet. */
export function ItemDetailsFixture() {
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
