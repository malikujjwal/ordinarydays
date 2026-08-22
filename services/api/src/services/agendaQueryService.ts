import { type AgendaQuery, parseAgendaInclude } from '@od/shared/schemas';
import type { ActivityAgendaData, AgendaData, AgendaDay } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import { getActivityPartitionStrong } from '../repositories/activityRepository.js';
import { projectAgendaItem, projectAgendaItems } from './agendaProjection.js';
import { assembleAgenda, targetedAgendaDependencies } from './agendaService.js';
import { assertActivityReadAccessFromPartition } from './authz.js';

/** Public agenda read: assemble canonical candidates, then apply caller-specific projection. */
export async function getAgenda(
  userId: string,
  query: AgendaQuery,
  now: string,
): Promise<AgendaData> {
  assertSupportedTimezone(query.tz);
  const include = new Set(parseAgendaInclude(query.include));
  const assembly = await assembleAgenda({
    userId,
    from: query.from,
    to: query.to,
    timezone: query.tz,
    now,
    includeAnytimeUnscheduled: include.has('anytime_unscheduled'),
    includeOverdue: include.has('overdue'),
    includeReminders: include.has('reminders'),
  });
  const clock = { now, timezone: query.tz, today: query.from };

  return {
    days: assembly.days.map(
      (day): AgendaDay => ({
        date: day.date,
        ...(day.upNext === undefined
          ? {}
          : { upNext: projectAgendaItem(day.upNext, clock) }),
        schedule: projectAgendaItems(day.schedule, clock),
        anytime: projectAgendaItems(day.anytime, clock),
        earlier: projectAgendaItems(day.earlier, clock),
      }),
    ),
    warnings: [...assembly.warnings],
    projectionVersions: [...assembly.projectionVersions],
  };
}

/**
 * Canonical, activity-scoped agenda read used to reconcile an acknowledged series edit.
 * It deliberately bypasses GSI discovery and treats an empty row array as authoritative.
 */
export async function getActivityAgenda(
  userId: string,
  activityId: string,
  query: AgendaQuery,
  now: string,
): Promise<ActivityAgendaData> {
  assertSupportedTimezone(query.tz);
  const partition = await getActivityPartitionStrong(activityId);
  const { activity } = await assertActivityReadAccessFromPartition(userId, partition);
  const include = new Set(parseAgendaInclude(query.include));
  const assembly = await assembleAgenda(
    {
      userId,
      from: query.from,
      to: query.to,
      timezone: query.tz,
      now,
      includeAnytimeUnscheduled: include.has('anytime_unscheduled'),
      includeOverdue: include.has('overdue'),
      includeReminders: include.has('reminders'),
    },
    targetedAgendaDependencies(activity, partition),
  );
  const clock = { now, timezone: query.tz, today: query.from };

  return {
    activityId,
    activityVersion: activity.updatedAt,
    rows: assembly.days.flatMap((day) => [
      ...day.schedule.map((candidate) => ({
        date: day.date,
        item: projectAgendaItem(candidate, clock),
      })),
      ...day.anytime.map((candidate) => ({
        date: day.date,
        item: projectAgendaItem(candidate, clock),
      })),
      ...day.earlier.map((candidate) => ({
        date: day.date,
        item: projectAgendaItem(candidate, clock),
      })),
    ]),
  };
}

/** Structural validation is shared; Node's timezone database validates actual support here. */
export function assertSupportedTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  } catch {
    throw new AppError('validation_failed', 'The timezone is not supported.', [
      { path: 'tz', message: 'Expected a supported IANA timezone' },
    ]);
  }
}
