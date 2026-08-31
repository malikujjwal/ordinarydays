import { space } from '@od/ui';
import { Children, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

interface ListCardGridProps {
  children: ReactNode;
}

/** The Lists index's fixed two-column composition (`design-system.md` §7.2). */
export function ListCardGrid({ children }: ListCardGridProps) {
  const cards = Children.toArray(children);
  const splitAt = Math.ceil(cards.length / 2);
  const columns = [cards.slice(0, splitAt), cards.slice(splitAt)];

  return (
    <View style={styles.grid} testID="list-card-grid">
      {columns.map((column, index) => (
        <View
          key={index === 0 ? 'first' : 'second'}
          style={styles.column}
          testID={`list-card-column-${String(index)}`}
        >
          {column}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    gap: space[4],
  },
  column: {
    flex: 1,
    minWidth: 0,
    gap: space[4],
  },
});
