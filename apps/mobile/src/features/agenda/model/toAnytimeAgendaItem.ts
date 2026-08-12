import type { ActivityListItem, AgendaItem } from '@od/shared/types';

/**
 * Adapts the saved `#N` index projection to the shared agenda-row presentation shape.
 * Saved rows are undated Tasks in the signed-in user's own index; no recurrence expansion,
 * snooze state, participant avatars, or clock-relative state exists on this endpoint.
 */
export function toAnytimeAgendaItem(item: ActivityListItem): AgendaItem {
  return {
    activityId: item.activityId,
    type: item.type,
    title: item.title,
    status: item.status,
    ...(item.time === undefined ? {} : { time: item.time }),
    ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
    isRecurring: item.isRecurring,
    isSnoozed: false,
    hasCheckbox: item.type === 'task',
    capabilities: { complete: true, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: item.participantCount,
    ...(item.locationLabel === undefined ? {} : { locationLabel: item.locationLabel }),
    ...(item.subtitle === undefined ? {} : { subtitle: item.subtitle }),
    isPast: false,
  };
}
