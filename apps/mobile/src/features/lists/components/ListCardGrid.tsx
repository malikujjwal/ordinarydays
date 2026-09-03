import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

interface ListCardGridProps {
  children: ReactNode;
}

/** The Lists index's full-width row stack (`design-system.md` §7.2). */
export function ListCardGrid({ children }: ListCardGridProps) {
  return (
    <View style={styles.grid} testID="list-card-grid">
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'column',
    gap: 0,
  },
});
