import { space, useBreakpoint } from '@od/ui';
import type { ReactNode } from 'react';
import { ScrollView, type ScrollViewProps, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';

/** One answer for floating compact chrome, and ordinary safe-area breathing room at width. */
export const listsScrollBottomPadding = (
  insetBottom: number,
  compact: boolean,
): number => (compact ? bottomChromeScrollPadding(insetBottom) : insetBottom + space[8]);

export interface ListsIndexScrollProps {
  children: ReactNode;
  onScroll?: ScrollViewProps['onScroll'];
  scrollEventThrottle?: number;
  testID?: string;
}

/** The production Lists-index scroll measure, shared with deterministic gallery fixtures. */
export function ListsIndexScroll({
  children,
  onScroll,
  scrollEventThrottle,
  testID = 'lists-scroll',
}: ListsIndexScrollProps) {
  const compact = useBreakpoint() === 'compact';
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      onScroll={onScroll}
      scrollEventThrottle={scrollEventThrottle}
      contentContainerStyle={[
        compact ? styles.compactContent : styles.wideContent,
        { paddingBottom: listsScrollBottomPadding(insets.bottom, compact) },
      ]}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  compactContent: {
    paddingHorizontal: space[5],
  },
  wideContent: {
    paddingHorizontal: space[7],
  },
});
