import { ApiError } from '@od/shared/client';
import {
  TODAY_ANYTIME_SAVED_LIMIT,
  TODAY_EARLIER_COLLAPSED_LIMIT,
  TODAY_OVERDUE_COLLAPSE_THRESHOLD,
  TODAY_OVERDUE_COLLAPSED_LIMIT,
} from '@od/shared/constants';
import { fixedClock, toWallDate, toWallTime, type WallDate } from '@od/shared/time';
import type { ActivityOutcome, AgendaData, AgendaItem } from '@od/shared/types';
import {
  Button,
  EmptyState,
  SectionHeader,
  Skeleton,
  Text,
  useMotion,
  useTheme,
} from '@od/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { AgendaRescheduleCoordinator } from '@/components/AgendaRescheduleCoordinator';
import { PassedPlanResolutionSheet } from '@/components/PassedPlanResolutionSheet';
import { TabScreen } from '@/components/TabScreen';
import { useAgenda } from '@/features/agenda/hooks/useAgenda';
import { useAgendaActivityActions } from '@/features/agenda/hooks/useAgendaActivityActions';
import { useMinuteTicker } from '@/features/agenda/hooks/useMinuteTicker';
import { agendaItemsForDay, partitionAgenda } from '@/features/agenda/model/partition';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { selectUpNext, toUpNextSelection } from '@/features/agenda/model/upNext';
import { AgendaSection, agendaItemKey } from './AgendaSection';
import { OverdueCollapse } from './OverdueCollapse';
import { SnoozeSheet } from './SnoozeSheet';
import { UpNextCard } from './UpNextCard';

export interface TodayScreenProps {
  onAdd: () => void;
  onAddTask: (date: WallDate) => void;
  onOpenAnytime: () => void;
  onOpenAgendaItem: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAgendaAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
  onResolvePassed?: (item: AgendaItem, outcome: ActivityOutcome) => void;
}

type CompletionSource = 'schedule' | 'anytime';

interface CompletionTransitionState {
  key: string;
  item: AgendaItem;
  source: CompletionSource;
  sourceIndex: number;
}

function completedItem(item: AgendaItem): AgendaItem {
  return {
    ...item,
    status: item.isRecurring ? 'completed_occurrence' : 'completed',
  };
}

