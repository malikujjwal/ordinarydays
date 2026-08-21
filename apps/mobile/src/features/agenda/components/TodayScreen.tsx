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
  ChevronDown,
  ChevronUp,
  EmptyState,
  formatDayCaption,
  IconButton,
  MoreHorizontal,
  ProgressBar,
  SectionHeader,
  Skeleton,
  Text,
  useMotion,
  useTheme,
} from '@od/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgendaRescheduleCoordinator } from '@/components/AgendaRescheduleCoordinator';
import { ConnectivityStatus } from '@/components/ConnectivityStatus';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';
import { PassedPlanResolutionSheet } from '@/components/PassedPlanResolutionSheet';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { TabScreen, useTabGutter } from '@/components/TabScreen';
import { useAgenda } from '@/features/agenda/hooks/useAgenda';
import { useAgendaActivityActions } from '@/features/agenda/hooks/useAgendaActivityActions';
import { useShowSkippedPreference } from '@/features/agenda/hooks/useShowSkippedPreference';
import { dayCount, dayCountLabel } from '@/features/agenda/model/dayCount';
import { agendaItemsForDay, partitionAgenda } from '@/features/agenda/model/partition';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { selectUpNext, toUpNextSelection } from '@/features/agenda/model/upNext';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import { AgendaSection, agendaItemKey } from './AgendaSection';
import { NowDivider } from './NowDivider';
import { OverdueCollapse } from './OverdueCollapse';
import { TodayOverflowMenu } from './TodayOverflowMenu';
import { TomorrowPreview } from './TomorrowPreview';
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
  const gutter = useTabGutter();
  const insets = useSafeAreaInsets();
  const motion = useMotion();
  const tick = useMinuteTicker();
  const agenda = useAgenda({
    now: tick.instant,
    incrementalLocalTargetReconciliation: true,
  });
  const { showSkipped, setShowSkipped } = useShowSkippedPreference();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showAllEarlier, setShowAllEarlier] = useState(false);
  /** `undefined` until the user touches it, so the default can follow the day's own length. */
  const [collapseEarlier, setCollapseEarlier] = useState<boolean | undefined>(undefined);
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
    ...(agenda.data === undefined ? {} : { agendaData: agenda.data as AgendaData }),
    getScrollOffset: () => scrollOffset.current,
    restoreScrollOffset: (offset) => {
      requestAnimationFrame(() =>
        scrollView.current?.scrollTo({ y: offset, animated: false }),
      );
    },
  });
  const effectiveToggleComplete = onToggleComplete ?? activityActions.toggleComplete;
  const effectiveResolvePassed = onResolvePassed ?? activityActions.resolvePassed;
  const overflowTrigger = (
    <IconButton
      icon={MoreHorizontal}
      label="More"
      onPress={() => setOverflowOpen(true)}
      testID="today-overflow-trigger"
    />
  );
  /**
   * The day's count on the title's trailing edge (§7.1). It is **not** a second progress
   * figure — it is the bar's own value in words, which is what the scope guard's "no second
   * progress figure" means: one number, rendered twice in one block, never two numbers.
   */
  const headerActionWith = (count: string | undefined) =>
    count === undefined ? (
      overflowTrigger
    ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
        <Text variant="footnoteStrong" color="textSecondary" testID="today-day-count">
          {count}
        </Text>
        {overflowTrigger}
      </View>
    );
  const headerAction = headerActionWith(undefined);
  const connectivityStatus = <ConnectivityStatus />;
  /** The date is known before the response is; the loading and error days are dated too. */
  const dayCaption = formatDayCaption(today);
  const overflowMenu = (
    <TodayOverflowMenu
      open={overflowOpen}
      showSkipped={showSkipped}
      onShowSkippedChange={setShowSkipped}
      onClose={() => setOverflowOpen(false)}
    />
  );

  if (agenda.status === 'pending') {
    return (
      <>
        <TabScreen
          title="Today"
          testID="today-screen"
          caption={dayCaption}
          titleAccessory={connectivityStatus}
          headerAction={headerAction}
        >
          <View testID="today-loading">
            <Skeleton shape="row" count={5} />
          </View>
        </TabScreen>
        {overflowMenu}
      </>
    );
  }

  if (agenda.status === 'error') {
    const failure = errorDetails(agenda.error);
    return (
      <>
        <TabScreen
          title="Today"
          testID="today-screen"
          caption={dayCaption}
          titleAccessory={connectivityStatus}
          headerAction={headerAction}
        >
          <View testID="today-error">
            <EmptyState
              heading={failure.message}
              {...(failure.requestId === undefined ? {} : { body: failure.requestId })}
              action={{ label: 'Try again', onPress: () => void agenda.refetch() }}
            />
          </View>
        </TabScreen>
        {overflowMenu}
      </>
    );
  }

  // The validated schema and the hand-written interface differ only in whether optional
  // keys explicitly carry `undefined`; contain that exact-optional assertion at the edge.
  const data = agenda.data as AgendaData;
  const day = data.days[0];
  const items = day === undefined ? [] : agendaItemsForDay(day);
  const sections = partitionAgenda(items, currentMinute, showSkipped);
  /**
   * **The four sections still partition `days[0]` alone** (P2-45's scope guard). The preview
   * reads `days[1]` and nothing else, so widening the window cannot change what Today contains.
   *
   * Both of tomorrow's buckets are dated to tomorrow — `schedule` holds its timed rows and
   * `anytime` its dated-but-untimed ones. An **undated** task cannot appear in either: the
   * server pins those to `input.from`, which is today, so they stay in Today's ANYTIME and
   * render exactly once.
   */
  const tomorrow = data.days[1];
  const tomorrowItems =
    tomorrow === undefined ? [] : [...tomorrow.schedule, ...tomorrow.anytime];
  const activeCompletionTransitions = completionTransitions.filter((transition) => {
    const sourceItems =
      transition.source === 'schedule' ? sections.schedule : sections.anytime;
    return !sourceItems.some((item) => agendaItemKey(item) === transition.key);
  });
  const completionTransitionKeys = new Set(
    activeCompletionTransitions.map(({ key }) => key),
  );
  /**
   * **Only an untimed row still travels** — founder decision, 2026-08-17.
   *
   * P2-24's hold-and-fade exists to cover a row *relocating* to EARLIER TODAY. A timed row no
   * longer relocates on completion: it keeps its slot, struck and dimmed, until the clock
   * reaches it. Running the transition there would fade a row out and back into the same
   * position for no reason. An ANYTIME row has no slot to keep, so it moves — and the
   * acknowledgement is exactly as `today-and-tasks.md` §2.4's 2026-08-11 amendment describes.
   */
  const beginCompletionTransition = (item: AgendaItem, commit: () => void): void => {
    const key = agendaItemKey(item);
    const anytimeIndex = sections.anytime.findIndex(
      (candidate) => agendaItemKey(candidate) === key,
    );
    const scheduleIndex = -1;

    if (anytimeIndex >= 0) {
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
  /**
   * **Collapsed by default, at any length** — founder, 2026-08-17.
   *
   * It began as "collapsed above four rows", on the reasoning that hiding two rows saves
   * nothing. The founder's ruling is simpler and better: EARLIER TODAY now sits between the user
   * and the part of the day they can still act on, and what is behind you is reference rather
   * than something to work from. It opens on a tap and its header always states the count, so
   * nothing is hidden — only folded.
   */
  const earlierCollapsed = collapseEarlier ?? true;
  const earlierVisible = earlierCollapsed ? [] : earlier;
  const earlierDoneCount = projectedEarlier.filter(
    (item) => item.status === 'completed' || item.status === 'completed_occurrence',
  ).length;
  const visibleItems = [...sections.schedule, ...sections.anytime, ...projectedEarlier];
  const isFullyEmpty = visibleItems.length === 0;
  /**
   * `2 of 6 done` over the day as rendered. UP NEXT is excluded by construction: it duplicates a
   * SCHEDULE row (`today-and-tasks.md` §2.1) and `visibleItems` holds that row once.
   */
  const count = dayCount(visibleItems);
  const countLabel = dayCountLabel(count);
  const hasOnlyUndatedTasks =
    schedule.length === 0 &&
    projectedEarlier.length === 0 &&
    sections.anytime.length > 0 &&
    sections.anytime.every((item) => item.status === 'saved');
  const showEmptySchedule =
    schedule.length === 0 && sections.anytime.length > 0 && projectedEarlier.length > 0;
  const isAllCompleted =
    activeCompletionTransitions.length === 0 &&
    visibleItems.length > 0 &&
    visibleItems.every(
      (item) => item.status === 'completed' || item.status === 'completed_occurrence',
    );
  /**
   * **Aligned with the task column, not centred** — founder, 2026-08-17: centred under the list
   * it "feels slightly detached", reading as a page action rather than as "add another item to
   * this group". The indent is the rail plus the leading control, which is where every title in
   * the section starts.
   */
  const anytimeFooter = (
    <View
      testID="today-anytime-actions"
      style={{
        gap: theme.space[2],
        paddingLeft: theme.space[11] + theme.space[2] + theme.layout.hitTarget,
        alignItems: 'flex-start',
      }}
    >
      {anytime.savedCount > TODAY_ANYTIME_SAVED_LIMIT ? (
        <Button
          label={`See all (${anytime.savedCount})`}
          variant="ghost"
          flush
          onPress={onOpenAnytime}
          testID="today-anytime-see-all"
        />
      ) : null}
      <Button
        label="+ Add a task"
        variant="ghost"
        flush
        onPress={() => onAddTask(today)}
        testID="today-add-task"
      />
    </View>
  );

  if (isFullyEmpty) {
    return (
      <>
        <TabScreen
          title="Today"
          testID="today-screen"
          caption={dayCaption}
          titleAccessory={connectivityStatus}
          headerAction={headerAction}
        >
          <EmptyState
            heading="Nothing planned today"
            body="Add something you want to do, or check your Lists."
            action={{ label: 'Add', onPress: onAdd }}
            testID="today-empty"
          />
        </TabScreen>
        {overflowMenu}
      </>
    );
  }

  return (
    <TabScreen
      title="Today"
      testID="today-screen"
      caption={dayCaption}
      titleAccessory={connectivityStatus}
      bleedBody
      headerAction={headerActionWith(countLabel)}
      belowHeader={
        /**
         * **Empty at `0 of n`, never hidden** (§7.1) — a bar that disappeared at zero would make
         * "nothing done yet" look like "nothing to do". It carries the same figure the header
         * states, as its accessible name, so the bar is never announced bare.
         */
        <ProgressBar value={count.fraction} label={countLabel} testID="today-progress" />
      }
    >
      <ScrollView
        ref={scrollView}
        testID="today-agenda"
        onScroll={({ nativeEvent }) => {
          scrollOffset.current = nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        contentContainerStyle={{
          /**
           * **One gap between every block on the screen** (founder, 2026-08-17: "make sure the
           * gaps between all different components is equal").
           *
           * It was `space[8]` (32), and the NOW divider added 12 of its own padding on each
           * side, so the earlier → now → schedule joins measured 44 while every other join
           * measured 32. `space[7]` is the section step, the divider contributes none of its
           * own, and the screen now steps at one interval from the header to the last row.
           */
          gap: theme.space[7],
          // The gutter lives here, not on the body, so the scrollbar rides outside the content.
          paddingHorizontal: gutter,
          // The final row scrolls above the global Add button without shrinking the viewport.
          // Clear of the floating Add control *and* the tab bar painted over the scroll.
          paddingBottom: bottomChromeScrollPadding(insets.bottom),
        }}
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
        {/**
         * **EARLIER TODAY renders first** — founder decision, 2026-08-17, which also settled the
         * NOW divider's position. It rendered last under `today-and-tasks.md` §2's original
         * order, and §7.1's divider "between EARLIER TODAY and what remains" then had nowhere to
         * go. Moving the section above SCHEDULE makes the screen one timeline read downward —
         * the morning, the present, then what is still coming — and §2 and §2.4 are amended to
         * it in this pull request.
         */}
        {earlier.length === 0 ? null : (
          <AgendaSection
            title="Earlier today"
            items={earlierVisible}
            testID="today-earlier"
            showTime
            headerAction={
              <Button
                label={`${earlierDoneCount} done`}
                accessibilityLabel={
                  earlierCollapsed
                    ? `Show ${projectedEarlier.length} earlier items`
                    : 'Hide earlier items'
                }
                variant="ghost"
                size="sm"
                flush
                icon={earlierCollapsed ? ChevronDown : ChevronUp}
                iconPosition="trailing"
                onPress={() => setCollapseEarlier(!earlierCollapsed)}
                testID="today-earlier-toggle"
              />
            }
            onOpen={onOpenAgendaItem}
            onOpenReschedule={setRescheduleItem}
            onToggleComplete={handleToggleComplete}
            onAction={effectiveAgendaAction}
            onOpenResolution={setResolutionItem}
            footer={
              !earlierCollapsed &&
              !showAllEarlier &&
              projectedEarlier.length > TODAY_EARLIER_COLLAPSED_LIMIT ? (
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
        {earlier.length === 0 || schedule.length === 0 ? null : (
          <NowDivider currentMinute={currentMinute} />
        )}
        {schedule.length === 0 && showEmptySchedule ? (
          <View testID="today-schedule" style={{ gap: theme.space[2] }}>
            <SectionHeader title="Schedule" variant="sectionLabel" />
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
            headerVariant="sectionLabel"
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
            headerVariant="sectionLabel"
            /**
             * **Everything the section holds**, not what is currently on screen — a count that
             * moved when the overdue collapse opened would be reporting the viewport rather than
             * the day. `anytime.items` is the capped set the section owns; the `See all (n)`
             * footer already states the figure beyond the cap.
             */
            headerCount={anytime.items.length}
            showTime
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
        <TomorrowPreview items={tomorrowItems} />
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
      {overflowMenu}
    </TabScreen>
  );
}
