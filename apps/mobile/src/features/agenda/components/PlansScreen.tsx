import { ApiError } from '@od/shared/client';
import { MAX_AGENDA_DAYS } from '@od/shared/constants';
import { toWallDate, toWallTime, type WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import {
  Card,
  DatePicker,
  EmptyState,
  SectionHeader,
  Sheet,
  Skeleton,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgendaRescheduleCoordinator } from '@/components/AgendaRescheduleCoordinator';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';
import { TabScreen } from '@/components/TabScreen';
import { useMinuteTicker } from '@/hooks/useMinuteTicker';
import { useAgenda } from '../hooks/useAgenda';
import { useAgendaActivityActions } from '../hooks/useAgendaActivityActions';
import {
  buildUpcomingSections,
  type UpcomingListItem,
  type UpcomingMonthSection,
} from '../model/plansWindow';
import { AgendaRow } from './AgendaRow';

export interface PlansScreenProps {
  /** Preserve occurrence scope when a generated recurring row opens detail. */
  onOpen: (item: AgendaItem) => void;
  /** The global Add action. Plans never pre-selects an object kind. */
  onAdd: () => void;
}

interface SelectedGap {
  pickedDate: WallDate | null;
}

interface SelectedAgendaItem {
  item: AgendaItem;
  date: WallDate;
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return {
      message: error.status >= 500 ? 'Something went wrong.' : error.message,
      requestId: error.requestId,
    };
  }
  return { message: "Couldn't load this." };
}

/** Plans' Phase 2 Upcoming stage: one bounded, multi-day projection of the shared agenda. */
export function PlansScreen({ onOpen, onAdd }: PlansScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tick = useMinuteTicker();
  const agenda = useAgenda({
    now: tick.instant,
    days: MAX_AGENDA_DAYS,
    incrementalLocalTargetReconciliation: true,
  });
  const today = toWallDate(tick.instant, agenda.timezone);
  const currentMinute = toWallTime(tick.instant, agenda.timezone);
  const actions = useAgendaActivityActions({
    today,
    currentMinute,
    timezone: agenda.timezone,
    ...(agenda.data === undefined ? {} : { agendaData: agenda.data }),
  });
  const sections = useMemo(
    () => (agenda.data === undefined ? [] : buildUpcomingSections(agenda.data)),
    [agenda.data],
  );
  const [selectedGap, setSelectedGap] = useState<SelectedGap>();
  const [reschedule, setReschedule] = useState<SelectedAgendaItem>();
  const failure = agenda.error === null ? undefined : describe(agenda.error);

  const renderItem = ({ item }: { item: UpcomingListItem }) => {
    if (item.kind === 'gap') {
      return (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() =>
            setSelectedGap({
              pickedDate: item.from as WallDate,
            })
          }
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

    return (
      <View testID={`plans-date-${item.date}`} style={{ gap: theme.space[3] }}>
        <SectionHeader title={item.label} />
        {item.items.map((agendaItem) => {
          const key = `${agendaItem.activityId}:${agendaItem.occurrenceDate ?? ''}`;
          return (
            <Card key={key} padding={5} testID={`plans-card-${key}`}>
              <AgendaRow
                item={agendaItem}
                today={today}
                showTime
                divider={false}
                untimedContextLabel={item.label}
                onOpen={onOpen}
                onToggleComplete={actions.toggleComplete}
                onOpenReschedule={(row) =>
                  setReschedule({ item: row, date: item.date as WallDate })
                }
              />
            </Card>
          );
        })}
      </View>
    );
  };

  return (
    <TabScreen title="Plans" testID="plans-screen">
      {agenda.status === 'pending' ? (
        <View testID="plans-loading">
          <Skeleton shape="card" count={5} />
        </View>
      ) : agenda.status === 'error' ? (
        <View testID="plans-error">
          <EmptyState
            heading={failure?.message ?? "Couldn't load this."}
            {...(failure?.requestId === undefined ? {} : { body: failure.requestId })}
            action={{ label: 'Try again', onPress: () => void agenda.refetch() }}
          />
        </View>
      ) : sections.length === 0 ? (
        <View testID="plans-empty">
          <EmptyState
            heading="No upcoming plans"
            body="Anything with a date shows up here."
            action={{ label: 'Add', onPress: onAdd }}
          />
        </View>
      ) : (
        <SectionList<UpcomingListItem, UpcomingMonthSection>
          testID="plans-list"
          sections={sections}
          keyExtractor={(item) =>
            item.kind === 'date' ? `date:${item.date}` : `gap:${item.from}:${item.to}`
          }
          stickySectionHeadersEnabled
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
          renderItem={renderItem}
          contentContainerStyle={{
            gap: theme.space[5],
            // The final row scrolls above the global Add button without shrinking the viewport.
            // Clear of the floating Add control *and* the tab bar painted over the scroll.
            paddingBottom: bottomChromeScrollPadding(insets.bottom),
          }}
        />
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