function withCompletionTransitions(
  items: readonly AgendaItem[],
  transitions: readonly CompletionTransitionState[],
  source: CompletionSource,
): AgendaItem[] {
  const result = [...items];
  const matching = transitions
    .filter((transition) => transition.source === source)
    .sort((left, right) => left.sourceIndex - right.sourceIndex);

  for (const transition of matching) {
    const existing = result.findIndex(
      (candidate) => agendaItemKey(candidate) === transition.key,
    );
    if (existing >= 0) result[existing] = transition.item;
    else
      result.splice(Math.min(transition.sourceIndex, result.length), 0, transition.item);
  }
  return result;
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
  onAdd,
  onAddTask,
  onOpenAnytime,
  onOpenAgendaItem,
  onToggleComplete,
  onAgendaAction,
  onResolvePassed,
}: TodayScreenProps) {
  const theme = useTheme();
  const motion = useMotion();
  const tick = useMinuteTicker();
  const agenda = useAgenda({ now: tick.instant });
  const [showAllEarlier, setShowAllEarlier] = useState(false);
  const [showAllOverdue, setShowAllOverdue] = useState(false);
  const [snoozeItem, setSnoozeItem] = useState<AgendaItem>();
  const [rescheduleItem, setRescheduleItem] = useState<AgendaItem>();
  const [resolutionItem, setResolutionItem] = useState<AgendaItem>();
  const [completionTransitions, setCompletionTransitions] = useState<
    CompletionTransitionState[]
  >([]);
  const completionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const finishCompletionTransition = useCallback((transitionKey: string) => {
    const timer = completionTimers.current.get(transitionKey);
    if (timer !== undefined) clearTimeout(timer);
    completionTimers.current.delete(transitionKey);
    setCompletionTransitions((current) =>
      current.filter(({ key }) => key !== transitionKey),
    );
  }, []);
  useEffect(
    () => () => {
      for (const timer of completionTimers.current.values()) clearTimeout(timer);
      completionTimers.current.clear();
    },
    [],
  );
  const scrollView = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const currentMinute = toWallTime(tick.instant, agenda.timezone);
  const today = toWallDate(tick.instant, agenda.timezone);
  const activityActions = useAgendaActivityActions({
    today,
    currentMinute,
    timezone: agenda.timezone,
    getScrollOffset: () => scrollOffset.current,
    restoreScrollOffset: (offset) => {
      requestAnimationFrame(() =>
        scrollView.current?.scrollTo({ y: offset, animated: false }),
      );
    },
  });
  const effectiveToggleComplete = onToggleComplete ?? activityActions.toggleComplete;
  const effectiveResolvePassed = onResolvePassed ?? activityActions.resolvePassed;

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
  const activeCompletionTransitions = completionTransitions.filter((transition) => {
    const sourceItems =
      transition.source === 'schedule' ? sections.schedule : sections.anytime;
    return !sourceItems.some((item) => agendaItemKey(item) === transition.key);
  });
  const completionTransitionKeys = new Set(
    activeCompletionTransitions.map(({ key }) => key),
  );
  const beginCompletionTransition = (item: AgendaItem, commit: () => void): void => {
    const key = agendaItemKey(item);
    const scheduleIndex = sections.schedule.findIndex(
      (candidate) => agendaItemKey(candidate) === key,
    );
    const anytimeIndex = sections.anytime.findIndex(
      (candidate) => agendaItemKey(candidate) === key,
    );

    if (scheduleIndex >= 0 || anytimeIndex >= 0) {
      finishCompletionTransition(key);
      setCompletionTransitions((current) => [
        ...current.filter((transition) => transition.key !== key),
        {
          key,
          item: completedItem(item),
          source: scheduleIndex >= 0 ? 'schedule' : 'anytime',
          sourceIndex: scheduleIndex >= 0 ? scheduleIndex : anytimeIndex,
        },
      ]);
      const duration = motion.duration.fast + motion.duration.base;
      if (duration > 0) {
        completionTimers.current.set(
          key,
          setTimeout(() => finishCompletionTransition(key), duration),
        );
      }
    }
    commit();
    if (motion.duration.fast + motion.duration.base === 0) {
      finishCompletionTransition(key);
    }
  };
  const handleToggleComplete = (item: AgendaItem, checked: boolean) => {
    const key = agendaItemKey(item);
    if (!checked) {
      finishCompletionTransition(key);
      effectiveToggleComplete(item, false);
      return;
    }
    beginCompletionTransition(item, () => effectiveToggleComplete(item, true));
  };
  const effectiveAgendaAction = (item: AgendaItem, action: AgendaSwipeAction) => {
    const delegate = () => {
      if (onAgendaAction !== undefined) onAgendaAction(item, action);
      else activityActions.onAgendaAction(item, action);
    };
    if (action.name === 'complete') {
      beginCompletionTransition(item, delegate);
      return;
    }
    if (action.name === 'undo' || action.name === 'undoSkip') {
      finishCompletionTransition(agendaItemKey(item));
      delegate();
      return;
    }
    if (onAgendaAction === undefined && action.name === 'snooze') {
      if (item.capabilities.snooze) setSnoozeItem(item);
      return;
    }
    if (
      onAgendaAction === undefined &&
      ['reschedule', 'schedule'].includes(action.name)
    ) {
      setRescheduleItem(item);
      return;
    }
    delegate();
  };
  const schedule = withCompletionTransitions(
    sections.schedule,
    activeCompletionTransitions,
    'schedule',
  );
  const anytime = cappedAnytime(
    withCompletionTransitions(sections.anytime, activeCompletionTransitions, 'anytime'),
  );
  const overdue = anytime.items.filter((item) => item.overdueFromDate !== undefined);
  const currentAnytime = anytime.items.filter(
    (item) => item.overdueFromDate === undefined,
  );
  const collapsesOverdue = overdue.length > TODAY_OVERDUE_COLLAPSE_THRESHOLD;
  const visibleOverdue =
    collapsesOverdue && !showAllOverdue
      ? overdue.slice(0, TODAY_OVERDUE_COLLAPSED_LIMIT)
      : overdue;
  const visibleAnytime = [...visibleOverdue, ...currentAnytime];
  const hiddenOverdueCount = Math.max(overdue.length - TODAY_OVERDUE_COLLAPSED_LIMIT, 0);
  const projectedEarlier = sections.earlier.filter(
    (item) => !completionTransitionKeys.has(agendaItemKey(item)),
  );
  const snapshotClock = fixedClock(tick.instant);
  const localUpNext = selectUpNext(items, snapshotClock, agenda.timezone);
  const initialUpNext =
    day?.upNext === undefined
      ? undefined
      : toUpNextSelection(day.upNext, snapshotClock, agenda.timezone);
  const upNext = tick.revision === 0 ? (initialUpNext ?? localUpNext) : localUpNext;
  const earlier = showAllEarlier
    ? projectedEarlier
    : projectedEarlier.slice(0, TODAY_EARLIER_COLLAPSED_LIMIT);
  const isFullyEmpty = items.length === 0;
  const hasOnlyUndatedTasks =
    schedule.length === 0 &&
    projectedEarlier.length === 0 &&
    sections.anytime.length > 0 &&
    sections.anytime.every((item) => item.status === 'saved');
  const showEmptySchedule =
    schedule.length === 0 && sections.anytime.length > 0 && projectedEarlier.length > 0;
  const isAllCompleted =
    activeCompletionTransitions.length === 0 &&
    items.length > 0 &&
    items.every(
      (item) => item.status === 'completed' || item.status === 'completed_occurrence',
    );
  const anytimeFooter = (
    <View testID="today-anytime-actions" style={{ gap: theme.space[2] }}>
      {anytime.savedCount > TODAY_ANYTIME_SAVED_LIMIT ? (
        <Button
          label={`See all (${anytime.savedCount})`}
          variant="ghost"
          fullWidth
          onPress={onOpenAnytime}
          testID="today-anytime-see-all"
        />
      ) : null}
      <Button
        label="+ Add a task"
        variant="ghost"
        fullWidth
        onPress={() => onAddTask(today)}
        testID="today-add-task"
      />
    </View>
  );

  if (isFullyEmpty) {
    return (
      <TabScreen title="Today" testID="today-screen">
        <EmptyState
          heading="Nothing planned today"
          body="Add something you want to do, or check your Lists."
          action={{ label: 'Add', onPress: onAdd }}
          testID="today-empty"
        />
      </TabScreen>
    );
  }

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
        {hasOnlyUndatedTasks ? (
          <Text variant="subhead" color="textSecondary" testID="today-unscheduled-note">
            Nothing scheduled today.
          </Text>
        ) : null}
        {isAllCompleted ? (
          <Text variant="subhead" color="textSecondary" testID="today-all-done-note">
            All done for today.
          </Text>
        ) : null}
        {upNext === undefined ? null : (
          <UpNextCard
            selection={upNext}
            onOpen={onOpenAgendaItem}
            onOpenReschedule={setRescheduleItem}
            onToggleComplete={handleToggleComplete}
            onAction={effectiveAgendaAction}
          />
        )}
        {schedule.length === 0 && showEmptySchedule ? (
          <View testID="today-schedule" style={{ gap: theme.space[2] }}>
            <SectionHeader title="Schedule" />
            <View
              style={{ minHeight: theme.layout.rowMinHeight, justifyContent: 'center' }}
            >
              <Text variant="body" color="textSecondary">
                Nothing left scheduled today.
              </Text>
            </View>
          </View>
        ) : schedule.length === 0 ? null : (
          <AgendaSection
            title="Schedule"
            items={schedule}
            testID="today-schedule"
            showTime
            onOpen={onOpenAgendaItem}
            onOpenReschedule={setRescheduleItem}
            onToggleComplete={handleToggleComplete}
            onAction={effectiveAgendaAction}
            completionTransitionKeys={completionTransitionKeys}
            onCompletionTransitionFinished={finishCompletionTransition}
          />
        )}
        {visibleAnytime.length === 0 ? null : (
          <AgendaSection
            title="Anytime"
            items={visibleAnytime}
            testID="today-anytime"
            onOpen={onOpenAgendaItem}
            onOpenReschedule={setRescheduleItem}
            onOpenOverdue={setRescheduleItem}
            onToggleComplete={handleToggleComplete}
            onAction={effectiveAgendaAction}
            completionTransitionKeys={completionTransitionKeys}
            onCompletionTransitionFinished={finishCompletionTransition}
            interstitialAfterIndex={visibleOverdue.length - 1}
            interstitial={
              collapsesOverdue ? (
                <OverdueCollapse
                  hiddenCount={hiddenOverdueCount}
                  expanded={showAllOverdue}
                  onToggle={() => setShowAllOverdue((expanded) => !expanded)}
                />
              ) : null
            }
            today={today}
            footer={anytimeFooter}
          />
        )}
        {visibleAnytime.length === 0 ? anytimeFooter : null}
        {earlier.length === 0 ? null : (
          <AgendaSection
            title="Earlier today"
            items={earlier}
            testID="today-earlier"
            showTime
            onOpen={onOpenAgendaItem}
            onOpenReschedule={setRescheduleItem}
            onToggleComplete={handleToggleComplete}
            onAction={effectiveAgendaAction}
            onOpenResolution={setResolutionItem}
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
      <SnoozeSheet
        open={snoozeItem !== undefined}
        item={snoozeItem}
        currentMinute={currentMinute}
        onClose={() => setSnoozeItem(undefined)}
        onSnooze={activityActions.snooze}
        onTomorrow={activityActions.moveToTomorrow}
      />
      {rescheduleItem === undefined ? null : (
        <AgendaRescheduleCoordinator
          item={rescheduleItem}
          today={today}
          onClose={() => setRescheduleItem(undefined)}
        />
      )}
      {resolutionItem === undefined ? null : (
        <PassedPlanResolutionSheet
          open
          type={resolutionItem.type}
          title={resolutionItem.title}
          onClose={() => setResolutionItem(undefined)}
          onResolve={(outcome) => {
            const item = resolutionItem;
            setResolutionItem(undefined);
            effectiveResolvePassed(item, outcome);
          }}
        />
      )}
    </TabScreen>
  );
}
