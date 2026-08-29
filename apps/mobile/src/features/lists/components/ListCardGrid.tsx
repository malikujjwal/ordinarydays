import { space } from '@od/ui';
import { Children, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

interface ListCardGridProps {
  children: ReactNode;
}

/** The Lists index's fixed two-column composition (`design-system.md` §7.2). */
export function ListCardGrid({ children }: ListCardGridProps) {
  return (
    <View style={styles.outerCompensation}>
      <View style={styles.grid}>
        {Children.map(children, (child) => (
          <View style={styles.cell}>
            <View style={styles.inset}>{child}</View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The nested token-sized offsets cancel the six points each edge card uses to make the
  // twelve-point interior gap, so card surfaces align exactly with their parent's gutter.
  outerCompensation: {
    marginHorizontal: -space[2],
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -space[1],
  },
  cell: {
    flexBasis: '50%',
    padding: space[2],
  },
  // Four points of cell padding plus this two-point inset on both cards makes the
  // design-system's twelve-point grid gap while keeping both columns exactly equal.
  inset: {
    margin: space[1],
  },
});
