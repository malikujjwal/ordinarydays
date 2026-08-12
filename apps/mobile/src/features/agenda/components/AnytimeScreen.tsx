import { toWallDate, toWallTime } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { Button, EmptyState, Skeleton, Text, useBreakpoint, useTheme } from '@od/ui';
import { useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAgendaActivityActions } from '@/features/agenda/hooks/useAgendaActivityActions';
import { useAnytime } from '@/features/agenda/hooks/useAnytime';
import { toAnytimeAgendaItem } from '@/features/agenda/model/toAnytimeAgendaItem';
import { useClock } from '@/hooks/useClock';
import { SwipeableRow } from './SwipeableRow';

export interface AnytimeScreenProps {
  onBack: () => void;
  onOpenAgendaItem: (item: AgendaItem) => void;
}

/** The pushed, cursor-paginated list of undated saved Tasks. */
export function AnytimeScreen({ onBack, onOpenAgendaItem }: AnytimeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const compact = useBreakpoint() === 'compact';
  const anytime = useAnytime();
  const clock = useClock();
  const now = clock.now();
  const scrollView = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const actions = useAgendaActivityActions({
    today: toWallDate(now, anytime.timezone),
    currentMinute: toWallTime(now, anytime.timezone),
    getScrollOffset: () => scrollOffset.current,
    restoreScrollOffset: (offset) => {
      requestAnimationFrame(() =>
        scrollView.current?.scrollTo({ y: offset, animated: false }),
      );
    },
  });
  const items = anytime.items.map(toAnytimeAgendaItem);

  return (
    <View
      testID="anytime-screen"
      style={{ flex: 1, backgroundColor: theme.colors.surface }}
    >
      <View
        style={{
          flex: 1,
          width: '100%',
          alignSelf: 'center',
          maxWidth: 720,
          paddingTop: insets.top + theme.space[3],
          paddingHorizontal: compact ? theme.space[5] : theme.space[7],
          gap: theme.space[3],
        }}
      >
        <Button label="Back" variant="ghost" onPress={onBack} testID="anytime-back" />
        <Text variant="display" color="textDisplay" accessibilityRole="header">
          Anytime
        </Text>

        {anytime.status === 'pending' ? (
          <View testID="anytime-loading" style={{ paddingTop: theme.space[5] }}>
            <Skeleton shape="row" count={5} />
          </View>
        ) : anytime.status === 'error' ? (
          <EmptyState
            heading={anytime.message ?? "Couldn't load this."}
            action={{ label: 'Try again', onPress: anytime.refetch }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            heading="No anytime tasks"
            body="Add a task without choosing a date."
            testID="anytime-empty"
          />
        ) : (
          <ScrollView
            ref={scrollView}
            testID="anytime-list"
            onScroll={({ nativeEvent }) => {
              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
              scrollOffset.current = contentOffset.y;
              if (
                contentSize.height > 0 &&
                contentOffset.y + layoutMeasurement.height >= contentSize.height * 0.8
              ) {
                anytime.loadMore();
              }
            }}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingBottom: theme.space[8] }}
          >
            {anytime.isOffline ? (
              <Text variant="footnote" color="textSecondary">
                You're offline. Showing saved data.
              </Text>
            ) : null}
            {items.map((item) => (
              <SwipeableRow
                key={item.activityId}
                item={item}
                onOpen={onOpenAgendaItem}
                onToggleComplete={actions.toggleComplete}
                onAction={actions.onAgendaAction}
              />
            ))}
            {anytime.isLoadingMore ? (
              <View testID="anytime-loading-more">
                <Skeleton shape="row" count={1} />
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
