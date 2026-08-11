import { assertNever } from '@od/shared';
import type { AgendaItem } from '@od/shared/types';
import { formatInTimeZone } from 'date-fns-tz';
import { deriveActionCapabilities } from './actionCapabilities.js';
import type { AgendaCandidate } from './agendaService.js';

const WALL_DATE = 'yyyy-MM-dd';
const WALL_TIME = 'HH:mm';

export interface AgendaProjectionClock {
  readonly now: string;
  readonly timezone: string;
}

/** Builds the trimmed, caller-specific API row from an already-hydrated agenda candidate. */
export function projectAgendaItem(
  candidate: AgendaCandidate,
  clock: AgendaProjectionClock,
): AgendaItem {
  const { activity } = candidate;
  const subtitle = deriveSubtitle(activity, candidate.actionContext.parentTitle);
  const locationLabel = activity.location?.label;

  return {
    activityId: activity.activityId,
    ...(candidate.occurrenceDate === undefined
      ? {}
      : { occurrenceDate: candidate.occurrenceDate }),
    type: activity.type,
    title: activity.title,
    status: candidate.status,
    ...(candidate.time === undefined ? {} : { time: candidate.time }),
    ...(candidate.endTime === undefined ? {} : { endTime: candidate.endTime }),
    isRecurring: activity.recurrence !== undefined,
    isSnoozed: candidate.isSnoozed,
    hasCheckbox: activity.type === 'task',
    capabilities: deriveActionCapabilities(candidate.actionContext),
    participantAvatars: candidate.participantAvatars.map((avatar) => ({ ...avatar })),
    participantCount: activity.participantCount,
    ...(locationLabel === undefined ? {} : { locationLabel }),
    ...(subtitle === undefined ? {} : { subtitle }),
    isPast: isPast(candidate, clock),
    ...(candidate.reminders === undefined
      ? {}
      : { reminders: candidate.reminders.map((reminder) => ({ ...reminder })) }),
    ...(candidate.overdueFromDate === undefined
      ? {}
      : { overdueFromDate: candidate.overdueFromDate }),
  };
}

/** Projects a batch without adding repository access or other per-item I/O. */
export function projectAgendaItems(
  candidates: readonly AgendaCandidate[],
  clock: AgendaProjectionClock,
): AgendaItem[] {
  return candidates.map((candidate) => projectAgendaItem(candidate, clock));
}

function deriveSubtitle(
  activity: AgendaCandidate['activity'],
  parentTitle: string | undefined,
): string | undefined {
  switch (activity.details.kind) {
    case 'task':
      return parentTitle;
    case 'meal':
      return activity.details.mealSlot === undefined
        ? 'Meal'
        : `Meal · ${capitalise(activity.details.mealSlot)}`;
    case 'watch': {
      const { season, episode, mediaKind } = activity.details;
      if (season !== undefined && episode !== undefined) {
        return `Watch · S${season} E${episode}`;
      }
      return mediaKind === undefined ? 'Watch' : `Watch · ${capitalise(mediaKind)}`;
    }
    case 'event':
      return activity.details.organiser ?? activity.location?.label;
    case 'custom':
      return undefined;
    default:
      return assertNever(activity.details, 'ActivityDetails');
  }
}

function isPast(candidate: AgendaCandidate, clock: AgendaProjectionClock): boolean {
  const instant = new Date(clock.now);
  const today = formatInTimeZone(instant, clock.timezone, WALL_DATE);
  if (candidate.viewerDate !== today) return candidate.viewerDate < today;

  const boundary = candidate.endTime ?? candidate.time;
  if (boundary === undefined) return false;
  const now = formatInTimeZone(instant, clock.timezone, WALL_TIME);
  return boundary <= now;
}

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
