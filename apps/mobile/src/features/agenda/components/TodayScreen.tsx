import { ApiError } from '@od/shared/client';
import {
  TODAY_ANYTIME_SAVED_LIMIT,
  TODAY_EARLIER_COLLAPSED_LIMIT,
} from '@od/shared/constants';
import { fixedClock, toWallDate, toWallTime } from '@od/shared/time';
import type { AgendaData, AgendaItem } from '@od/shared/types';
import { Button, EmptyState, Skeleton, useTheme } from '@od/ui';
import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { TabScreen } from '@/components/TabScreen';
import { useAgendaActivityActions } from '@/features/activity/hooks/useActivityActions';
import { useAgenda } from '@/features/agenda/hooks/useAgenda';
import { useMinuteTicker } from '@/features/agenda/hooks/useMinuteTicker';
import { agendaItemsForDay, partitionAgenda } from '@/features/agenda/model/partition';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { selectUpNext, toUpNextSelection } from '@/features/agenda/model/upNext';
import { AgendaSection } from './AgendaSection';
import { UpNextCard } from './UpNextCard';

export interface TodayScreenProps {
  onOpenAnytime: () => void;
  onOpenAgendaItem: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAgendaAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
}

function cappedAnytime(items: readonly AgendaItem[]): {
  items: AgendaItem[];
  savedCount: number;
} {
  const saved = items.filter((item) => item.status === 'saved');
  const other = items.filter((item) => item.status !== 'saved');
  return {
    items: [...other, ...saved.slice(0, TODAY_ANYTIME_SAVED_LIMIT)],
    savedCount: saved.length,
  };
}

function errorDetails(error: unknown): { message: string; requestId?: string } {
  if (!(error instanceof ApiError)) return { message: "Couldn't load this." };
  return {
    message: error.status >= 500 ? 'Something went wrong.' : error.message,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  };
}

/** Today is a disposable projection: one agenda response, four locally derived sections. */
export function TodayScreen({
  onOpenAnytime,
  onOpenAgendaItem,
  onToggleComplete,
  onAgendaAction,
}: TodayScreenProps) {
  const theme = useTheme();
  const tick = useMinuteTicker();
  const agenda = useAgenda({ now: tick.instant });
  const [showAllEarlier, setShowAllEarlier] = useState(false);
  const scrollView = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const currentMinute = toWallTime(tick.instant, agenda.timezone);
  const activityActions = useAgendaActivityActions({
    today: toWallDate(tick.instant, agenda.timezone),
    currentMinute,
    getScrollOffset: () => scrollOffset.current,
    restoreScrollOffset: (offset) => {
      requestAnimationFrame(() =>
        scrollView.current?.scrollTo({ y: offset, animated: false }),
      );
    },
  });
  const effectiveToggleComplete = onToggleComplete ?? activityActions.toggleComplete;
  const effectiveAgendaAction = onAgendaAction ?? activityActions.onAgendaAction;

  if (agenda.status === 'pending') {
    return (
      <TabScreen title="Today" testID="today-screen">
        <View testID="today-loading">
          <Skeleton shape="row" count={5} />
        </View>
      </TabScreen>
    );
  }

  if (agenda.status === 'error') {
    const failure = errorDetails(agenda.error);
    return (
      <TabScreen title="Today" testID="today-screen">
        <View testID="today-error">
          <EmptyState
            heading={failure.message}
            {...(failure.requestId === undefined ? {} : { body: failure.requestId })}
            action={{ label: 'Try again', onPress: () => void agenda.refetch() }}
          />
        </View>
      </TabScreen>
    );
  }

  // The validated schema and the hand-written interface differ only in whether optional
  // keys explicitly carry `undefined`; contain that exact-optional assertion at the edge.
  const data = agenda.data as AgendaData;
  const day = data.days[0];
  const items = day === undefined ? [] : agendaItemsForDay(day);
  const sections = partitionAgenda(items, currentMinute);
  const snapshotClock = fixedClock(tick.instant);
  const localUpNext = selectUpNext(items, snapshotClock, agenda.timezone);
  const initialUpNext =
    day?.upNext === undefined
      ? undefined
      : toUpNextSelection(day.upNext, snapshotClock, agenda.timezone);
  const upNext = tick.revision === 0 ? (initialUpNext ?? localUpNext) : localUpNext;
  const anytime = cappedAnytime(sections.anytime);
  const earlier = showAllEarlier
    ? sections.earlier
    : sections.earlier.slice(0, TODAY_EARLIER_COLLAPSED_LIMIT);

  return (
    <TabScreen title="Today" testID="today-screen">
      <ScrollView
        ref={scrollView}
        testID="today-agenda"
        onScroll={({ nativeEvent }) => {
          scrollOffset.current = nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        contentContainerStyle={{ gap: theme.space[8], paddingBottom: theme.space[8] }}
      >
        {upNext === undefined ? null : (
          <UpNextCard
            selection={upNext}
            onOpen={onOpenAgendaItem}
            onToggleComplete={effectiveToggleComplete}
            onAction={effectiveAgendaAction}
          />
        )}
        {sections.schedule.length === 0 ? null : (
          <AgendaSection
            title="Schedule"
            items={sections.schedule}
            testID="today-schedule"
            showTime
            onOpen={onOpenAgendaItem}
            onToggleComplete={effectiveToggleComplete}
            onAction={effectiveAgendaAction}
          />
        )}
        {anytime.items.length === 0 ? null : (
          <AgendaSection
            title="Anytime"
            items={anytime.items}
            testID="today-anytime"
            onOpen={onOpenAgendaItem}
            onToggleComplete={effectiveToggleComplete}
            onAction={effectiveAgendaAction}
            footer={
              anytime.savedCount > TODAY_ANYTIME_SAVED_LIMIT ? (
                <Button
                  label={`See all (${anytime.savedCount})`}
                  variant="ghost"
                  fullWidth
                  onPress={onOpenAnytime}
                  testID="today-anytime-see-all"
                />
              ) : null
            }
          />
        )}
        {earlier.length === 0 ? null : (
          <AgendaSection
            title="Earlier today"
            items={earlier}
            testID="today-earlier"
            showTime
            onOpen={onOpenAgendaItem}
            onToggleComplete={effectiveToggleComplete}
            onAction={effectiveAgendaAction}
            footer={
              !showAllEarlier &&
              sections.earlier.length > TODAY_EARLIER_COLLAPSED_LIMIT ? (
                <Button
                  label="Show all"
                  variant="ghost"
                  fullWidth
                  onPress={() => setShowAllEarlier(true)}
                  testID="today-earlier-show-all"
                />
              ) : null
            }
          />
        )}
      </ScrollView>
    </TabScreen>
  );
}
