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
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgendaRescheduleCoordinator } from '@/components/AgendaRescheduleCoordinator';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';
import { TabScreen } from '@/components/TabScreen';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import { resolveViewerTimezone } from '@/lib/viewerTimezone';
import { useAgendaActivityActions } from '../hooks/useAgendaActivityActions';
import { type NeedsDateRowData, usePlans } from '../hooks/usePlans';
import { pastSectionsFromStore, upcomingSectionsFromStore } from '../model/plansStages';
import type { UpcomingListItem, UpcomingMonthSection } from '../model/plansWindow';
import { AgendaRow } from './AgendaRow';
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

interface SelectedAgendaItem {
  item: AgendaItem;
  date: WallDate;
}

export function PlansScreen({ onOpen, onAdd }: PlansScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tick = useMinuteTicker();
  const queryClient = useQueryClient();
  const timezone = resolveViewerTimezone(queryClient);
  const today = toWallDate(tick.instant, timezone);
  const currentMinute = toWallTime(tick.instant, timezone);
  const plans = usePlans(timezone);
  const actions = useAgendaActivityActions({ today, currentMinute, timezone });
  /**
   * Upcoming is where the tab lands: it answers "what is next", the question the tab is
   * opened for, while the switcher keeps the other two stages one tap away (decision
   * recorded here — §1.3 names no landing stage; raise in PR if wrong).
   */
  const [stage, setStage] = useState<Stage>('upcoming');
  const [selectedGap, setSelectedGap] = useState<SelectedGap>();
  const [reschedule, setReschedule] = useState<SelectedAgendaItem>();

  const upcomingSections = useMemo(
    () =>
      plans.upcomingWindow === undefined
        ? []
        : upcomingSectionsFromStore(
            plans.store,
            plans.upcomingWindow.from,
            plans.upcomingWindow.through,
          ),
    [plans.store, plans.upcomingWindow],
  );
  const pastSections = useMemo(
    () => pastSectionsFromStore(plans.store, today),
    [plans.store, today],
  );

  const upcomingEmpty =
    upcomingSections.length === 0 && plans.upcomingWindow?.nextFrom == null;
  const allEmpty =
    plans.status === 'success' &&
    plans.needsDate.length === 0 &&
    upcomingEmpty &&
    pastSections.length === 0 &&
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
    !plans.isLoadingMoreUpcoming;
  const { loadMoreUpcoming } = plans;
  useEffect(() => {
    if (shouldAdvance) loadMoreUpcoming();
  }, [shouldAdvance, loadMoreUpcoming]);

  const toggleComplete = (item: AgendaItem, checked: boolean) => {
    plans.applyCompletion(item, checked);
    actions.toggleComplete(item, checked);
  };

  const refresh = (
    <RefreshControl refreshing={plans.isRefreshing} onRefresh={plans.refetch} />
  );
  const listPadding = {
    gap: theme.space[5],
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
        return (
          <View testID="plans-needs-date-empty">
            <EmptyState
              heading="Nothing without a date"
              body="Plans you've started but not scheduled show up here."
            />
          </View>
        );
      }
      return (
        <SectionList<NeedsDateRowData>
          testID="plans-needs-date-list"
          sections={[{ data: [...plans.needsDate] }]}
          keyExtractor={(item) => item.activityId}
          refreshControl={refresh}
          renderItem={({ item }) => (
            <NeedsDateCard
              item={item}
              onOpen={onOpen}
              testID={`plans-needs-date-${item.activityId}`}
            />
          )}
          contentContainerStyle={listPadding}
        />
      );
    }

    if (stage === 'upcoming') {
      if (upcomingSections.length === 0) {
        return (
          <View testID="plans-upcoming-empty">
            <EmptyState
              heading="No upcoming plans"
              body="Anything with a date shows up here."
              action={{ label: 'Add', onPress: onAdd }}
            />
          </View>
        );
      }
      return (
        <SectionList<UpcomingListItem, UpcomingMonthSection>
          testID="plans-list"
          sections={upcomingSections}
          keyExtractor={(item) =>
            item.kind === 'date' ? `date:${item.date}` : `gap:${item.from}:${item.to}`
          }
          stickySectionHeadersEnabled
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

    if (pastSections.length === 0) {
      return (
        <View testID="plans-past-empty">
          <EmptyState
            heading="Nothing here"
            body="Plans that have happened show up here."
          />
        </View>
      );
    }
    return (
      <SectionList
        testID="plans-past-list"
        sections={pastSections}
        keyExtractor={(day) => `past:${day.date}`}
        stickySectionHeadersEnabled
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
        <View testID="plans-all-empty">
          <EmptyState
            heading="No plans"
            body="Add something you want to do, on its own or with someone."
            action={{ label: 'Add', onPress: onAdd }}
          />
        </View>
      ) : (
        <View style={{ flex: 1, gap: theme.space[4] }}>
          <SegmentedControl
            segments={STAGES.map(({ label }) => ({ label }))}
            selectedIndex={STAGES.findIndex(({ key }) => key === stage)}
            onChange={(index) => {
              const next = STAGES[index];
              if (next !== undefined) setStage(next.key);
            }}
            testID="plans-stage-switcher"
          />
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
