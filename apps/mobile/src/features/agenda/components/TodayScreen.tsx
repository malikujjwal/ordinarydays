import { ApiError } from '@od/shared/client';
import {
  TODAY_ANYTIME_SAVED_LIMIT,
  TODAY_EARLIER_COLLAPSED_LIMIT,
} from '@od/shared/constants';
import type { AgendaData, AgendaItem } from '@od/shared/types';
import { Button, EmptyState, Skeleton, useTheme } from '@od/ui';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { TabScreen } from '@/components/TabScreen';
import { useAgenda } from '@/features/agenda/hooks/useAgenda';
import { agendaItemsForDay, partitionAgenda } from '@/features/agenda/model/partition';
import { AgendaSection } from './AgendaSection';

export interface TodayScreenProps {
  onOpenAnytime: () => void;
  onOpenAgendaItem: (item: AgendaItem) => void;
  /** P2-20 replaces this edge reading with its foreground-aware minute ticker. */
  now?: Date;
  /** Test seam for the viewer-zone minute; P2-20 supplies it from the shared clock. */
  currentMinute?: string;
}

function minuteAt(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
  now = new Date(),
  currentMinute = minuteAt(now),
}: TodayScreenProps) {
  const theme = useTheme();
  const agenda = useAgenda({ now });
  const [showAllEarlier, setShowAllEarlier] = useState(false);

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
  const sections = partitionAgenda(
    day === undefined ? [] : agendaItemsForDay(day),
    currentMinute,
  );
  const anytime = cappedAnytime(sections.anytime);
  const earlier = showAllEarlier
    ? sections.earlier
    : sections.earlier.slice(0, TODAY_EARLIER_COLLAPSED_LIMIT);

  return (
    <TabScreen title="Today" testID="today-screen">
      <ScrollView
        testID="today-agenda"
        contentContainerStyle={{ gap: theme.space[8], paddingBottom: theme.space[8] }}
      >
        {sections.upNext.length === 0 ? null : (
          <AgendaSection
            title="Up next"
            items={sections.upNext}
            testID="today-up-next"
            onOpen={onOpenAgendaItem}
          />
        )}
        {sections.schedule.length === 0 ? null : (
          <AgendaSection
            title="Schedule"
            items={sections.schedule}
            testID="today-schedule"
            showTime
            onOpen={onOpenAgendaItem}
          />
        )}
        {anytime.items.length === 0 ? null : (
          <AgendaSection
            title="Anytime"
            items={anytime.items}
            testID="today-anytime"
            onOpen={onOpenAgendaItem}
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
