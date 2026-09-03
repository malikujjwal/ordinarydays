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
  useTheme,
} from '@od/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
  SectionList,
  View,
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
 * estimate of the offset — a little further on each failure, so a short estimate still
 * walks the target into the mounted window — and land exactly once it is measurable.
 */
const LANDING_ATTEMPTS = 40;
function onScrollToIndexFailed<Item, Section>(
  list: SectionList<Item, Section> | null,
  info: { index: number; averageItemLength: number },
  attempt: number,
  retry: () => void,
): void {
  if (attempt >= LANDING_ATTEMPTS) return;
  list?.getScrollResponder()?.scrollTo({
    y: info.averageItemLength * info.index + attempt * info.averageItemLength * 4,
    animated: false,
  });
  setTimeout(retry, 60);
}

/** A landing is best effort: a list that cannot measure yet simply stays where it is. */
function scrollTo<Item, Section>(
  list: SectionList<Item, Section> | null,
  sectionIndex: number,
  itemIndex: number,
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
      animated: true,
      viewPosition: 0,
      viewOffset: 0,
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
  const [calendarHidden, setCalendarHidden] = useState(false);
  const [calendarHeight, setCalendarHeight] = useState(0);
  const calendarHiddenRef = useRef(false);
  const calendarScrollAnchor = useRef(0);
  const calendarScrollDirection = useRef<-1 | 0 | 1>(0);
  const lastCalendarScrollY = useRef(0);
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

  const resetCalendarVisibility = useCallback(() => {
    calendarHiddenRef.current = false;
    setCalendarHidden(false);
    calendarScrollAnchor.current = 0;
    calendarScrollDirection.current = 0;
    lastCalendarScrollY.current = 0;
  }, []);
  const calendarScrollThreshold = theme.space[4];
  const handlePlansScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      const previous = lastCalendarScrollY.current;
      lastCalendarScrollY.current = y;
      if (y <= theme.space[2]) {
        resetCalendarVisibility();
        return;
      }
      const direction = y === previous ? 0 : y > previous ? 1 : -1;
      if (direction === 0) return;
      if (direction !== calendarScrollDirection.current) {
        calendarScrollDirection.current = direction;
        calendarScrollAnchor.current = previous;
      }
      if (Math.abs(y - calendarScrollAnchor.current) < calendarScrollThreshold) return;
      const nextHidden = direction === 1;
      calendarScrollAnchor.current = y;
      if (nextHidden === calendarHiddenRef.current) return;
      calendarHiddenRef.current = nextHidden;
      setCalendarHidden(nextHidden);
    },
    [calendarScrollThreshold, resetCalendarVisibility, theme.space],
  );

  const upcomingSections = useMemo(
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
  /** Projected only while its stage shows — Past can hold months of paged history. */
  const pastSections = useMemo(
    () => (stage === 'past' ? pastSectionsFromStore(plans.store, today) : undefined),
    [stage, plans.store, today],
  );
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

  useEffect(() => {
    if (landing === undefined) return;
    // One landing for both stages: a fresh retry budget, the scroll, and the state cleared.
    const land = (scroll: () => void) => {
      pendingScroll.current = scroll;
      landingAttempts.current = 0;
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
        land(() => scrollTo(upcomingList.current, target.sectionIndex, target.itemIndex));
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
        land(() => scrollTo(pastList.current, target.sectionIndex, target.itemIndex));
      }
    }
  }, [landing, stage, upcomingSections, pastSections, plans.store]);

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
      contentContainerStyle={{ flexGrow: 1 }}
      testID={testID}
    >
      {child}
    </ScrollView>
  );
  const listPadding = {
    gap: theme.space[5],
    ...(stage === 'needsDate' || calendarHeight === 0
      ? {}
      : { paddingTop: calendarHeight }),
    // The final row scrolls above the global Add button without shrinking the viewport.
    paddingBottom: bottomChromeScrollPadding(insets.bottom),
  };

  const dayCard = (date: string, label: string, items: AgendaItem[]) => (
    <View testID={`plans-date-${date}`} style={{ gap: theme.space[3] }}>
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
          ref={upcomingList}
          onScrollToIndexFailed={(info) =>
            onScrollToIndexFailed(
              upcomingList.current,
              info,
              landingAttempts.current++,
              () => pendingScroll.current(),
            )
          }
          testID="plans-list"
          sections={upcomingSections}
          keyExtractor={(item) =>
            item.kind === 'date' ? `date:${item.date}` : `gap:${item.from}:${item.to}`
          }
          stickySectionHeadersEnabled
          onScroll={handlePlansScroll}
          scrollEventThrottle={16}
          refreshControl={refresh}
          onEndReached={plans.loadMoreUpcoming}
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
          contentContainerStyle={listPadding}
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
        ref={pastList}
        onScrollToIndexFailed={(info) =>
          onScrollToIndexFailed(pastList.current, info, landingAttempts.current++, () =>
            pendingScroll.current(),
          )
        }
        testID="plans-past-list"
        sections={pastSections}
        keyExtractor={(day) => `past:${day.date}`}
        stickySectionHeadersEnabled
        onScroll={handlePlansScroll}
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
        contentContainerStyle={listPadding}
      />
    );
  };

  return (
    <TabScreen title="Plans" testID="plans-screen">
      {plans.status === 'pending' ? (
        <View testID="plans-loading">
          <Skeleton shape="card" count={5} />
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
        <View style={{ flex: 1, gap: theme.space[4] }}>
          <SegmentedControl
            segments={STAGES.map(({ label }) => ({ label }))}
            selectedIndex={STAGES.findIndex(({ key }) => key === stage)}
            onChange={(index) => {
              const next = STAGES[index];
              if (next !== undefined) {
                resetCalendarVisibility();
                setStage(next.key);
              }
            }}
            testID="plans-stage-switcher"
          />
          {/**
           * A refresh or pagination failure after a successful load (§5.3): the stages keep
           * showing what they hold, and the failure is said out loud instead of a spinner
           * that ends in silence. Cleared by the next successful load.
           */}
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
          {stage === 'needsDate' ? (
            <View style={{ flex: 1 }}>{stageBody()}</View>
          ) : (
            // The navigator overlays the dated list. Its measured height is stable list
            // content inset, while scroll-driven visibility uses only compositor
            // translation/opacity; no sibling is relaid out during the transition.
            <View style={{ flex: 1 }}>
              <CalendarNavigator
                stage={stage}
                today={today}
                projection={plans.store}
                loadRange={plans.loadRange}
                onSelectDate={setLanding}
                hidden={calendarHidden}
                onHeightChange={setCalendarHeight}
              />
              <View style={{ flex: 1 }}>{stageBody()}</View>
            </View>
          )}
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
