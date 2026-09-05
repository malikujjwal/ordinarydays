import { isRangeCovered } from '@od/shared/client';
import { toWallDate, toWallTime, type WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import {
  Card,
  DatePicker,
  EmptyState,
  SectionHeader,
  SegmentedControl,
  Sheet,
  Skeleton,
  Text,
  Touchable,
  useMotion,
  useTheme,
} from '@od/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  RefreshControl,
  ScrollView,
  SectionList,
  View,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgendaRescheduleCoordinator } from '@/components/AgendaRescheduleCoordinator';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';
import { TabScreen } from '@/components/TabScreen';
import type { FollowUpNavigation } from '@/hooks/useFollowUp';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import { resolveViewerTimezone } from '@/lib/viewerTimezone';
import { useAgendaActivityActions } from '../hooks/useAgendaActivityActions';
import { type NeedsDateRowData, usePlans } from '../hooks/usePlans';
import { usePlansBoundaryNavigation } from '../hooks/usePlansBoundaryNavigation';
import { calendarListLandingRecovery } from '../model/calendarListLanding';
import { calendarListWindow } from '../model/calendarListWindow';
import {
  type PastDay,
  type PastMonthSection,
  pastSectionsFromStore,
  upcomingSectionsFromStore,
} from '../model/plansStages';
import type { UpcomingListItem, UpcomingMonthSection } from '../model/plansWindow';
import { AgendaRow } from './AgendaRow';
import { CalendarNavigator } from './CalendarNavigator';
import { NeedsDateCard } from './NeedsDateCard';

/**
 * The Plans tab: three stages behind one switcher (P3-36, `plans-and-lists.md` §1.3).
 *
 * `Needs a date · Upcoming · Past`, one stage visible at a time, from one
 * `GET /v1/plans?mode=initial` — this screen replaces the Phase 2 date-range agenda view
 * (P2-32), whose Upcoming presentation it keeps: the same `AgendaRow`, the same date and
 * month grammar, now framed as **one card per day** with hairline-separated rows (the
 * founder's settled tile treatment — the card edge means the day, the unit the heading
 * already names).
 *
 * The rules that shape everything this screen refuses to do (§1.3.2, each one a test):
 * no badge or count anywhere — not on the tab, not on the switcher, not in a heading;
 * nothing re-sorts, greys out or archives for being old; and no copy calls a stage
 * something to clear. The selected stage renders its own §1.3.3 empty line; when all three
 * are empty the switcher is replaced by the single `No plans` state.
 */
export interface PlansScreenProps {
  /** Preserve occurrence scope when a generated recurring row opens detail. */
  onOpen: (item: AgendaItem) => void;
  /** Where a completion follow-up's navigation rows go (P3-44). */
  followUp?: FollowUpNavigation;
  /** The global Add action. Plans never pre-selects an object kind. */
  onAdd: () => void;
}

type Stage = 'needsDate' | 'upcoming' | 'past';

/**
 * §1.3's fixed order. The switcher carries these three words and **nothing else** — no
 * `count` is ever passed, which the plans chrome test asserts by reading this file.
 */
