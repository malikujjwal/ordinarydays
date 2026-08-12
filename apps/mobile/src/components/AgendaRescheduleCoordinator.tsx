import type { AgendaItem } from '@od/shared/types';
import { EmptyState, Sheet, Skeleton } from '@od/ui';
import { View } from 'react-native';
import { RescheduleSheet } from '@/features/activity/components/RescheduleSheet';
import { useActivityDetail } from '@/features/activity/hooks/useActivity';
import type { WallDate } from '@/features/activity/model/dates';

export interface AgendaRescheduleCoordinatorProps {
  item: AgendaItem;
  today: WallDate;
  onClose: () => void;
}

/** Loads the full Activity contract that the shared reschedule sheet needs from an agenda row. */
export function AgendaRescheduleCoordinator({
  item,
  today,
  onClose,
}: AgendaRescheduleCoordinatorProps) {
  const detail = useActivityDetail(item.activityId);

  if (detail.status === 'pending') {
    return (
      <Sheet open onClose={onClose} title="When?" testID="reschedule-loading">
        <Skeleton shape="row" count={3} />
      </Sheet>
    );
  }

  if (detail.status === 'error' || detail.detail === undefined) {
    return (
      <Sheet open onClose={onClose} title="When?" testID="reschedule-load-error">
        <View>
          <EmptyState
            heading={detail.message ?? "Couldn't load this."}
            {...(detail.requestId === undefined ? {} : { body: detail.requestId })}
            action={{ label: 'Try again', onPress: detail.refetch }}
          />
        </View>
      </Sheet>
    );
  }

  return (
    <RescheduleSheet
      open
      onClose={onClose}
      today={today}
      activity={detail.detail.activity}
      {...(item.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: item.occurrenceDate })}
      renderedDate={today}
      {...(item.time === undefined ? {} : { renderedTime: item.time })}
      onSchedule={detail.schedule}
      onPatch={detail.patch}
      busy={detail.isSaving}
      {...(detail.editError === undefined ? {} : { error: detail.editError })}
    />
  );
}
