import type {
  Activity,
  AgendaItemStatus,
  Occurrence,
  OccurrenceDetailProjection,
} from '@od/shared/types';

function wallTime(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{2}:\d{2}$/.test(value) ? value : undefined;
}

/** The same status vocabulary the server Agenda projection exposes for an occurrence. */
export function agendaStatusForOccurrence(
  activityStatus: Activity['status'],
  occurrenceStatus: Occurrence['status'] | undefined,
): AgendaItemStatus {
  if (occurrenceStatus === 'completed') return 'completed_occurrence';
  if (occurrenceStatus === 'skipped') return 'skipped_occurrence';
  return activityStatus;
}

/** Materializes a canonical stored override without changing the recurring Activity row. */
export function projectionFromCanonicalOccurrence(
  activity: Activity,
  nominalDate: string,
  occurrence: Occurrence | undefined,
  previous: OccurrenceDetailProjection | undefined,
): OccurrenceDetailProjection {
  if (occurrence === undefined) {
    return {
      nominalDate,
      date: nominalDate,
      ...(activity.schedule?.time === undefined ? {} : { time: activity.schedule.time }),
      ...(activity.schedule?.endTime === undefined
        ? {}
        : { endTime: activity.schedule.endTime }),
      status: activity.status,
      isSnoozed: false,
    };
  }
  const snoozeTime = wallTime(occurrence.snoozedUntil);
  const time =
    snoozeTime ?? occurrence.overrideTime ?? previous?.time ?? activity.schedule?.time;
  const endTime = previous?.endTime ?? activity.schedule?.endTime;
  return {
    nominalDate,
    date: occurrence.overrideDate ?? previous?.date ?? nominalDate,
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    status: agendaStatusForOccurrence(activity.status, occurrence.status),
    isSnoozed: occurrence.status === 'snoozed',
    ...(occurrence.completedAt === undefined
      ? {}
      : { completedAt: occurrence.completedAt }),
  };
}