const STAGES: readonly { key: Stage; label: string }[] = [
  { key: 'needsDate', label: 'Needs a date' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
];

interface SelectedGap {
  pickedDate: WallDate | null;
}

/**
 * A virtualized list cannot measure an offscreen date. When it says so, scroll to its own
 * estimate of the offset once, then retry across two layout frames. Repeatedly walking past
 * that estimate makes a distant day oscillate through the virtualized window and stalls the
 * JS thread precisely while the user is waiting for the landing.
 */
function onScrollToIndexFailed<Item, Section>(
  list: SectionList<Item, Section> | null,
  info: { index: number; averageItemLength: number },
  attempt: number,
  retry: () => void,
): void {
  const recovery = calendarListLandingRecovery(info, attempt);
  if (recovery === undefined) return;
  if (attempt === 0) {
    list?.getScrollResponder()?.scrollTo({
      y: recovery.offset,
      animated: false,
    });
  }
  setTimeout(retry, recovery.retryAfterMs);
}

/** A landing is best effort: a list that cannot measure yet simply stays where it is. */
function scrollTo<Item, Section>(
  list: SectionList<Item, Section> | null,
  sectionIndex: number,
  itemIndex: number,
  viewOffset: number,
): void {
  try {
    /**
     * RN 0.81's VirtualizedSectionList flattens the current section header at index zero
     * but does not add that header inside `scrollToLocation`. Passing the data index lands
     * on the preceding row (Sep 4 -> Sep 3); offset it once at this adapter boundary.
     */
    list?.scrollToLocation({
      sectionIndex,
      itemIndex: itemIndex + 1,
      // Calendar navigation is a positional jump, not a tour through every intervening day.
      // Native animated traversal over distant virtualized sections is both slow and janky.
      animated: false,
      viewPosition: 0,
      // The calendar no longer participates in layout. Leave the selected card below the
      // visible overlay instead of placing it at viewport zero underneath the calendar.
      viewOffset,
    });
  } catch {
    // A list that has not laid out yet cannot scroll; the next landing will succeed.
  }
}

interface SelectedAgendaItem {
  item: AgendaItem;
  date: WallDate;
}

interface CalendarLandingTarget {
  readonly sectionIndex: number;
  readonly itemIndex: number;
}

/**
 * Both dated stages use the same landing rule: an exact loaded date wins; a directional
 * neighbour is legal only after the selected date is covered and therefore known empty.
 * Past's cold ranges used to take that fallback immediately and clear the pending selection
 * before its exact row arrived.
 */
function calendarLandingTarget<Item>(
  sections: readonly { readonly data: readonly Item[] }[],
  selected: WallDate,
  direction: 'forward' | 'backward',
  dateOf: (item: Item) => WallDate | undefined,
  allowFallback: boolean,
): CalendarLandingTarget | undefined {
  for (const [sectionIndex, section] of sections.entries()) {
    const itemIndex = section.data.findIndex((item) => dateOf(item) === selected);
    if (itemIndex !== -1) return { sectionIndex, itemIndex };
  }
  if (!allowFallback) return undefined;
  for (const [sectionIndex, section] of sections.entries()) {
    const itemIndex = section.data.findIndex((item) => {
      const date = dateOf(item);
      return (
        date !== undefined &&
        (direction === 'forward' ? date >= selected : date <= selected)
      );
    });
    if (itemIndex !== -1) return { sectionIndex, itemIndex };
  }
  return undefined;
}

export function PlansScreen({ onOpen, onAdd, followUp }: PlansScreenProps) {
  const theme = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const tick = useMinuteTicker();
  const queryClient = useQueryClient();
  const timezone = resolveViewerTimezone(queryClient);
  const today = toWallDate(tick.instant, timezone);
  const currentMinute = toWallTime(tick.instant, timezone);
  const plans = usePlans(timezone, today, currentMinute);
  const actions = useAgendaActivityActions({
    today,
    currentMinute,
    timezone,
    ...(followUp === undefined ? {} : { followUp }),
  });
  /**
   * Upcoming is where the tab lands: it answers "what is next", the question the tab is
   * opened for, while the switcher keeps the other two stages one tap away (decision
   * recorded here — §1.3 names no landing stage; raise in PR if wrong).
   */
  const [stage, setStage] = useState<Stage>('upcoming');
  const [selectedGap, setSelectedGap] = useState<SelectedGap>();
  const [reschedule, setReschedule] = useState<SelectedAgendaItem>();
  const [compactHeader, setCompactHeader] = useState(false);
  const [calendarHeight, setCalendarHeight] = useState(0);
  const [fullHeaderHeight, setFullHeaderHeight] = useState(0);
  const [titleBlockHeight, setTitleBlockHeight] = useState(0);
  // Measurements belong to a presentation: expanded chrome cannot size a compact jump.
  const [chromeLayout, setChromeLayout] = useState({ compact: false, height: 0 });
  const chromeHeight = chromeLayout.height;
  const headerReady = !compactHeader || chromeLayout.compact;
  const [viewportHeight, setViewportHeight] = useState(0);
  const [lastDayLayout, setLastDayLayout] = useState({ key: '', height: 0 });
  const compactHeaderRef = useRef(false);
  const headerProgress = useRef(new Animated.Value(0)).current;
  /**
   * The calendar's day tap (P3-48): land the list on that date, within the stage. Held as
   * state so the landing can wait for the sections that a just-fetched window produces; a
   * date with no card lands on the nearest card in the stage's own direction.
   */
  const [landing, setLanding] = useState<WallDate>();
  const upcomingList = useRef<SectionList<UpcomingListItem, UpcomingMonthSection>>(null);
  const pastList = useRef<SectionList<PastDay, PastMonthSection>>(null);
  /** The last landing, retried while the list's own offset estimate walks the target in. */
  const pendingScroll = useRef<() => void>(() => {});
  const landingAttempts = useRef(0);
  const landingDeadline = useRef(0);
  const scrollOffset = useRef(0);
  const userScrolling = useRef(false);
  const nearWindowStart = useRef(false);
  const [calendarWindow, setCalendarWindow] = useState<{
    stage: Stage;
    date: WallDate;
    precedingRows: number;
    selection: number;
  }>();
  const currentHeaderReady = useRef(true);
  const retryLanding = useCallback(() => {
    if (currentHeaderReady.current && performance.now() < landingDeadline.current)
      pendingScroll.current();
  }, []);

  const resetHeaderVisibility = useCallback(() => {
    compactHeaderRef.current = false;
    setCompactHeader(false);
  }, []);

  useEffect(() => {
    const transition = Animated.timing(headerProgress, {
      toValue: compactHeader ? 1 : 0,
      duration: motion.duration.base,
      useNativeDriver: true,
    });
    transition.start();
    return () => transition.stop();
  }, [compactHeader, headerProgress, motion.duration.base]);

  const allUpcomingSections = useMemo(
    () =>
      plans.upcomingWindow === undefined
        ? []
        : upcomingSectionsFromStore(
            plans.store,
            /**
             * Clamped to the caller's ticking `today`, not the window the server answered
             * with: `from` is frozen at fetch time, so a tab left mounted across midnight
             * would otherwise keep yesterday in Upcoming while Past (which filters on
             * `today`) claimed the same day.
             */
            plans.upcomingWindow.from >= today ? plans.upcomingWindow.from : today,
            plans.upcomingWindow.through,
          ),
    [plans.store, plans.upcomingWindow, today],
  );
  const boundary = usePlansBoundaryNavigation(plans.loadRange);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;
  const onUpcomingViewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<UpcomingListItem>[] }) => {
      const item = viewableItems.find((entry) => entry.item.kind === 'unloaded')?.item;
      boundary.visible(item?.kind === 'unloaded' ? item : undefined);
    },
    [boundary.visible],
  );
  const hasUnknownBoundary = allUpcomingSections.some((section) =>
    section.data.some((item) => item.kind === 'unloaded'),
  );
  /** Projected only while its stage shows — Past can hold months of paged history. */
  const allPastSections = useMemo(
    () => (stage === 'past' ? pastSectionsFromStore(plans.store, today) : undefined),
    [stage, plans.store, today],
  );
  const upcomingView = useMemo(() => {
    const whole = { sections: allUpcomingSections, key: 'upcoming' };
    if (Platform.OS === 'web' || calendarWindow?.stage !== 'upcoming') return whole;
    const target = calendarLandingTarget(
      allUpcomingSections,
      calendarWindow.date,
      'forward',
      (item) => (item.kind === 'date' ? (item.date as WallDate) : undefined),
      isRangeCovered(plans.store, calendarWindow.date, calendarWindow.date),
    );
    return target === undefined
      ? whole
      : {
          sections: calendarListWindow(
            allUpcomingSections,
            target,
            calendarWindow.precedingRows,
          ),
          key: `upcoming:${calendarWindow.date}:${calendarWindow.selection}`,
        };
  }, [allUpcomingSections, calendarWindow, plans.store]);
  const pastView = useMemo(() => {
    const whole = { sections: allPastSections, key: 'past' };
    if (Platform.OS === 'web' || calendarWindow?.stage !== 'past' || !allPastSections)
      return whole;
    const target = calendarLandingTarget(
      allPastSections,
      calendarWindow.date,
      'backward',
      (day) => day.date,
      isRangeCovered(plans.store, calendarWindow.date, calendarWindow.date),
    );
    return target === undefined
      ? whole
      : {
          sections: calendarListWindow(
            allPastSections,
            target,
            calendarWindow.precedingRows,
          ),
          key: `past:${calendarWindow.date}:${calendarWindow.selection}`,
        };
  }, [allPastSections, calendarWindow, plans.store]);
  const upcomingSections = upcomingView.sections;
  const pastSections = pastView.sections;
  const stageHasRows =
    stage === 'upcoming'
      ? allUpcomingSections.length > 0
      : stage === 'past'
        ? (allPastSections?.length ?? 0) > 0
        : false;
  useEffect(() => {
    if (!stageHasRows) setCalendarWindow(undefined);
  }, [stageHasRows]);
  /** Whether the store holds any row at all — a loop with an early exit, no allocation. */
  const hasAnyRows = useMemo(() => {
    for (const rows of plans.store.byDate.values()) {
      if (rows.length > 0) return true;
    }
    return false;
  }, [plans.store]);
  /** A stable section identity — the screen re-renders every ticker minute. */
  const needsDateSections = useMemo(
    () => [{ data: [...plans.needsDate] }],
    [plans.needsDate],
  );
  /** Stable so the memoised card is not defeated by a new renderItem identity (§8.3). */
  const renderNeedsDateItem = useCallback(
    ({ item }: { item: NeedsDateRowData }) => (
      <NeedsDateCard
        item={item}
        onOpen={onOpen}
        testID={`plans-needs-date-${item.activityId}`}
      />
    ),
    [onOpen],
  );

  const upcomingEmpty =
    upcomingSections.length === 0 && plans.upcomingWindow?.nextFrom == null;
  // `hasAnyRows`, not a stage-scoped check: a row projected anywhere — a create landing on
  // a date no stage happens to render right now — still means the account is not empty.
  const allEmpty =
    plans.status === 'success' &&
    plans.needsDate.length === 0 &&
    upcomingEmpty &&
    !hasAnyRows &&
    plans.pastCursor === undefined;

  /**
   * The far-future sentinel: a loaded window with nothing visible and a non-null `nextFrom`
   * is the server saying "the next row is out there". With no rows there is no scroll to
   * reach the end with, so the screen advances one window itself — `nextFrom` jumps the
   * empty gap, so one hop lands the row (§P3-20's contract, tested against a six-month gap).
   */
  const shouldAdvance =
    stage === 'upcoming' &&
    plans.status === 'success' &&
    upcomingSections.length === 0 &&
    plans.upcomingWindow?.nextFrom != null &&
    !plans.isLoadingMoreUpcoming &&
    // A failed **window** request must not re-arm the advance, or a 500ing API turns this
    // effect into an unbounded retry loop; the failure banner's refresh is the retry. The
    // flag is upcoming-specific so a Past-page failure cannot suppress the advance.
    !plans.upcomingStalled;
  const { loadMoreUpcoming } = plans;
  useEffect(() => {
    if (shouldAdvance) loadMoreUpcoming();
  }, [shouldAdvance, loadMoreUpcoming]);

  const stableHeaderInset = fullHeaderHeight || calendarHeight;
  const compactCalendarExtension = compactHeader
    ? Math.max(calendarHeight - theme.layout.hitTarget, 0)
    : 0;
  const visibleHeaderOffset = compactHeader
    ? insets.top + theme.space[2] + chromeHeight + compactCalendarExtension
    : stableHeaderInset;
  const restoreCalendarPrefix = useCallback(() => {
    setCalendarWindow((window) =>
      window === undefined
        ? window
        : { ...window, precedingRows: window.precedingRows + 10 },
    );
  }, []);
  const handlePlansScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffset.current = y;
      const near = y <= viewportHeight + visibleHeaderOffset;
      if (userScrolling.current && near && !nearWindowStart.current)
        restoreCalendarPrefix();
      nearWindowStart.current = near;
      if (y <= theme.space[2]) {
        // A native layout adjustment during the jump is not a user return to the top.
        // Reopening here changes the measured inset and feeds back into the same landing.
        if (performance.now() < landingDeadline.current) return;
        resetHeaderVisibility();
        return;
      }
      if (compactHeaderRef.current) return;
      compactHeaderRef.current = true;
      setCompactHeader(true);
    },
    [
      resetHeaderVisibility,
      theme.space,
      viewportHeight,
      visibleHeaderOffset,
      restoreCalendarPrefix,
    ],
  );

  const currentHeaderOffset = useRef(visibleHeaderOffset);
  useEffect(() => {
    currentHeaderReady.current = headerReady;
    if (!headerReady) return;
    currentHeaderOffset.current = visibleHeaderOffset;
    // Native scrolling compacts/re-measures the overlay after the first jump. Do not
    // keep the expanded header's captured offset during the contract's recovery window.
    retryLanding();
  }, [visibleHeaderOffset, headerReady, retryLanding]);

  useEffect(() => {
    if (landing === undefined || !headerReady) return;
    // One landing for both stages: a fresh retry budget, the scroll, and the state cleared.
    const land = (scroll: () => void) => {
      pendingScroll.current = scroll;
      landingAttempts.current = 0;
      landingDeadline.current = performance.now() + 256;
      scroll();
      setLanding(undefined);
    };
    if (stage === 'upcoming') {
      const target = calendarLandingTarget(
        upcomingSections,
        landing,
        'forward',
        (item) => (item.kind === 'date' ? (item.date as WallDate) : undefined),
        isRangeCovered(plans.store, landing, landing),
      );
      if (target !== undefined) {
        land(() =>
          scrollTo(
            upcomingList.current,
            target.sectionIndex,
            target.itemIndex,
            currentHeaderOffset.current,
          ),
        );
      }
    } else if (stage === 'past' && pastSections !== undefined) {
      const target = calendarLandingTarget(
        pastSections,
        landing,
        'backward',
        (day) => day.date,
        isRangeCovered(plans.store, landing, landing),
      );
      if (target !== undefined) {
        land(() =>
          scrollTo(
            pastList.current,
            target.sectionIndex,
            target.itemIndex,
            currentHeaderOffset.current,
          ),
        );
      }
    }
  }, [landing, stage, upcomingSections, pastSections, plans.store, headerReady]);

  /**
   * The tap projects **synchronously and on both platforms** — native has no MutationCache
   * for `usePlans`' subscription to observe, so the direct call is the channel that works
   * everywhere; on web the `pending` event then patches the same value (a no-op) and the
   * lifecycle handles rollback and Undo. The action layer itself reports acceptance, so
   * every refusal it knows about — including native's commit gate — projects nothing.
   *
   * Known native limitation (recorded, device-matrix gate): a write the server later
   * refuses, or an Undo from the toast, settles through the SQLite coordinator without a
   * MutationCache event, so this store reconciles on the next refetch rather than reverting
   * live. Web reverts through the mutation lifecycle.
   */
  const toggleComplete = (item: AgendaItem, checked: boolean) => {
    if (actions.toggleComplete(item, checked)) {
      plans.projectCompletion(item, checked);
    }
  };

  const refresh = (
    <RefreshControl refreshing={plans.isRefreshing} onRefresh={plans.refetch} />
  );
  /**
   * Pull-to-refresh must reach every stage, empty ones included — "pull-to-refresh
   * refetches all three stages in the one request" (§P3-36) is unreachable from a bare
   * `View`, so an empty stage renders inside its own refreshable scroll.
   */
  const refreshableEmpty = (testID: string, child: React.ReactNode) => (
    <ScrollView
      refreshControl={refresh}
      onScroll={handlePlansScroll}
      scrollEventThrottle={16}
      contentContainerStyle={{
        flexGrow: 1,
        ...(stableHeaderInset === 0 ? {} : { paddingTop: stableHeaderInset }),
      }}
      testID={testID}
    >
      {child}
    </ScrollView>
  );
  const listPadding = {
    gap: theme.space[5],
    ...(stableHeaderInset === 0 ? {} : { paddingTop: stableHeaderInset }),
    // The final row scrolls above the global Add button without shrinking the viewport.
    paddingBottom: bottomChromeScrollPadding(insets.bottom),
  };
  const beginCalendarScroll = () => {
    landingDeadline.current = 0;
    userScrolling.current = true;
    // Prepend once on entry, then once per return to the start during an active gesture.
    const near = scrollOffset.current <= viewportHeight + visibleHeaderOffset;
    nearWindowStart.current = near;
    if (near) restoreCalendarPrefix();
  };
  const calendarScrollLifecycle = {
    onScrollEndDrag: () => {
      userScrolling.current = false;
    },
    onMomentumScrollBegin: () => {
      userScrolling.current = true;
    },
    onMomentumScrollEnd: () => {
      userScrolling.current = false;
    },
  };

  const lastUpcomingItem = upcomingSections.at(-1)?.data.at(-1);
  const lastDate =
    stage === 'past'
      ? pastSections?.at(-1)?.data.at(-1)?.date
      : lastUpcomingItem?.kind === 'date'
        ? lastUpcomingItem.date
        : undefined;
  const lastDayKey = `${stage}:${lastDate}`;
  // A short final day still needs enough scroll range to land below the overlay (§1.3.4).
  // Reserve only the missing viewport space, without loading more dates to manufacture it.
  const datedListPadding = {
    ...listPadding,
    paddingBottom: Math.max(
      listPadding.paddingBottom,
      viewportHeight -
        visibleHeaderOffset -
        (lastDayLayout.key === lastDayKey ? lastDayLayout.height : 0),
    ),
  };

  const dayCard = (date: string, label: string, items: AgendaItem[]) => (
    <View
      testID={`plans-date-${date}`}
      style={{ gap: theme.space[3] }}
      onLayout={
        date === lastDate
          ? (event) => {
              const height = event.nativeEvent.layout.height;
              setLastDayLayout((previous) =>
                previous.key === lastDayKey && previous.height === height
                  ? previous
                  : { key: lastDayKey, height },
              );
            }
          : undefined
      }
    >
      <SectionHeader title={label} />
      <Card padding={5} testID={`plans-day-${date}`}>
        {items.map((agendaItem, index) => (
          <AgendaRow
            key={`${agendaItem.activityId}:${agendaItem.occurrenceDate ?? ''}`}
            item={agendaItem}
            today={today}
            showTime
            divider={index < items.length - 1}
            untimedContextLabel={label}
            onOpen={onOpen}
            onToggleComplete={toggleComplete}
            onOpenReschedule={(row) =>
              setReschedule({ item: row, date: date as WallDate })
            }
          />
        ))}
      </Card>
    </View>
  );

  const renderUpcomingItem = ({ item }: { item: UpcomingListItem }) => {
    if (item.kind === 'unloaded') {
      return (
        <Touchable
          testID={`plans-unloaded-${item.from}`}
          accessibilityRole="button"
          accessibilityLabel={
            boundary.failed === item.from
              ? 'Try loading these dates again'
              : 'Load more dates'
          }
          onPress={() => boundary.load(item)}
          disabled={boundary.pending === item.from}
          style={{ padding: theme.space[3] }}
        >
          {boundary.pending === item.from ? (
            <ActivityIndicator accessibilityLabel="Loading dates" />
          ) : (
            <Text variant="footnote" color="textSecondary">
              {boundary.failed === item.from
                ? "Couldn't load these dates. Try again."
                : 'Load more dates'}
            </Text>
          )}
        </Touchable>
      );
    }
    if (item.kind === 'gap') {
      return (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => setSelectedGap({ pickedDate: item.from as WallDate })}
          testID={`plans-gap-${item.from}`}
          style={{
            alignItems: 'flex-start',
            paddingHorizontal: theme.space[3],
            width: '100%',
          }}
        >
          <Text variant="footnote" color="textSecondary">
            {item.label}
          </Text>
        </Touchable>
      );
    }
    return dayCard(item.date, item.label, item.items);
  };

  const stageBody = () => {
    if (stage === 'needsDate') {
      if (plans.needsDate.length === 0) {
        return refreshableEmpty(
          'plans-needs-date-empty',
          <EmptyState
            heading="Nothing without a date"
            body="Plans you've started but not scheduled show up here."
          />,
        );
      }
      return (
        <SectionList<NeedsDateRowData>
          testID="plans-needs-date-list"
          sections={needsDateSections}
          keyExtractor={(item) => item.activityId}
          refreshControl={refresh}
          onScroll={handlePlansScroll}
          scrollEventThrottle={16}
          renderItem={renderNeedsDateItem}
          contentContainerStyle={listPadding}
        />
      );
    }

    if (stage === 'upcoming') {
      if (upcomingSections.length === 0) {
        /**
         * A zero-row window with a non-null `nextFrom` is the server saying "the next row
         * is out there" (§P3-20): the screen shows a refreshable loading state — never a
         * false `No upcoming plans`. It drops through to the empty state only when the
         * stalled advance's failure banner is on screen to explain it; a stalled advance
         * whose banner a later success cleared keeps the refreshable skeleton instead,
         * so the false empty is unreachable in every combination.
         */
        if (
          plans.upcomingWindow?.nextFrom != null &&
          !(plans.upcomingStalled && plans.message !== undefined)
        ) {
          return refreshableEmpty(
            'plans-upcoming-advancing',
            <Skeleton shape="card" count={2} />,
          );
        }
        return refreshableEmpty(
          'plans-upcoming-empty',
          <EmptyState
            heading="No upcoming plans"
            body="Anything with a date shows up here."
            action={{ label: 'Add', onPress: onAdd }}
          />,
        );
      }
      return (
        <SectionList<UpcomingListItem, UpcomingMonthSection>
          key={upcomingView.key}
          {...calendarScrollLifecycle}
          {...(calendarWindow?.stage === 'upcoming' && Platform.OS !== 'web'
            ? { maintainVisibleContentPosition: { minIndexForVisible: 0 } }
            : {})}
          ref={upcomingList}
          onScrollToIndexFailed={(info) => {
            if (
              !currentHeaderReady.current ||
              performance.now() >= landingDeadline.current
            )
              return;
            onScrollToIndexFailed(
              upcomingList.current,
              info,
              landingAttempts.current++,
              retryLanding,
            );
          }}
          testID="plans-list"
          sections={upcomingSections}
          keyExtractor={(item) =>
            item.kind === 'date' ? `date:${item.date}` : `gap:${item.from}:${item.to}`
          }
          stickySectionHeadersEnabled
          onScroll={handlePlansScroll}
          scrollEventThrottle={16}
          refreshControl={refresh}
          onScrollBeginDrag={() => {
            beginCalendarScroll();
            boundary.beginScroll();
          }}
          onContentSizeChange={retryLanding}
          onViewableItemsChanged={onUpcomingViewable}
          viewabilityConfig={viewabilityConfig}
          onEndReached={() => {
            // An unrelated unloaded middle interval is not evidence of later activity.
            if (!hasUnknownBoundary) plans.loadMoreUpcoming();
          }}
          onEndReachedThreshold={0.4}
          renderSectionHeader={({ section }) => (
            <View
              testID={`plans-month-${section.month}`}
              style={{
                backgroundColor: theme.colors.surface,
                paddingTop: theme.space[3],
              }}
            >
              <SectionHeader title={section.title} />
            </View>
          )}
          renderItem={renderUpcomingItem}
          contentContainerStyle={datedListPadding}
        />
      );
    }

    if (pastSections === undefined || pastSections.length === 0) {
      return refreshableEmpty(
        'plans-past-empty',
        <EmptyState
          heading="Nothing here"
          body="Plans that have happened show up here."
        />,
      );
    }
    return (
      <SectionList<PastDay, PastMonthSection>
        key={pastView.key}
        {...calendarScrollLifecycle}
        {...(calendarWindow?.stage === 'past' && Platform.OS !== 'web'
          ? { maintainVisibleContentPosition: { minIndexForVisible: 0 } }
          : {})}
        ref={pastList}
        onScrollToIndexFailed={(info) => {
          if (!currentHeaderReady.current || performance.now() >= landingDeadline.current)
            return;
          onScrollToIndexFailed(
            pastList.current,
            info,
            landingAttempts.current++,
            retryLanding,
          );
        }}
        testID="plans-past-list"
        sections={pastSections}
        keyExtractor={(day) => `past:${day.date}`}
        stickySectionHeadersEnabled
        onScroll={handlePlansScroll}
        onScrollBeginDrag={beginCalendarScroll}
        onContentSizeChange={retryLanding}
        scrollEventThrottle={16}
        refreshControl={refresh}
        onEndReached={plans.loadMorePast}
        onEndReachedThreshold={0.4}
        renderSectionHeader={({ section }) => (
          <View
            testID={`plans-past-month-${section.month}`}
            style={{
              backgroundColor: theme.colors.surface,
              paddingTop: theme.space[3],
            }}
          >
            <SectionHeader title={section.title} />
          </View>
        )}
        renderItem={({ item }) => dayCard(item.date, item.label, item.items)}
        contentContainerStyle={datedListPadding}
      />
    );
  };

  return (
    <TabScreen
      title="Plans"
      testID="plans-screen"
      hideHeader={plans.status === 'success' && !allEmpty}
    >
      {plans.status === 'pending' ? (
        <View
          testID="plans-loading"
          style={{ alignItems: 'center', paddingTop: theme.space[8] }}
        >
          <ActivityIndicator
            accessibilityRole="progressbar"
            accessibilityLabel="Loading plans"
            size="large"
            color={theme.colors.accent}
          />
        </View>
      ) : plans.status === 'error' ? (
        <View testID="plans-error">
          <EmptyState
            heading={plans.message ?? "Couldn't load this."}
            {...(plans.requestId === undefined ? {} : { body: plans.requestId })}
            action={{ label: 'Try again', onPress: plans.refetch }}
          />
        </View>
      ) : allEmpty ? (
        refreshableEmpty(
          'plans-all-empty',
          <EmptyState
            heading="No plans"
            body="Add something you want to do, on its own or with someone."
            action={{ label: 'Add', onPress: onAdd }}
          />,
        )
      ) : (
        <View
          testID="plans-viewport"
          style={{ flex: 1 }}
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        >
          {/**
           * One non-reflowing header owns the title, stage switcher and calendar. The list
           * retains the full header's measured inset while compositor-only transforms replace
           * the title/calendar with compact chrome, so scrolling never changes its offset.
           */}
          <View
            pointerEvents="box-none"
            testID="plans-header"
            onLayout={(event) => {
              if (compactHeader) return;
              const height = event.nativeEvent.layout.height;
              if (height > 0 && height !== fullHeaderHeight) setFullHeaderHeight(height);
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 2,
            }}
          >
            <View
              pointerEvents="none"
              testID="plans-safe-area-backdrop"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: insets.top + theme.space[2],
                backgroundColor: theme.colors.surface,
              }}
            />
            <Animated.View
              testID="plans-title-block"
              aria-hidden={compactHeader}
              accessibilityElementsHidden={compactHeader}
              importantForAccessibility={compactHeader ? 'no-hide-descendants' : 'auto'}
              pointerEvents="none"
              onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                if (height > 0 && height !== titleBlockHeight) {
                  setTitleBlockHeight(height);
                }
              }}
              style={{
                paddingTop: insets.top + theme.space[5],
                paddingBottom: theme.space[4],
                backgroundColor: theme.colors.surface,
                opacity: headerProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 0],
                }),
                transform: [
                  {
                    translateY: headerProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -theme.space[5]],
                    }),
                  },
                ],
              }}
            >
              <Text variant="display" color="textDisplay" accessibilityRole="header">
                Plans
              </Text>
            </Animated.View>

            <Animated.View
              testID="plans-compact-chrome"
              onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                if (height > 0) {
                  setChromeLayout((held) =>
                    held.height === height && held.compact === compactHeader
                      ? held
                      : { compact: compactHeader, height },
                  );
                }
              }}
              style={{
                gap: compactHeader ? theme.space[0] : theme.space[4],
                paddingBottom: compactHeader ? theme.space[0] : theme.space[4],
                backgroundColor: theme.colors.surface,
                transform: [
                  {
                    translateY: headerProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [
                        0,
                        -Math.max(titleBlockHeight - insets.top - theme.space[2], 0),
                      ],
                    }),
                  },
                ],
              }}
            >
              <SegmentedControl
                segments={STAGES.map(({ label }) => ({ label }))}
                selectedIndex={STAGES.findIndex(({ key }) => key === stage)}
                onChange={(index) => {
                  const next = STAGES[index];
                  if (next !== undefined) {
                    landingDeadline.current = 0;
                    userScrolling.current = false;
                    setCalendarWindow(undefined);
                    setStage(next.key);
                  }
                }}
                testID="plans-stage-switcher"
              />
              {stage === 'needsDate' ? null : (
                <CalendarNavigator
                  stage={stage}
                  today={today}
                  projection={plans.store}
                  loadRange={plans.loadRange}
                  onSelectDate={(date) => {
                    landingDeadline.current = 0;
                    userScrolling.current = false;
                    if (Platform.OS !== 'web')
                      // A new date command owns a fresh native scroll anchor, even for the
                      // same date after manual scrolling has prepended earlier rows.
                      setCalendarWindow((previous) => ({
                        stage,
                        date,
                        precedingRows: 1,
                        selection: (previous?.selection ?? 0) + 1,
                      }));
                    boundary.selectDate();
                    setLanding(date);
                  }}
                  compact={compactHeader}
                  onHeightChange={setCalendarHeight}
                />
              )}
              {plans.message === undefined ? null : (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  testID="plans-stale-error"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.space[3],
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="footnote" color="danger">
                      {plans.message}
                    </Text>
                  </View>
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    onPress={plans.refetch}
                    testID="plans-stale-retry"
                  >
                    <Text variant="footnoteStrong" color="textAction">
                      Try again
                    </Text>
                  </Touchable>
                </View>
              )}
            </Animated.View>
          </View>

          <View style={{ flex: 1 }}>{stageBody()}</View>
        </View>
      )}

      <Sheet
        open={selectedGap !== undefined}
        onClose={() => setSelectedGap(undefined)}
        title="When?"
        detent="medium"
        testID="plans-gap-date-picker"
      >
        {selectedGap === undefined ? null : (
          <DatePicker
            label="Date"
            value={selectedGap.pickedDate}
            today={today}
            onChange={(pickedDate) =>
              setSelectedGap((current) =>
                current === undefined
                  ? undefined
                  : { ...current, pickedDate: pickedDate as WallDate | null },
              )
            }
          />
        )}
      </Sheet>

      {reschedule === undefined ? null : (
        <AgendaRescheduleCoordinator
          item={reschedule.item}
          today={today}
          renderedDate={reschedule.date}
          onClose={() => setReschedule(undefined)}
        />
      )}
    </TabScreen>
  );
}
